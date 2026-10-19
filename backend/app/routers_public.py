"""前台 API（无需鉴权）。前端 web/assets/js/lib/api.js 是唯一调用方。

  GET  /api/site/config            站点配置（文案 / 作者 / 友链）
  GET  /api/home                   首页聚合（置顶、最新、热门、统计、标签）—— 一次请求渲染首页
  GET  /api/posts                  文章列表（分页 + 分类 / 标签 / 年份筛选）
  GET  /api/posts/{slug}           文章详情（渲染后 HTML + 目录 + 上下篇 + 相关）
  GET  /api/posts/{slug}/comments  评论树
  POST /api/posts/{slug}/comments  提交评论（先审后发 + 风控）
  POST /api/posts/{slug}/like      点赞（按访客去重）
  GET  /api/taxonomy               分类 / 标签 / 年份统计
  GET  /api/archive                归档时间线
  GET  /api/search                 全文搜索（高亮）
  POST /api/events                 阅读事件采集
"""
import hashlib
import re
from datetime import datetime

from fastapi import APIRouter, Query, Request, Response
from pydantic import BaseModel, Field

from . import db
from .config import settings
from .deps import check_idempotency, client_ip, store_idempotency
from .helpers import (ERR_NOT_FOUND, ERR_PARAM, ERR_RATE_LIMITED, cards, highlight, loads, make_etag,
                      make_snippet, ok, page_result, paginate, post_card, post_tags_map, raise_err, time_ago)
from .markdown import render_comment, to_plain
from .services import (LIST_TTL, POST_TTL, SEARCH_TTL, TAXONOMY_TTL, cache, detect_spam_flag, publish_event,
                       rate_limiter)

router = APIRouter(prefix="/api", tags=["前台"])

PUB = ("published", "pinned")
PUB_SQL = "p.status IN ('published','pinned')"
CARD_SELECT = """SELECT p.id,p.slug,p.title,p.excerpt,p.status,p.cover,p.reading_minutes,p.word_count,p.comment_count,
                 p.view_count,p.like_count,p.published_at,p.scheduled_at,p.created_at,c.name AS category_name
                 FROM posts p LEFT JOIN categories c ON c.id=p.category_id"""
SLUG_OK = re.compile(r"^[A-Za-z0-9\-_一-鿿]{1,128}$")


def site_config_data() -> dict:
    cached = cache.get("site:config")
    if cached:
        return cached
    row = db.q1("SELECT value FROM site_config WHERE key='site'")
    data = loads(row["value"]) if row else {}
    links = db.q("SELECT name,url,description FROM friend_links WHERE is_active=1 ORDER BY sort")
    data.setdefault("about", {})["friendLinks"] = [
        {"name": l["name"], "href": l["url"], "desc": l["description"]} for l in links]
    data.setdefault("site", {})
    if settings.SITE_URL:
        data["site"]["url"] = settings.SITE_URL
    cache.set("site:config", data, TAXONOMY_TTL)
    return data


@router.get("/site/config")
def site_config():
    return ok(site_config_data())


# ---------------------------------------------------------------- 统计
def site_stats() -> dict:
    s = db.q1(f"""SELECT COUNT(*) AS posts, COALESCE(SUM(word_count),0) AS words,
                  COALESCE(SUM(view_count),0) AS views, COALESCE(SUM(like_count),0) AS likes
                  FROM posts p WHERE {PUB_SQL}""")
    comments = db.q1("SELECT COUNT(*) AS c FROM comments WHERE status='approved'")["c"]
    cfg = site_config_data().get("site", {})
    try:
        start = datetime.strptime(cfg.get("startDate", ""), "%Y-%m-%d")
        days = (datetime.now() - start).days
    except ValueError:
        first = db.q1(f"SELECT MIN(published_at) AS d FROM posts p WHERE {PUB_SQL}")["d"]
        days = (datetime.now() - datetime.strptime(first[:10], "%Y-%m-%d")).days if first else 0
    last = db.q1(f"SELECT MAX(published_at) AS d FROM posts p WHERE {PUB_SQL}")["d"]
    return {"posts": s["posts"], "words": s["words"], "views": s["views"], "likes": s["likes"],
            "comments": comments, "days": max(days, 0), "lastPublished": (last or "")[:10]}


