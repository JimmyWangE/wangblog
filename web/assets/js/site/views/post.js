/* 文章详情：服务端渲染正文 + 目录联动 + 阅读进度 + 点赞/分享 + 无刷新评论 */
import { api, invalidate } from "../../lib/api.js";
import { enhance, rerenderMermaid } from "../../lib/enhance.js";
import { toast, copyText, reveal, modal } from "../../lib/ui.js";
import { $, $$, html, raw, mount, icon, fmtDate, fmtNum, urlFor, rafThrottle, toStr } from "../../lib/util.js";
import { state } from "../state.js";
import { cover, miniCard, errorState } from "../components.js";
import { notFoundView } from "./notfound.js";

const LIKED_KEY = "wb-liked";
const likedSet = () => { try { return new Set(JSON.parse(localStorage.getItem(LIKED_KEY) || "[]")); } catch { return new Set(); } };
const saveLiked = (s) => { try { localStorage.setItem(LIKED_KEY, JSON.stringify([...s].slice(-500))); } catch { /* noop */ } };
const PROFILE_KEY = "wb-commenter";

export async function postView(outlet, ctx) {
  const slug = ctx.params.slug;
  mount(outlet, html`<div class="container">${skeleton()}</div>`);
  let p;
  try { p = await api.post(slug); }
  catch (e) {
    if (ctx.isStale()) return;
    if (e.code === 40401) return notFoundView(outlet, ctx);
    mount(outlet, html`<div class="container" style="padding-top:80px">${errorState(e)}</div>`);
    $("[data-retry]", outlet)?.addEventListener("click", () => postView(outlet, ctx));
    return;
  }
  if (ctx.isStale()) return;
  const siteName = state.site.site?.name || "";
  document.title = `${p.title} — ${siteName}`;
  const liked = likedSet().has(slug);

  mount(outlet, html`
  <div class="read-progress" aria-hidden="true"><i></i></div>
  <article>
    <header class="article-head container view-enter">
      <nav class="crumbs" aria-label="面包屑"><a href="/">首页</a><span class="sep">/</span>
        ${p.category ? html`<a href="${urlFor.category(p.category)}">${p.category}</a><span class="sep">/</span>` : ""}<span>正文</span></nav>
      <h1 class="article-title">${p.title}</h1>
      <div class="article-meta">
        <span class="meta-i">${icon("calendar")}${fmtDate(p.date)}</span>
        ${p.updatedAt && p.updatedAt.slice(0, 10) !== p.date ? html`<span class="meta-i">${icon("edit")}更新于 ${fmtDate(p.updatedAt)}</span>` : ""}
        <span class="meta-i">${icon("file")}${fmtNum(p.words)} 字</span>
        <span class="meta-i">${icon("clock")}约 ${p.readingMinutes || 1} 分钟</span>
        <span class="meta-i">${icon("eye")}${fmtNum(p.views)} 阅读</span>
      </div>
      ${p.tags?.length ? html`<div class="article-tags">${p.tags.map((t) => html`<a class="chip" href="${urlFor.tag(t)}">#${t}</a>`)}</div>` : ""}
    </header>
    ${p.cover ? html`<div class="container"><div class="article-cover view-enter">${cover(p)}</div></div>` : ""}

    <div class="container">
      <div class="article-layout">
        <div class="article-rail" aria-label="文章操作">
          <button class="rail-btn ${liked ? "is-liked" : ""}" data-like title="点赞" aria-pressed="${liked}">${icon("heart")}<small data-like-n>${p.likes || 0}</small></button>
          <span class="rail-sep"></span>
          <a class="rail-btn" href="#comments" title="评论">${icon("msg")}<small>${p.commentCount || 0}</small></a>
          <span class="rail-sep"></span>
          <button class="rail-btn" data-share title="复制链接">${icon("link")}</button>
        </div>

        <div>
          <div class="prose" data-content>${raw(p.contentHtml)}</div>

          <div class="article-end">
            ${icon("sparkles")}
            <p>本文由 <b>${state.site.site?.author || ""}</b> 原创，采用 CC BY-NC-SA 4.0 协议，转载请注明出处。</p>
            <button class="btn btn--sm" data-share>${icon("link")}复制链接</button>
          </div>

          <nav class="post-nav" aria-label="上一篇 / 下一篇">
            ${p.prev ? html`<a href="${urlFor.post(p.prev.slug)}" data-prefetch="${p.prev.slug}"><small>${icon("arrowLeft")}上一篇</small><b>${p.prev.title}</b></a>` : html`<span></span>`}
            ${p.next ? html`<a class="next" href="${urlFor.post(p.next.slug)}" data-prefetch="${p.next.slug}"><small>下一篇${icon("arrowRight")}</small><b>${p.next.title}</b></a>` : ""}
          </nav>

          ${p.related?.length ? html`<section class="related"><h2 class="section__title"><span class="idx">↗</span>相关推荐</h2>
            <div class="related__grid">${p.related.map(miniCard)}</div></section>` : ""}

          <section class="comments" id="comments">
            <h2 class="comments__head">${icon("msg")}评论 <span class="badge" data-cmt-total>${p.commentCount || 0}</span></h2>
            ${commentForm()}
            <div class="comment-list" data-cmt-list><div class="skeleton sk-line"></div><div class="skeleton sk-line" style="width:60%"></div></div>
          </section>
        </div>

        <aside class="toc" aria-label="目录" data-toc>${tocTpl(p.toc)}</aside>
      </div>
    </div>
  </article>
  ${p.toc?.length ? html`<button class="toc-fab" data-toc-open aria-label="目录">${icon("list")}</button>` : ""}`);

  const content = $("[data-content]", outlet);
  enhance(content);
  const cleanups = [];
  cleanups.push(bindProgress(outlet, p, slug));
  cleanups.push(bindTocSpy(outlet));
  cleanups.push(bindActions(outlet, p, slug));
  bindComments(outlet, slug);
  const onTheme = () => rerenderMermaid(content);
  window.addEventListener("themechange", onTheme);
  cleanups.push(() => window.removeEventListener("themechange", onTheme));
  api.track({ event: "view", slug });
  reveal(outlet);
  return () => cleanups.forEach((f) => f && f());
}

