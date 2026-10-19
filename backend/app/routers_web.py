"""前端兼容层（/api/web/*）：直接向前端 prototype 输出与 mock JSON 同构的数据。

前端 assets/js/api.js 在检测到后端可用时切换到本组接口，
页面与渲染层零改动。数据全部来自数据库（种子 = 原 mock 数据）。
"""
import json
import shutil
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter

from . import db
from .config import settings

router = APIRouter(prefix="/api/web", tags=["前端兼容层"])

PUB = ("published", "pinned")


def _j(text, default=None):
    try:
        return json.loads(text) if text else default
    except Exception:
        return default


def _tags_of(post_id: str) -> list[str]:
    rows = db.q("""SELECT t.name FROM post_tags pt JOIN tags t ON t.id=pt.tag_id
                   WHERE pt.post_id=? ORDER BY t.name""", (post_id,))
    return [r["name"] for r in rows]


def _post_out(r: dict) -> dict:
    date_src = r["published_at"] or r["scheduled_at"] or r["updated_at"]
    updated = r["updated_at"] or ""
    editor = _j(r["editor"], {}) or {}
    editor["markdown"] = r["content_md"] or ""  # 编辑器内容以 content_md 为准（草稿保存后同步）
    return {
        "id": r["id"],
        "slug": r["slug"],
        "title": r["title"],
        "excerpt": r["excerpt"] or "",
        "date": (date_src or "")[:10],
        "category": r.get("category") or "",
        "tags": _tags_of(r["id"]),
        "readingMinutes": r["reading_minutes"],
        "commentCount": r["comment_count"],
        "status": r["status"],
        "updatedAt": updated[5:16] if updated else "",
        "cover": _j(r["cover"]),
        "detail": _j(r["detail"], {}),
        "editor": editor,
        "scheduledAt": r["scheduled_at"],
        "draftNote": r["draft_note"],
    }


@router.get("/posts")
def web_posts():
    """对应 prototype/data/posts.json（回收站文章不下发）"""
    rows = db.q("""SELECT p.*, c.name AS category FROM posts p
                   LEFT JOIN categories c ON c.id=p.category_id
                   WHERE p.status != 'trashed'
                   ORDER BY COALESCE(p.published_at, p.scheduled_at, p.updated_at) DESC""")
    return {"posts": [_post_out(r) for r in rows]}


