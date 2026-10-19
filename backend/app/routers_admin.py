"""后台 API（需 JWT 鉴权）。前端：web/admin/（单页应用）。"""
import json
import re
import shutil
import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Request, UploadFile
from pydantic import BaseModel, Field

from . import db
from .config import settings
from .deps import check_idempotency, current_user, store_idempotency
from .helpers import (ERR_CONFLICT, ERR_FILE_TOO_LARGE, ERR_FILE_TYPE, ERR_NOT_FOUND, ERR_PARAM, ERR_SLUG_CONFLICT,
                      SLUG_RE, loads, ok, page_result, paginate, post_date, post_tags_map, raise_err, slugify,
                      time_ago)
from .markdown import make_excerpt, render_comment, render_post
from .security import hash_password, revoke_user_sessions, verify_password
from .services import SPAM_KEYWORDS, cache, create_publish_task, publish_event, publish_tasks

router = APIRouter(prefix="/api/admin", tags=["后台"], dependencies=[Depends(current_user)])

STATUS_ALL = ("draft", "published", "pinned", "scheduled", "trashed")
ALL_CACHE = ("post:", "taxonomy", "dashboard", "home", "posts:", "archive", "search:", "comments:", "feed")


def _audit(user: dict, action: str, detail: str):
    db.exec_("INSERT INTO audit_logs(user_id,action,detail,created_at) VALUES(?,?,?,?)",
             (user["id"], action, detail[:500], db.now()))


def _get_post(post_id: str) -> dict:
    r = db.q1("""SELECT p.*, c.name AS category_name FROM posts p
                 LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=?""", (post_id,))
    if not r:
        raise_err(ERR_NOT_FOUND, "文章不存在")
    return r


def _set_tags(post_id: str, names: list[str]):
    db.exec_("DELETE FROM post_tags WHERE post_id=?", (post_id,))
    for name in names:
        name = name.strip().lstrip("#")[:32]
        if not name:
            continue
        tag = db.q1("SELECT id FROM tags WHERE name=?", (name,))
        tid = tag["id"] if tag else db.uid()
        if not tag:
            db.exec_("INSERT INTO tags(id,name) VALUES(?,?)", (tid, name))
        db.exec_("INSERT OR IGNORE INTO post_tags(post_id,tag_id) VALUES(?,?)", (post_id, tid))


def _category_id(name: str | None) -> str | None:
    if not name:
        return None
    cat = db.q1("SELECT id FROM categories WHERE name=?", (name.strip(),))
    if cat:
        return cat["id"]
    cid = db.uid()
    db.exec_("INSERT INTO categories(id,name,sort) VALUES(?,?,?)", (cid, name.strip()[:32], 99))
    return cid


# ================================================================ 文章
def _admin_item(r: dict, tags: list[str]) -> dict:
    return {
        "id": r["id"], "slug": r["slug"], "title": r["title"], "status": r["status"],
        "category": r.get("category_name") or "", "tags": tags, "excerpt": r.get("excerpt") or "",
        "commentCount": r["comment_count"], "views": r["view_count"], "likes": r.get("like_count", 0),
        "words": r.get("word_count", 0), "updatedAt": (r["updated_at"] or "")[:16],
        "updatedAgo": time_ago(r["updated_at"] or ""), "date": post_date(r), "rev": r["updated_at"],
        "scheduledAt": r.get("scheduled_at"), "publishedAt": r.get("published_at"),
        "cover": loads(r.get("cover"), None) if r.get("cover") else None,
    }