def taxonomy_data() -> dict:
    cached = cache.get("taxonomy")
    if cached:
        return cached
    cats = db.q(f"""SELECT c.name, c.description, COUNT(p.id) AS count FROM categories c
                    LEFT JOIN posts p ON p.category_id=c.id AND {PUB_SQL}
                    GROUP BY c.id ORDER BY c.sort, c.name""")
    tags = db.q(f"""SELECT t.name, COUNT(p.id) AS count FROM tags t
                    JOIN post_tags pt ON pt.tag_id=t.id
                    JOIN posts p ON p.id=pt.post_id AND {PUB_SQL}
                    GROUP BY t.id ORDER BY count DESC, t.name""")
    years = db.q(f"""SELECT substr(published_at,1,4) AS year, COUNT(*) AS count FROM posts p
                     WHERE {PUB_SQL} AND published_at IS NOT NULL GROUP BY year ORDER BY year DESC""")
    max_c = max([t["count"] for t in tags], default=1) or 1
    data = {
        "categories": [{"name": c["name"], "description": c["description"] or "", "count": c["count"]} for c in cats],
        "tags": [{"name": t["name"], "count": t["count"], "weight": round(t["count"] / max_c, 2)} for t in tags],
        "years": [{"year": int(y["year"]), "count": y["count"]} for y in years if y["year"]],
        "stats": site_stats(),
    }
    cache.set("taxonomy", data, TAXONOMY_TTL)
    return data


@router.get("/taxonomy")
def taxonomy():
    return ok(taxonomy_data())


# ---------------------------------------------------------------- 首页聚合
@router.get("/home")
def home():
    cached = cache.get("home")
    if cached:
        return ok(cached)
    featured = db.q(f"{CARD_SELECT} WHERE p.status='pinned' ORDER BY p.published_at DESC LIMIT 3")
    hot = db.q(f"{CARD_SELECT} WHERE {PUB_SQL} ORDER BY p.view_count DESC LIMIT 5")
    recent_comments = db.q("""SELECT cm.author_name, cm.content, cm.created_at, cm.is_author, p.slug, p.title
                              FROM comments cm JOIN posts p ON p.id=cm.post_id
                              WHERE cm.status='approved' AND p.status IN ('published','pinned')
                              ORDER BY cm.created_at DESC LIMIT 5""")
    tax = taxonomy_data()
    data = {
        "featured": cards(featured),
        "hot": cards(hot),
        "recentComments": [{"author": c["author_name"], "body": to_plain(c["content"])[:60],
                            "timeAgo": time_ago(c["created_at"]), "isAuthor": bool(c["is_author"]),
                            "slug": c["slug"], "title": c["title"]} for c in recent_comments],
        "categories": tax["categories"], "tags": tax["tags"][:24], "stats": tax["stats"],
    }
    cache.set("home", data, LIST_TTL)
    return ok(data)


# ---------------------------------------------------------------- 文章列表
@router.get("/posts")
def list_posts(page: int = 1, pageSize: int = 8, category: str = "", tag: str = "", year: str = "",
               sort: str = "latest", excludePinned: bool = False):
    page, size = paginate(page, pageSize, 50)
    key = f"posts:{page}:{size}:{category}:{tag}:{year}:{sort}:{excludePinned}"
    cached = cache.get(key)
    if cached:
        return ok(cached)
    where, args = [PUB_SQL], []
    if category:
        where.append("c.name = ?")
        args.append(category)
    if tag:
        where.append("EXISTS (SELECT 1 FROM post_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.post_id=p.id AND t.name=?)")
        args.append(tag)
    if year and year.isdigit():
        where.append("substr(p.published_at,1,4) = ?")
        args.append(year)
    if excludePinned:
        where.append("p.status != 'pinned'")
    w = " AND ".join(where)
    total = db.q1(f"SELECT COUNT(*) AS c FROM posts p LEFT JOIN categories c ON c.id=p.category_id WHERE {w}", args)["c"]
    order = {"hot": "p.view_count DESC", "comments": "p.comment_count DESC"}.get(sort, "p.published_at DESC")
    pin_first = "" if (category or tag or year or excludePinned) else "CASE p.status WHEN 'pinned' THEN 0 ELSE 1 END, "
    rows = db.q(f"{CARD_SELECT} WHERE {w} ORDER BY {pin_first}{order} LIMIT ? OFFSET ?", (*args, size, (page - 1) * size))
    data = page_result(cards(rows), total, page, size)
    cache.set(key, data, LIST_TTL)
    return ok(data)


# ---------------------------------------------------------------- 文章详情
def get_public_post(slug: str) -> dict | None:
    if not SLUG_OK.match(slug or ""):
        return None
    return db.q1(f"""SELECT p.*, c.name AS category_name FROM posts p LEFT JOIN categories c ON c.id=p.category_id
                     WHERE p.slug=? AND {PUB_SQL}""", (slug,))


