"""WangBlog 后端接口测试（进程内运行，使用临时数据库，不会触碰任何真实数据）。

    cd backend
    .venv/bin/python -m pytest tests -q        # 或直接：.venv/bin/python tests/test_api.py
"""
import io
import os
import struct
import sys
import tempfile
import time
import zlib
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="wangblog-test-")
os.environ.update({
    "WB_DB": str(Path(_TMP) / "test.db"), "WB_UPLOAD_DIR": str(Path(_TMP) / "uploads"),
    "WB_PUBLISH_STEP_DELAY": "0.01", "WB_SECRET": "test-secret-0123456789-0123456789-abcdef",
    "WB_DEMO_TOTP": "true", "WB_COMMENT_RATE": "100", "WB_SEARCH_RATE": "1000",
})
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


def png_bytes() -> bytes:
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + b"\xff\x00\x00" * 8 for _ in range(8))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


_client = None


def client() -> TestClient:
    global _client
    if _client is None:
        _client = TestClient(app)
        _client.__enter__()
    return _client


def login() -> dict:
    c = client()
    t = c.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).json()["data"]["ticket"]
    tok = c.post("/api/auth/totp", json={"ticket": t, "code": "123456"}).json()["data"]
    return tok


def H(tok):
    return {"Authorization": "Bearer " + tok["accessToken"]}


# ---------------------------------------------------------------- 前台
def test_health_and_home():
    c = client()
    assert c.get("/api/health").json()["data"]["status"] == "up"
    d = c.get("/api/home").json()["data"]
    assert d["featured"] and d["hot"] and d["stats"]["posts"] > 0


def test_list_filters_and_pagination():
    c = client()
    d = c.get("/api/posts?pageSize=3").json()["data"]
    assert len(d["list"]) == 3 and d["hasMore"]
    assert d["list"][0]["pinned"]  # 置顶优先
    cat = c.get("/api/posts?category=运维").json()["data"]
    assert cat["total"] > 0 and all(p["category"] == "运维" for p in cat["list"])
    tag = c.get("/api/posts?tag=CSS").json()["data"]
    assert all("CSS" in p["tags"] for p in tag["list"])


def test_detail_render_toc_etag():
    c = client()
    r = c.get("/api/posts/http-cache-deep-dive")
    d = r.json()["data"]
    assert "<h2" in d["contentHtml"] and "code-block" in d["contentHtml"] and "data-mermaid" in d["contentHtml"]
    assert d["toc"] and d["toc"][0]["level"] == 2
    assert d["contentHtml"].count("<div") == d["contentHtml"].count("</div>")  # 结构闭合
    assert c.get("/api/posts/http-cache-deep-dive", headers={"If-None-Match": r.headers["etag"]}).status_code == 304
    assert c.get("/api/posts/font-subsetting").status_code == 404  # 定时文章未到点不可见
    assert c.get("/api/posts/structured-data-article").status_code == 404  # 草稿不可见


def test_comments_flow_and_xss():
    c = client()
    tok = login()
    r = c.post("/api/posts/docker-compose-homelab/comments",
               json={"content": "<script>alert(1)</script> **好文**", "nick": "测试"}).json()
    assert r["code"] == 0 and r["data"]["status"] == "pending"
    assert "&lt;script&gt;" in r["data"]["comment"]["html"]
    cid = r["data"]["id"]
    c.post(f"/api/admin/comments/{cid}/approve", headers=H(tok))
    tree = c.get("/api/posts/docker-compose-homelab/comments").json()["data"]
    assert any(x["id"] == cid for x in tree["list"])
    rep = c.post(f"/api/admin/comments/{cid}/reply", headers=H(tok), json={"content": "谢谢"}).json()
    assert rep["code"] == 0
    tree = c.get("/api/posts/docker-compose-homelab/comments").json()["data"]
    root = next(x for x in tree["list"] if x["id"] == cid)
    assert root["replies"] and root["replies"][0]["isAuthor"]
    spam = c.post("/api/posts/docker-compose-homelab/comments", json={"content": "加微信刷单", "nick": "x"}).json()
    assert spam["code"] == 0  # 不暴露风控结果
    q = c.get("/api/admin/comments?status=pending", headers=H(tok)).json()["data"]
    assert any(i["flag"] == "命中关键词" for i in q["list"])


