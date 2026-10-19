/* 首页：Hero（粒子网络 + 打字机 + 终端卡片 + 数据计数）→ 置顶精选 → 分类筛选的无限列表 + 侧栏 */
import { api } from "../../lib/api.js";
import { reveal, countUp } from "../../lib/ui.js";
import { $, $$, html, mount, icon, fmtNum, fmtDate, urlFor, toStr } from "../../lib/util.js";
import { state } from "../state.js";
import { postCard, postCardSkeleton, featuredCard, authorCard, hotList, tagCloud, recentComments, emptyState, errorState } from "../components.js";

export async function homeView(outlet) {
  const site = state.site;
  const h = site.home || {};
  const s = site.site || {};
  document.title = `${s.name || "向明笔记"} — ${s.slogan || ""}`;
  const lines = h.titleLines || ["写作即思考，", "记录一名工程师的", "长期主义。"];
  const hl = h.highlight || "";
  const titleHtml = lines.map((l) => {
    if (hl && l.includes(hl)) {
      const [a, b] = l.split(hl);
      return html`<span class="line">${a}<span class="hl grad-text">${hl}</span>${b}</span>`;
    }
    return html`<span class="line">${l}</span>`;
  });

  mount(outlet, html`
  <section class="hero">
    <canvas class="hero__canvas" aria-hidden="true"></canvas>
    <div class="container hero__grid">
      <div class="view-enter">
        <span class="eyebrow"><span class="pulse"></span>${h.eyebrow || "Personal Tech Journal"}</span>
        <h1 class="hero__title">${titleHtml}</h1>
        <p class="hero__desc">${h.desc || s.description || ""}</p>
        <div class="typing" aria-hidden="true"><span class="typing__prompt">~/blog $</span><span>writing --topic</span>
          <span class="typing__text"></span><span class="typing__caret"></span></div>
        <div class="hero__ctas">
          ${(h.ctas || [{ label: "开始阅读", href: "/archive", primary: true }]).map((c) =>
            html`<a class="btn btn--lg ${c.primary ? "btn--primary" : ""}" href="${c.href}">${c.label}${c.primary ? icon("arrowRight") : ""}</a>`)}
          <button class="btn btn--lg btn--ghost" data-search>${icon("search")}搜索</button>
        </div>
        <div class="hero__stats">
          <div class="stat"><div class="stat__num" data-count="posts">0</div><div class="stat__label">篇文章</div></div>
          <div class="stat"><div class="stat__num" data-count="words">0</div><div class="stat__label">字</div></div>
          <div class="stat"><div class="stat__num" data-count="views">0</div><div class="stat__label">次阅读</div></div>
          <div class="stat"><div class="stat__num" data-count="days">0</div><div class="stat__label">天运行</div></div>
        </div>
      </div>
      <div class="terminal view-enter" style="animation-delay:.12s">
        <div class="terminal__bar"><i></i><i></i><i></i><span>jimmy@blog: ~/posts</span></div>
        <div class="terminal__body" data-terminal><div class="cmd">ls -lt posts/ | head</div></div>
      </div>
    </div>
  </section>

  <section class="section container" data-featured-wrap></section>

  <section class="section container">
    <div class="layout">
      <div>
        <div class="section__head">
          <div><h2 class="section__title"><span class="idx">02</span>最新文章</h2><p class="section__sub">按分类筛选，向下滚动自动加载</p></div>
          <div class="filters" data-filters role="tablist"></div>
        </div>
        <div class="post-list" data-list>${postCardSkeleton(4)}</div>
        <div class="load-more" data-more></div>
      </div>
      <aside class="sidebar" data-sidebar></aside>
    </div>
  </section>`);

  const cleanups = [startParticles($(".hero__canvas", outlet)), startTyping($(".typing__text", outlet), h.typing || ["前端工程化", "运维实践", "内容主权"])];

  // ---------- 首页聚合数据 ----------
  let home;
  try { home = await api.home(); } catch (e) { mount($("[data-list]", outlet), errorState(e)); return () => cleanups.forEach((f) => f()); }

  const st = home.stats || {};
  $$("[data-count]", outlet).forEach((el) => countUp(el, st[el.dataset.count] || 0, { format: (n) => (n >= 10000 ? fmtNum(n) : n.toLocaleString()) }));

  if (home.featured?.length) {
    mount($("[data-featured-wrap]", outlet), html`<div class="section__head"><div><h2 class="section__title"><span class="idx">01</span>置顶精选</h2></div></div>
      <div style="display:grid;gap:18px">${home.featured.map(featuredCard)}</div>`);
  } else $("[data-featured-wrap]", outlet).remove();

  mount($("[data-sidebar]", outlet), html`${authorCard(site, st)}${hotList(home.hot || [])}${tagCloud(home.tags || [])}${recentComments(home.recentComments)}`);
  renderTerminal($("[data-terminal]", outlet), home, st);

  // ---------- 分类筛选 + 无限加载 ----------
  const filters = $("[data-filters]", outlet);
  const cats = (home.categories || []).filter((c) => c.count > 0);
  let current = "";
  const paintFilters = () => mount(filters, html`<button class="chip ${current === "" ? "is-active" : ""}" data-cat="" role="tab">全部</button>
    ${cats.map((c) => html`<button class="chip ${current === c.name ? "is-active" : ""}" data-cat="${c.name}" role="tab">${c.name}<span class="chip__count">${c.count}</span></button>`)}`);
  paintFilters();

  const list = $("[data-list]", outlet);
  const more = $("[data-more]", outlet);
  let page = 0, loading = false, hasMore = true, gen = 0;
  const hasFeatured = !!home.featured?.length;

  async function load(reset = false) {
    if (loading && !reset) return;
    if (reset) { page = 0; hasMore = true; gen++; mount(list, postCardSkeleton(3)); }
    if (!hasMore) return;
    loading = true;
    const myGen = gen;
    mount(more, html`<span class="spinner faint"></span>`);
    try {
      const d = await api.posts({ page: page + 1, pageSize: 6, category: current, excludePinned: !current && hasFeatured ? "true" : "" });
      if (myGen !== gen) return;
      if (page === 0) list.innerHTML = "";
      page = d.page; hasMore = d.hasMore;
      list.insertAdjacentHTML("beforeend", toStr(d.list.map(postCard)));
      if (!d.total) mount(list, emptyState("这里还没有文章", "换个分类看看吧"));
      reveal(list);
      mount(more, hasMore ? html`<button class="btn" data-load>加载更多</button>` : d.total ? html`<div class="end-mark">— END · 共 ${d.total} 篇 —</div>` : "");
    } catch (e) {
      if (myGen === gen) mount(more, html`<button class="btn" data-load>${icon("refresh")}加载失败，点击重试</button>`);
    } finally { if (myGen === gen) loading = false; }
  }

  filters.addEventListener("click", (e) => {
    const b = e.target.closest("[data-cat]");
    if (!b || b.dataset.cat === current) return;
    current = b.dataset.cat;
    paintFilters();
    loading = false;
    load(true);
  });
  more.addEventListener("click", (e) => { if (e.target.closest("[data-load]")) load(); });
  const io = new IntersectionObserver((en) => { if (en[0].isIntersecting && hasMore && !loading && page > 0) load(); }, { rootMargin: "400px" });
  io.observe(more);
  await load(true);
  reveal(outlet);
  return () => { io.disconnect(); cleanups.forEach((f) => f()); };
}

