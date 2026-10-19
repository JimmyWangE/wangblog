"""SQLite 数据访问层（开发/演示）。生产切换 PostgreSQL 时只需替换本模块的连接与占位符。"""
import json
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
"""


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
        with _lock:
            _conn.executescript(SCHEMA)
    return _conn


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


# ---------------------------------------------------------------- 种子数据
def seed_if_empty() -> None:
    """首次启动时从 prototype 数据契约导入种子数据（对应架构文档 P1「数据导入」）。"""
    if q1("SELECT id FROM posts LIMIT 1"):
        return
    from .security import hash_password

    seed_dir: Path = settings.SEED_DIR
    posts_json = json.loads((seed_dir / "posts.json").read_text(encoding="utf-8"))
    comments_json = json.loads((seed_dir / "comments.json").read_text(encoding="utf-8"))
    taxonomy_json = json.loads((seed_dir / "taxonomy.json").read_text(encoding="utf-8"))
    dashboard_json = json.loads((seed_dir / "dashboard.json").read_text(encoding="utf-8"))
    site_json = json.loads(settings.SITE_SEED.read_text(encoding="utf-8"))

    ts = now()
    # 用户（admin 初始密码取 WB_ADMIN_PASSWORD，见 README）
    for uname, pwd in (("admin", settings.ADMIN_PASSWORD), ("reviewer", "review123")):
        exec_("INSERT INTO users(id,username,password_hash,totp_secret,created_at,updated_at) VALUES(?,?,?,?,?,?)",
              (uid(), uname, hash_password(pwd), "JBSWY3DPEHPK3PXP", ts, ts))

    # 分类 / 标签
    cat_ids, tag_ids = {}, {}
    for i, c in enumerate(taxonomy_json["categories"]):
        cat_ids[c["name"]] = uid()
        exec_("INSERT INTO categories(id,name,sort) VALUES(?,?,?)", (cat_ids[c["name"]], c["name"], i))
    for t in taxonomy_json["tags"]:
        tag_ids[t["name"]] = uid()
        exec_("INSERT INTO tags(id,name) VALUES(?,?)", (tag_ids[t["name"]], t["name"]))

    # 文章（含详情契约 detail / 编辑器字段 editor）
    post_ids = {}
    for p in posts_json["posts"]:
        pid = uid()
        post_ids[p["slug"]] = pid
        published_at = p["date"] + " 12:00:00" if p["status"] in ("published", "pinned") else None
        exec_(
            """INSERT INTO posts(id,slug,title,excerpt,content_md,detail,status,category_id,cover,
               reading_minutes,comment_count,scheduled_at,published_at,draft_note,editor,created_at,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (pid, p["slug"], p["title"], p.get("excerpt", ""), p.get("editor", {}).get("markdown", ""),
             json.dumps(p.get("detail", {}), ensure_ascii=False), p["status"],
             cat_ids.get(p["category"]), json.dumps(p.get("cover"), ensure_ascii=False) if p.get("cover") else None,
             p.get("readingMinutes", 0), p.get("commentCount") or 0, p.get("scheduledAt"), published_at,
             p.get("draftNote"), json.dumps(p.get("editor", {}), ensure_ascii=False), ts, ts))
        for t in p.get("tags", []):
            if t in tag_ids:
                exec_("INSERT OR IGNORE INTO post_tags(post_id,tag_id) VALUES(?,?)", (pid, tag_ids[t]))

    # 文章评论（已通过）+ 待审队列
    for slug, items in comments_json["byPost"].items():
        pid = post_ids.get(slug)
        if not pid:
            continue
        for c in items:
            exec_("""INSERT INTO comments(id,post_id,author_name,content,status,is_author,created_at,reviewed_at)
                     VALUES(?,?,?,?,?,?,?,?)""",
                  (uid(), pid, c["author"], c["body"], "approved", 1 if c.get("isAuthor") else 0,
                   c["time"], c["time"]))
    for c in comments_json["review"]["pending"]:
        pid = post_ids.get("http-cache-deep-dive")
        body = c["bodyHtml"].replace("<mark>", "").replace("</mark>", "")
        exec_("""INSERT INTO comments(id,post_id,author_name,author_email,content,status,flag,created_at)
                 VALUES(?,?,?,?,?,?,?,?)""",
              (uid(), pid, c["author"], None if c["contact"] in ("游客",) else c["contact"],
               body, "pending", c.get("flag"), ts))

    # 站点配置 / 友链
    exec_("INSERT INTO site_config(key,value,updated_at) VALUES('site',?,?)",
          (json.dumps(site_json, ensure_ascii=False), ts))
    for i, f in enumerate(site_json["about"].get("friendLinks", [])):
        exec_("INSERT INTO friend_links(id,name,url,description,sort) VALUES(?,?,?,?,?)",
              (uid(), f["name"], f["href"], f["desc"], i))

    # 看板热度：Top5 阅读量回写 view_count；近 30 天趋势写入 analytics_daily
    for item in dashboard_json["topPosts"]["items"]:
        views = int(float(item["num"].rstrip("k")) * 1000)
        exec_("UPDATE posts SET view_count=? WHERE slug=?", (views, item["slug"]))
    values = dashboard_json["trend"]["values"]
    base = datetime.now() - timedelta(days=len(values) - 1)
    for i, v in enumerate(values):
        d = (base + timedelta(days=i)).strftime("%Y-%m-%d")
        exec_("INSERT INTO analytics_daily(date,post_id,pv,uv,mer) VALUES(?,?,?,?,?)",
              (d, "", v * 40, v * 27, v * 11))

    exec_("INSERT INTO audit_logs(user_id,action,detail,created_at) VALUES(NULL,'seed','prototype data imported',?)", (ts,))