def test_like_toggle():
    c = client()
    a = c.post("/api/posts/nginx-tuning/like").json()["data"]
    b = c.post("/api/posts/nginx-tuning/like").json()["data"]
    assert a["liked"] and not b["liked"] and b["likes"] == a["likes"] - 1


def test_search_archive_taxonomy():
    c = client()
    s = c.get("/api/search?q=缓存").json()["data"]
    assert s["total"] > 0 and "<mark>" in s["list"][0]["titleHtml"] + s["list"][0]["snippetHtml"]
    assert c.get("/api/search?q=").json()["code"] == 40001
    a = c.get("/api/archive").json()["data"]
    assert a["groups"] and a["total"] == sum(g["count"] for g in a["groups"])
    t = c.get("/api/taxonomy").json()["data"]
    assert t["categories"] and t["tags"] and t["years"]


def test_feeds_and_spa():
    c = client()
    assert "<rss" in c.get("/rss.xml").text
    assert "<urlset" in c.get("/sitemap.xml").text
    page = c.get("/post/http-cache-deep-dive").text
    assert "深入 HTTP 缓存" in page and "application/ld+json" in page
    assert c.get("/post/not-exists").status_code == 404
    assert c.get("/admin/posts").status_code == 200


# ---------------------------------------------------------------- 认证
def test_auth_errors_and_refresh_rotation():
    c = client()
    assert c.post("/api/auth/login", json={"username": "admin", "password": "bad"}).json()["code"] == 40103
    assert c.get("/api/admin/dashboard").json()["code"] == 40101
    tok = login()
    r1 = c.post("/api/auth/refresh", json={"refreshToken": tok["refreshToken"]}).json()
    assert r1["code"] == 0
    assert c.post("/api/auth/refresh", json={"refreshToken": tok["refreshToken"]}).json()["code"] == 40101  # 旧令牌失效


# ---------------------------------------------------------------- 后台写作闭环
def test_editor_publish_cycle():
    c = client()
    h = H(login())
    pid = c.post("/api/admin/posts", headers=h, json={"title": "Hello World 测试"}).json()["data"]["id"]
    md = "## 小节一\n\n正文 **加粗** 与 $E=mc^2$\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] 完成\n"
    r = c.put(f"/api/admin/posts/{pid}/draft", headers=h,
              json={"contentMd": md, "tags": ["测试", "新标签"], "category": "前端", "slug": "hello-world-test"}).json()
    assert r["code"] == 0 and r["data"]["slug"] == "hello-world-test"
    rev = r["data"]["updatedAt"]
    # 乐观锁：用过期版本覆盖正文 → 40902
    time.sleep(1.1)
    c.put(f"/api/admin/posts/{pid}/draft", headers=h, json={"contentMd": md + "\n更新", "baseUpdatedAt": rev})
    assert c.put(f"/api/admin/posts/{pid}/draft", headers=h,
                 json={"contentMd": md + "\n冲突", "baseUpdatedAt": rev}).json()["code"] == 40902
    tid = c.post(f"/api/admin/posts/{pid}/publish", headers=h, json={"mode": "now"}).json()["data"]["taskId"]
    for _ in range(50):
        t = c.get(f"/api/admin/tasks/{tid}", headers=h).json()["data"]
        if t["status"] != "running":
            break
        time.sleep(0.05)
    assert t["status"] == "done", t
    d = c.get("/api/posts/hello-world-test").json()["data"]
    assert "math-inline" in d["contentHtml"] and "table-wrap" in d["contentHtml"] and d["category"] == "前端"
    assert c.get("/api/admin/posts/" + pid + "/versions", headers=h).json()["data"]["list"]
    # 撤回 / 回收站 / 恢复 / 彻底删除
    assert c.post(f"/api/admin/posts/{pid}/unpublish", headers=h).json()["data"]["status"] == "draft"
    assert c.get("/api/posts/hello-world-test").status_code == 404
    c.delete(f"/api/admin/posts/{pid}", headers=h)
    assert c.get("/api/admin/posts?status=trashed", headers=h).json()["data"]["total"] >= 1
    c.post(f"/api/admin/posts/{pid}/restore", headers=h)
    c.delete(f"/api/admin/posts/{pid}", headers=h)
    assert c.delete(f"/api/admin/posts/{pid}?purge=true", headers=h).json()["data"]["status"] == "purged"


