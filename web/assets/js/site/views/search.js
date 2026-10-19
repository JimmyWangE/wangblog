/* 搜索页：输入即搜（防抖 + 取消过期请求），URL 同步关键词 */
import { api } from "../../lib/api.js";
import { reveal } from "../../lib/ui.js";
import { $, html, raw, mount, icon, debounce, urlFor } from "../../lib/util.js";
import { state } from "../state.js";
import { emptyState } from "../components.js";

export async function searchView(outlet, ctx) {
  const site = state.site;
  let q = ctx.query.q || "";
  document.title = `搜索 — ${site.site?.name || ""}`;
  mount(outlet, html`<div class="container">
    <header class="page-head view-enter">
      <div class="page-head__kicker">${icon("search")}Search</div>
      <h1 class="page-head__title">搜索<span class="grad-text">文章</span></h1>
      <div class="search-box" style="margin-top:22px">${icon("search")}
        <input class="input" type="search" placeholder="${site.search?.placeholder || "搜索…"}" value="${q}" aria-label="搜索关键词" autofocus></div>
      <div class="filters" style="margin-top:14px" data-hot>${(site.search?.hotTags || []).map((t) => html`<button class="chip" data-q="${t}">#${t}</button>`)}</div>
    </header>
    <div data-results style="display:grid;gap:14px;max-width:820px"></div>
  </div>`);
  const input = $("input", outlet);
  const box = $("[data-results]", outlet);
  let ctrl;
  const run = async (kw) => {
    q = kw.trim();
    history.replaceState(null, "", q ? `/search?q=${encodeURIComponent(q)}` : "/search");
    if (!q) { mount(box, html`<p class="faint">输入关键词，实时搜索标题、正文、分类与标签。快捷键 <kbd>/</kbd> 或 <kbd>⌘K</kbd> 可随时唤起搜索面板。</p>`); return; }
    ctrl?.abort(); ctrl = new AbortController();
    mount(box, html`<div class="skeleton" style="height:96px"></div><div class="skeleton" style="height:96px"></div>`);
    try {
      const d = await api.search(q, { pageSize: 30 }, ctrl.signal);
      if (!d.list.length) { mount(box, emptyState(`没有找到「${q}」`, "换个关键词试试，或浏览热门标签", "search")); return; }
      mount(box, html`<p class="faint" style="font-size:13px">找到 ${d.total} 篇相关文章</p>
        ${d.list.map((r) => html`<a class="search-result reveal" href="${urlFor.post(r.slug)}" data-prefetch="${r.slug}">
          <h3>${raw(r.titleHtml)}</h3><p>${raw(r.snippetHtml)}</p>
          <small>${r.category} · ${r.date} ${r.tags.map((t) => html` · #${t}`)}</small></a>`)}`);
      reveal(box);
    } catch (e) { if (e.code !== -2) mount(box, html`<p class="faint">${e.message}</p>`); }
  };
  const deb = debounce(run, 260);
  input.addEventListener("input", () => deb(input.value));
  $("[data-hot]", outlet).addEventListener("click", (e) => {
    const b = e.target.closest("[data-q]");
    if (b) { input.value = b.dataset.q; run(b.dataset.q); }
  });
  run(q);
  return () => { deb.cancel(); ctrl?.abort(); };
}
