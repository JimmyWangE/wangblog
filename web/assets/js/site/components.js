/* 前台可复用组件（纯模板函数，返回 html``） */
import { html, raw, icon, esc, fmtDate, fmtNum, hashGradient, urlFor } from "../lib/util.js";

export function cover(post, cls = "") {
  const c = post.cover || {};
  const [a, b] = c.from && c.to ? [c.from, c.to] : hashGradient(post.slug || post.title);
  const text = c.text || (post.category || "W").slice(0, 2);
  return html`<div class="cover ${cls}" style="--from:${raw(esc(a))};--to:${raw(esc(b))}">
    ${c.image ? html`<img src="${c.image}" alt="" loading="lazy">` : html`<span class="cover__text">${text}</span>`}</div>`;
}

export function metaLine(p, { views = true } = {}) {
  return html`
    <span class="meta-i">${icon("calendar")}${fmtDate(p.date)}</span>
    ${p.readingMinutes ? html`<span class="meta-i">${icon("clock")}${p.readingMinutes} 分钟</span>` : ""}
    ${views ? html`<span class="meta-i">${icon("eye")}${fmtNum(p.views)}</span>` : ""}
    <span class="meta-i">${icon("msg")}${p.commentCount || 0}</span>`;
}

export function postCard(p) {
  return html`<a class="post-card spotlight reveal" href="${urlFor.post(p.slug)}" data-prefetch="${p.slug}">
    <div class="post-card__cover">${cover(p)}</div>
    <div class="post-card__body">
      <div class="post-card__meta">
        ${p.pinned ? html`<span class="badge badge--grad">${icon("pin")}置顶</span>` : ""}
        ${p.category ? html`<span class="cat">${p.category}</span>` : ""}
        <span>${fmtDate(p.date)}</span>
      </div>
      <h3 class="post-card__title">${p.title}</h3>
      <p class="post-card__excerpt">${p.excerpt}</p>
      <div class="post-card__foot">
        <span class="tags">${(p.tags || []).slice(0, 3).map((t) => html`<span class="tag">${t}</span>`)}</span>
        ${p.readingMinutes ? html`<span class="meta-i">${icon("clock")}${p.readingMinutes} 分钟</span>` : ""}
        <span class="meta-i">${icon("eye")}${fmtNum(p.views)}</span>
        <span class="meta-i">${icon("msg")}${p.commentCount || 0}</span>
      </div>
    </div>
  </a>`;
}

export function postCardSkeleton(n = 3) {
  return Array.from({ length: n }, () => html`<div class="post-card">
    <div class="post-card__cover skeleton"></div>
    <div class="post-card__body"><div class="skeleton sk-line" style="width:30%"></div>
      <div class="skeleton sk-title"></div><div class="skeleton sk-line"></div><div class="skeleton sk-line" style="width:80%"></div></div>
  </div>`);
}

export function featuredCard(p) {
  return html`<a class="featured spotlight reveal" href="${urlFor.post(p.slug)}" data-prefetch="${p.slug}">
    <div class="featured__cover">${cover(p)}</div>
    <div class="featured__body">
      <div class="post-card__meta"><span class="badge badge--grad">${icon("pin")}置顶精选</span>
        ${p.category ? html`<span class="cat">${p.category}</span>` : ""}</div>
      <h2 class="featured__title">${p.title}</h2>
      <p class="featured__excerpt">${p.excerpt}</p>
      <div class="featured__foot">
        <div class="post-card__foot">${metaLine(p)}</div>
        <span class="read-more">阅读全文 ${icon("arrowRight")}</span>
      </div>
    </div>
  </a>`;
}

export function miniCard(p) {
  return html`<a class="mini-card" href="${urlFor.post(p.slug)}" data-prefetch="${p.slug}">
    <div class="mini-card__cover">${cover(p)}</div>
    <div class="mini-card__body"><div class="mini-card__title">${p.title}</div>
      <div class="mini-card__meta">${p.category} · ${fmtDate(p.date)}</div></div></a>`;
}

export function authorCard(site, stats) {
  const a = site.about?.author || {};
  return html`<section class="card author reveal">
    <div class="avatar">${a.avatarText || "W"}</div>
    <div class="author__name">${a.name || site.site?.author}</div>
    <p class="author__bio">${a.bio || ""}</p>
    <div class="author__links">
      ${(a.links || []).map((l) => html`<a class="icon-btn" href="${l.href}" title="${l.label}" ${/^https?:/.test(l.href) ? raw('target="_blank" rel="noopener"') : raw("data-native")}>
        ${icon(/github/i.test(l.label) ? "github" : /rss/i.test(l.label) ? "rss" : "link")}</a>`)}
      ${a.email ? html`<a class="icon-btn" href="mailto:${a.email}" title="邮件">${icon("mail")}</a>` : ""}
    </div>
    ${stats ? html`<div class="mini-stats"><div><b>${stats.posts}</b><span>文章</span></div>
      <div><b>${fmtNum(stats.words)}</b><span>字数</span></div><div><b>${fmtNum(stats.views)}</b><span>阅读</span></div></div>` : ""}
  </section>`;
}