def test_schedule_validation():
    c = client()
    h = H(login())
    pid = c.post("/api/admin/posts", headers=h, json={"title": "定时测试"}).json()["data"]["id"]
    assert c.post(f"/api/admin/posts/{pid}/publish", headers=h,
                  json={"mode": "schedule", "scheduledAt": "2000-01-01T00:00"}).json()["code"] == 40001


def test_upload_rules():
    c = client()
    h = H(login())
    ok = c.post("/api/admin/uploads", headers=h, files=[("files", ("a.png", io.BytesIO(png_bytes()), "image/png"))]).json()
    assert ok["code"] == 0 and ok["data"]["items"][0]["url"].startswith("/uploads/")
    assert c.get(ok["data"]["items"][0]["url"]).status_code == 200
    svg = c.post("/api/admin/uploads", headers=h, files=[("files", ("x.svg", io.BytesIO(b"<svg onload=alert(1)>"), "image/svg+xml"))]).json()
    assert svg["code"] == 41501
    fake = c.post("/api/admin/uploads", headers=h, files=[("files", ("x.png", io.BytesIO(b"not an image"), "image/png"))]).json()
    assert fake["code"] == 41501


def test_taxonomy_and_site_admin():
    c = client()
    h = H(login())
    r = c.post("/api/admin/categories", headers=h, json={"name": "测试分类", "description": "d"}).json()
    assert r["code"] == 0
    tags = c.get("/api/admin/taxonomy", headers=h).json()["data"]["tags"]
    assert tags
    site = c.get("/api/admin/site", headers=h).json()["data"]
    site["site"]["slogan"] = "新标语"
    assert c.put("/api/admin/site", headers=h, json=site).json()["code"] == 0
    assert c.get("/api/site/config").json()["data"]["site"]["slogan"] == "新标语"
    dash = c.get("/api/admin/dashboard", headers=h).json()["data"]
    assert len(dash["trend"]) == 30 and dash["posts"]["published"] > 0


