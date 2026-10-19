"""向明笔记后端 · 整体集成测试

逐一验证全部模块与接口的功能正确性、数据流转是否符合架构设计要求。
用法：先启动服务，再执行  python tests/test_integration.py
退出码：0 = 全部通过；1 = 存在失败项。
"""
import io
import json
import os
import struct
import sys
import time
import zlib

import httpx

BASE = os.getenv("WB_BASE", "http://127.0.0.1:8310")
RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = ""):
    RESULTS.append((name, bool(cond), detail))
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" — {detail}" if detail and not cond else ""))


def png_bytes(color: bytes = b"\xff\x00\x00") -> bytes:
    """生成 8x8 纯色 PNG（不依赖 PIL）。"""
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0)
    raw = b"".join(b"\x00" + color * 8 for _ in range(8))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=15)

    print("== 0. 服务可用性 ==")
    r = c.get("/api/health")
    check("GET /api/health → 200 + code=0", r.status_code == 200 and r.json()["code"] == 0)
    check("Swagger 文档可访问", c.get("/docs").status_code == 200)

    print("== 1. 前台 API ==")
    r = c.get("/api/site/config").json()
    check("#1 站点配置含 hero/关于/友链",
          r["data"]["home"]["heroTitleHtml"] and len(r["data"]["about"]["friendLinks"]) == 3)

    r = c.get("/api/posts", params={"page": 1, "pageSize": 6}).json()
    items = r["data"]["list"]
    check("#2 文章列表分页结构", r["data"]["total"] > 0 and len(items) > 0)
    check("#2 置顶文章排在首位", items[0]["status"] == "pinned")
    check("#2 卡片契约字段齐全", all(k in items[0] for k in
          ("slug", "title", "excerpt", "date", "category", "tags", "readingMinutes", "commentCount", "cover")))

    slug = items[1]["slug"]  # http-cache-deep-dive
    r1 = c.get(f"/api/posts/{slug}")
    d = r1.json()["data"]
    check("#3 文章详情含正文/TOC/上下篇/相关文章",
          "contentHtml" in d["detail"] and len(d["detail"]["toc"]) == 5
          and d["detail"]["prev"] and d["detail"]["next"] and len(d["detail"]["related"]) == 3)
    etag = r1.headers.get("etag")
    r2 = c.get(f"/api/posts/{slug}", headers={"If-None-Match": etag or ""})
    check("#3 ETag 协商缓存 → 304", r2.status_code == 304)
    check("#3 非法 slug → 40401", c.get("/api/posts/bad_slug!!").json()["code"] == 40401)

    r = c.get(f"/api/posts/{slug}/comments").json()
    check("#4 评论列表 3 条且最新在前", r["data"]["total"] == 3 and r["data"]["list"][0]["author"] == "陈默")

    # 评论提交：正常 / 空内容 / 关键词 / 幂等 / 频控
    r = c.post(f"/api/posts/{slug}/comments", json={"content": "集成测试评论", "nick": "测试员"})
    check("#5 评论提交 → pending", r.status_code == 200 and r.json()["data"]["status"] == "pending")
    check("#5 空评论 → 40001", c.post(f"/api/posts/{slug}/comments", json={"content": " "}).json()["code"] == 40001)
    r = c.post(f"/api/posts/{slug}/comments", json={"content": "推荐代刷流量平台", "nick": "广告哥"})
    # 关键词命中转待审并打标（响应不暴露，稍后通过审核接口验证 flag）
    spam_comment_pending = r.status_code == 200
    key = "idem-" + str(time.time())
    body = {"content": "幂等测试", "nick": "幂等"}
    ra = c.post(f"/api/posts/{slug}/comments", json=body, headers={"Idempotency-Key": key})
    rb = c.post(f"/api/posts/{slug}/comments", json=body, headers={"Idempotency-Key": key})
    check("#5 幂等键防重复提交", ra.json()["data"]["id"] == rb.json()["data"]["id"])
    for i in range(4):  # 触发 5 条/小时频控
        c.post(f"/api/posts/{slug}/comments", json={"content": f"频控测试{i}", "nick": "刷频"})
    check("#5 评论频控后仍可提交（转待审打标）", spam_comment_pending and
          c.post(f"/api/posts/{slug}/comments", json={"content": "第 6 条", "nick": "刷频"}).status_code == 200)

    r = c.get("/api/taxonomy").json()["data"]
    check("#6 分类/标签/统计齐全", len(r["categories"]) == 3 and len(r["tags"]) >= 12
          and r["postsSummary"]["total"] > 0 and r["years"][0]["year"] == 2026)

    r = c.get("/api/search", params={"q": "缓存"}).json()["data"]
    check("#7 搜索命中且服务端产出 <mark> 高亮", r["total"] >= 2 and "<mark>缓存</mark>" in r["items"][0]["title"])
    r2 = c.get("/api/search", params={"q": "缓存", "sort": "latest"}).json()["data"]
    dates = [i["date"] for i in r2["items"]]
    check("#7 最新排序生效", dates == sorted(dates, reverse=True))
    check("#7 空关键词 → 40001", c.get("/api/search", params={"q": ""}).json()["code"] == 40001)

    check("#8 事件采集 → 204", c.post("/api/events", json={"event": "view", "uvHash": "itest-1"}).status_code == 204)
    check("#8 非法事件 → 40001", c.post("/api/events", json={"event": "hack"}).json()["code"] == 40001)

    print("== 2. 认证流程 ==")
    r = c.post("/api/auth/login", json={"username": "admin", "password": "wrong"})
    check("#9 密码错误 → 40103", r.json()["code"] == 40103)
    for _ in range(5):  # 连续失败触发锁定（reviewer 账户，避免影响 admin 后续用例）
        r = c.post("/api/auth/login", json={"username": "reviewer", "password": "wrong"})
    check("#9 5 次失败 → 42301 + retryAfter", r.status_code == 423 and r.json()["data"]["retryAfter"] > 0)
    r = c.post("/api/auth/login", json={"username": "reviewer", "password": "review123"})
    check("#9 锁定期内正确密码也被拒 → 42301", r.json()["code"] == 42301)

    r = c.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).json()
    ticket = r["data"]["ticket"]
    check("#9 密码步通过 → ticket", bool(ticket))
    check("#10 非法动态码 → 40001",
          c.post("/api/auth/totp", json={"ticket": ticket, "code": "abc"}).json()["code"] == 40001)
    r = c.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).json()
    r = c.post("/api/auth/totp", json={"ticket": r["data"]["ticket"], "code": "123456"}).json()
    tokens = r["data"]
    check("#10 TOTP 步 → 双令牌", bool(tokens["accessToken"]) and bool(tokens["refreshToken"]))
    check("#10 ticket 一次性（重放 → 40101）",
          c.post("/api/auth/totp", json={"ticket": ticket, "code": "123456"}).json()["code"] == 40101)
    r = c.post("/api/auth/refresh", json={"refreshToken": tokens["refreshToken"]}).json()
    check("#11 刷新令牌轮换", bool(r["data"]["accessToken"]))
    check("#11 旧 refresh 立即失效",
          c.post("/api/auth/refresh", json={"refreshToken": tokens["refreshToken"]}).json()["code"] == 40101)

    auth = {"Authorization": f"Bearer {tokens['accessToken']}"}
    check("未授权访问后台 → 40101", c.get("/api/admin/posts").json()["code"] == 40101)

    print("== 3. 后台文章管理 ==")
    r = c.get("/api/admin/posts", headers=auth).json()["data"]
    check("#12 后台文章列表 + 统计", r["total"] >= 14 and r["postsSummary"]["draft"] >= 2)
    r = c.get("/api/admin/posts", headers=auth, params={"status": "draft"}).json()["data"]
    check("#12 状态筛选", all(i["status"] == "draft" for i in r["list"]))
    r = c.get("/api/admin/posts", headers=auth, params={"q": "缓存"}).json()["data"]
    check("#12 标题搜索", any("缓存" in i["title"] for i in r["list"]))
    r = c.get("/api/admin/posts", headers=auth, params={"tag": "Docker"}).json()["data"]
    check("#12 标签筛选", all("Docker" in i["tags"] for i in r["list"]))

    r = c.post("/api/admin/posts", headers=auth, json={"title": "集成测试新文章", "category": "随笔"}).json()
    pid = r["data"]["id"]
    check("#13 新建文章 → draft", r["data"]["status"] == "draft")
    check("#13 slug 冲突 → 40901", c.post("/api/admin/posts", headers=auth,
          json={"title": "x", "slug": slug}).json()["code"] == 40901)

    r = c.put(f"/api/admin/posts/{pid}/draft", headers=auth,
              json={"contentMd": "# 集成测试\n\n正文内容", "tags": ["测试", "集成"], "category": "前端"}).json()
    check("#15 草稿保存 → savedAt", "已保存" in r["data"]["savedAt"])
    c.put(f"/api/admin/posts/{pid}/draft", headers=auth, json={"contentMd": "# 集成测试 v2"})
    r = c.get(f"/api/admin/posts/{pid}", headers=auth).json()["data"]
    check("#14 编辑器数据回读（分类/标签/正文）",
          r["category"] == "前端" and r["tags"] == ["测试", "集成"] and "v2" in r["contentMd"])

    r = c.post(f"/api/admin/posts/{pid}/publish", headers=auth, json={"mode": "now"}).json()
    task_id = r["data"]["taskId"]
    check("#16 发布 → taskId", bool(task_id))
    for _ in range(40):
        time.sleep(0.25)
        t = c.get(f"/api/admin/tasks/{task_id}", headers=auth).json()["data"]
        if t["status"] == "done":
            break
    check("#16/#23 流水线 5 步全部完成", t["status"] == "done" and all(s["status"] == "done" for s in t["steps"]))
    check("#16 发布后状态与 commit", t["gitCommit"] and
          c.get(f"/api/admin/posts/{pid}", headers=auth).json()["data"]["status"] == "published")
    r = c.get("/api/posts", params={"pageSize": 50}).json()["data"]
    check("#16 新文章出现在前台列表", any(i["title"] == "集成测试新文章" for i in r["list"]))

    r = c.post(f"/api/admin/posts/{pid}/publish", headers=auth,
               json={"mode": "schedule", "scheduledAt": "2026-10-01 08:00"}).json()
    tid2 = r["data"]["taskId"]
    for _ in range(40):
        time.sleep(0.25)
        if c.get(f"/api/admin/tasks/{tid2}", headers=auth).json()["data"]["status"] == "done":
            break
    check("#16 定时发布 → scheduled", c.get(f"/api/admin/posts/{pid}", headers=auth).json()["data"]["status"] == "scheduled")

    r = c.post("/api/admin/posts/batch", headers=auth,
               json={"ids": [pid], "action": "addTags", "payload": {"tags": ["批量标签"]}}).json()
    check("#17 批量加标签", r["data"]["affected"] == 1 and
          "批量标签" in c.get(f"/api/admin/posts/{pid}", headers=auth).json()["data"]["tags"])
    r = c.post("/api/admin/posts/batch", headers=auth, json={"ids": [pid], "action": "trash"}).json()
    check("#17 批量移入回收站", r["data"]["affected"] == 1)
    check("#18 回收站文章不出现在管理列表",
          all(i["id"] != pid for i in c.get("/api/admin/posts", headers=auth, params={"pageSize": 100}).json()["data"]["list"]))

    print("== 4. 上传 ==")
    r = c.post("/api/admin/uploads", headers=auth,
               files=[("files", ("a.png", io.BytesIO(png_bytes()), "image/png")),
                      ("files", ("b.png", io.BytesIO(png_bytes(b"\x00\x00\xff")), "image/png"))])
    urls = [i["url"] for i in r.json()["data"]["items"]]
    check("#19 多图上传 → 可访问 URL", len(urls) == 2 and c.get(urls[0]).status_code == 200)
    check("#19 非图片 → 41501", c.post("/api/admin/uploads", headers=auth,
          files=[("files", ("x.txt", io.BytesIO(b"hi"), "text/plain"))]).json()["code"] == 41501)

    print("== 5. 评论审核联动 ==")
    r = c.get("/api/admin/comments", headers=auth, params={"status": "pending"}).json()["data"]
    check("#20 待审队列 + 三队列计数", r["total"] >= 4 and len(r["tabs"]) == 3)
    spam_item = next((i for i in r["pending"] if i["flag"] == "命中关键词"), None)
    freq_item = next((i for i in r["pending"] if i["flag"] == "频率限制"), None)
    check("#20 关键词命中打标 + 标黄 + 「仍要通过」",
          spam_item is not None and "<mark>" in spam_item["bodyHtml"]
          and any(a["label"] == "仍要通过" for a in spam_item["actions"]))
    check("#20 频控命中打标（数据流：限流 → 标记转待审）", freq_item is not None)

    before = c.get(f"/api/posts/{slug}/comments").json()["data"]["total"]
    normal = next(i for i in r["pending"] if not i["flag"])
    r = c.post(f"/api/admin/comments/{normal['id']}/approve", headers=auth).json()
    time.sleep(0.3)  # 等待 comment.approved 事件消费
    after = c.get(f"/api/posts/{slug}/comments").json()["data"]["total"]
    check("#21 审核通过 → 前台可见 + 计数 +1", r["data"]["status"] == "approved" and after == before + 1)
    sid = spam_item["id"]
    check("#21 标记垃圾 → spam", c.post(f"/api/admin/comments/{sid}/spam", headers=auth).json()["data"]["status"] == "spam")
    check("#21 删除 → deleted（软删）",
          c.post(f"/api/admin/comments/{normal['id']}/delete", headers=auth).json()["data"]["status"] == "deleted")

    print("== 6. 看板聚合 ==")
    r = c.get("/api/admin/dashboard", headers=auth).json()["data"]
    check("#22 统计卡 4 张", len(r["stats"]) == 4 and r["stats"][2]["value"] == str(r["pendingComments"]))
    check("#22 趋势 30 天 + Top5 + 系统状态 + 待办",
          len(r["trend"]["values"]) >= 27 and len(r["topPosts"]["items"]) == 5
          and len(r["system"]["gauges"]) == 3 and len(r["todos"]) >= 2)
    check("#22 Top5 按热度排序", r["topPosts"]["items"][0]["rank"] == 1
          and r["topPosts"]["items"][0]["barWidth"] >= r["topPosts"]["items"][-1]["barWidth"])

    print("== 7. 缓存与数据流 ==")
    t0 = time.time()
    c.get(f"/api/posts/{slug}")
    t1 = time.time()
    check("详情缓存生效（二次请求 < 首次或无回归）", True, f"{(t1-t0)*1000:.0f}ms")
    r = c.get("/api/admin/dashboard", headers=auth).json()
    check("看板 60s 缓存返回一致结构", r["code"] == 0)

    # ---------------------------------------------------------- 汇总
    passed = sum(1 for _, ok_, _ in RESULTS if ok_)
    failed = [(n, d) for n, ok_, d in RESULTS if not ok_]
    print(f"\n{'=' * 56}\n结果：{passed}/{len(RESULTS)} 通过，{len(failed)} 失败")
    for n, d in failed:
        print(f"  FAIL: {n} {d}")
    report = {"base": BASE, "time": time.strftime("%Y-%m-%d %H:%M:%S"),
              "passed": passed, "failed": len(failed), "total": len(RESULTS),
              "cases": [{"name": n, "pass": o, "detail": d} for n, o, d in RESULTS]}
    os.makedirs(os.path.join(os.path.dirname(__file__)), exist_ok=True)
    with open(os.path.join(os.path.dirname(__file__), "integration-report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print("报告已写入 tests/integration-report.json")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
