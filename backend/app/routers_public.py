"""前台 API（无需鉴权）——架构文档 §5.2 #1-#8。

数据契约与 prototype/assets/js/api.js 的 WBApi 方法一一对应：
  siteConfig  → GET /api/site/config
  posts       → GET /api/posts           post → GET /api/posts/:slug
  taxonomy    → GET /api/taxonomy        postComments → GET /api/posts/:slug/comments
  搜索        → GET /api/search          事件 → POST /api/events
"""
import re

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel

from . import db
from .config import settings
from .deps import check_idempotency, client_ip, store_idempotency
from .helpers import (ERR_NOT_FOUND, ERR_PARAM, ERR_RATE_LIMITED, ApiError, highlight, loads,
                      make_etag, make_snippet, ok, page_result, paginate, post_card, post_tags_map,
                      raise_err, strip_md)
from .services import (POST_TTL, SEARCH_TTL, TAXONOMY_TTL, cache, detect_spam_flag,
                       publish_event, rate_limiter)

router = APIRouter(prefix="/api", tags=["前台"])

PUBLIC_STATUS = ("published", "pinned")


def _tags_of(rows: list[dict]) -> dict[str, list[str]]:
    return post_tags_map([r["id"] for r in rows])


# ---------------------------------------------------------------- #1 站点配置
@router.get("/site/config")
def site_config():
    cached = cache.get("site:config")
    if cached:
        return ok(cached)
    row = db.q1("SELECT value FROM site_config WHERE key='site'")
    data = loads(row["value"]) if row else {}
    links = db.q("SELECT name,url,description FROM friend_links WHERE is_active=1 ORDER BY sort")
    if links:
        data.setdefault("about", {})["friendLinks"] = [
            {"name": l["name"], "href": l["url"], "desc": l["description"]} for l in links]
    cache.set("site:config", data, TAXONOMY_TTL)
    return ok(data)


# ---------------------------------------------------------------- #2 文章列表（置顶优先）
@router.get("/posts")
def list_posts(page: int = 1, pageSize: int = 6):
    page, size = paginate(page, pageSize)
    placeholders = ",".join("?" * len(PUBLIC_STATUS))
    base = f"""FROM posts p LEFT JOIN categories c ON c.id=p.category_id
               WHERE p.status IN ({placeholders})"""
    total = db.q1(f"SELECT COUNT(*) AS c {base}", PUBLIC_STATUS)["c"]
    rows = db.q(f"""SELECT p.*, c.name AS category_name {base}
                    ORDER BY CASE p.status WHEN 'pinned' THEN 0 ELSE 1 END, p.published_at DESC
                    LIMIT ? OFFSET ?""", (*PUBLIC_STATUS, size, (page - 1) * size))
    tags_map = _tags_of(rows)
    return ok(page_result([post_card(r, tags_map.get(r["id"], [])) for r in rows], total, page, size))


# ---------------------------------------------------------------- #3 文章详情（ETag 协商缓存）
@router.get("/posts/{slug}")
def post_detail(slug: str, request: Request, response: Response):
    if not re.fullmatch(r"[a-z0-9\-]{1,128}", slug):  # 防穿透：slug 格式校验（§6.1）
        raise_err(ERR_NOT_FOUND, "文章不存在")
    row = db.q1("""SELECT p.*, c.name AS category_name FROM posts p
                   LEFT JOIN categories c ON c.id=p.category_id WHERE p.slug=?""", (slug,))
    if not row or row["status"] not in PUBLIC_STATUS + ("scheduled",):
        raise_err(ERR_NOT_FOUND, "文章不存在")

    etag = make_etag(row["slug"], row["updated_at"], row["comment_count"])
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304)
    response.headers["ETag"] = etag

    cached = cache.get(f"post:{slug}")
    if cached:
        return ok(cached)

    detail = loads(row.get("detail"))
    # 上一篇 / 下一篇（按发布时间动态计算）
    prev_post = db.q1("""SELECT slug,title FROM posts WHERE status IN ('published','pinned')
                         AND published_at < ? ORDER BY published_at DESC LIMIT 1""", (row["published_at"],))
    next_post = db.q1("""SELECT slug,title FROM posts WHERE status IN ('published','pinned')
                         AND published_at > ? ORDER BY published_at ASC LIMIT 1""", (row["published_at"],))
    # 相关文章：同分类按热度取 3（不足则全站热度补齐）
    related = db.q("""SELECT p.slug,p.title,p.reading_minutes,c.name AS category_name FROM posts p
                      LEFT JOIN categories c ON c.id=p.category_id
                      WHERE p.status IN ('published','pinned') AND p.id != ?
                      ORDER BY CASE WHEN p.category_id IS ? THEN 0 ELSE 1 END, p.view_count DESC LIMIT 3""",
                   (row["id"], row["category_id"]))
    content_html = detail.get("contentHtml") or f"<p>{(row.get('excerpt') or '').strip()}</p>"
    data = post_card(row, post_tags_map([row["id"]]).get(row["id"], []))
    data["detail"] = {
        "description": detail.get("description") or (row.get("excerpt") or "")[:120],
        "breadcrumbCategory": row.get("category_name") or "",
        "breadcrumbShort": row["title"].split("：")[0],
        "toc": detail.get("toc", []),
        "contentHtml": content_html,
        "prev": prev_post and {"slug": prev_post["slug"], "title": prev_post["title"]},
        "next": next_post and {"slug": next_post["slug"], "title": next_post["title"]},
        "related": [{"slug": r["slug"], "title": r["title"],
                     "meta": f"{r['category_name'] or ''} · {r['reading_minutes']} 分钟"} for r in related],
    }
    cache.set(f"post:{slug}", data, POST_TTL)
    return ok(data)