@router.get("/posts")
def admin_posts(q: str = "", status: str = "", category: str = "", tag: str = "", page: int = 1, pageSize: int = 20,
                sort: str = "updated"):
    page, size = paginate(page, pageSize)
    where, args = [], []
    if status == "trashed":
        where.append("p.status = 'trashed'")
    else:
        where.append("p.status != 'trashed'")
        if status:
            if status not in STATUS_ALL:
                raise_err(ERR_PARAM, "非法的 status 取值", {"field": "status"})
            if status == "published":
                where.append("p.status IN ('published','pinned')")
            else:
                where.append("p.status = ?")
                args.append(status)
    if q:
        where.append("(p.title LIKE ? OR p.slug LIKE ? OR p.content_md LIKE ?)")
        args += [f"%{q}%"] * 3
    if category:
        where.append("c.name = ?")
        args.append(category)
    if tag:
        where.append("EXISTS (SELECT 1 FROM post_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.post_id=p.id AND t.name=?)")
        args.append(tag)
    base = f"FROM posts p LEFT JOIN categories c ON c.id=p.category_id WHERE {' AND '.join(where)}"
    total = db.q1(f"SELECT COUNT(*) AS c {base}", args)["c"]
    order = {"views": "p.view_count DESC", "published": "COALESCE(p.published_at,p.scheduled_at,p.created_at) DESC",
             "title": "p.title"}.get(sort, "p.updated_at DESC")
    rows = db.q(f"SELECT p.*, c.name AS category_name {base} ORDER BY {order} LIMIT ? OFFSET ?",
                (*args, size, (page - 1) * size))
    tags_map = post_tags_map([r["id"] for r in rows])
    data = page_result([_admin_item(r, tags_map.get(r["id"], [])) for r in rows], total, page, size)
    counts = {r["status"]: r["c"] for r in db.q("SELECT status, COUNT(*) AS c FROM posts GROUP BY status")}
    data["counts"] = {
        "all": sum(v for k, v in counts.items() if k != "trashed"),
        "published": counts.get("published", 0) + counts.get("pinned", 0),
        "draft": counts.get("draft", 0), "scheduled": counts.get("scheduled", 0), "trashed": counts.get("trashed", 0)}
    return ok(data)


class PostCreateIn(BaseModel):
    title: str = ""
    slug: str | None = None
    category: str | None = None
    contentMd: str = ""


@router.post("/posts")
def create_post(body: PostCreateIn, user: dict = Depends(current_user)):
    title = (body.title or "").strip()[:200] or "无标题文章"
    slug = (body.slug or "").strip().lower() or slugify(title)
    if not SLUG_RE.match(slug):
        raise_err(ERR_PARAM, "Slug 仅支持小写字母、数字与连字符", {"field": "slug"})
    if db.q1("SELECT id FROM posts WHERE slug=?", (slug,)):
        raise_err(ERR_SLUG_CONFLICT, "Slug 已存在，全站唯一", {"slug": slug})
    pid, ts = db.uid(), db.now()
    db.exec_("""INSERT INTO posts(id,slug,title,content_md,status,category_id,created_at,updated_at)
                VALUES(?,?,?,?,'draft',?,?,?)""", (pid, slug, title, body.contentMd, _category_id(body.category), ts, ts))
    if body.contentMd:
        db.rerender_post(pid)
    _audit(user, "post.create", f"{title} ({slug})")
    return ok({"id": pid, "slug": slug, "status": "draft"})


@router.get("/posts/{post_id}")
def admin_post_detail(post_id: str):
    r = _get_post(post_id)
    tags = post_tags_map([r["id"]]).get(r["id"], [])
    versions = db.q1("SELECT COUNT(*) AS c FROM post_versions WHERE post_id=?", (post_id,))["c"]
    return ok({**_admin_item(r, tags), "contentMd": r.get("content_md") or "", "versionCount": versions,
               "previewUrl": f"/post/{r['slug']}" if r["status"] in ("published", "pinned") else None})


class DraftIn(BaseModel):
    title: str | None = Field(None, max_length=200)
    contentMd: str | None = None
    slug: str | None = None
    category: str | None = None
    tags: list[str] | None = None
    excerpt: str | None = Field(None, max_length=500)
    cover: dict | None = None
    clearCover: bool = False
    pinned: bool | None = None
    baseUpdatedAt: str | None = None  # 乐观锁：编辑器打开时的 updatedAt，防多窗口覆盖


