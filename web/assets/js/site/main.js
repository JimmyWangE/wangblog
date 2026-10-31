/* ==========================================================================
 * 前台单页应用入口：外壳（顶栏 / 抽屉 / 页脚 / 搜索面板）+ 路由
 * ========================================================================== */
import { api } from "../lib/api.js";
import { Router } from "../lib/router.js";
import { theme, toast, initSpotlight, routeBar } from "../lib/ui.js";
import { $, $$, html, raw, mount, icon, debounce, urlFor, rafThrottle } from "../lib/util.js";
import { state } from "./state.js";
import { homeView } from "./views/home.js";
import { postView } from "./views/post.js";
import { listView } from "./views/list.js";
import { archiveView } from "./views/archive.js";
import { categoriesView } from "./views/categories.js";
import { searchView } from "./views/search.js";
import { aboutView } from "./views/about.js";
import { notFoundView } from "./views/notfound.js";

const NAV = [
  { href: "/", label: "首页", icon: "home", match: (p) => p === "/" },
  { href: "/archive", label: "归档", icon: "archive", match: (p) => p.startsWith("/archive") },
  { href: "/categories", label: "分类", icon: "layers", match: (p) => /^\/(categories|category|tag)/.test(p) },
  { href: "/about", label: "关于", icon: "user", match: (p) => p.startsWith("/about") },
];

let site = { site: { name: "向明笔记" } };

function renderShell() {
  const s = site.site || {};
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  mount($("#header"), html`<div class="container header__inner">
    <a class="logo" href="/" aria-label="${s.name} 首页"><span class="logo__mark">${s.logoText || "W"}</span>
      <span class="logo__text">${s.name}<small>${s.slogan ? "// " + s.slogan : ""}</small></span></a>
    <nav class="nav" aria-label="主导航">${NAV.map((n) => html`<a href="${n.href}" data-nav="${n.href}">${n.label}</a>`)}</nav>
    <div class="header__actions">
      <button class="search-trigger" data-search aria-label="搜索">${icon("search")}<span class="lbl">搜索文章…</span><kbd>${isMac ? "⌘" : "Ctrl"} K</kbd></button>
      <a class="icon-btn" href="/rss.xml" data-native title="RSS 订阅" aria-label="RSS">${icon("rss")}</a>
      <button class="icon-btn theme-btn" data-theme-toggle title="切换主题" aria-label="切换主题">${icon("moon", "i-moon")}${icon("sun", "i-sun")}</button>
      <button class="icon-btn nav-toggle" data-drawer-open aria-label="菜单">${icon("menu")}</button>
    </div></div>`);

  const drawer = document.createElement("div");
  drawer.className = "drawer";
  mount(drawer, html`<div class="drawer__mask" data-drawer-close></div>
    <nav class="drawer__panel" aria-label="移动端导航">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span class="logo"><span class="logo__mark">${s.logoText || "W"}</span>${s.name}</span>
        <button class="icon-btn" data-drawer-close aria-label="关闭">${icon("x")}</button></div>
      ${NAV.map((n) => html`<a href="${n.href}" data-nav="${n.href}">${icon(n.icon)}${n.label}</a>`)}
      <a href="/search">${icon("search")}搜索</a>
      <a href="/rss.xml" data-native>${icon("rss")}RSS 订阅</a>
    </nav>`);
  document.body.appendChild(drawer);

  const year = new Date().getFullYear();
  mount($("#footer"), html`<div class="container footer__grid">
    <div>
      <div>© ${year} ${s.name} · ${s.slogan || ""}</div>
      <div style="margin-top:6px" class="footer__links">
        ${s.icp ? html`<a href="https://beian.miit.gov.cn/" target="_blank" rel="nofollow noopener">${s.icp}</a>` : ""}
        ${s.policeIcp ? html`<span>${s.policeIcp}</span>` : ""}
      </div>
    </div>
    <div class="footer__links">
      <a href="/archive">归档</a><a href="/rss.xml" data-native>RSS</a><a href="/sitemap.xml" data-native>Sitemap</a>
      <a href="/admin/" data-native>管理</a>
      <span class="footer__status"><span class="pulse"></span>All systems normal</span>
    </div></div>`);

  const top = document.createElement("button");
  top.className = "to-top";
  top.setAttribute("aria-label", "回到顶部");
  mount(top, icon("arrowUp"));
  top.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  document.body.appendChild(top);

  // 交互绑定
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-theme-toggle]")) theme.toggle();
    if (e.target.closest("[data-drawer-open]")) drawer.classList.add("is-open");
    if (e.target.closest("[data-drawer-close]") || (e.target.closest(".drawer a"))) drawer.classList.remove("is-open");
    if (e.target.closest("[data-search]")) openPalette();
  });

  // 顶栏：滚动变玻璃态，向下滚动隐藏
  const header = $("#header");
  let lastY = 0;
  const onScroll = rafThrottle(() => {
    const y = window.scrollY;
    header.classList.toggle("is-scrolled", y > 10);
    if (y > 480 && y > lastY + 4 && !paletteOpen) header.classList.add("is-hidden");
    else if (y < lastY - 4 || y < 480) header.classList.remove("is-hidden");
    top.classList.toggle("is-visible", y > 900);
    if (Math.abs(y - lastY) > 4 || y < 480) lastY = y; // 逐帧触发时位移很小，累积超过阈值再更新方向基准
  });
  window.addEventListener("scroll", onScroll, { passive: true });
}