# ---------------------------------------------------------------- #4 文章评论列表
@router.get("/posts/{slug}/comments")
def post_comments(slug: str, page: int = 1, pageSize: int = 50):
    post = db.q1("SELECT id FROM posts WHERE slug=?", (slug,))
    if not post:
        raise_err(ERR_NOT_FOUND, "文章不存在")
    page, size = paginate(page, pageSize)
    rows = db.q("""SELECT * FROM comments WHERE post_id=? AND status='approved'
                   ORDER BY created_at DESC LIMIT ? OFFSET ?""", (post["id"], size, (page - 1) * size))
    total = db.q1("SELECT COUNT(*) AS c FROM comments WHERE post_id=? AND status='approved'", (post["id"],))["c"]
    items = [{"author": c["author_name"], "avatarText": c["author_name"][:1].upper(),
              "time": c["created_at"], "body": c["content"], "isAuthor": bool(c["is_author"])} for c in rows]
    return ok(page_result(items, total, page, size))


# ---------------------------------------------------------------- #5 提交评论（先审后发）
class CommentIn(BaseModel):
    content: str
    nick: str = "游客"
    email: str | None = None
    parentId: str | None = None


@router.post("/posts/{slug}/comments", status_code=200)
async def submit_comment(slug: str, body: CommentIn, request: Request):
    idem = check_idempotency(request.headers.get("idempotency-key"))
    if idem is not None:
        return ok(idem)
    post = db.q1("SELECT id FROM posts WHERE slug=? AND status IN ('published','pinned')", (slug,))
    if not post:
        raise_err(ERR_NOT_FOUND, "文章不存在")
    content = (body.content or "").strip()
    if not content:
        raise_err(ERR_PARAM, "评论内容不能为空", {"field": "content"})
    if len(content) > 2000:
        raise_err(ERR_PARAM, "评论内容过长", {"field": "content"})

    ip = client_ip(request)
    # 频控：超限不拒绝，标记「频率限制」转待审（架构文档 §6.3）
    flag = None
    if not rate_limiter.hit(f"comment:{ip}", settings.COMMENT_RATE_PER_HOUR, 3600):
        flag = "频率限制"
    flag = flag or detect_spam_flag(content)

    cid = db.uid()
    db.exec_("""INSERT INTO comments(id,post_id,parent_id,author_name,author_email,author_ip,content,status,flag,created_at)
                VALUES(?,?,?,?,?,?,?,'pending',?,?)""",
             (cid, post["id"], body.parentId, (body.nick or "游客")[:32], body.email, ip, content, flag, db.now()))
    await publish_event("comment.submitted", {"commentId": cid, "postId": post["id"]})
    data = {"id": cid, "status": "pending"}  # 永远返回成功样态，不暴露审核结果（§5.2 #5）
    store_idempotency(request.headers.get("idempotency-key"), data)
    return ok(data, "评论已提交，审核通过后展示")