function skeleton() {
  return html`<div style="max-width:760px;margin:70px auto 0">
    <div class="skeleton sk-line" style="width:20%;margin:0 auto"></div>
    <div class="skeleton" style="height:44px;margin:22px auto;width:80%"></div>
    <div class="skeleton sk-line" style="width:40%;margin:0 auto 50px"></div>
    ${Array.from({ length: 8 }, (_, i) => html`<div class="skeleton sk-line" style="width:${[100, 96, 88, 100, 70, 92, 100, 60][i]}%"></div>`)}</div>`;
}

function tocTpl(toc) {
  if (!toc?.length) return "";
  return html`<div class="toc__title">${icon("list")}目录</div>
    <ol>${toc.map((t) => html`<li><a class="lv${t.level}" href="#${t.id}" data-toc-id="${t.id}">${t.label}</a></li>`)}</ol>`;
}

/* 阅读进度条 + 读完事件 */
function bindProgress(outlet, p, slug) {
  const bar = $(".read-progress i", outlet);
  const article = $("[data-content]", outlet);
  let finished = false;
  const onScroll = rafThrottle(() => {
    const r = article.getBoundingClientRect();
    const total = r.height - window.innerHeight * 0.6;
    const ratio = Math.max(0, Math.min(1, -r.top / Math.max(total, 1)));
    bar.style.transform = `scaleX(${ratio})`;
    if (!finished && ratio > 0.92) { finished = true; api.track({ event: "read_finish", slug }); }
  });
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  return () => { onScroll.cancel(); window.removeEventListener("scroll", onScroll); };
}

