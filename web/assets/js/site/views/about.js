/* 关于页：作者卡 + 站点介绍 + 实时统计 + 友链 */
import { api } from "../../lib/api.js";
import { reveal, countUp } from "../../lib/ui.js";
import { $$, html, mount, icon, fmtNum, hashGradient } from "../../lib/util.js";
import { state } from "../state.js";
import { authorCard } from "../components.js";

export async function aboutView(outlet) {
  const site = state.site;
  const about = site.about || {};
  document.title = `关于 — ${site.site?.name || ""}`;
  let stats = {};
  try { stats = (await api.taxonomy()).stats || {}; } catch { /* 统计失败不影响页面 */ }
  mount(outlet, html`<div class="container">
    <header class="page-head view-enter">
      <div class="page-head__kicker">${icon("user")}About</div>
      <h1 class="page-head__title">关于<span class="grad-text">这里</span></h1>
    </header>
    <div class="about-grid">
      <div>${authorCard(site, null)}</div>
      <div>
        <section class="card card--pad reveal">
          <div class="card__title">${icon("terminal")}关于本站</div>
          <div class="prose about-intro">${(about.blogIntro || "").split("\n").filter(Boolean).map((p) => html`<p>${p}</p>`)}</div>
          <div class="big-stats">
            <div><b data-count="${stats.posts || 0}">0</b><span>篇文章</span></div>
            <div><b data-count="${stats.words || 0}">0</b><span>总字数</span></div>
            <div><b data-count="${stats.comments || 0}">0</b><span>条评论</span></div>
            <div><b data-count="${stats.days || 0}">0</b><span>天运行</span></div>
          </div>
        </section>
        ${about.friendLinks?.length ? html`<section class="section reveal" style="padding-bottom:0">
          <h2 class="section__title"><span class="idx">↔</span>友情链接</h2>
          <div class="links-grid">${about.friendLinks.map((l) => {
            const [a, b] = hashGradient(l.name);
            return html`<a class="link-card" href="${l.href}" target="_blank" rel="noopener">
              <span class="link-card__icon" style="background:linear-gradient(135deg,${a},${b})">${l.name.slice(0, 1)}</span>
              <span><b>${l.name}</b><small>${l.desc}</small></span></a>`;
          })}</div></section>` : ""}
      </div>
    </div></div>`);
  $$("[data-count]", outlet).forEach((el) => countUp(el, Number(el.dataset.count), { format: (n) => (n >= 10000 ? fmtNum(n) : n.toLocaleString()) }));
  reveal(outlet);
}
