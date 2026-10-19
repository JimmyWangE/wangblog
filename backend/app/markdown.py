"""Markdown → HTML 渲染（服务端，文章详情 / RSS / 评论共用）。

- CommonMark + GFM 表格 / 删除线 / 任务列表 / 脚注 / 数学公式（$…$ / $$…$$）
- 标题自动生成锚点 id，并抽取 h2/h3 目录
- 代码块使用 Pygments 服务端高亮（读者端零 JS），mermaid 代码块输出为待渲染容器
- 统计字数与阅读时长、提取纯文本摘要
"""
import html
import re

from markdown_it import MarkdownIt
from mdit_py_plugins.dollarmath import dollarmath_plugin
from mdit_py_plugins.footnote import footnote_plugin
from mdit_py_plugins.tasklists import tasklists_plugin

try:  # Pygments 为可选依赖：缺失时降级为纯文本代码块
    from pygments import highlight as _pyg_highlight
    from pygments.formatters import HtmlFormatter
    from pygments.lexers import get_lexer_by_name
    from pygments.util import ClassNotFound

    _FORMATTER = HtmlFormatter(nowrap=True, classprefix="t-")
except ImportError:  # pragma: no cover
    _pyg_highlight = None

LANG_ALIAS = {"sh": "bash", "shell": "bash", "zsh": "bash", "js": "javascript", "ts": "typescript",
              "py": "python", "yml": "yaml", "conf": "nginx", "md": "markdown", "vue": "html"}


def _highlight_code(code: str, lang: str) -> str:
    if _pyg_highlight and lang:
        try:
            lexer = get_lexer_by_name(LANG_ALIAS.get(lang, lang), stripall=False)
            return _pyg_highlight(code, lexer, _FORMATTER).rstrip("\n")
        except ClassNotFound:
            pass
    return html.escape(code.rstrip("\n"))


def _slug(text: str) -> str:
    s = re.sub(r"[^\w一-鿿\- ]+", "", text.strip().lower())
    s = re.sub(r"[\s_]+", "-", s).strip("-")
    return s[:60] or "section"


def _render_fence(self, tokens, idx, options, env):
    token = tokens[idx]
    info = (token.info or "").strip().split()
    lang = info[0].lower() if info else ""
    code = token.content
    if lang == "mermaid":
        return f'<div class="mermaid-block" data-mermaid>{html.escape(code)}</div>\n'
    if lang in ("math", "latex", "katex"):
        return f'<div class="math-block" data-math="block">{html.escape(code)}</div>\n'
    label = html.escape(lang or "text")
    lines = code.rstrip("\n").count("\n") + 1
    return (f'<figure class="code-block" data-lang="{label}" data-lines="{lines}">'
            f'<figcaption><span class="code-block__lang">{label}</span>'
            f'<button type="button" class="code-block__copy" aria-label="复制代码">复制</button></figcaption>'
            f'<pre><code class="language-{label}">{_highlight_code(code, lang)}</code></pre></figure>\n')


def _build(html_enabled: bool) -> MarkdownIt:
    md = (MarkdownIt("commonmark", {"html": html_enabled, "linkify": False, "typographer": False, "breaks": False})
          .enable(["table", "strikethrough"]))
    md.use(tasklists_plugin).use(footnote_plugin)
    md.use(dollarmath_plugin, allow_space=True, double_inline=True)
    md.add_render_rule("fence", _render_fence)
    md.add_render_rule("code_block", _render_fence)
    md.add_render_rule("math_inline", lambda self, t, i, o, e: f'<span class="math-inline" data-math="inline">{html.escape(t[i].content)}</span>')
    md.add_render_rule("math_inline_double", lambda self, t, i, o, e: f'<div class="math-block" data-math="block">{html.escape(t[i].content)}</div>')
    md.add_render_rule("math_block", lambda self, t, i, o, e: f'<div class="math-block" data-math="block">{html.escape(t[i].content)}</div>\n')
    md.add_render_rule("math_block_label", lambda self, t, i, o, e: f'<div class="math-block" data-math="block">{html.escape(t[i].content)}</div>\n')
    return md


_md_post = _build(html_enabled=True)     # 作者内容：允许内嵌 HTML
_md_safe = _build(html_enabled=False)    # 访客评论：HTML 全部转义


def render_post(md_text: str) -> dict:
    """渲染文章，返回 {html, toc, words, readingMinutes, plain}。"""
    env: dict = {}
    tokens = _md_post.parse(md_text or "", env)
    toc, used = [], {}
    for i, tok in enumerate(tokens):
        if tok.type == "heading_open":
            inline = tokens[i + 1]
            text = "".join(c.content for c in (inline.children or []) if c.type in ("text", "code_inline")) or inline.content
            base = _slug(text)
            used[base] = used.get(base, 0) + 1
            hid = base if used[base] == 1 else f"{base}-{used[base]}"
            tok.attrSet("id", hid)
            level = int(tok.tag[1])
            if level in (2, 3):
                toc.append({"id": hid, "label": text.strip(), "level": level})
        elif tok.type == "image" or (tok.type == "inline" and tok.children):
            for child in tok.children or []:
                if child.type == "image":
                    child.attrSet("loading", "lazy")
                    child.attrSet("decoding", "async")
        elif tok.type == "table_open":
            tok.attrSet("class", "md-table")
    # 外链新窗口打开
    for tok in tokens:
        for child in tok.children or []:
            if child.type == "link_open":
                href = child.attrGet("href") or ""
                if href.startswith(("http://", "https://")):
                    child.attrSet("target", "_blank")
                    child.attrSet("rel", "noopener")
    html_out = _md_post.renderer.render(tokens, _md_post.options, env)
    html_out = re.sub(r"(<table[^>]*>)", r'<div class="table-wrap">\1', html_out).replace("</table>", "</table></div>")
    plain = to_plain(md_text)
    words = count_words(plain)
    return {"html": html_out, "toc": toc, "words": words, "readingMinutes": max(1, round(words / 300)) if words else 0,
            "plain": plain}


def render_comment(text: str) -> str:
    """评论：安全子集（转义 HTML、外链 nofollow、去掉图片与标题）。"""
    out = _md_safe.render(text or "")
    out = re.sub(r"<img[^>]*>", "", out)
    out = re.sub(r"<(/?)h[1-6]>", r"<\1p>", out)
    out = re.sub(r'<a href="(?!https?://|/|#)[^"]*"', '<a href="#"', out)  # 屏蔽 javascript: 等协议
    out = out.replace("<a href=", '<a rel="nofollow ugc noopener" target="_blank" href=')
    return out


def to_plain(md_text: str) -> str:
    text = re.sub(r"```[\s\S]*?```", " ", md_text or "")
    text = re.sub(r"\$\$[\s\S]*?\$\$", " ", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+", "", text, flags=re.M)
    text = re.sub(r"^[\s|:\-]{3,}$", " ", text, flags=re.M)
    text = re.sub(r"\[[ xX]\]\s", "", text)
    text = re.sub(r"\*\*|~~|[*`|]", "", text)
    text = re.sub(r"^\s*-{3,}\s*$", " ", text, flags=re.M)
    return re.sub(r"\s+", " ", text).strip()


def count_words(plain: str) -> int:
    cjk = len(re.findall(r"[一-鿿]", plain))
    latin = len(re.findall(r"[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*", plain))
    return cjk + latin


def make_excerpt(md_text: str, limit: int = 120) -> str:
    plain = to_plain(md_text)
    return plain[:limit] + ("…" if len(plain) > limit else "")
