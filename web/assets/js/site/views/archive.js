/* 归档：按年份时间线，分类 / 标签筛选即时切换（URL 同步，可分享） */
import { api } from "../../lib/api.js";
import { reveal } from "../../lib/ui.js";
import { $, html, mount, icon, fmtDate, urlFor, fmtNum } from "../../lib/util.js";
import { state, go } from "../state.js";
import { emptyState, errorState } from "../components.js";

export async function archiveView(outlet, ctx) {
  document.title = `归档 — ${state.site.site?.name || ""}`;
  const category = ctx.query.category || "";
  const tag = ctx.query.tag || "";
  mount(outlet, html`<div class="container">
    <header class="page-head view-enter">
      <div class="page-head__kicker">${icon("archive")}Archive</div>
      <h1 class="page-head__title">文章<span class="grad-text">归档</span></h1>
      <p class="page-head__desc" data-summary>&nbsp;</p>
    </header>
    <div class="archive-filters card card--pad" data-filters><div class="skeleton sk-line"></div><div class="skeleton sk-line" style="width:70%"></div></div>
    <div class="timeline" data-timeline>${Array.from({ length: 6 }, () => html`<div class="skeleton" style="height:44px;margin:10px 0"></div>`)}</div>
  </div>`);

  let tax, data;
  try { [tax, data] = await Promise.all([api.taxonomy(), api.archive({ category, tag })]); }
  catch (e) { mount($("[data-timeline]", outlet), errorState(e)); return; }
  if (ctx.isStale()) return;
  const st = tax.stats || {};
  $("[data-summary]", outlet).textContent = `${st.posts} 篇文章 · ${fmtNum(st.words)} 字 · 持续写作 ${st.days} 天。好的文章值得被反复阅读。`;

  const link = (k, v) => {
    const q = new URLSearchParams({ category, tag });
    v ? q.set(k, v) : q.delete(k);
    if (!q.get("category")) q.delete("category");
    if (!q.get("tag")) q.delete("tag");
    const s = q.toString();
    return "/archive" + (s ? "?" + s : "");
  };
  mount($("[data-filters]", outlet), html`
    <div class="row"><span class="label">分类</span>
      <a class="chip ${!category ? "is-active" : ""}" href="${link("category", "")}">全部</a>
      ${tax.categories.filter((c) => c.count).map((c) => html`<a class="chip ${category === c.name ? "is-active" : ""}" href="${link("category", c.name)}">${c.name}<span class="chip__count">${c.count}</span></a>`)}</div>
    <div class="row"><span class="label">标签</span>
      <a class="chip ${!tag ? "is-active" : ""}" href="${link("tag", "")}">全部</a>
      ${tax.tags.map((t) => html`<a class="chip ${tag === t.name ? "is-active" : ""}" href="${link("tag", t.name)}">${t.name}<span class="chip__count">${t.count}</span></a>`)}</div>`);

  const tl = $("[data-timeline]", outlet);
  if (!data.total) { mount(tl, emptyState("没有符合条件的文章", "试试其它筛选条件", "archive")); return; }
  mount(tl, data.groups.map((g) => html`<section class="year-block reveal">
    <div class="year-block__year"><b class="grad-text">${g.year}</b><span>${g.count} 篇</span></div>
    <div class="year-block__list">${g.posts.map((p) => html`<a class="tl-item" href="${urlFor.post(p.slug)}" data-prefetch="${p.slug}">
      <span class="tl-item__date">${fmtDate(p.date, false)}</span><span class="tl-item__title">${p.title}</span>
      <span class="tl-item__cat">${p.category}</span></a>`)}</div></section>`));
  reveal(outlet);
  // 筛选切换时保持滚动位置（无刷新）
  const onClick = (e) => {
    const a = e.target.closest("[data-filters] a");
    if (!a) return;
    e.preventDefault();
    const y = window.scrollY;
    go(a.getAttribute("href"), { replace: true })?.then(() => window.scrollTo(0, y));
  };
  outlet.addEventListener("click", onClick);
  return () => outlet.removeEventListener("click", onClick);
}