function updateNav(pathname) {
  $$("[data-nav]").forEach((a) => {
    const n = NAV.find((x) => x.href === a.dataset.nav);
    a.classList.toggle("is-active", !!n && n.match(pathname));
  });
}

/* ---------------------------------------------------------------- 搜索面板（⌘K） */
let paletteOpen = false;
function openPalette(initial = "") {
  if (paletteOpen) return;
  paletteOpen = true;
  const wrap = document.createElement("div");
  wrap.className = "palette";
  const hot = site.search?.hotTags || [];
  mount(wrap, html`<div class="palette__box" role="dialog" aria-label="搜索">
    <div class="palette__input">${icon("search")}<input placeholder="${site.search?.placeholder || "搜索文章…"}" value="${initial}" aria-label="搜索关键词" autocomplete="off"><kbd>Esc</kbd></div>
    <div class="palette__results" role="listbox"></div>
    <div class="palette__foot"><span><kbd>↑</kbd><kbd>↓</kbd>选择</span><span><kbd>↵</kbd>打开</span><span><kbd>Esc</kbd>关闭</span></div></div>`);
  document.body.appendChild(wrap);
  const input = $("input", wrap);
  const results = $(".palette__results", wrap);
  let items = [], active = 0, ctrl;

  const hint = () => mount(results, html`<div class="palette__hint">输入关键词开始搜索，支持空格分隔多个词。<br>热门：
    ${hot.map((t) => html`<button class="chip" data-q="${t}">${t}</button>`)}</div>`);
  const paint = () => {
    $$(".palette__item", results).forEach((el, i) => el.classList.toggle("is-active", i === active));
    $$(".palette__item", results)[active]?.scrollIntoView({ block: "nearest" });
  };
  const run = debounce(async (q) => {
    if (!q.trim()) { items = []; hint(); return; }
    ctrl?.abort(); ctrl = new AbortController();
    mount(results, html`<div class="palette__hint"><span class="spinner"></span></div>`);
    try {
      const d = await api.search(q.trim(), { pageSize: 8 }, ctrl.signal);
      items = d.list; active = 0;
      if (!items.length) { mount(results, html`<div class="palette__hint">没有找到与「${q}」相关的内容</div>`); return; }
      mount(results, html`${items.map((r) => html`<a class="palette__item" href="${urlFor.post(r.slug)}" role="option">
        <b>${raw(r.titleHtml)}</b><p>${raw(r.snippetHtml)}</p><small>${r.category} · ${r.date}</small></a>`)}
        ${d.total > items.length ? html`<a class="palette__item" href="/search?q=${encodeURIComponent(q)}"><small>查看全部 ${d.total} 条结果 →</small></a>` : ""}`);
      paint();
    } catch (e) { if (e.code !== -2) mount(results, html`<div class="palette__hint">${e.message}</div>`); }
  }, 220);

  const close = () => {
    paletteOpen = false;
    document.removeEventListener("keydown", onKey, true);
    wrap.remove();
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, $$(".palette__item", results).length - 1); paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); paint(); }
    else if (e.key === "Enter") {
      const el = $$(".palette__item", results)[active];
      if (el) { e.preventDefault(); close(); router.go(el.getAttribute("href")); }
      else if (input.value.trim()) { close(); router.go("/search?q=" + encodeURIComponent(input.value.trim())); }
    }
  };
  document.addEventListener("keydown", onKey, true);
  wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) close(); });
  results.addEventListener("click", (e) => {
    const q = e.target.closest("[data-q]");
    if (q) { input.value = q.dataset.q; run(q.dataset.q); input.focus(); return; }
    if (e.target.closest("a")) close();
  });
  input.addEventListener("input", () => run(input.value));
  initial ? run(initial) : hint();
  setTimeout(() => input.focus(), 10);
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
  else if (e.key === "/" && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) {
    e.preventDefault(); openPalette();
  }
});