def _time_ago(created: str) -> str:
    try:
        dt = datetime.strptime(created, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return created
    diff = datetime.now() - dt
    if diff.days >= 2:
        return created[:10]
    if diff.days == 1:
        return "昨天 " + created[11:16]
    mins = int(diff.total_seconds() // 60)
    if mins < 1:
        return "刚刚"
    if mins < 60:
        return f"{mins} 分钟前"
    return f"{mins // 60} 小时前"


@router.get("/comments")
def web_comments():
    """对应 prototype/data/comments.json（byPost + 待审队列）"""
    rows = db.q("""SELECT c.*, p.slug AS slug, p.title AS post_title FROM comments c
                   JOIN posts p ON p.id=c.post_id ORDER BY c.created_at""")
    by_post: dict[str, list] = {}
    pending = []
    counts = {"pending": 0, "approved": 0, "spam": 0}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
        if r["status"] == "approved":
            by_post.setdefault(r["slug"], []).append({
                "author": r["author_name"],
                "avatarText": (r["author_name"] or "?")[0],
                "time": r["created_at"][:16],
                "body": r["content"],
                "isAuthor": bool(r["is_author"]),
            })
        elif r["status"] == "pending":
            flagged = bool(r["flag"])
            approve_label = "仍要通过" if r["flag"] == "命中关键词" else "通过"
            actions = ([{"action": "spam", "label": "标记垃圾", "style": "ghost"}] if flagged else []) + [
                {"action": "delete", "label": "删除", "style": "ghost"},
                {"action": "approve", "label": approve_label, "style": "primary"},
            ]
            pending.append({
                "id": r["id"],
                "author": r["author_name"],
                "contact": r["author_email"] or "游客",
                "timeAgo": _time_ago(r["created_at"]),
                "flag": r["flag"],
                "bodyHtml": r["content"],
                "postTitle": r["post_title"],
                "actions": actions,
            })
    return {
        "byPost": by_post,
        "review": {
            "tabs": [
                {"label": "待审核", "count": counts.get("pending", 0), "active": True},
                {"label": "已通过", "count": counts.get("approved", 0), "active": False},
                {"label": "垃圾评论", "count": counts.get("spam", 0), "active": False},
            ],
            "pending": list(reversed(pending)),
        },
    }


def _tag_style(count: int, max_count: int) -> tuple[int, str]:
    if count >= max_count and count > 0:
        return 24, "accent"
    size = max(12, min(20, 12 + count))
    return size, ("muted" if count <= 3 else "normal")


@router.get("/taxonomy")
def web_taxonomy():
    """对应 prototype/data/taxonomy.json（统计全部由库内数据实时计算）"""
    placeholders = ",".join("?" * len(PUB))
    total = db.q1(f"SELECT COUNT(*) AS c FROM posts WHERE status IN ({placeholders})", PUB)["c"]
    years = db.q(f"""SELECT substr(published_at,1,4) AS year, COUNT(*) AS count FROM posts
                     WHERE status IN ({placeholders}) AND published_at IS NOT NULL
                     GROUP BY year ORDER BY year DESC""", PUB)
    cats = db.q(f"""SELECT c.name, COUNT(p.id) AS count FROM categories c
                    LEFT JOIN posts p ON p.category_id=c.id AND p.status IN ({placeholders})
                    GROUP BY c.id ORDER BY count DESC, c.sort""", PUB)
    tag_rows = db.q(f"""SELECT t.name, COUNT(pt.post_id) AS count FROM tags t
                        LEFT JOIN post_tags pt ON pt.tag_id=t.id
                        LEFT JOIN posts p ON p.id=pt.post_id AND p.status IN ({placeholders})
                        GROUP BY t.id ORDER BY count DESC, t.name""", PUB)
    max_c = max([r["count"] for r in tag_rows], default=0)
    summary = {r["status"]: r["c"] for r in
               db.q("SELECT status, COUNT(*) AS c FROM posts WHERE status != 'trashed' GROUP BY status")}
    return {
        "totalPosts": total,
        "years": [{"year": int(y["year"]), "count": y["count"]} for y in years],
        "categories": [{"name": c["name"], "count": c["count"]} for c in cats],
        "tags": [{"name": t["name"], "count": t["count"],
                  "size": _tag_style(t["count"], max_c)[0],
                  "tone": _tag_style(t["count"], max_c)[1]} for t in tag_rows],
        "postsSummary": {
            "total": sum(summary.values()),
            "published": summary.get("published", 0) + summary.get("pinned", 0),
            "draft": summary.get("draft", 0),
            "scheduled": summary.get("scheduled", 0),
        },
    }


def _gauges() -> list[dict]:
    """真实系统指标（Linux /proc）；读取失败时降级为 0。"""
    cpu = mem = 0
    try:
        load1 = float(Path("/proc/loadavg").read_text().split()[0])
        cpu = min(100, round(load1 * 25))  # 4 核经验换算，仅作演示量级
        info = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            k, v = line.split(":", 1)
            info[k.strip()] = int(v.strip().split()[0])
        mem = round((1 - info.get("MemAvailable", 0) / max(info.get("MemTotal", 1), 1)) * 100)
    except Exception:
        pass
    disk = round(shutil.disk_usage("/").used / shutil.disk_usage("/").total * 100)
    def color(p):
        return "success" if p < 60 else ("accent" if p < 80 else "warning")
    return [{"label": "CPU", "percent": cpu, "color": color(cpu)},
            {"label": "内存", "percent": mem, "color": "accent"},
            {"label": "磁盘", "percent": disk, "color": color(disk)}]


@router.get("/dashboard")
def web_dashboard():
    """对应 prototype/data/dashboard.json（看板聚合）"""
    today, yesterday = db.today(), (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    t = db.q1("SELECT pv, uv FROM analytics_daily WHERE date=? AND post_id=''", (today,)) or {"pv": 0, "uv": 0}
    y = db.q1("SELECT pv FROM analytics_daily WHERE date=? AND post_id=''", (yesterday,)) or {"pv": 0}
    delta = round((t["pv"] - y["pv"]) / y["pv"] * 100, 1) if y["pv"] else 0.0
    month = datetime.now().strftime("%Y-%m")
    mer = db.q1("SELECT COALESCE(SUM(mer),0) AS s FROM analytics_daily WHERE date LIKE ?", (month + "-%",))["s"]
    pending_n = db.q1("SELECT COUNT(*) AS c FROM comments WHERE status='pending'")["c"]
    cert = settings.CERT_DAYS

    trend_rows = db.q("""SELECT date, pv FROM analytics_daily WHERE post_id=''
                         ORDER BY date DESC LIMIT 30""")
    trend_rows.reverse()

    top = db.q("""SELECT slug, title, view_count FROM posts
                  WHERE status IN ('published','pinned') ORDER BY view_count DESC LIMIT 5""")
    max_v = max([r["view_count"] for r in top], default=1) or 1

    drafts = db.q1("SELECT COUNT(*) AS c FROM posts WHERE status='draft'")["c"]
    sched = db.q1("SELECT title, scheduled_at FROM posts WHERE status='scheduled' ORDER BY scheduled_at LIMIT 1")

    todos = []
    if cert < 14:
        todos.append({"level": "err", "text": f"证书 {cert} 天后到期，验证自动续期任务", "actionText": "处理", "href": "#"})
    if pending_n:
        todos.append({"level": "warn", "text": f"{pending_n} 条评论等待审核", "actionText": "审核", "href": "comments.html"})
    if sched:
        todos.append({"level": "ok", "text": f"定时发布：{sched['scheduled_at'][5:16]}《{sched['title']}》",
                      "actionText": "查看", "href": "posts.html"})
    if drafts:
        todos.append({"level": "ok", "text": f"草稿箱有 {drafts} 篇未完成文章", "actionText": "继续写", "href": "posts.html"})

    return {
        "pendingComments": pending_n,
        "stats": [
            {"label": "今日 PV / UV", "value": f"{t['pv']:,}", "valueColor": None,
             "subHtml": f"▲ {delta}% vs 昨日 · UV {t['uv']:,}", "subClass": "ok"},
            {"label": "本月有效阅读 MER", "value": f"{mer:,}", "valueColor": None,
             "subHtml": "完读率 28% · 目标 ≥25%", "subClass": "ok"},
            {"label": "待审评论", "value": str(pending_n), "valueColor": None,
             "subHtml": '<a href="comments.html">前往审核 →</a>', "subClass": ""},
            {"label": "证书剩余", "value": f"{cert} 天", "valueColor": "warning" if cert < 14 else None,
             "subHtml": "⚠ 低于 14 天高优告警线，请检查自动续期" if cert < 14 else "自动续期正常",
             "subClass": "danger" if cert < 14 else "ok"},
        ],
        "trend": {
            "title": "访问量趋势", "period": "近 30 天",
            "startLabel": trend_rows[0]["date"][5:] if trend_rows else "",
            "endLabel": trend_rows[-1]["date"][5:] if trend_rows else "",
            "values": [round(r["pv"] / 40) for r in trend_rows],
        },
        "topPosts": {
            "title": "热门文章 Top 5", "period": "近 30 天",
            "items": [{"rank": i + 1, "slug": r["slug"], "title": r["title"],
                       "barWidth": max(20, round(r["view_count"] / max_v * 120)),
                       "num": f"{r['view_count'] / 1000:.1f}k", "hot": i < 3}
                      for i, r in enumerate(top)],
        },
        "system": {
            "gauges": _gauges(),
            "health": [{"label": "应用服务", "level": "ok"},
                       {"label": "数据库", "level": "ok"},
                       {"label": "证书续期", "level": "warn" if cert < 14 else "ok"}],
        },
        "todos": todos,
    }