@router.put("/posts/{post_id}/draft")
def save_draft(post_id: str, body: DraftIn, user: dict = Depends(current_user)):
    r = _get_post(post_id)
    if body.baseUpdatedAt and (r["updated_at"] or "")[:19] > body.baseUpdatedAt[:19] and body.contentMd is not None \
            and body.contentMd != r["content_md"]:
        raise_err(ERR_CONFLICT, "文章已在其他窗口被修改，请刷新后再编辑", {"updatedAt": r["updated_at"]})
    updates, args = [], []
    if body.title is not None:
        updates.append("title=?")
        args.append(body.title.strip() or r["title"])
    if body.contentMd is not None:
        updates.append("content_md=?")
        args.append(body.contentMd)
    if body.excerpt is not None:
        updates.append("excerpt=?")
        args.append(body.excerpt.strip())
    if body.slug is not None and body.slug.strip() and body.slug.strip() != r["slug"]:
        slug = body.slug.strip().lower()
        if not SLUG_RE.match(slug):
            raise_err(ERR_PARAM, "Slug 仅支持小写字母、数字与连字符", {"field": "slug"})
        if db.q1("SELECT id FROM posts WHERE slug=? AND id != ?", (slug, post_id)):
            raise_err(ERR_SLUG_CONFLICT, "Slug 已存在，全站唯一", {"slug": slug})
        updates.append("slug=?")
        args.append(slug)
    if body.category is not None:
        updates.append("category_id=?")
        args.append(_category_id(body.category))
    if body.cover is not None or body.clearCover:
        updates.append("cover=?")
        args.append(None if body.clearCover else json.dumps(body.cover, ensure_ascii=False))
    if body.pinned is not None and r["status"] in ("published", "pinned"):
        updates.append("status=?")
        args.append("pinned" if body.pinned else "published")
    ts = db.now()
    updates.append("updated_at=?")
    args.append(ts)
    db.exec_(f"UPDATE posts SET {', '.join(updates)} WHERE id=?", (*args, post_id))
    if body.tags is not None:
        _set_tags(post_id, body.tags)

    if body.contentMd is not None and body.contentMd != r["content_md"]:
        db.rerender_post(post_id)
        # 版本快照：距上个版本 ≥ 10 分钟才新建，避免自动保存产生海量版本；最多保留 50 个
        last = db.q1("SELECT version_no, created_at FROM post_versions WHERE post_id=? ORDER BY version_no DESC LIMIT 1",
                     (post_id,))
        if not last or last["created_at"] < (datetime.now() - timedelta(minutes=10)).strftime("%Y-%m-%d %H:%M:%S"):
            db.exec_("INSERT INTO post_versions(post_id,content_md,version_no,created_at) VALUES(?,?,?,?)",
                     (post_id, body.contentMd, (last["version_no"] if last else 0) + 1, ts))
            db.exec_("""DELETE FROM post_versions WHERE post_id=? AND version_no <=
                        (SELECT MAX(version_no) - 50 FROM post_versions WHERE post_id=?)""", (post_id, post_id))
        else:
            db.exec_("UPDATE post_versions SET content_md=?, created_at=? WHERE post_id=? AND version_no=?",
                     (body.contentMd, ts, post_id, last["version_no"]))
    elif body.excerpt is not None and not body.excerpt.strip():
        db.exec_("UPDATE posts SET excerpt=? WHERE id=?", (make_excerpt(r["content_md"] or ""), post_id))

    if r["status"] in ("published", "pinned"):
        cache.invalidate(*ALL_CACHE)
    row = db.q1("SELECT slug, word_count, reading_minutes, updated_at FROM posts WHERE id=?", (post_id,))
    return ok({"id": post_id, "savedAt": ts, "slug": row["slug"], "words": row["word_count"],
               "readingMinutes": row["reading_minutes"], "updatedAt": row["updated_at"]})


class PublishIn(BaseModel):
    mode: str = "now"           # now | schedule
    scheduledAt: str | None = None


@router.post("/posts/{post_id}/publish")
def publish_post(post_id: str, body: PublishIn, request: Request, user: dict = Depends(current_user)):
    idem = check_idempotency(request.headers.get("idempotency-key"))
    if idem is not None:
        return ok(idem)
    r = _get_post(post_id)
    if r["status"] == "trashed":
        raise_err(ERR_PARAM, "回收站中的文章需先恢复")
    if body.mode not in ("now", "schedule"):
        raise_err(ERR_PARAM, "mode 仅支持 now / schedule", {"field": "mode"})
    sched = None
    if body.mode == "schedule":
        try:
            dt = datetime.fromisoformat((body.scheduledAt or "").replace("Z", ""))
        except ValueError:
            raise_err(ERR_PARAM, "定时发布时间格式不正确", {"field": "scheduledAt"})
        if dt <= datetime.now():
            raise_err(ERR_PARAM, "定时发布时间需晚于当前时间", {"field": "scheduledAt"})
        sched = dt.strftime("%Y-%m-%d %H:%M:%S")
    task_id = create_publish_task(post_id, body.mode, sched)
    _audit(user, "post.publish", f"{r['slug']} mode={body.mode}")
    data = {"taskId": task_id}
    store_idempotency(request.headers.get("idempotency-key"), data)
    return ok(data, "发布任务已创建")


@router.get("/tasks/{task_id}")
def task_status(task_id: str):
    task = publish_tasks.get(task_id)
    if not task:
        raise_err(ERR_NOT_FOUND, "任务不存在")
    return ok({"taskId": task_id, "status": task["status"], "steps": task["steps"],
               "doneUrl": task.get("doneUrl"), "error": task.get("error")})