/* 目录高亮跟随 + 移动端目录面板 */
function bindTocSpy(outlet) {
  const links = $$("[data-toc-id]", outlet);
  const heads = links.map((a) => document.getElementById(a.dataset.tocId)).filter(Boolean);
  if (!heads.length) return null;
  const toc = $("[data-toc]", outlet);
  let curId = null;
  const onScroll = rafThrottle(() => {
    let cur = heads[0].id;
    for (const h of heads) { if (h.getBoundingClientRect().top < 120) cur = h.id; else break; }
    if (cur === curId) return; // 未跨越标题时不触碰 DOM
    curId = cur;
    let active = null;
    links.forEach((a) => { const on = a.dataset.tocId === cur; a.classList.toggle("is-active", on); if (on) active = a; });
    if (active && toc.clientHeight) { const t = active.offsetTop - toc.clientHeight / 2; if (Math.abs(toc.scrollTop - t) > 80) toc.scrollTo({ top: t, behavior: "smooth" }); }
  });
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  const fab = $("[data-toc-open]", outlet);
  fab?.addEventListener("click", () => {
    const m = modal({ title: "目录", body: html`<div class="toc-sheet"><aside class="toc">${raw($("[data-toc]", outlet).innerHTML)}</aside></div>`, width: 420 });
    m.el.addEventListener("click", (e) => {
      const a = e.target.closest("a[href^='#']");
      if (a) { e.preventDefault(); m.close(); document.getElementById(a.getAttribute("href").slice(1))?.scrollIntoView({ behavior: "smooth" }); }
    });
  });
  return () => { onScroll.cancel(); window.removeEventListener("scroll", onScroll); };
}

function bindActions(outlet, p, slug) {
  const onClick = async (e) => {
    if (e.target.closest("[data-share]")) {
      const ok = await copyText(location.origin + urlFor.post(slug));
      toast(ok ? "链接已复制，快去分享吧" : "复制失败，请手动复制地址栏", ok ? "success" : "error");
    }
    const likeBtn = e.target.closest("[data-like]");
    if (likeBtn && !likeBtn.disabled) {
      likeBtn.disabled = true;
      try {
        const d = await api.like(slug);
        const set = likedSet();
        d.liked ? set.add(slug) : set.delete(slug);
        saveLiked(set);
        likeBtn.classList.toggle("is-liked", d.liked);
        likeBtn.setAttribute("aria-pressed", d.liked);
        $("[data-like-n]", likeBtn).textContent = d.likes;
        if (d.liked) toast("感谢你的喜欢 ❤", "success");
        invalidate(`/api/posts/${encodeURIComponent(slug)}`);
      } catch (err) { toast(err.message, "error"); }
      likeBtn.disabled = false;
    }
    const tocLink = e.target.closest(".toc a[href^='#']");
    if (tocLink) {
      e.preventDefault();
      const el = document.getElementById(decodeURIComponent(tocLink.getAttribute("href").slice(1)));
      if (el) { el.scrollIntoView({ behavior: "smooth" }); history.replaceState(null, "", "#" + el.id); }
    }
  };
  outlet.addEventListener("click", onClick);
  return () => outlet.removeEventListener("click", onClick);
}

/* ---------------------------------------------------------------- 评论 */
function commentForm() {
  let prof = {};
  try { prof = JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}"); } catch { /* noop */ }
  return html`<form class="comment-form" data-cmt-form novalidate>
    <div class="replying" data-replying hidden></div>
    <textarea name="content" placeholder="写下你的想法…（支持 Markdown，Ctrl/⌘ + Enter 发送）" maxlength="2000" aria-label="评论内容" required></textarea>
    <input name="hp" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
    <div class="comment-form__row">
      <input class="input" name="nick" placeholder="昵称 *" maxlength="32" value="${prof.nick || ""}" aria-label="昵称">
      <input class="input" name="email" type="email" placeholder="邮箱（不公开，可选）" maxlength="128" value="${prof.email || ""}" aria-label="邮箱">
      <button class="btn btn--primary" type="submit">${icon("send")}发布评论</button>
    </div>
    <div class="comment-form__tip">${icon("shield")}评论经审核后公开展示 · 请文明交流</div>
  </form>`;
}