function renderTerminal(el, home, st) {
  const posts = [...(home.featured || []), ...(home.hot || [])].filter((p, i, a) => a.findIndex((x) => x.slug === p.slug) === i)
    .sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 6);
  const rows = [
    html`<div class="cmd">ls -lt posts/ | head -n ${posts.length}</div>`,
    ...posts.map((p) => html`<div class="row"><span class="dim">${fmtDate(p.date, false)}</span><span class="dim">${String(p.readingMinutes || 1).padStart(2, " ")}m</span><a href="${urlFor.post(p.slug)}">${p.slug}.md</a></div>`),
    html`<div class="cmd" style="margin-top:10px">blog stats</div>`,
    html`<div class="row"><span class="ok">✔</span><span>${st.posts} posts · ${fmtNum(st.words)} words · ${st.comments} comments</span></div>`,
    html`<div class="row"><span class="ok">✔</span><span>last publish: ${st.lastPublished || "-"}</span></div>`,
  ];
  // 逐行出现
  el.innerHTML = "";
  rows.forEach((r, i) => setTimeout(() => el.insertAdjacentHTML("beforeend", toStr(r)), 120 + i * 90));
}

function startTyping(el, words) {
  if (!el) return () => {};
  let wi = 0, ci = 0, del = false, t;
  const tick = () => {
    const w = words[wi % words.length];
    el.textContent = w.slice(0, ci);
    if (!del && ci < w.length) { ci++; t = setTimeout(tick, 110); }
    else if (!del) { del = true; t = setTimeout(tick, 1600); }
    else if (ci > 0) { ci--; t = setTimeout(tick, 45); }
    else { del = false; wi++; t = setTimeout(tick, 300); }
  };
  tick();
  return () => clearTimeout(t);
}

/* 粒子网络：节点缓慢漂移，近邻连线，鼠标附近增强；页面不可见/离屏时暂停 */
function startParticles(canvas) {
  if (!canvas || matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};
  const ctx = canvas.getContext("2d");
  let w, hgt, dpr, raf, pts = [], mouse = { x: -9999, y: -9999 }, visible = true;
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth; hgt = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = hgt * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.min(90, Math.floor((w * hgt) / 14000));
    pts = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * hgt, vx: (Math.random() - .5) * .3, vy: (Math.random() - .5) * .3 }));
  };
  const color = () => (document.documentElement.dataset.theme === "light" ? "91,91,214" : "129,140,248");
  const draw = () => {
    raf = requestAnimationFrame(draw);
    if (!visible) return;
    ctx.clearRect(0, 0, w, hgt);
    const c = color();
    for (const p of pts) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > hgt) p.vy *= -1;
      const dm = Math.hypot(p.x - mouse.x, p.y - mouse.y);
      if (dm < 140) { p.x += (p.x - mouse.x) / dm * .6; p.y += (p.y - mouse.y) / dm * .6; }
    }
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      for (let j = i + 1; j < pts.length; j++) {
        const b = pts[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < 130) {
          ctx.strokeStyle = `rgba(${c},${(1 - d / 130) * .35})`;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
      const near = Math.hypot(a.x - mouse.x, a.y - mouse.y) < 160;
      ctx.fillStyle = `rgba(${c},${near ? .95 : .55})`;
      ctx.beginPath(); ctx.arc(a.x, a.y, near ? 2.2 : 1.4, 0, Math.PI * 2); ctx.fill();
    }
  };
  const onMove = (e) => { const r = canvas.getBoundingClientRect(); mouse = { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const io = new IntersectionObserver((en) => { visible = en[0].isIntersecting && !document.hidden; });
  io.observe(canvas);
  resize();
  draw();
  window.addEventListener("resize", resize);
  window.addEventListener("pointermove", onMove, { passive: true });
  return () => { cancelAnimationFrame(raf); io.disconnect(); window.removeEventListener("resize", resize); window.removeEventListener("pointermove", onMove); };
}