@router.post("/posts/{post_id}/unpublish")
def unpublish(post_id: str, user: dict = Depends(current_user)):
    r = _get_post(post_id)
    db.exec_("UPDATE posts SET status='draft', scheduled_at=NULL, updated_at=? WHERE id=?", (db.now(), post_id))
    cache.invalidate(*ALL_CACHE)
    _audit(user, "post.unpublish", r["slug"])
    return ok({"id": post_id, "status": "draft"})


@router.post("/posts/{post_id}/restore")
def restore(post_id: str, user: dict = Depends(current_user)):
    r = _get_post(post_id)
    status = "published" if r["published_at"] else "draft"
    db.exec_("UPDATE posts SET status=?, updated_at=? WHERE id=?", (status, db.now(), post_id))
    cache.invalidate(*ALL_CACHE)
    _audit(user, "post.restore", r["slug"])
    return ok({"id": post_id, "status": status})


@router.delete("/posts/{post_id}")
def trash_post(post_id: str, purge: bool = False, user: dict = Depends(current_user)):
    r = _get_post(post_id)
    if purge:
        if r["status"] != "trashed":
            raise_err(ERR_PARAM, "只能彻底删除回收站中的文章")
        for sql in ("DELETE FROM post_tags WHERE post_id=?", "DELETE FROM post_versions WHERE post_id=?",
                    "DELETE FROM comments WHERE post_id=?", "DELETE FROM post_likes WHERE post_id=?",
                    "DELETE FROM posts WHERE id=?"):
            db.exec_(sql, (post_id,))
        _audit(user, "post.purge", r["slug"])
        return ok({"id": post_id, "status": "purged"})
    db.exec_("UPDATE posts SET status='trashed', updated_at=? WHERE id=?", (db.now(), post_id))
    cache.invalidate(*ALL_CACHE)
    _audit(user, "post.trash", r["slug"])
    return ok({"id": post_id, "status": "trashed"})


class BatchIn(BaseModel):
    ids: list[str]
    action: str                 # setCategory | addTags | publish | trash | restore | unpublish
    payload: dict = {}


@router.post("/posts/batch")
def batch_posts(body: BatchIn, user: dict = Depends(current_user)):
    if body.action not in ("setCategory", "addTags", "publish", "trash", "restore", "unpublish"):
        raise_err(ERR_PARAM, "不支持的批量操作", {"field": "action"})
    if not body.ids:
        raise_err(ERR_PARAM, "未选择文章", {"field": "ids"})
    affected, task_ids = 0, []
    for pid in body.ids[:200]:
        r = db.q1("SELECT * FROM posts WHERE id=?", (pid,))
        if not r:
            continue
        ts = db.now()
        if body.action == "trash":
            db.exec_("UPDATE posts SET status='trashed', updated_at=? WHERE id=?", (ts, pid))
        elif body.action == "restore":
            db.exec_("UPDATE posts SET status=?, updated_at=? WHERE id=?",
                     ("published" if r["published_at"] else "draft", ts, pid))
        elif body.action == "unpublish":
            db.exec_("UPDATE posts SET status='draft', updated_at=? WHERE id=?", (ts, pid))
        elif body.action == "setCategory":
            db.exec_("UPDATE posts SET category_id=?, updated_at=? WHERE id=?",
                     (_category_id(body.payload.get("category")), ts, pid))
        elif body.action == "addTags":
            existing = post_tags_map([pid]).get(pid, [])
            _set_tags(pid, existing + list(body.payload.get("tags", [])))
        elif body.action == "publish":
            task_ids.append(create_publish_task(pid, "now", None))
        affected += 1
    cache.invalidate(*ALL_CACHE)
    _audit(user, "post.batch", f"{body.action} ×{affected}")
    return ok({"affected": affected, "taskIds": task_ids or None})


@router.get("/posts/{post_id}/versions")
def versions(post_id: str):
    _get_post(post_id)
    rows = db.q("""SELECT version_no, created_at, length(content_md) AS size FROM post_versions
                   WHERE post_id=? ORDER BY version_no DESC LIMIT 50""", (post_id,))
    return ok({"list": [{"version": r["version_no"], "createdAt": r["created_at"][:16],
                         "ago": time_ago(r["created_at"]), "size": r["size"]} for r in rows]})


