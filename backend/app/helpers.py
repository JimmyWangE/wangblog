"""通用工具：响应包络、错误码、分页、ETag、搜索高亮、序列化。"""
import hashlib
import html
import json
import re
import uuid
from collections import defaultdict

from fastapi.responses import JSONResponse

from . import db


# ---------------------------------------------------------------- 响应包络
def ok(data=None, message: str = "ok") -> dict:
    return {"code": 0, "message": message, "data": data if data is not None else {}, "requestId": uuid.uuid4().hex}


class ApiError(Exception):
    def __init__(self, code: int, http_status: int, message: str, data=None):
        self.code, self.http_status, self.message, self.data = code, http_status, message, data or {}


def error_response(e: ApiError) -> JSONResponse:
    return JSONResponse(status_code=e.http_status,
                        content={"code": e.code, "message": e.message, "data": e.data, "requestId": uuid.uuid4().hex})


ERR_PARAM = (40001, 400)
ERR_UNAUTHORIZED = (40101, 401)
ERR_LOGIN_FAILED = (40103, 401)
ERR_FORBIDDEN = (40301, 403)
ERR_NOT_FOUND = (40401, 404)
ERR_SLUG_CONFLICT = (40901, 409)
ERR_CONFLICT = (40902, 409)
ERR_FILE_TOO_LARGE = (41301, 413)
ERR_FILE_TYPE = (41501, 415)
ERR_LOCKED = (42301, 423)
ERR_RATE_LIMITED = (42901, 429)
ERR_INTERNAL = (50001, 500)


def raise_err(err: tuple[int, int], message: str, data=None):
    raise ApiError(err[0], err[1], message, data)


# ---------------------------------------------------------------- 分页
def paginate(page: int = 1, page_size: int = 20, max_size: int = 100) -> tuple[int, int]:
    page = max(1, int(page or 1))
    page_size = min(max(1, int(page_size or 20)), max_size)
    return page, page_size


def page_result(items: list, total: int, page: int, page_size: int) -> dict:
    return {"list": items, "total": total, "page": page, "pageSize": page_size,
            "hasMore": page * page_size < total}


def make_etag(*parts) -> str:
    raw = "|".join(str(p) for p in parts)
    return 'W/"' + hashlib.md5(raw.encode()).hexdigest() + '"'


# ---------------------------------------------------------------- 搜索高亮 / 摘要
def highlight(text: str, keyword: str) -> str:
    escaped = html.escape(text or "")
    kw = html.escape(keyword)
    if not kw:
        return escaped
    return re.sub(re.escape(kw), lambda m: f"<mark>{m.group(0)}</mark>", escaped, flags=re.IGNORECASE)


def make_snippet(text: str, keyword: str, width: int = 60) -> str:
    idx = text.lower().find(keyword.lower())
    if idx < 0:
        return text[: width * 2] + ("…" if len(text) > width * 2 else "")
    start = max(0, idx - width // 2)
    end = min(len(text), idx + len(keyword) + width)
    return ("…" if start > 0 else "") + text[start:end] + ("…" if end < len(text) else "")


# ---------------------------------------------------------------- 序列化
def loads(s: str | None, default=None):
    if not s:
        return default if default is not None else {}
    try:
        return json.loads(s)
    except (TypeError, ValueError):
        return default if default is not None else {}


def post_date(row: dict) -> str:
    return (row.get("published_at") or row.get("scheduled_at") or row.get("created_at") or "")[:16]


def post_card(row: dict, tags: list[str]) -> dict:
    """前台文章卡片契约。"""
    return {
        "id": row["id"], "slug": row["slug"], "title": row["title"], "excerpt": row.get("excerpt") or "",
        "date": post_date(row)[:10], "datetime": post_date(row),
        "category": row.get("category_name") or "", "tags": tags,
        "readingMinutes": row.get("reading_minutes", 0), "words": row.get("word_count", 0),
        "commentCount": row.get("comment_count", 0), "views": row.get("view_count", 0),
        "likes": row.get("like_count", 0), "pinned": row["status"] == "pinned",
        "cover": loads(row.get("cover"), None) if row.get("cover") else None,
    }


def post_tags_map(post_ids: list[str]) -> dict[str, list[str]]:
    if not post_ids:
        return {}
    placeholders = ",".join("?" * len(post_ids))
    rows = db.q(f"""SELECT pt.post_id, t.name FROM post_tags pt JOIN tags t ON t.id=pt.tag_id
                    WHERE pt.post_id IN ({placeholders}) ORDER BY t.name""", post_ids)
    result: dict[str, list[str]] = defaultdict(list)
    for r in rows:
        result[r["post_id"]].append(r["name"])
    return result


def cards(rows: list[dict]) -> list[dict]:
    tags = post_tags_map([r["id"] for r in rows])
    return [post_card(r, tags.get(r["id"], [])) for r in rows]


SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{0,127}$")


def slugify(title: str) -> str:
    """中文标题无法直接 slug 化时退化为短随机串（作者可在编辑器中修改）。"""
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:80]
    return s if len(s) >= 3 else f"post-{uuid.uuid4().hex[:8]}"


def time_ago(ts: str) -> str:
    from datetime import datetime
    try:
        delta = datetime.now() - datetime.strptime(ts[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return ts
    secs = delta.total_seconds()
    if secs < 60:
        return "刚刚"
    if secs < 3600:
        return f"{int(secs // 60)} 分钟前"
    if secs < 86400:
        return f"{int(secs // 3600)} 小时前"
    if delta.days == 1:
        return f"昨天 {ts[11:16]}"
    if delta.days < 30:
        return f"{delta.days} 天前"
    return ts[:10]
