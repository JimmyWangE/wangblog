/* 仪表盘：KPI + 30 天访问趋势（SVG 折线，悬停查看）+ 热门 / 草稿 / 定时 / 动态 */
import { admin } from "../../lib/api.js";
import { countUp } from "../../lib/ui.js";
import { $, $$, html, mount, icon, fmtNum, esc } from "../../lib/util.js";

const ACTION_LABEL = { "post.create": "新建文章", "post.publish": "发布文章", "post.trash": "移入回收站", "post.restore": "恢复文章",
  "post.visibility": "修改文章可见性",
  "post.unpublish": "撤回发布", "post.batch": "批量操作", "post.purge": "彻底删除", upload: "上传图片", "comment.approve": "通过评论",
  "comment.spam": "标记垃圾评论", "comment.delete": "删除评论", "comment.reply": "回复评论", "site.update": "修改站点设置",
  "login.success": "登录成功", "login.password": "密码验证通过", "category.create": "新建分类", "category.update": "修改分类",
  "tag.rename": "重命名标签", seed: "初始化数据" };

export async function dashboardView(main) {
  document.title = "仪表盘 — 管理后台";
  const hour = new Date().getHours();
  const hello = hour < 6 ? "夜深了" : hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
  mount(main, html`<div class="topline"><div><h1>${hello} 👋</h1><p>这里是站点的实时概况</p></div>
    <div class="topline__actions"><a class="btn" href="/admin/posts">${icon("file")}管理文章</a><a class="btn btn--primary" href="/admin/editor/new">${icon("edit")}写文章</a></div></div>
    <div data-body><div class="kpis">${[1, 2, 3, 4].map(() => html`<div class="skeleton" style="height:112px;border-radius:14px"></div>`)}</div></div>`);
  let d;
  try { d = await admin.dashboard(); } catch (e) { mount($("[data-body]", main), html`<div class="empty"><div class="empty__title">${e.message}</div></div>`); return; }
  const t = d.today;
  const delta = t.pvYesterday ? ((t.pv - t.pvYesterday) / t.pvYesterday) * 100 : 0;
  const warn = [];
  if (d.system.defaultSecret) warn.push("WB_SECRET 仍为默认值，生产环境请立即修改。");
  if (d.system.demoTotp) warn.push("二步验证处于演示模式（任意 6 位数字可通过），生产环境请设置 WB_DEMO_TOTP=false。");

  mount($("[data-body]", main), html`
    ${warn.length ? html`<div style="display:grid;gap:8px;margin-bottom:14px">${warn.map((w) => html`<div class="alert alert--warn">${icon("shield")}<span>${w}</span></div>`)}</div>` : ""}
    <div class="kpis">
      <div class="card kpi"><div class="kpi__label">${icon("eye")}今日浏览 PV</div><div class="kpi__value" data-c="${t.pv}">0</div>
        <div class="kpi__sub"><span class="${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(1)}%</span> 较昨日 · UV ${t.uv}</div></div>
      <div class="card kpi"><div class="kpi__label">${icon("file")}已发布文章</div><div class="kpi__value" data-c="${d.posts.published}">0</div>
        <div class="kpi__sub">草稿 ${d.posts.draft} · 定时 ${d.posts.scheduled} · ${fmtNum(d.posts.words)} 字</div></div>
      <div class="card kpi"><div class="kpi__label">${icon("msg")}待审评论</div><div class="kpi__value" data-c="${d.comments.pending}">0</div>
        <div class="kpi__sub"><a href="/admin/comments" style="color:var(--accent)">前往审核 →</a> · 已通过 ${d.comments.approved}</div></div>
      <div class="card kpi"><div class="kpi__label">${icon("shield")}系统</div><div class="kpi__value">${d.system.diskPercent}<small style="font-size:14px">%</small></div>
        <div class="kpi__sub">磁盘占用 · 图片 ${(d.system.uploadBytes / 1048576).toFixed(1)}MB · 证书 ${d.system.certDays} 天</div></div>
    </div>
    <div class="dash-grid">
      <section class="card card--pad"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div class="card__title" style="margin:0">${icon("chart")}访问趋势 · 近 30 天</div>
        <div class="legend"><span><i style="background:var(--c2)"></i>PV</span><span><i style="background:var(--c1)"></i>UV</span></div></div>
        <div class="chart" data-chart></div></section>
      <section class="card card--pad"><div class="card__title">${icon("layers")}分类分布</div>
        ${d.categories.map((c) => {
          const max = Math.max(...d.categories.map((x) => x.count), 1);
          return html`<div class="bar-row"><span>${c.name}</span><span class="bar"><i style="width:0" data-w="${(c.count / max) * 100}"></i></span><span class="num faint">${c.count}</span></div>`;
        })}
        <div class="card__title" style="margin-top:22px">${icon("history")}最近动态</div>
        <div class="list-rows">${d.activity.map((a) => html`<div><span class="t">${ACTION_LABEL[a.action] || a.action}${a.detail ? html` <span class="faint">· ${a.detail.slice(0, 28)}</span>` : ""}</span><span class="n">${a.ago}</span></div>`)}</div>
      </section>
    </div>
    <div class="dash-grid dash-grid--3">
      <section class="card card--pad"><div class="card__title">${icon("flame")}热门文章</div>
        <div class="list-rows">${d.top.map((p) => html`<div><a class="t" href="/admin/editor/${p.id}">${p.title}</a><span class="n">${fmtNum(p.views)} 阅读</span></div>`)}</div></section>
      <section class="card card--pad"><div class="card__title">${icon("edit")}继续写作</div>
        <div class="list-rows">${d.drafts.length ? d.drafts.map((p) => html`<div><a class="t" href="/admin/editor/${p.id}">${p.title}</a><span class="n">${p.ago}</span></div>`) : html`<div class="faint">没有草稿</div>`}</div></section>
      <section class="card card--pad"><div class="card__title">${icon("clock")}定时发布</div>
        <div class="list-rows">${d.scheduled.length ? d.scheduled.map((p) => html`<div><a class="t" href="/admin/editor/${p.id}">${p.title}</a><span class="n">${p.at}</span></div>`) : html`<div class="faint">暂无定时任务</div>`}</div></section>
    </div>`);
  $$("[data-c]", main).forEach((el) => countUp(el, Number(el.dataset.c), { duration: 1000 }));
  requestAnimationFrame(() => $$("[data-w]", main).forEach((el) => { el.style.width = el.dataset.w + "%"; }));
  return drawChart($("[data-chart]", main), d.trend);
}