@router.get("/posts/{slug}")
def post_detail(slug: str, request: Request, response: Response):
    row = get_public_post(slug)
    if not row:
        raise_err(ERR_NOT_FOUND, "文章不存在")
    etag = make_etag(row["slug"], row["updated_at"], row["comment_count"], row["like_count"], row["render_ver"])
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers={"ETag": etag})
    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = "no-cache"

    cached = cache.get(f"post:{slug}")
    if cached and cached.get("_etag") == etag:
        return ok({k: v for k, v in cached.items() if k != "_etag"})
    if row["render_ver"] < db.RENDER_VERSION or (not row["content_html"] and row["content_md"]):
        db.rerender_post(row["id"])
        row = get_public_post(slug)

    prev_post = db.q1(f"""SELECT slug,title FROM posts p WHERE {PUB_SQL} AND published_at < ?
                         ORDER BY published_at DESC LIMIT 1""", (row["published_at"],))
    next_post = db.q1(f"""SELECT slug,title FROM posts p WHERE {PUB_SQL} AND published_at > ?
                         ORDER BY published_at ASC LIMIT 1""", (row["published_at"],))
    # 相关文章：共同标签数 > 同分类 > 热度
    related = db.q(f"""{CARD_SELECT}
        WHERE {PUB_SQL} AND p.id != ?
        ORDER BY (SELECT COUNT(*) FROM post_tags a JOIN post_tags b ON a.tag_id=b.tag_id
                  WHERE a.post_id=p.id AND b.post_id=?) DESC,
                 CASE WHEN p.category_id IS ? THEN 0 ELSE 1 END, p.view_count DESC LIMIT 3""",
                   (row["id"], row["id"], row["category_id"]))
    data = post_card(row, post_tags_map([row["id"]]).get(row["id"], []))
    data.update({
        "contentHtml": row["content_html"] or f"<p>{(row.get('excerpt') or '')}</p>",
        "toc": loads(row["toc"], []),
        "updatedAt": (row["updated_at"] or "")[:16],
        "prev": prev_post, "next": next_post,
        "related": cards(related),
        "description": row.get("excerpt") or "",
    })
    cache.set(f"post:{slug}", {**data, "_etag": etag}, POST_TTL)
    return ok(data)


# ---------------------------------------------------------------- 评论
def _comment_out(c: dict) -> dict:
    return {"id": c["id"], "parentId": c["parent_id"], "author": c["author_name"],
            "avatarText": (c["author_name"] or "?")[:1].upper(),
            "avatarHue": int(hashlib.md5((c["author_name"] or "").encode()).hexdigest()[:2], 16) * 360 // 256,
            "time": c["created_at"][:16], "timeAgo": time_ago(c["created_at"]),
            "html": render_comment(c["content"]), "isAuthor": bool(c["is_author"]), "replies": []}


@router.get("/posts/{slug}/comments")
def post_comments(slug: str):
    post = get_public_post(slug)
    if not post:
        raise_err(ERR_NOT_FOUND, "文章不存在")
    cached = cache.get(f"comments:{slug}")
    if cached:
        return ok(cached)
    rows = db.q("""SELECT * FROM comments WHERE post_id=? AND status='approved' ORDER BY created_at ASC""", (post["id"],))
    nodes = {r["id"]: _comment_out(r) for r in rows}
    roots = []
    for r in rows:
        node = nodes[r["id"]]
        parent = nodes.get(r["parent_id"]) if r["parent_id"] else None
        if parent:
            # 只保留两层：回复的回复挂在根评论下，并标注 @ 对象
            root = parent
            while root["parentId"] and root["parentId"] in nodes:
                root = nodes[root["parentId"]]
            node["replyTo"] = parent["author"]
            root["replies"].append(node)
        else:
            roots.append(node)
    roots.reverse()  # 根评论最新在前，回复按时间正序
    data = {"list": roots, "total": len(rows)}
    cache.set(f"comments:{slug}", data, LIST_TTL)
    return ok(data)


class CommentIn(BaseModel):
    content: str = Field(..., max_length=4000)
    nick: str = Field("", max_length=64)
    email: str | None = Field(None, max_length=128)
    url: str | None = Field(None, max_length=256)
    parentId: str | None = None
    hp: str | None = None  # 蜜罐字段：真人不会填写