function commentTpl(c, isReply = false) {
  return html`<div class="comment ${c.pending ? "comment--pending" : ""}" id="c-${c.id}" data-cid="${c.id}">
    <div class="comment__avatar" style="--h:${c.avatarHue || 220}">${c.avatarText}</div>
    <div>
      <div class="comment__meta"><b>${c.author}</b>
        ${c.isAuthor ? html`<span class="badge badge--grad">作者</span>` : ""}
        ${c.replyTo && isReply ? html`<span>回复 <b style="font-size:13px">@${c.replyTo}</b></span>` : ""}
        <span title="${c.time}">${c.timeAgo}</span>
        ${c.pending ? html`<span class="badge badge--warning">审核中，仅你可见</span>` : ""}</div>
      <div class="comment__body">${raw(c.html)}</div>
      ${c.pending ? "" : html`<div class="comment__actions"><button type="button" data-reply="${c.id}" data-reply-name="${c.author}">${icon("reply")}回复</button></div>`}
      ${!isReply && c.replies?.length ? html`<div class="comment__replies">${c.replies.map((r) => commentTpl(r, true))}</div>` : ""}
    </div></div>`;
}

async function bindComments(outlet, slug) {
  const list = $("[data-cmt-list]", outlet);
  const form = $("[data-cmt-form]", outlet);
  const replying = $("[data-replying]", form);
  let parentId = null;

  const load = async (force) => {
    try {
      const d = await api.comments(slug, force);
      $("[data-cmt-total]", outlet).textContent = d.total;
      mount(list, d.list.length ? d.list.map((c) => commentTpl(c)) : html`<div class="empty" style="padding:30px 0"><p>还没有评论，来抢沙发吧 ✨</p></div>`);
    } catch (e) { mount(list, errorState(e)); }
  };
  // 评论区进入视口时再加载
  const io = new IntersectionObserver((en) => { if (en[0].isIntersecting) { io.disconnect(); load(); } }, { rootMargin: "600px" });
  io.observe(list);
  if (location.hash === "#comments") load();

  list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-reply]");
    if (b) {
      parentId = b.dataset.reply;
      replying.hidden = false;
      mount(replying, html`${icon("reply")}回复 @${b.dataset.replyName}<button type="button" data-cancel-reply>取消</button>`);
      form.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => form.content.focus(), 300);
    }
    if (e.target.closest("[data-retry]")) load(true);
  });
  replying.addEventListener("click", (e) => {
    if (e.target.closest("[data-cancel-reply]")) { parentId = null; replying.hidden = true; }
  });
  form.content.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) form.requestSubmit(); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const content = form.content.value.trim();
    const nick = form.nick.value.trim();
    const email = form.email.value.trim();
    if (!content) { toast("评论内容不能为空", "warning"); form.content.focus(); return; }
    if (!nick) { toast("请填写昵称", "warning"); form.nick.focus(); return; }
    const btn = $("button[type=submit]", form);
    btn.classList.add("is-loading");
    try {
      const d = await api.submitComment(slug, { content, nick, email: email || null, parentId, hp: form.hp.value });
      try { localStorage.setItem(PROFILE_KEY, JSON.stringify({ nick, email })); } catch { /* noop */ }
      form.content.value = "";
      const c = { ...d.comment, pending: d.status !== "approved" };
      const node = document.createElement("div");
      node.innerHTML = toStr(commentTpl(c, !!parentId));
      const el = node.firstElementChild;
      el.classList.add("is-new");
      if (parentId) {
        const parent = $(`[data-cid="${parentId}"]`, list);
        const root = parent?.closest(".comment__replies")?.closest(".comment") || parent;
        let box = root && $(".comment__replies", root);
        if (root && !box) { box = document.createElement("div"); box.className = "comment__replies"; root.lastElementChild.appendChild(box); }
        (box || list).appendChild(el);
      } else {
        $(".empty", list)?.remove();
        list.prepend(el);
      }
      parentId = null; replying.hidden = true;
      toast(d.status === "approved" ? "评论已发布" : "评论已提交，审核通过后公开展示", "success");
      invalidate(`/api/posts/${encodeURIComponent(slug)}`);
    } catch (err) { toast(err.message, "error"); }
    btn.classList.remove("is-loading");
  });
  return () => io.disconnect();
}
