#!/usr/bin/env python3
"""端到端验证：发布 → 前台可见 → 删除 → 前台消失 完整闭环。"""
import json
import time

import httpx

B = "http://127.0.0.1:8310"
c = httpx.Client(base_url=B, timeout=15)
passed, failed = [], []


def check(name, cond, extra=""):
    (passed if cond else failed).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f" | {extra}" if extra else ""))


# 1. 登录
r = c.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).json()
ticket = r["data"]["ticket"]
r = c.post("/api/auth/totp", json={"ticket": ticket, "code": "123456"}).json()
token = r["data"]["accessToken"]
H = {"Authorization": "Bearer " + token}
check("登录获取 JWT", bool(token))

# 2. 创建文章
r = c.post("/api/admin/posts", json={"title": "端到端验证专用文章", "slug": "e2e-verify-post", "category": "运维"}, headers=H).json()
pid = r["data"]["id"]
check("创建文章（草稿）", r["code"] == 0 and r["data"]["status"] == "draft", f"id={pid[:8]}")

# 3. 保存草稿（含正文/标签/摘要）
md = "# 端到端验证\n\n这是验证发布流程的正文。\n\n## 第二节\n\n**加粗** 与 `代码`。"
r = c.put(f"/api/admin/posts/{pid}/draft", json={
    "title": "端到端验证专用文章", "contentMd": md, "category": "运维",
    "tags": ["Docker", "验证"], "excerpt": "验证发布闭环的摘要"}, headers=H).json()
check("保存草稿", r["code"] == 0, r["data"].get("savedAt", ""))

# 4. 发布前：前台不可见
web = c.get("/api/web/posts").json()["posts"]
check("发布前前台不可见", all(p["slug"] != "e2e-verify-post" or p["status"] == "draft" for p in web))
published = [p for p in web if p["status"] in ("published", "pinned")]
check("发布前不在已发布列表", all(p["slug"] != "e2e-verify-post" for p in published))

# 5. 发布 + 轮询任务
r = c.post(f"/api/admin/posts/{pid}/publish", json={"mode": "now"}, headers=H).json()
task_id = r["data"]["taskId"]
check("创建发布任务", r["code"] == 0, task_id[:8])
for _ in range(30):
    t = c.get(f"/api/admin/tasks/{task_id}", headers=H).json()["data"]
    if t["status"] == "done":
        break
    time.sleep(0.4)
check("发布流水线完成", t["status"] == "done", f"commit={t.get('gitCommit')}")

# 6. 发布后：前台可见且数据完整
web = c.get("/api/web/posts").json()["posts"]
p = next((x for x in web if x["slug"] == "e2e-verify-post"), None)
check("发布后前台可见", p is not None and p["status"] == "published")
check("前台文章带 id", bool(p and p.get("id")))
check("正文 markdown 同步到 editor", p and "端到端验证" in p["editor"]["markdown"])
check("标签与分类正确", p and p["tags"] == ["Docker", "验证"] and p["category"] == "运维", str(p and p["tags"]))
check("日期为发布日", p and p["date"] == time.strftime("%Y-%m-%d"))

# 7. 删除（移入回收站）
r = c.delete(f"/api/admin/posts/{pid}", headers=H).json()
check("删除接口", r["code"] == 0 and r["data"]["status"] == "trashed")

# 8. 删除后：前台消失
web = c.get("/api/web/posts").json()["posts"]
check("删除后前台消失", all(p["slug"] != "e2e-verify-post" for p in web))
tax = c.get("/api/web/taxonomy").json()
check("回收站不计入统计", tax["postsSummary"]["total"] == 16, f"total={tax['postsSummary']['total']}")

# 9. 后台列表不含回收站文章
r = c.get("/api/admin/posts", headers=H).json()
check("后台列表不含回收站", all(x["slug"] != "e2e-verify-post" for x in r["data"]["list"]))

print(f"\n===== {len(passed)} passed, {len(failed)} failed =====")
raise SystemExit(1 if failed else 0)
