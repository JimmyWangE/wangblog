"""SQLite 数据访问层：Schema、轻量迁移、种子数据导入。

生产切换 PostgreSQL 时只需替换本模块的连接与占位符。
"""
import json
import re
import sqlite3
import threading
import uuid
from datetime import datetime, timedelta
from pathlib import Path

from .config import settings

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  totp_secret TEXT NOT NULL DEFAULT '', recovery_codes TEXT NOT NULL DEFAULT '[]',
  locked_until TEXT, failed_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS categories(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tags(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS posts(
  id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, excerpt TEXT,
  content_md TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft', category_id TEXT REFERENCES categories(id),
  cover TEXT, reading_minutes INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0, view_count INTEGER NOT NULL DEFAULT 0,
  scheduled_at TEXT, published_at TEXT, git_commit TEXT,
  draft_note TEXT, editor TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_posts_status_date ON posts(status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_cat ON posts(category_id, published_at DESC);
CREATE TABLE IF NOT EXISTS post_tags(post_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY(post_id, tag_id));
CREATE TABLE IF NOT EXISTS post_versions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL, content_md TEXT NOT NULL,
  version_no INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(post_id, version_no));
CREATE INDEX IF NOT EXISTS idx_versions_created ON post_versions(created_at);
CREATE TABLE IF NOT EXISTS comments(
  id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES posts(id), parent_id TEXT,
  author_name TEXT NOT NULL, author_email TEXT, author_ip TEXT,
  content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  flag TEXT, is_author INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, reviewed_at TEXT);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status, created_at);
CREATE TABLE IF NOT EXISTS assets(
  id TEXT PRIMARY KEY, post_id TEXT, filename TEXT NOT NULL, mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL, oss_key TEXT UNIQUE NOT NULL, uploader_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS site_config(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS friend_links(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL DEFAULT '#',
  description TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS analytics_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT, event TEXT NOT NULL,
  uv_hash TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS analytics_daily(
  date TEXT NOT NULL, post_id TEXT NOT NULL DEFAULT '',
  pv INTEGER NOT NULL DEFAULT 0, uv INTEGER NOT NULL DEFAULT 0, mer INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(date, post_id));
CREATE TABLE IF NOT EXISTS idempotency_keys(key TEXT PRIMARY KEY, response TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS refresh_tokens(
  jti TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS post_likes(
  post_id TEXT NOT NULL, visitor TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(post_id, visitor));
"""

# 增量迁移：(表, 列, 定义)。对已有线上库执行 ALTER TABLE，幂等。
MIGRATIONS = [
    ("posts", "visibility", "TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private'))"),
    ("posts", "content_html", "TEXT NOT NULL DEFAULT ''"),
    ("posts", "toc", "TEXT NOT NULL DEFAULT '[]'"),
    ("posts", "word_count", "INTEGER NOT NULL DEFAULT 0"),
    ("posts", "like_count", "INTEGER NOT NULL DEFAULT 0"),
    ("posts", "render_ver", "INTEGER NOT NULL DEFAULT 0"),
    ("categories", "description", "TEXT NOT NULL DEFAULT ''"),
    ("categories", "slug", "TEXT"),
]

RENDER_VERSION = 2  # 渲染器升级时 +1，启动时自动重渲染所有文章


def now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def uid() -> str:
    return uuid.uuid4().hex


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        Path(settings.DB_PATH).parent.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(settings.DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA foreign_keys = ON")
        _conn.execute("PRAGMA journal_mode = WAL")
        with _lock:
            _conn.executescript(SCHEMA)
            _migrate(_conn)
    return _conn


def _migrate(c: sqlite3.Connection) -> None:
    for table, column, ddl in MIGRATIONS:
        cols = {r[1] for r in c.execute(f"PRAGMA table_info({table})")}
        if column not in cols:
            c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
    c.commit()


def q(sql: str, args=()) -> list[dict]:
    with _lock:
        cur = conn().execute(sql, args)
        return [dict(r) for r in cur.fetchall()]


def q1(sql: str, args=()) -> dict | None:
    rows = q(sql, args)
    return rows[0] if rows else None


def exec_(sql: str, args=()) -> int:
    with _lock:
        cur = conn().execute(sql, args)
        conn().commit()
        return cur.rowcount


# ---------------------------------------------------------------- 渲染缓存列
def rerender_post(post_id: str) -> None:
    """从 content_md 渲染并写回 content_html / toc / 字数 / 阅读时长 / 摘要。"""
    from .markdown import make_excerpt, render_post

    row = q1("SELECT content_md, detail, excerpt FROM posts WHERE id=?", (post_id,))
    if not row:
        return
    md = row["content_md"] or ""
    if md.strip():
        r = render_post(md)
        excerpt = row["excerpt"] or make_excerpt(md)
        exec_("""UPDATE posts SET content_html=?, toc=?, word_count=?, reading_minutes=?, excerpt=?, render_ver=?
                 WHERE id=?""",
              (r["html"], json.dumps(r["toc"], ensure_ascii=False), r["words"], r["readingMinutes"],
               excerpt, RENDER_VERSION, post_id))
    else:
        # 兼容旧数据：只有预渲染 HTML（detail.contentHtml）而没有 Markdown 的文章
        try:
            detail = json.loads(row["detail"] or "{}")
        except ValueError:
            detail = {}
        legacy = detail.get("contentHtml") or ""
        exec_("UPDATE posts SET content_html=?, toc=?, render_ver=? WHERE id=?",
              (legacy, json.dumps(detail.get("toc", []), ensure_ascii=False), RENDER_VERSION, post_id))


def rerender_outdated() -> int:
    rows = q("SELECT id FROM posts WHERE render_ver < ?", (RENDER_VERSION,))
    for r in rows:
        rerender_post(r["id"])
    return len(rows)


# ---------------------------------------------------------------- 种子数据
def _parse_front_matter(text: str) -> tuple[dict, str]:
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.S)
    if not m:
        return {}, text
    meta = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip()
    return meta, m.group(2).lstrip("\n")


def seed_if_empty() -> None:
    """空库首次启动：创建管理员、站点配置；WB_SEED_DEMO=true 时导入演示文章与评论。"""
    if q1("SELECT id FROM users LIMIT 1"):
        return
    from .security import hash_password

    ts = now()
    exec_("INSERT INTO users(id,username,password_hash,totp_secret,created_at,updated_at) VALUES(?,?,?,?,?,?)",
          (uid(), "admin", hash_password(settings.ADMIN_PASSWORD), "JBSWY3DPEHPK3PXP", ts, ts))

    seed_dir: Path = settings.SEED_DIR
    site_file = seed_dir / "site.json"
    site_json = json.loads(site_file.read_text(encoding="utf-8")) if site_file.exists() else {}
    exec_("INSERT OR REPLACE INTO site_config(key,value,updated_at) VALUES('site',?,?)",
          (json.dumps(site_json, ensure_ascii=False), ts))
    for i, f in enumerate(site_json.get("about", {}).get("friendLinks", [])):
        exec_("INSERT INTO friend_links(id,name,url,description,sort) VALUES(?,?,?,?,?)",
              (uid(), f["name"], f["href"], f.get("desc", ""), i))
    cat_desc = site_json.get("categories", {})
    for i, (name, desc) in enumerate(cat_desc.items()):
        exec_("INSERT OR IGNORE INTO categories(id,name,sort,description) VALUES(?,?,?,?)", (uid(), name, i, desc))

    if q1("SELECT id FROM posts LIMIT 1") or not settings.SEED_DEMO:
        return
    _seed_demo(seed_dir, ts)


def _seed_demo(seed_dir: Path, ts: str) -> None:
    post_ids: dict[str, str] = {}
    for f in sorted((seed_dir / "posts").glob("*.md")):
        meta, body = _parse_front_matter(f.read_text(encoding="utf-8"))
        slug = f.stem
        cat_name = meta.get("category", "")
        cat = q1("SELECT id FROM categories WHERE name=?", (cat_name,))
        if not cat and cat_name:
            cid = uid()
            exec_("INSERT INTO categories(id,name,sort) VALUES(?,?,?)", (cid, cat_name, 99))
            cat = {"id": cid}
        date = meta.get("date", ts)
        if len(date) == 16:
            date += ":00"
        status = meta.get("status", "draft")
        pid = uid()
        post_ids[slug] = pid
        exec_("""INSERT INTO posts(id,slug,title,excerpt,content_md,status,category_id,cover,view_count,
                 scheduled_at,published_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
              (pid, slug, meta.get("title", slug), meta.get("excerpt", ""), body, status, cat and cat["id"],
               meta.get("cover") or None, int(meta.get("views", 0) or 0),
               date if status == "scheduled" else None,
               date if status in ("published", "pinned") else None, date, date))
        for t in [x.strip() for x in meta.get("tags", "").split(",") if x.strip()]:
            tag = q1("SELECT id FROM tags WHERE name=?", (t,))
            tid = tag["id"] if tag else uid()
            if not tag:
                exec_("INSERT INTO tags(id,name) VALUES(?,?)", (tid, t))
            exec_("INSERT OR IGNORE INTO post_tags(post_id,tag_id) VALUES(?,?)", (pid, tid))
        exec_("INSERT INTO post_versions(post_id,content_md,version_no,created_at) VALUES(?,?,1,?)", (pid, body, date))
        rerender_post(pid)

    cfile = seed_dir / "comments.json"
    if cfile.exists():
        by_post: dict[str, list[str]] = {}
        for c in json.loads(cfile.read_text(encoding="utf-8")).get("comments", []):
            pid = post_ids.get(c["post"])
            if not pid:
                continue
            cid = uid()
            siblings = by_post.setdefault(c["post"], [])
            parent = siblings[c["replyTo"]] if isinstance(c.get("replyTo"), int) and c["replyTo"] < len(siblings) else None
            siblings.append(cid)
            created = c.get("time") or ts
            exec_("""INSERT INTO comments(id,post_id,parent_id,author_name,author_email,content,status,flag,is_author,
                     created_at,reviewed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                  (cid, pid, parent, c["author"], c.get("email"), c["body"], c.get("status", "pending"),
                   c.get("flag"), 1 if c.get("isAuthor") else 0, created,
                   created if c.get("status") == "approved" else None))
        exec_("""UPDATE posts SET comment_count=(SELECT COUNT(*) FROM comments
                 WHERE comments.post_id=posts.id AND comments.status='approved')""")

    # 近 30 天访问趋势（演示数据，真实访问会叠加在上面）
    import random
    rnd = random.Random(42)
    base = datetime.now() - timedelta(days=29)
    for i in range(30):
        d = (base + timedelta(days=i)).strftime("%Y-%m-%d")
        pv = int(600 + i * 18 + rnd.randint(-120, 160) + (180 if (base + timedelta(days=i)).weekday() < 5 else -60))
        exec_("INSERT OR IGNORE INTO analytics_daily(date,post_id,pv,uv,mer) VALUES(?,?,?,?,?)",
              (d, "", pv, int(pv * 0.62), int(pv * 0.24)))
    exec_("INSERT INTO audit_logs(user_id,action,detail,created_at) VALUES(NULL,'seed','demo data imported',?)", (ts,))