@router.post("/posts/{slug}/comments")
async def submit_comment(slug: str, body: CommentIn, request: Request):
    idem = check_idempotency(request.headers.get("idempotency-key"))
    if idem is not None:
        return ok(idem)
    post = get_public_post(slug)
    if not post:
        raise_err(ERR_NOT_FOUND, "文章不存在")
    content = (body.content or "").strip()
    nick = (body.nick or "").strip()[:32] or "访客"
    if not content:
        raise_err(ERR_PARAM, "评论内容不能为空", {"field": "content"})
    if len(content) > 2000:
        raise_err(ERR_PARAM, "评论内容不能超过 2000 字", {"field": "content"})
    if body.email and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", body.email):
        raise_err(ERR_PARAM, "邮箱格式不正确", {"field": "email"})
    parent_id = None
    if body.parentId:
        parent = db.q1("SELECT id FROM comments WHERE id=? AND post_id=? AND status='approved'", (body.parentId, post["id"]))
        parent_id = parent and parent["id"]

    ip = client_ip(request)
    flag = None
    if body.hp:
        flag = "机器人"
    elif not rate_limiter.hit(f"comment:{ip}", settings.COMMENT_RATE_PER_HOUR, 3600):
        flag = "频率限制"
    flag = flag or detect_spam_flag(content) or detect_spam_flag(nick)
    status = "approved" if (settings.COMMENT_AUTO_APPROVE and not flag) else "pending"

    cid = db.uid()
    db.exec_("""INSERT INTO comments(id,post_id,parent_id,author_name,author_email,author_ip,content,status,flag,created_at,
                reviewed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
             (cid, post["id"], parent_id, nick, body.email, ip, content, status, flag, db.now(),
              db.now() if status == "approved" else None))
    if status == "approved":
        db.exec_("UPDATE posts SET comment_count=comment_count+1 WHERE id=?", (post["id"],))
        cache.invalidate(f"comments:{slug}", f"post:{slug}", "home")
    await publish_event("comment.submitted", {"commentId": cid, "postId": post["id"]})
    row = db.q1("SELECT * FROM comments WHERE id=?", (cid,))
    data = {"id": cid, "status": "approved" if status == "approved" else "pending", "comment": _comment_out(row)}
    store_idempotency(request.headers.get("idempotency-key"), data)
    return ok(data, "评论已发布" if status == "approved" else "评论已提交，审核通过后展示")


# ---------------------------------------------------------------- 点赞
@router.post("/posts/{slug}/like")
def like_post(slug: str, request: Request):
    post = get_public_post(slug)
    if not post:
        raise_err(ERR_NOT_FOUND, "文章不存在")
    visitor = hashlib.sha256(f"{client_ip(request)}|{request.headers.get('user-agent', '')}".encode()).hexdigest()[:32]
    liked = db.q1("SELECT 1 FROM post_likes WHERE post_id=? AND visitor=?", (post["id"], visitor))
    if liked:
        db.exec_("DELETE FROM post_likes WHERE post_id=? AND visitor=?", (post["id"], visitor))
        db.exec_("UPDATE posts SET like_count=MAX(like_count-1,0) WHERE id=?", (post["id"],))
    else:
        if not rate_limiter.hit(f"like:{visitor}", 30, 60):
            raise_err(ERR_RATE_LIMITED, "操作过于频繁")
        db.exec_("INSERT INTO post_likes(post_id,visitor,created_at) VALUES(?,?,?)", (post["id"], visitor, db.now()))
        db.exec_("UPDATE posts SET like_count=like_count+1 WHERE id=?", (post["id"],))
    count = db.q1("SELECT like_count FROM posts WHERE id=?", (post["id"],))["like_count"]
    cache.invalidate(f"post:{slug}")
    return ok({"liked": not liked, "likes": count})


# ---------------------------------------------------------------- 归档
@router.get("/archive")
def archive(category: str = "", tag: str = ""):
    key = f"archive:{category}:{tag}"
    cached = cache.get(key)
    if cached:
        return ok(cached)
    where, args = [PUB_SQL], []
    if category:
        where.append("c.name=?")
        args.append(category)
    if tag:
        where.append("EXISTS (SELECT 1 FROM post_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.post_id=p.id AND t.name=?)")
        args.append(tag)
    rows = db.q(f"{CARD_SELECT} WHERE {' AND '.join(where)} ORDER BY p.published_at DESC", args)
    groups: list[dict] = []
    for card in cards(rows):
        y = card["date"][:4]
        if not groups or groups[-1]["year"] != y:
            groups.append({"year": y, "count": 0, "posts": []})
        groups[-1]["posts"].append({k: card[k] for k in ("slug", "title", "date", "category", "tags", "readingMinutes")})
        groups[-1]["count"] += 1
    data = {"total": len(rows), "groups": groups}
    cache.set(key, data, LIST_TTL)
    return ok(data)


# ---------------------------------------------------------------- 搜索
@router.get("/search")
def search(request: Request, q: str = Query("", max_length=64), page: int = 1, pageSize: int = 10):
    keyword = q.strip()
    if not keyword:
        raise_err(ERR_PARAM, "关键词不能为空", {"field": "q"})
    ip = client_ip(request)
    if not rate_limiter.hit(f"search:{ip}", settings.SEARCH_RATE_PER_MINUTE, 60):
        raise_err(ERR_RATE_LIMITED, "搜索过于频繁，请稍后再试")
    page, size = paginate(page, pageSize, 30)
    cache_key = f"search:{keyword.lower()}:{page}:{size}"
    cached = cache.get(cache_key)
    if cached:
        return ok(cached)

    terms = [t for t in re.split(r"\s+", keyword) if t][:5]
    conds, args = [], []
    for t in terms:
        like = f"%{t}%"
        conds.append("""(p.title LIKE ? OR p.excerpt LIKE ? OR p.content_md LIKE ? OR c.name LIKE ?
                       OR EXISTS (SELECT 1 FROM post_tags pt JOIN tags tg ON tg.id=pt.tag_id
                                  WHERE pt.post_id=p.id AND tg.name LIKE ?))""")
        args += [like] * 5
    rows = db.q(f"""SELECT p.*, c.name AS category_name FROM posts p LEFT JOIN categories c ON c.id=p.category_id
                    WHERE {PUB_SQL} AND {' AND '.join(conds)}""", args)
    tags_map = post_tags_map([r["id"] for r in rows])

    def score(r):
        s = 0
        for t in terms:
            tl = t.lower()
            s += 10 if tl in r["title"].lower() else 0
            s += 5 if any(tl in x.lower() for x in tags_map.get(r["id"], [])) else 0
            s += 3 if tl in (r.get("excerpt") or "").lower() else 0
            s += min((r.get("content_md") or "").lower().count(tl), 5)
        return s

    rows.sort(key=lambda r: (score(r), r["published_at"] or ""), reverse=True)
    items = []
    for r in rows[(page - 1) * size: page * size]:
        plain = to_plain(r.get("content_md") or "") or (r.get("excerpt") or "")
        snippet = make_snippet(plain, terms[0])
        title_h, snip_h = r["title"], snippet
        title_h = highlight(r["title"], terms[0])
        snip_h = highlight(snippet, terms[0])
        for t in terms[1:]:
            title_h = re.sub(re.escape(t), lambda m: f"<mark>{m.group(0)}</mark>", title_h, flags=re.I)
            snip_h = re.sub(re.escape(t), lambda m: f"<mark>{m.group(0)}</mark>", snip_h, flags=re.I)
        items.append({"slug": r["slug"], "title": r["title"], "titleHtml": title_h, "snippetHtml": snip_h,
                      "date": (r["published_at"] or "")[:10], "category": r.get("category_name") or "",
                      "tags": tags_map.get(r["id"], [])})
    data = {"total": len(rows), "list": items, "page": page, "pageSize": size, "q": keyword}
    cache.set(cache_key, data, SEARCH_TTL)
    return ok(data)


# ---------------------------------------------------------------- 行为事件
class EventIn(BaseModel):
    slug: str | None = None
    postId: str | None = None
    event: str  # view | read_finish
    uvHash: str = ""


@router.post("/events", status_code=204)
async def track_event(body: EventIn, request: Request):
    if body.event not in ("view", "read_finish"):
        raise_err(ERR_PARAM, "不支持的 event 类型", {"field": "event"})
    ip = client_ip(request)
    if not rate_limiter.hit(f"event:{ip}", 60, 60):
        return Response(status_code=204)
    post_id = body.postId
    if body.slug:
        p = db.q1("SELECT id FROM posts WHERE slug=?", (body.slug,))
        post_id = p and p["id"]
    uv = body.uvHash[:64] or hashlib.sha256(f"{ip}|{db.today()}".encode()).hexdigest()[:32]
    db.exec_("INSERT INTO analytics_events(post_id,event,uv_hash,created_at) VALUES(?,?,?,?)",
             (post_id, body.event, uv, db.now()))
    await publish_event("page." + ("read_finish" if body.event == "read_finish" else "viewed"),
                        {"postId": post_id, "event": body.event})
    return Response(status_code=204)