export function hotList(posts) {
  return html`<section class="card card--pad reveal"><div class="card__title">${icon("flame")}热门文章</div>
    <div class="rank">${posts.map((p) => html`<a href="${urlFor.post(p.slug)}" data-prefetch="${p.slug}">
      <span class="rank__title">${p.title}</span><span class="rank__meta">${fmtNum(p.views)} 阅读 · ${p.commentCount} 评论</span></a>`)}</div></section>`;
}

export function tagCloud(tags, active = "") {
  return html`<section class="card card--pad reveal"><div class="card__title">${icon("hash")}标签云</div>
    <div class="tag-cloud">${tags.map((t) => html`<a class="chip ${t.name === active ? "is-active" : ""}" href="${urlFor.tag(t.name)}"
      style="font-size:${12 + Math.round((t.weight || 0) * 3)}px">${t.name}<span class="chip__count">${t.count}</span></a>`)}</div></section>`;
}

export function categoryList(cats) {
  return html`<section class="card card--pad reveal"><div class="card__title">${icon("folder")}分类</div>
    <div class="cat-list">${cats.map((c) => html`<a href="${urlFor.category(c.name)}">${icon("folder")}<span>${c.name}</span><span class="n">${c.count}</span></a>`)}</div></section>`;
}

export function recentComments(list) {
  if (!list?.length) return "";
  return html`<section class="card card--pad reveal"><div class="card__title">${icon("msg")}最新评论</div>
    <div class="recent-cmt">${list.map((c) => html`<a href="${urlFor.post(c.slug)}#comments">
      <b>${c.author}</b> <small>· ${c.timeAgo}</small><p>${c.body}</p></a>`)}</div></section>`;
}

export function emptyState(title, desc = "", iconName = "file") {
  return html`<div class="empty"><div class="empty__icon">${icon(iconName)}</div><div class="empty__title">${title}</div>
    ${desc ? html`<p>${desc}</p>` : ""}</div>`;
}

export function errorState(err, retryAttr = "data-retry") {
  return html`<div class="empty"><div class="empty__icon">${icon("zap")}</div><div class="empty__title">加载失败</div>
    <p>${err?.message || "请稍后重试"}</p><button class="btn btn--sm" ${raw(retryAttr)}>${icon("refresh")}重试</button></div>`;
}

/* 写作热力图（GitHub 贡献图式）：列为周、行为周日~周六；一次性拼接字符串渲染，无逐格监听 */
const ACT_LEVEL = (c) => (c <= 0 ? 0 : c <= 2 ? 1 : c <= 5 ? 2 : c <= 9 ? 3 : 4);
const parseDay = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export function activityGraph(act) {
  const days = act?.days || [];
  if (!days.length) return "";
  const lead = parseDay(days[0].date).getDay(); // 首列从周日开始，前面补空格
  const cols = Math.ceil((lead + days.length) / 7);
  let cells = "<i class=\"pad\"></i>".repeat(lead);
  const months = [];
  let lastMonth = -1;
  days.forEach((d, i) => {
    const date = parseDay(d.date);
    const col = Math.floor((lead + i) / 7);
    if (date.getMonth() !== lastMonth && (date.getDate() <= 7 || i === 0)) {
      lastMonth = date.getMonth();
      // 首列月份若只剩几天，标签会与下一个月重叠，跳过
      if (!(i === 0 && date.getDate() > 21)) months.push(`<span style="grid-column:${col + 1}">${date.getMonth() + 1}月</span>`);
    }
    cells += `<i class="l${ACT_LEVEL(d.count)}" data-d="${d.date}" data-c="${d.count}"></i>`;
  });
  return html`<section class="card card--pad activity">
    <div class="activity__head">
      <div class="card__title" style="margin:0">${icon("chart")}写作足迹</div>
      <div class="activity__sum">过去一年 <b>${act.total}</b> 次写作 · 活跃 <b>${act.activeDays}</b> 天 · 最长连续 <b>${act.longestStreak}</b> 天</div>
    </div>
    <div class="activity__scroll" data-act-scroll>
      <div class="activity__graph" style="--cols:${cols}">
        <div class="activity__months">${raw(months.join(""))}</div>
        <div class="activity__wk" aria-hidden="true"><span></span><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span></div>
        <div class="activity__cells" role="img" aria-label="过去一年共 ${act.total} 次写作">${raw(cells)}</div>
      </div>
    </div>
    <div class="activity__legend"><span>发布文章与写作快照（每 10 分钟一次）计入</span><span class="grow"></span>少<i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i>多</div>
  </section>`;
}