def test_site_settings_sync_home_contacts_and_rss():
    import copy
    import xml.etree.ElementTree as ET

    c, h = client(), H(login())
    original = c.get("/api/admin/site", headers=h).json()["data"]
    body = copy.deepcopy(original)
    host = {"Host": "lawrencewang.xyz"}
    c.get("/rss.xml", headers=host)  # Prime cache: saving must invalidate this response.
    body["site"].update(name="笔记 & 思考 <测试>", description="新的 RSS 与首页简介 & 链接")
    body["home"].update(titleLines=["新的首页标题", "保持 <文字>"], desc="首页介绍 & 日常", typing=["写作", "技术"])
    body["about"]["author"].update(github="https://github.com/example?tab=repositories&view=all", email="writer@example.com")
    body["rss"] = {"language": "en-US", "itemLimit": 1, "fullContent": False}
    try:
        assert c.put("/api/admin/site", headers=h, json=body).json()["code"] == 0
        public = c.get("/api/site/config").json()["data"]
        assert public["home"] == body["home"]
        github = [link for link in public["about"]["author"]["links"] if link["label"] == "GitHub"]
        assert github == [{"label": "GitHub", "href": body["about"]["author"]["github"]}]
        assert public["about"]["author"]["email"] == "writer@example.com"
        channel = ET.fromstring(c.get("/rss.xml", headers=host).content).find("channel")
        assert channel.findtext("title") == body["site"]["name"]
        assert channel.findtext("description") == body["site"]["description"]
        assert channel.findtext("language") == "en-US"
        assert "writer@example.com" in channel.findtext("managingEditor")
        related = channel.find("{http://www.w3.org/2005/Atom}link[@rel='related']")
        assert related.attrib["href"] == body["about"]["author"]["github"]
        assert channel.find("{urn:wangblog:site}homepage/{urn:wangblog:site}title").text == "\n".join(body["home"]["titleLines"])
        assert len(channel.findall("item")) == 1
        assert channel.find("item/{http://purl.org/rss/1.0/modules/content/}encoded") is None
        assert "笔记 &amp; 思考 &lt;测试&gt;" in c.get("/", headers=host).text
    finally:
        assert c.put("/api/admin/site", headers=h, json=original).json()["code"] == 0


def test_rss_legacy_links_full_text_and_contact_removal():
    import copy
    import xml.etree.ElementTree as ET

    c, h = client(), H(login())
    original = c.get("/api/admin/site", headers=h).json()["data"]
    body = copy.deepcopy(original)
    author = body["about"]["author"]
    author.pop("github", None)
    author["links"] = [{"label": "GitHub", "href": "https://github.com/legacy"}, {"label": "RSS", "href": "/rss.xml"}]
    body["rss"] = {"language": "zh-CN", "itemLimit": 2, "fullContent": True}
    try:
        assert c.put("/api/admin/site", headers=h, json=body).json()["code"] == 0
        feed = ET.fromstring(c.get("/feed").content)
        related = feed.find("channel/{http://www.w3.org/2005/Atom}link[@rel='related']")
        assert related.attrib["href"] == "https://github.com/legacy"
        assert feed.find("channel/item/{http://purl.org/rss/1.0/modules/content/}encoded") is not None
        author.update(github="", email="")
        assert c.put("/api/admin/site", headers=h, json=body).json()["code"] == 0
        public = c.get("/api/site/config").json()["data"]
        assert public["about"]["author"]["links"] == [{"label": "RSS", "href": "/rss.xml"}]
        channel = ET.fromstring(c.get("/rss.xml").content).find("channel")
        assert channel.find("managingEditor") is None
        assert channel.find("{http://www.w3.org/2005/Atom}link[@rel='related']") is None
    finally:
        assert c.put("/api/admin/site", headers=h, json=original).json()["code"] == 0


def test_invalid_feed_and_contact_settings_do_not_write():
    import copy

    c, h = client(), H(login())
    original = c.get("/api/admin/site", headers=h).json()["data"]
    invalid = [("rss", "itemLimit", 0), ("rss", "itemLimit", 101), ("rss", "itemLimit", True),
               ("rss", "language", "<invalid>"), ("rss", "fullContent", "false"),
               ("author", "github", "javascript:alert(1)"), ("author", "email", "bad\naddress@example.com")]
    for section, key, value in invalid:
        body = copy.deepcopy(original)
        target = body.setdefault("rss", {}) if section == "rss" else body["about"]["author"]
        target[key] = value
        body["about"]["friendLinks"] = []
        response = c.put("/api/admin/site", headers=h, json=body)
        assert response.status_code == 400 and response.json()["code"] == 40001
        assert c.get("/api/admin/site", headers=h).json()["data"] == original
    assert c.put("/api/admin/site", json=original).status_code == 401


if __name__ == "__main__":
    tests = [(n, f) for n, f in globals().items() if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  [PASS] {name}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  [FAIL] {name}: {e!r}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