@router.get("/posts/{post_id}/versions/{version}")
def version_detail(post_id: str, version: int):
    r = db.q1("SELECT * FROM post_versions WHERE post_id=? AND version_no=?", (post_id, version))
    if not r:
        raise_err(ERR_NOT_FOUND, "版本不存在")
    return ok({"version": r["version_no"], "createdAt": r["created_at"], "contentMd": r["content_md"]})


class RenderIn(BaseModel):
    contentMd: str


@router.post("/render")
def render_preview(body: RenderIn):
    r = render_post(body.contentMd)
    return ok({"html": r["html"], "toc": r["toc"], "words": r["words"], "readingMinutes": r["readingMinutes"]})


# ================================================================ 上传
ALLOWED_MIME = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif"}
MAGIC = {b"\x89PNG": "image/png", b"\xff\xd8\xff": "image/jpeg", b"GIF8": "image/gif"}


def _sniff(blob: bytes) -> str | None:
    for sig, mime in MAGIC.items():
        if blob.startswith(sig):
            return mime
    if blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return "image/webp"
    if blob[4:12] in (b"ftypavif", b"ftypavis"):
        return "image/avif"
    return None


@router.post("/uploads")
async def upload(files: list[UploadFile], user: dict = Depends(current_user)):
    """图片上传。出于安全考虑不接受 SVG（可内嵌脚本），并以文件头校验真实类型。"""
    if not files:
        raise_err(ERR_PARAM, "未接收到文件")
    settings.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    items = []
    for f in files[:20]:
        blob = await f.read()
        if len(blob) > settings.UPLOAD_MAX_BYTES:
            raise_err(ERR_FILE_TOO_LARGE, f"图片超过 {settings.UPLOAD_MAX_BYTES // 1024 // 1024}MB 限制",
                      {"filename": f.filename})
        mime = _sniff(blob)
        if mime not in ALLOWED_MIME:
            raise_err(ERR_FILE_TYPE, "仅支持 png / jpg / gif / webp / avif 图片", {"filename": f.filename})
        key = f"{datetime.now():%Y/%m}/{uuid.uuid4().hex[:16]}.{ALLOWED_MIME[mime]}"
        path = settings.UPLOAD_DIR / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(blob)
        db.exec_("""INSERT INTO assets(id,filename,mime,size_bytes,oss_key,uploader_id,created_at)
                    VALUES(?,?,?,?,?,?,?)""",
                 (db.uid(), (f.filename or key)[:200], mime, len(blob), key, user["id"], db.now()))
        alt = re.sub(r"[\[\]()]", "", (f.filename or "image").rsplit(".", 1)[0])[:60] or "image"
        items.append({"url": f"/uploads/{key}", "alt": alt, "size": len(blob)})
    _audit(user, "upload", f"{len(items)} file(s)")
    return ok({"items": items})


# ================================================================ 评论
@router.get("/comments")
def review_comments(status: str = "pending", q: str = "", page: int = 1, pageSize: int = 20):
    if status not in ("pending", "approved", "spam"):
        raise_err(ERR_PARAM, "非法的 status 取值", {"field": "status"})
    page, size = paginate(page, pageSize)
    counts = {r["status"]: r["c"] for r in db.q("SELECT status, COUNT(*) AS c FROM comments GROUP BY status")}
    where, args = ["cm.status=?"], [status]
    if q:
        where.append("(cm.content LIKE ? OR cm.author_name LIKE ?)")
        args += [f"%{q}%"] * 2
    w = " AND ".join(where)
    total = db.q1(f"SELECT COUNT(*) AS c FROM comments cm WHERE {w}", args)["c"]
    rows = db.q(f"""SELECT cm.*, p.title AS post_title, p.slug AS post_slug, pc.author_name AS parent_author
                    FROM comments cm JOIN posts p ON p.id=cm.post_id
                    LEFT JOIN comments pc ON pc.id=cm.parent_id
                    WHERE {w} ORDER BY cm.created_at DESC LIMIT ? OFFSET ?""", (*args, size, (page - 1) * size))
    items = []
    for c in rows:
        body = render_comment(c["content"])
        if c["flag"] == "命中关键词":
            for kw in SPAM_KEYWORDS:  # 内容已转义，安全地标黄命中词
                body = body.replace(kw, f"<mark>{kw}</mark>")
        items.append({
            "id": c["id"], "author": c["author_name"], "email": c["author_email"] or "", "ip": c["author_ip"] or "",
            "timeAgo": time_ago(c["created_at"]), "time": c["created_at"][:16], "flag": c["flag"],
            "html": body, "postTitle": c["post_title"], "postSlug": c["post_slug"], "isAuthor": bool(c["is_author"]),
            "replyTo": c["parent_author"],
        })
    data = page_result(items, total, page, size)
    data["counts"] = {"pending": counts.get("pending", 0), "approved": counts.get("approved", 0),
                      "spam": counts.get("spam", 0)}
    return ok(data)


