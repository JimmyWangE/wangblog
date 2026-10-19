/* 分类与标签总览 */
import { api } from "../../lib/api.js";
import { reveal } from "../../lib/ui.js";
import { $, html, mount, icon, urlFor } from "../../lib/util.js";
import { state } from "../state.js";
import { errorState } from "../components.js";

const CAT_ICONS = ["layers", "terminal", "book", "zap", "folder", "sparkles"];

export async function categoriesView(outlet) {
  document.title = `分类与标签 — ${state.site.site?.name || ""}`;
  mount(outlet, html`<div class="container">
    <header class="page-head view-enter">
      <div class="page-head__kicker">${icon("layers")}Topics</div>
      <h1 class="page-head__title">分类与<span class="grad-text">标签</span></h1>
      <p class="page-head__desc">按主题浏览全部文章。</p>
    </header>
    <div data-body><div class="cat-grid">${[1, 2, 3].map(() => html`<div class="skeleton" style="height:150px;border-radius:22px"></div>`)}</div></div>
  </div>`);
  let t;
  try { t = await api.taxonomy(); } catch (e) { mount($("[data-body]", outlet), errorState(e)); return; }
  mount($("[data-body]", outlet), html`
    <div class="cat-grid">${t.categories.map((c, i) => html`<a class="cat-card spotlight reveal" href="${urlFor.category(c.name)}">
      <span class="n">${String(c.count).padStart(2, "0")}</span>
      <div class="cat-card__icon">${icon(CAT_ICONS[i % CAT_ICONS.length])}</div>
      <h3>${c.name}</h3><p>${c.description || "—"}</p><p class="faint" style="margin-top:12px;font-size:12.5px">${c.count} 篇文章 →</p></a>`)}</div>
    <section class="section" style="padding-top:44px">
      <div class="section__head"><h2 class="section__title"><span class="idx">#</span>全部标签</h2></div>
      <div class="tag-cloud reveal">${t.tags.map((x) => html`<a class="chip" href="${urlFor.tag(x.name)}" style="font-size:${13 + Math.round(x.weight * 4)}px;height:auto;padding:6px 14px">
        #${x.name}<span class="chip__count">${x.count}</span></a>`)}</div>
    </section>`);
  reveal(outlet);
}