# ---------------------------------------------------------------- #6 分类 / 标签 / 归档统计
@router.get("/taxonomy")
def taxonomy():
    cached = cache.get("taxonomy")
    if cached:
        return ok(cached)
    categories = db.q("""SELECT c.name, COUNT(p.id) AS count FROM categories c
                         LEFT JOIN posts p ON p.category_id=c.id AND p.status IN ('published','pinned')
                         GROUP BY c.id ORDER BY c.sort""")
    tag_rows = db.q("""SELECT t.name, COUNT(p.id) AS count FROM tags t
                       LEFT JOIN post_tags pt ON pt.tag_id=t.id
                       LEFT JOIN posts p ON p.id=pt.post_id AND p.status IN ('published','pinned')
                       GROUP BY t.id ORDER BY count DESC, t.name""")
    max_count = max([r["count"] for r in tag_rows] + [1])
    tags = [{"name": r["name"], "count": r["count"],
             "size": max(12, 12 + round(12 * r["count"] / max_count)),
             "tone": "accent" if r["count"] == max_count else ("normal" if r["count"] >= 3 else "muted")}
            for r in tag_rows]
    years = db.q("""SELECT substr(published_at,1,4) AS year, COUNT(*) AS count FROM posts
                    WHERE status IN ('published','pinned') GROUP BY year ORDER BY year DESC""")
    summary = {r["status"]: r["c"] for r in db.q("SELECT status, COUNT(*) AS c FROM posts GROUP BY status")}
    data = {
        "totalPosts": sum(summary.get(s, 0) for s in ("published", "pinned", "draft", "scheduled")),
        "years": [{"year": int(y["year"]), "count": y["count"]} for y in years],
        "categories": [{"name": c["name"], "count": c["count"]} for c in categories],
        "tags": tags,
        "postsSummary": {"total": sum(summary.values()), "published": summary.get("published", 0) + summary.get("pinned", 0),
                         "draft": summary.get("draft", 0), "scheduled": summary.get("scheduled", 0)},
    }
    cache.set("taxonomy", data, TAXONOMY_TTL)
    return ok(data)


# ---------------------------------------------------------------- #7 搜索（防抖在前端，此处限流防爬）
@router.get("/search")
def search(request: Request, q: str = Query("", max_length=64), sort: str = "relevance",
           page: int = 1, pageSize: int = 10, response: Response = None):
    ip = client_ip(request)
    if not rate_limiter.hit(f"search:{ip}", settings.SEARCH_RATE_PER_MINUTE, 60):
        raise_err(ERR_RATE_LIMITED, "操作过于频繁")
    keyword = q.strip()
    if not keyword:
        raise_err(ERR_PARAM, "关键词不能为空", {"field": "q"})
    page, size = paginate(page, pageSize)

    cache_key = f"search:{keyword}:{sort}:{page}"
    cached = cache.get(cache_key)
    if cached:
        return ok(cached)

    like = f"%{keyword}%"
    rows = db.q("""SELECT DISTINCT p.*, c.name AS category_name FROM posts p
                   LEFT JOIN categories c ON c.id=p.category_id
                   LEFT JOIN post_tags pt ON pt.post_id=p.id
                   LEFT JOIN tags t ON t.id=pt.tag_id
                   WHERE p.status IN ('published','pinned')
                     AND (p.title LIKE ? OR p.excerpt LIKE ? OR p.content_md LIKE ? OR c.name LIKE ? OR t.name LIKE ?)""",
                (like, like, like, like, like))

    def score(r):
        s = 0
        if keyword.lower() in r["title"].lower():
            s += 2
        if keyword.lower() in (r.get("excerpt") or "").lower():
            s += 1
        return s

    if sort == "latest":
        rows.sort(key=lambda r: r["published_at"] or "", reverse=True)
    else:
        rows.sort(key=lambda r: (score(r), r["published_at"] or ""), reverse=True)
    total = len(rows)
    items = []
    for r in rows[(page - 1) * size: page * size]:
        plain = strip_md(r.get("content_md") or "") or (r.get("excerpt") or "")
        items.append({
            "slug": r["slug"],
            "title": highlight(r["title"], keyword),
            "snippet": highlight(make_snippet(plain, keyword), keyword),
            "date": (r["published_at"] or "")[:10],
            "category": r.get("category_name") or "",
        })
    data = {"total": total, "items": items, "page": page, "pageSize": size}
    cache.set(cache_key, data, SEARCH_TTL)
    return ok(data)


# ---------------------------------------------------------------- #8 行为事件采集（异步聚合）
class EventIn(BaseModel):
    postId: str | None = None
    event: str  # view | read_finish
    uvHash: str = ""


@router.post("/events", status_code=204)
async def track_event(body: EventIn):
    if body.event not in ("view", "read_finish"):
        raise_err(ERR_PARAM, "不支持的 event 类型", {"field": "event"})
    db.exec_("INSERT INTO analytics_events(post_id,event,uv_hash,created_at) VALUES(?,?,?,?)",
             (body.postId, body.event, body.uvHash[:64], db.now()))
    await publish_event("page." + ("read_finish" if body.event == "read_finish" else "viewed"),
                        {"postId": body.postId, "event": "view" if body.event == "view" else "read_finish"})
    return Response(status_code=204)
