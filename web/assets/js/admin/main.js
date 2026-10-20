/* ==========================================================================
 * 管理后台单页应用入口：鉴权守卫 + 布局 + 路由
 * ========================================================================== */
import { auth_, admin, setAuthExpiredHandler } from "../lib/api.js";
import { Router } from "../lib/router.js";
import { theme, toast, routeBar, initSpotlight } from "../lib/ui.js";
import { $, html, mount, icon } from "../lib/util.js";
import { loginView } from "./views/login.js";
import { dashboardView } from "./views/dashboard.js";
import { postsView } from "./views/posts.js";
import { commentsView } from "./views/comments.js";
import { taxonomyView } from "./views/taxonomy.js";
import { settingsView } from "./views/settings.js";
import { adminState } from "./state.js";

const root = $("#admin");

const NAV = [
  { href: "/admin/", label: "仪表盘", icon: "chart", match: (p) => p === "/admin" || p === "/admin/" },
  { href: "/admin/posts", label: "文章", icon: "file", match: (p) => p.startsWith("/admin/posts") },
  { href: "/admin/comments", label: "评论", icon: "msg", match: (p) => p.startsWith("/admin/comments"), badge: "pending" },
  { href: "/admin/taxonomy", label: "分类与标签", icon: "tag", match: (p) => p.startsWith("/admin/taxonomy") },
  { href: "/admin/settings", label: "站点设置", icon: "settings", match: (p) => p.startsWith("/admin/settings") },
];

function shell() {
  const existing = $(".main", root);
  if (existing) {
    // 每次切换视图换一个新的 <main>，旧视图绑定的事件随节点一起释放
    const fresh = existing.cloneNode(false);
    existing.replaceWith(fresh);
    return fresh;
  }
  mount(root, html`<div class="admin-shell">
    <aside class="aside" data-aside>
      <a class="logo" href="/" data-native target="_blank"><span class="logo__mark" style="width:32px;height:32px;border-radius:10px;display:grid;place-items:center;color:#fff;font:700 15px var(--font-mono);background:var(--grad)">W</span>
        <span>WangBlog<small style="display:block;font:500 10px var(--font-mono);color:var(--text-3);letter-spacing:.12em">ADMIN CONSOLE</small></span></a>
      <a class="btn btn--primary btn--block" href="/admin/editor/new" style="margin-bottom:12px">${icon("edit")}写文章</a>
      <div class="aside__group">Workspace</div>
      <nav class="aside__nav">${NAV.map((n) => html`<a href="${n.href}" data-nav="${n.href}">${icon(n.icon)}${n.label}
        ${n.badge ? html`<span class="count" data-badge="${n.badge}" hidden>0</span>` : ""}</a>`)}</nav>
      <div class="aside__group">Site</div>
      <nav class="aside__nav">
        <a href="/" data-native target="_blank">${icon("external")}查看站点</a>
        <a href="/admin/rss" data-nav="/admin/rss">${icon("rss")}RSS 与首页</a>
        <a href="/docs" data-native target="_blank">${icon("book")}API 文档</a>
      </nav>
      <div class="aside__foot">
        <div class="aside__user"><span class="av">${(adminState.user?.username || "A")[0].toUpperCase()}</span>
          <span><b>${adminState.user?.username || "admin"}</b><small>管理员</small></span>
          <button class="icon-btn" data-theme-toggle title="切换主题">${icon("moon")}</button>
          <button class="icon-btn" data-logout title="退出登录">${icon("logout")}</button></div>
      </div>
    </aside>
    <div>
      <div class="m-topbar"><button class="icon-btn" data-aside-open>${icon("menu")}</button><b>WangBlog 后台</b>
        <a class="btn btn--sm btn--primary" style="margin-left:auto" href="/admin/editor/new">${icon("edit")}写文章</a></div>
      <main class="main" id="admin-main"></main>
    </div>
  </div>`);
  return $(".main", root);
}

/** 布局包装：后台页面放进带侧栏的外壳；登录页与编辑器全屏 */
const withShell = (view) => async (_outlet, ctx) => {
  if (!auth_.isLoggedIn()) { router.go("/admin/login?next=" + encodeURIComponent(location.pathname + location.search), { replace: true }); return; }
  const main = shell();
  updateNav(ctx.url.pathname);
  $("[data-aside]", root)?.classList.remove("is-open");
  refreshBadge();
  return view(main, ctx);
};
const fullscreen = (loader) => async (_outlet, ctx) => {
  if (!auth_.isLoggedIn()) { router.go("/admin/login?next=" + encodeURIComponent(location.pathname), { replace: true }); return; }
  root.innerHTML = "";
  const el = document.createElement("div");
  root.appendChild(el);
  const mod = await loader();
  return mod.editorView(el, ctx);
};

function updateNav(pathname) {
  root.querySelectorAll("[data-nav]").forEach((a) => {
    const n = [...NAV, { href: "/admin/rss", match: (p) => p.startsWith("/admin/rss") }].find((x) => x.href === a.dataset.nav);
    a.classList.toggle("is-active", !!n && n.match(pathname));
  });
}
export async function refreshBadge() {
  try {
    const d = await admin.comments({ status: "pending", pageSize: 1 });
    const b = root.querySelector('[data-badge="pending"]');
    if (b) { b.textContent = d.counts.pending; b.hidden = !d.counts.pending; }
  } catch { /* 忽略 */ }
}

const router = new Router({
  outlet: root,
  base: "/admin",
  routes: [
    { path: "/login", view: (o, c) => { root.innerHTML = ""; return loginView(root, c); } },
    { path: "/", view: withShell(dashboardView) },
    { path: "/posts", view: withShell(postsView) },
    { path: "/comments", view: withShell(commentsView) },
    { path: "/taxonomy", view: withShell(taxonomyView) },
    { path: "/settings", view: withShell(settingsView) },
    { path: "/rss", view: withShell(settingsView) },
    { path: "/editor/:id", view: fullscreen(() => import("./editor.js")) },
  ],
  notFound: withShell(async (main) => mount(main, html`<div class="empty"><div class="empty__title">页面不存在</div><a class="btn" href="/admin/">返回仪表盘</a></div>`)),
  onStart: () => routeBar.start(),
  onEnd: () => routeBar.done(),
});
adminState.router = router;

setAuthExpiredHandler(() => {
  toast("登录已过期，请重新登录", "warning");
  router.go("/admin/login?next=" + encodeURIComponent(location.pathname), { replace: true });
});

document.addEventListener("click", async (e) => {
  if (e.target.closest("[data-theme-toggle]")) theme.toggle();
  if (e.target.closest("[data-aside-open]")) $("[data-aside]", root)?.classList.add("is-open");
  if (e.target.closest("[data-logout]")) {
    await auth_.logout();
    toast("已退出登录");
    router.go("/admin/login", { replace: true });
  }
  if (!e.target.closest("[data-aside]") && !e.target.closest("[data-aside-open]")) $("[data-aside]", root)?.classList.remove("is-open");
});

(async function boot() {
  initSpotlight();
  if (auth_.isLoggedIn()) {
    try { adminState.user = await auth_.me(); } catch { /* 失效时由守卫处理 */ }
  }
  router.start();
})();