function drawChart(el, data) {
  const W = 800, H = 240, P = { l: 40, r: 10, t: 14, b: 26 };
  const max = Math.max(...data.map((d) => d.pv), 10) * 1.15;
  const x = (i) => P.l + (i / (data.length - 1)) * (W - P.l - P.r);
  const y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
  const line = (k) => data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d[k]).toFixed(1)}`).join(" ");
  const area = `${line("pv")} L${x(data.length - 1)},${H - P.b} L${x(0)},${H - P.b} Z`;
  const ticks = [0, .25, .5, .75, 1].map((r) => Math.round(max * r));
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--c2)" stop-opacity=".35"/><stop offset="1" stop-color="var(--c2)" stop-opacity="0"/></linearGradient>
    <linearGradient id="gl" x1="0" x2="1"><stop offset="0" stop-color="var(--c1)"/><stop offset=".5" stop-color="var(--c2)"/><stop offset="1" stop-color="var(--c3)"/></linearGradient></defs>
    ${ticks.map((t) => `<line class="grid-line" x1="${P.l}" x2="${W - P.r}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${P.l - 8}" y="${y(t) + 3}" text-anchor="end">${t >= 1000 ? (t / 1000).toFixed(1) + "k" : t}</text>`).join("")}
    ${data.map((d, i) => (i % 5 === 0 || i === data.length - 1 ? `<text class="axis" x="${x(i)}" y="${H - 6}" text-anchor="middle">${d.date.slice(5)}</text>` : "")).join("")}
    <path d="${area}" fill="url(#ga)"/>
    <path d="${line("uv")}" fill="none" stroke="var(--c1)" stroke-width="1.6" stroke-dasharray="4 4" opacity=".8" vector-effect="non-scaling-stroke"/>
    <path d="${line("pv")}" fill="none" stroke="url(#gl)" stroke-width="2.5" vector-effect="non-scaling-stroke" class="pv-line"/>
    <line class="cursor" y1="${P.t}" y2="${H - P.b}" stroke="var(--border-strong)" opacity="0"/>
  </svg><div class="tip"></div>`;
  const path = el.querySelector(".pv-line");
  const len = path.getTotalLength();
  path.style.strokeDasharray = len; path.style.strokeDashoffset = len;
  path.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 1200, easing: "cubic-bezier(.2,.8,.2,1)", fill: "forwards" });
  const tip = el.querySelector(".tip"), cursor = el.querySelector(".cursor");
  const onMove = (e) => {
    const r = el.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(data.length - 1, Math.round(((px - P.l) / (W - P.l - P.r)) * (data.length - 1))));
    const d = data[i];
    cursor.setAttribute("x1", x(i)); cursor.setAttribute("x2", x(i)); cursor.setAttribute("opacity", 1);
    tip.style.left = (x(i) / W) * 100 + "%"; tip.style.top = (y(d.pv) / H) * 100 + "%"; tip.style.opacity = 1;
    tip.innerHTML = `${esc(d.date)}<br>PV <b>${d.pv}</b> · UV <b>${d.uv}</b>`;
  };
  const onLeave = () => { tip.style.opacity = 0; cursor.setAttribute("opacity", 0); };
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerleave", onLeave);
}