/* ---------------------------------------------------------------- 悬停预取 */
const prefetched = new Set();
document.addEventListener("pointerover", (e) => {
  const a = e.target.closest?.("[data-prefetch]");
  if (!a || prefetched.has(a.dataset.prefetch)) return;
  prefetched.add(a.dataset.prefetch);
  api.post(a.dataset.prefetch).catch(() => prefetched.delete(a.dataset.prefetch));
}, { passive: true });

/* ---------------------------------------------------------------- 路由 */
const legacy = (outlet, ctx) => {
  // 兼容旧版多页地址：post.html?slug=x、archive.html 等
  const map = { "/post.html": ctx.query.slug ? urlFor.post(ctx.query.slug) : "/", "/index.html": "/", "/archive.html": "/archive",
    "/about.html": "/about", "/search.html": "/search", "/404.html": "/404" };
  router.go(map[ctx.url.pathname] || "/", { replace: true });
};

const router = new Router({
  outlet: $("#app"),
  ignore: ["/admin", "/api", "/uploads", "/rss.xml", "/sitemap.xml", "/feed", "/docs"],
  routes: [
    { path: "/", view: homeView },
    { path: "/post/:slug", view: postView },
    { path: "/category/:name", view: (o, c) => listView(o, { ...c, kind: "category" }) },
    { path: "/tag/:name", view: (o, c) => listView(o, { ...c, kind: "tag" }) },
    { path: "/categories", view: categoriesView },
    { path: "/tags", view: categoriesView },
    { path: "/archive", view: archiveView },
    { path: "/search", view: searchView },
    { path: "/about", view: aboutView },
    { path: "/:legacy.html", view: legacy },
  ],
  notFound: notFoundView,
  onStart: () => { routeBar.start(); },
  onEnd: (ctx) => {
    routeBar.done();
    updateNav(ctx.url.pathname);
    $("#app").focus({ preventScroll: true });
    if (!ctx.url.pathname.startsWith("/post/")) api.track({ event: "view" });
  },
});
state.router = router;
state.openPalette = openPalette;

/* ---------------------------------------------------------------- 启动 */
(async function boot() {
  initSpotlight();
  try { site = await api.site(); state.site = site; } catch { toast("站点配置加载失败，部分内容可能缺失", "warning"); }
  renderShell();
  await router.start();
})();
