/* 404 */
import { api } from "../../lib/api.js";
import { $, html, mount, icon } from "../../lib/util.js";
import { state } from "../state.js";
import { miniCard } from "../components.js";

export async function notFoundView(outlet) {
  const nf = state.site.notFound || {};
  document.title = `404 — ${state.site.site?.name || ""}`;
  mount(outlet, html`<div class="container notfound view-enter">
    <div class="notfound__code">404</div>
    <h1 style="margin-top:12px;font-size:24px">${nf.title || "页面不存在"}</h1>
    <p class="muted" style="margin-top:10px">${nf.desc || ""}</p>
    <div class="hero__ctas" style="justify-content:center">
      <a class="btn btn--primary" href="/">${icon("home")}返回首页</a>
      <button class="btn" data-search>${icon("search")}搜索文章</button>
    </div>
    <div class="related__grid" style="max-width:900px;margin:44px auto 0;text-align:left" data-rec></div>
  </div>`);
  try {
    const home = await api.home();
    mount($("[data-rec]", outlet), (home.hot || []).slice(0, 3).map(miniCard));
  } catch { /* 忽略 */ }
}
