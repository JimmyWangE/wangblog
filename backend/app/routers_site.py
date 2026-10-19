"""站点级路由：RSS、Sitemap、robots，以及前端单页应用（SPA）托管与 SEO 元信息注入。

当 WB_SERVE_WEB=true（默认）时，后端直接托管 web/ 目录：
  /assets/*、/favicon.svg 等静态文件 → 原样返回
  /admin/*                         → web/admin/index.html（后台 SPA）
  其它路径                          → web/index.html（前台 SPA），并按路由注入 <title>/description/OG 标签，
                                      让分享卡片与搜索引擎在不执行 JS 的情况下也能拿到正确信息。
"""
import html
import json
import re
from email.utils import format_datetime
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, HTMLResponse, Response

from . import db
from .config import settings
from .routers_public import PUB_SQL, get_public_post, site_config_data
from .services import cache

router = APIRouter(tags=["站点"])


def _base_url(request: Request) -> str:
    if settings.SITE_URL:
        return settings.SITE_URL
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}"


def _rfc822(ts: str) -> str:
    try:
        return format_datetime(datetime.strptime(ts[:19], "%Y-%m-%d %H:%M:%S").astimezone())
    except ValueError:
        return ""


@router.get("/rss.xml", include_in_schema=False)
@router.get("/feed", include_in_schema=False)
def rss(request: Request):
    base = _base_url(request)
    key = f"feed:rss:{base}"
    xml = cache.get(key)
    if not xml:
        cfg = site_config_data().get("site", {})
        rows = db.q(f"""SELECT p.slug,p.title,p.excerpt,p.content_html,p.published_at,c.name AS category FROM posts p
                        LEFT JOIN categories c ON c.id=p.category_id WHERE {PUB_SQL}
                        ORDER BY p.published_at DESC LIMIT 20""")
        items = "".join(
            f"""<item><title>{html.escape(r['title'])}</title><link>{base}/post/{r['slug']}</link>
<guid isPermaLink="true">{base}/post/{r['slug']}</guid><pubDate>{_rfc822(r['published_at'] or '')}</pubDate>
<category>{html.escape(r['category'] or '')}</category><description>{html.escape(r['excerpt'] or '')}</description>
<content:encoded><![CDATA[{(r['content_html'] or '').replace(']]>', ']]&gt;')}]]></content:encoded></item>"""
            for r in rows)
        xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel><title>{html.escape(cfg.get('name', 'WangBlog'))}</title><link>{base}/</link>
<atom:link href="{base}/rss.xml" rel="self" type="application/rss+xml"/>
<description>{html.escape(cfg.get('description', ''))}</description><language>zh-CN</language>{items}</channel></rss>"""
        cache.set(key, xml, 600)
    return Response(xml, media_type="application/rss+xml; charset=utf-8")


@router.get("/sitemap.xml", include_in_schema=False)
def sitemap(request: Request):
    base = _base_url(request)
    rows = db.q(f"SELECT slug, updated_at FROM posts p WHERE {PUB_SQL} ORDER BY published_at DESC")
    urls = [f"<url><loc>{base}/</loc><changefreq>daily</changefreq></url>",
            f"<url><loc>{base}/archive</loc></url>", f"<url><loc>{base}/about</loc></url>"]
    urls += [f"<url><loc>{base}/post/{r['slug']}</loc><lastmod>{(r['updated_at'] or '')[:10]}</lastmod></url>" for r in rows]
    xml = ('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
           + "".join(urls) + "</urlset>")
    return Response(xml, media_type="application/xml")


@router.get("/robots.txt", include_in_schema=False)
def robots(request: Request):
    return Response(f"User-agent: *\nDisallow: /admin/\nDisallow: /api/\nSitemap: {_base_url(request)}/sitemap.xml\n",
                    media_type="text/plain")


# ---------------------------------------------------------------- SPA 托管
_index_cache: dict[str, tuple[float, str]] = {}


def _read_index(path: Path) -> str:
    mtime = path.stat().st_mtime
    hit = _index_cache.get(str(path))
    if hit and hit[0] == mtime:
        return hit[1]
    text = path.read_text(encoding="utf-8")
    _index_cache[str(path)] = (mtime, text)
    return text


def _inject_meta(page: str, title: str, desc: str, url: str, extra: str = "") -> str:
    t, d = html.escape(title), html.escape(desc)
    meta = (f'<title>{t}</title>\n<meta name="description" content="{d}">\n'
            f'<meta property="og:title" content="{t}">\n<meta property="og:description" content="{d}">\n'
            f'<meta property="og:url" content="{html.escape(url)}">\n<meta property="og:type" content="website">\n'
            f'<link rel="canonical" href="{html.escape(url)}">\n{extra}')
    page = re.sub(r"<title>.*?</title>\s*", "", page, count=1, flags=re.S)
    page = re.sub(r'<meta name="description"[^>]*>\s*', "", page, count=1)
    return page.replace("<!--wb:meta-->", meta, 1)


def spa_response(request: Request, path: str) -> Response:
    web = settings.WEB_DIR
    if path.startswith("admin"):
        return FileResponse(web / "admin" / "index.html", headers={"Cache-Control": "no-cache"})
    index = web / "index.html"
    page = _read_index(index)
    cfg = site_config_data().get("site", {})
    name = cfg.get("name", "WangBlog")
    base = _base_url(request)
    title, desc, extra, status = f"{name} — {cfg.get('slogan', '')}", cfg.get("description", ""), "", 200
    m = re.match(r"^post/([^/]+)/?$", path)
    if m:
        post = get_public_post(m.group(1))
        if post:
            title, desc = f"{post['title']} — {name}", post["excerpt"] or desc
            ld = {"@context": "https://schema.org", "@type": "BlogPosting", "headline": post["title"],
                  "datePublished": (post["published_at"] or "")[:10], "dateModified": (post["updated_at"] or "")[:10],
                  "author": {"@type": "Person", "name": cfg.get("author", "")}, "description": desc}
            extra = ('<meta property="article:published_time" content="' + (post["published_at"] or "")[:10] + '">\n'
                     '<script type="application/ld+json">' + json.dumps(ld, ensure_ascii=False).replace("</", "<\\/")
                     + "</script>\n")
        else:
            status = 404
    elif path.startswith("category/"):
        title = f"分类：{path.split('/', 1)[1]} — {name}"
    elif path.startswith("tag/"):
        title = f"标签：{path.split('/', 1)[1]} — {name}"
    elif path in ("archive", "about", "search"):
        title = {"archive": "归档", "about": "关于", "search": "搜索"}[path] + f" — {name}"
    from urllib.parse import unquote
    title = unquote(title)
    body = _inject_meta(page, title, desc, f"{base}/{path}", extra)
    return HTMLResponse(body, status_code=status, headers={"Cache-Control": "no-cache"})