class ReplyIn(BaseModel):
    content: str = Field(..., min_length=1, max_length=2000)


@router.post("/comments/{comment_id}/reply")
def reply_comment(comment_id: str, body: ReplyIn, user: dict = Depends(current_user)):
    c = db.q1("SELECT * FROM comments WHERE id=?", (comment_id,))
    if not c:
        raise_err(ERR_NOT_FOUND, "评论不存在")
    site = loads((db.q1("SELECT value FROM site_config WHERE key='site'") or {}).get("value"))
    name = site.get("site", {}).get("author") or user["username"]
    ts = db.now()
    if c["status"] == "pending":  # 回复即视为通过
        db.exec_("UPDATE comments SET status='approved', reviewed_at=? WHERE id=?", (ts, comment_id))
    rid = db.uid()
    db.exec_("""INSERT INTO comments(id,post_id,parent_id,author_name,content,status,is_author,created_at,reviewed_at)
                VALUES(?,?,?,?,?,'approved',1,?,?)""", (rid, c["post_id"], comment_id, name, body.content.strip(), ts, ts))
    db.exec_("""UPDATE posts SET comment_count=(SELECT COUNT(*) FROM comments
                WHERE post_id=? AND status='approved') WHERE id=?""", (c["post_id"], c["post_id"]))
    post = db.q1("SELECT slug FROM posts WHERE id=?", (c["post_id"],))
    cache.invalidate(f"post:{post['slug']}", f"comments:{post['slug']}", "home", "dashboard")
    _audit(user, "comment.reply", comment_id)
    return ok({"id": rid})


@router.post("/comments/{comment_id}/{action}")
async def review_action(comment_id: str, action: str, user: dict = Depends(current_user)):
    if action not in ("approve", "spam", "delete", "pending"):
        raise_err(ERR_PARAM, "不支持的审核操作")
    c = db.q1("SELECT * FROM comments WHERE id=?", (comment_id,))
    if not c:
        raise_err(ERR_NOT_FOUND, "评论不存在")
    target = {"approve": "approved", "spam": "spam", "delete": "deleted", "pending": "pending"}[action]
    db.exec_("UPDATE comments SET status=?, reviewed_at=? WHERE id=?", (target, db.now(), comment_id))
    db.exec_("""UPDATE posts SET comment_count=(SELECT COUNT(*) FROM comments
                WHERE post_id=? AND status='approved') WHERE id=?""", (c["post_id"], c["post_id"]))
    post = db.q1("SELECT slug FROM posts WHERE id=?", (c["post_id"],))
    if post:
        cache.invalidate(f"post:{post['slug']}", f"comments:{post['slug']}", "home", "dashboard", "taxonomy")
    if action == "approve":
        await publish_event("comment.approved", {"commentId": comment_id, "postId": c["post_id"]})
    _audit(user, f"comment.{action}", comment_id)
    return ok({"id": comment_id, "status": target})


# ================================================================ 分类 / 标签
@router.get("/taxonomy")
def admin_taxonomy():
    cats = db.q("""SELECT c.id, c.name, c.description, c.sort, COUNT(p.id) AS count FROM categories c
                   LEFT JOIN posts p ON p.category_id=c.id AND p.status != 'trashed'
                   GROUP BY c.id ORDER BY c.sort, c.name""")
    tags = db.q("""SELECT t.id, t.name, COUNT(p.id) AS count FROM tags t
                   LEFT JOIN post_tags pt ON pt.tag_id=t.id
                   LEFT JOIN posts p ON p.id=pt.post_id AND p.status != 'trashed'
                   GROUP BY t.id ORDER BY count DESC, t.name""")
    return ok({"categories": cats, "tags": tags})


class CategoryIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=32)
    description: str = Field("", max_length=200)
    sort: int = 0


@router.post("/categories")
def create_category(body: CategoryIn, user: dict = Depends(current_user)):
    if db.q1("SELECT id FROM categories WHERE name=?", (body.name.strip(),)):
        raise_err(ERR_CONFLICT, "分类已存在")
    cid = db.uid()
    db.exec_("INSERT INTO categories(id,name,description,sort) VALUES(?,?,?,?)",
             (cid, body.name.strip(), body.description, body.sort))
    cache.invalidate("taxonomy", "home")
    _audit(user, "category.create", body.name)
    return ok({"id": cid})


