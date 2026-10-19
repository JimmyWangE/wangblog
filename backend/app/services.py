"""运行时服务：TTL 缓存、限流、进程内事件总线与异步 worker。

对应架构文档：
- §6.1 L2 缓存（生产换 Redis，接口保持一致：get/set/invalidate）
- §6.3 限流（生产在网关层，此处为服务层兜底）
- §6.4 事件总线 + worker（生产换 RabbitMQ，事件名与载荷不变）
"""
import asyncio
import time
import uuid
from collections import defaultdict, deque

from .config import settings
from . import db


# ---------------------------------------------------------------- L2 缓存（TTL）
class TTLCache:
    def __init__(self):
        self._store: dict[str, tuple[float, object]] = {}

    def get(self, key: str):
        item = self._store.get(key)
        if not item:
            return None
        exp, value = item
        if exp < time.time():
            self._store.pop(key, None)
            return None
        return value

    def set(self, key: str, value, ttl: int):
        # TTL 随机抖动 ±10%，防雪崩（架构文档 §6.1）
        jitter = ttl * 0.1 * (2 * (uuid.uuid4().int % 1000) / 1000 - 1)
        self._store[key] = (time.time() + ttl + jitter, value)

    def invalidate(self, *prefixes: str):
        for k in [k for k in self._store if any(k.startswith(p) for p in prefixes)]:
            self._store.pop(k, None)


cache = TTLCache()

POST_TTL, TAXONOMY_TTL, DASHBOARD_TTL, SEARCH_TTL = 3600, 600, 60, 300


# ---------------------------------------------------------------- 限流（固定窗口计数）
class RateLimiter:
    def __init__(self):
        self._hits: dict[str, deque] = defaultdict(deque)

    def hit(self, key: str, limit: int, window_sec: int) -> bool:
        """返回 True 表示放行。"""
        now_ts = time.time()
        dq = self._hits[key]
        while dq and dq[0] < now_ts - window_sec:
            dq.popleft()
        if len(dq) >= limit:
            return False
        dq.append(now_ts)
        return True


rate_limiter = RateLimiter()

# 评论反垃圾关键词（命中 → flag=命中关键词，转待审而非拒绝，架构文档 §6.3）
SPAM_KEYWORDS = ["代刷", "加微信", "刷单", "赌博", "发票"]


def detect_spam_flag(content: str) -> str | None:
    for kw in SPAM_KEYWORDS:
        if kw in content:
            return "命中关键词"
    return None


# ---------------------------------------------------------------- 事件总线与 worker
_event_queue: asyncio.Queue = asyncio.Queue()
publish_tasks: dict[str, dict] = {}   # taskId → 任务状态（生产写 Redis）


async def publish_event(event_type: str, payload: dict):
    await _event_queue.put({"type": event_type, "payload": payload, "ts": time.time()})


PUBLISH_STEPS = ["推送到 Git 仓库", "渲染静态页面", "生成 sitemap 与 RSS", "重建搜索索引", "部署到 ECS 并刷新 CDN"]


def create_publish_task(post_id: str, mode: str, scheduled_at: str | None) -> str:
    # 幂等：同一文章存在未完成任务时合并（架构文档 §6.6）
    for tid, t in publish_tasks.items():
        if t["postId"] == post_id and t["status"] == "running":
            return tid
    task_id = uuid.uuid4().hex
    publish_tasks[task_id] = {
        "postId": post_id, "mode": mode, "scheduledAt": scheduled_at, "status": "running",
        "steps": [{"name": n, "status": "pending"} for n in PUBLISH_STEPS],
        "gitCommit": None,
    }
    _event_queue.put_nowait({"type": "publish.task", "payload": {"taskId": task_id}, "ts": time.time()})
    return task_id


async def _run_publish(task_id: str):
    """发布流水线状态机（对应前端构建弹窗的 5 个 step）。"""
    task = publish_tasks[task_id]
    for step in task["steps"]:
        step["status"] = "running"
        await asyncio.sleep(settings.PUBLISH_STEP_DELAY)  # 模拟构建耗时（生产为真实 Git/CI 调用）
        step["status"] = "done"
    post = db.q1("SELECT * FROM posts WHERE id=?", (task["postId"],))
    commit = uuid.uuid4().hex[:7]
    if task["mode"] == "schedule":
        db.exec_("UPDATE posts SET status='scheduled', scheduled_at=?, git_commit=?, updated_at=? WHERE id=?",
                 (task["scheduledAt"], commit, db.now(), task["postId"]))
    else:
        db.exec_("UPDATE posts SET status='published', published_at=?, git_commit=?, updated_at=? WHERE id=?",
                 (db.now(), commit, db.now(), task["postId"]))
    task["status"], task["gitCommit"] = "done", commit
    task["doneUrl"] = f"/posts/{post['slug']}" if post else None
    cache.invalidate("post:", "taxonomy", "dashboard")


async def _stat_worker(event: dict):
    """page.viewed / page.read_finish → analytics_daily 聚合（架构文档 §6.4）。"""
    p = event["payload"]
    post_id, date = p.get("postId") or "", db.today()
    row = db.q1("SELECT * FROM analytics_daily WHERE date=? AND post_id=?", (date, post_id))
    if not row:
        db.exec_("INSERT INTO analytics_daily(date,post_id,pv,uv,mer) VALUES(?,?,0,0,0)", (date, post_id))
    if p.get("event") == "view":
        db.exec_("UPDATE analytics_daily SET pv=pv+1 WHERE date=? AND post_id=?", (date, post_id))
        uv = db.q1("SELECT COUNT(DISTINCT uv_hash) AS c FROM analytics_events WHERE post_id IS ? AND date(created_at)=?",
                   (post_id or None, date))["c"]
        db.exec_("UPDATE analytics_daily SET uv=? WHERE date=? AND post_id=?", (uv, date, post_id))
        if post_id:
            db.exec_("UPDATE posts SET view_count=view_count+1 WHERE id=?", (post_id,))
    elif p.get("event") == "read_finish":
        db.exec_("UPDATE analytics_daily SET mer=mer+1 WHERE date=? AND post_id=?", (date, post_id))
    cache.invalidate("dashboard")


async def _event_loop():
    while True:
        event = await _event_queue.get()
        try:
            etype = event["type"]
            if etype == "publish.task":
                await _run_publish(event["payload"]["taskId"])
            elif etype in ("page.viewed", "page.read_finish"):
                await _stat_worker(event)
            elif etype == "comment.approved":
                post = db.q1("SELECT slug FROM posts WHERE id=?", (event["payload"]["postId"],))
                if post:
                    cache.invalidate(f"post:{post['slug']}", "dashboard")
            elif etype == "comment.submitted":
                pass  # notify-worker：生产环境发送邮件通知作者
        except Exception as e:  # worker 异常不拖垮主循环（生产进死信队列 + 告警）
            print(f"[worker] event {event.get('type')} failed: {e}")


def start_workers() -> asyncio.Task:
    return asyncio.create_task(_event_loop())