@router.put("/categories/{cat_id}")
def update_category(cat_id: str, body: CategoryIn, user: dict = Depends(current_user)):
    if not db.q1("SELECT id FROM categories WHERE id=?", (cat_id,)):
        raise_err(ERR_NOT_FOUND, "分类不存在")
    dup = db.q1("SELECT id FROM categories WHERE name=? AND id != ?", (body.name.strip(), cat_id))
    if dup:
        raise_err(ERR_CONFLICT, "分类名已存在")
    db.exec_("UPDATE categories SET name=?, description=?, sort=? WHERE id=?",
             (body.name.strip(), body.description, body.sort, cat_id))
    cache.invalidate(*ALL_CACHE)
    _audit(user, "category.update", body.name)
    return ok({"id": cat_id})


@router.delete("/categories/{cat_id}")
def delete_category(cat_id: str, user: dict = Depends(current_user)):
    db.exec_("UPDATE posts SET category_id=NULL WHERE category_id=?", (cat_id,))
    db.exec_("DELETE FROM categories WHERE id=?", (cat_id,))
    cache.invalidate(*ALL_CACHE)
    _audit(user, "category.delete", cat_id)
    return ok({"id": cat_id})


class TagIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=32)


@router.put("/tags/{tag_id}")
def rename_tag(tag_id: str, body: TagIn, user: dict = Depends(current_user)):
    name = body.name.strip().lstrip("#")
    other = db.q1("SELECT id FROM tags WHERE name=? AND id != ?", (name, tag_id))
    if other:  # 重名即合并
        db.exec_("INSERT OR IGNORE INTO post_tags(post_id,tag_id) SELECT post_id, ? FROM post_tags WHERE tag_id=?",
                 (other["id"], tag_id))
        db.exec_("DELETE FROM post_tags WHERE tag_id=?", (tag_id,))
        db.exec_("DELETE FROM tags WHERE id=?", (tag_id,))
    else:
        db.exec_("UPDATE tags SET name=? WHERE id=?", (name, tag_id))
    cache.invalidate(*ALL_CACHE)
    _audit(user, "tag.rename", name)
    return ok({"merged": bool(other)})


@router.delete("/tags/{tag_id}")
def delete_tag(tag_id: str, user: dict = Depends(current_user)):
    db.exec_("DELETE FROM post_tags WHERE tag_id=?", (tag_id,))
    db.exec_("DELETE FROM tags WHERE id=?", (tag_id,))
    cache.invalidate(*ALL_CACHE)
    _audit(user, "tag.delete", tag_id)
    return ok({"id": tag_id})


# ================================================================ 站点设置 / 账号
@router.get("/site")
def get_site():
    row = db.q1("SELECT value FROM site_config WHERE key='site'")
    data = loads(row["value"]) if row else {}
    links = db.q("SELECT name,url,description FROM friend_links ORDER BY sort")
    data.setdefault("about", {})["friendLinks"] = [{"name": l["name"], "href": l["url"], "desc": l["description"]}
                                                   for l in links]
    return ok(data)


@router.put("/site")
def put_site(body: dict, user: dict = Depends(current_user)):
    if not isinstance(body.get("site"), dict):
        raise_err(ERR_PARAM, "缺少 site 字段")
    links = (body.get("about") or {}).get("friendLinks")
    if isinstance(links, list):
        db.exec_("DELETE FROM friend_links")
        for i, f in enumerate(links[:100]):
            if f.get("name"):
                db.exec_("INSERT INTO friend_links(id,name,url,description,sort) VALUES(?,?,?,?,?)",
                         (db.uid(), str(f["name"])[:64], str(f.get("href") or "#")[:300], str(f.get("desc") or "")[:200], i))
    db.exec_("INSERT OR REPLACE INTO site_config(key,value,updated_at) VALUES('site',?,?)",
             (json.dumps(body, ensure_ascii=False), db.now()))
    cache.invalidate("site:config", "home", "taxonomy", "feed")
    _audit(user, "site.update", "")
    return ok({})


class PasswordIn(BaseModel):
    oldPassword: str
    newPassword: str = Field(..., min_length=8, max_length=128)


@router.put("/me/password")
def change_password(body: PasswordIn, user: dict = Depends(current_user)):
    if not verify_password(body.oldPassword, user["password_hash"]):
        raise_err(ERR_PARAM, "原密码不正确", {"field": "oldPassword"})
    db.exec_("UPDATE users SET password_hash=?, updated_at=? WHERE id=?",
             (hash_password(body.newPassword), db.now(), user["id"]))
    revoke_user_sessions(user["id"])
    _audit(user, "user.password", "")
    return ok({}, "密码已修改，请重新登录")


# ================================================================ 看板
@router.get("/dashboard")
def dashboard():
    cached = cache.get("dashboard")
    if cached:
        return ok(cached)
    today = db.today()
    yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    t = db.q1("SELECT COALESCE(SUM(pv),0) AS pv, COALESCE(SUM(uv),0) AS uv FROM analytics_daily WHERE date=? AND post_id=''", (today,))
    y = db.q1("SELECT COALESCE(SUM(pv),0) AS pv FROM analytics_daily WHERE date=? AND post_id=''", (yesterday,))
    since = (datetime.now() - timedelta(days=29)).strftime("%Y-%m-%d")
    trend_rows = {r["date"]: r for r in db.q("""SELECT date, pv, uv FROM analytics_daily
                                               WHERE post_id='' AND date >= ? ORDER BY date""", (since,))}
    trend = []
    for i in range(30):
        d = (datetime.now() - timedelta(days=29 - i)).strftime("%Y-%m-%d")
        r = trend_rows.get(d) or {"pv": 0, "uv": 0}
        trend.append({"date": d, "pv": r["pv"], "uv": r["uv"]})
    counts = {r["status"]: r["c"] for r in db.q("SELECT status, COUNT(*) AS c FROM posts GROUP BY status")}
    words = db.q1("SELECT COALESCE(SUM(word_count),0) AS w FROM posts WHERE status IN ('published','pinned')")["w"]
    pending = db.q1("SELECT COUNT(*) AS c FROM comments WHERE status='pending'")["c"]
    top = db.q("""SELECT id, slug, title, view_count, comment_count, like_count FROM posts
                  WHERE status IN ('published','pinned') ORDER BY view_count DESC LIMIT 6""")
    drafts = db.q("SELECT id, title, updated_at FROM posts WHERE status='draft' ORDER BY updated_at DESC LIMIT 5")
    scheduled = db.q("SELECT id, title, scheduled_at FROM posts WHERE status='scheduled' ORDER BY scheduled_at LIMIT 5")
    cats = db.q("""SELECT c.name, COUNT(p.id) AS count FROM categories c LEFT JOIN posts p
                   ON p.category_id=c.id AND p.status IN ('published','pinned') GROUP BY c.id ORDER BY count DESC""")
    activity = db.q("SELECT action, detail, created_at FROM audit_logs ORDER BY id DESC LIMIT 8")
    try:
        disk = shutil.disk_usage(str(settings.UPLOAD_DIR))
        disk_pct = round(disk.used / disk.total * 100)
    except OSError:
        disk_pct = 0
    upload_bytes = db.q1("SELECT COALESCE(SUM(size_bytes),0) AS s FROM assets")["s"]
    data = {
        "today": {"pv": t["pv"], "uv": t["uv"], "pvYesterday": y["pv"]},
        "posts": {"published": counts.get("published", 0) + counts.get("pinned", 0), "draft": counts.get("draft", 0),
                  "scheduled": counts.get("scheduled", 0), "trashed": counts.get("trashed", 0), "words": words},
        "comments": {"pending": pending,
                     "approved": db.q1("SELECT COUNT(*) AS c FROM comments WHERE status='approved'")["c"]},
        "trend": trend,
        "top": [{"id": r["id"], "slug": r["slug"], "title": r["title"], "views": r["view_count"],
                 "comments": r["comment_count"], "likes": r["like_count"]} for r in top],
        "drafts": [{"id": r["id"], "title": r["title"], "ago": time_ago(r["updated_at"])} for r in drafts],
        "scheduled": [{"id": r["id"], "title": r["title"], "at": (r["scheduled_at"] or "")[:16]} for r in scheduled],
        "categories": cats,
        "activity": [{"action": a["action"], "detail": a["detail"], "ago": time_ago(a["created_at"])} for a in activity],
        "system": {"diskPercent": disk_pct, "uploadBytes": upload_bytes, "certDays": settings.CERT_DAYS,
                   "demoTotp": settings.DEMO_TOTP, "defaultSecret": settings.SECRET.startswith("dev-secret")},
    }
    cache.set("dashboard", data, 30)
    return ok(data)
