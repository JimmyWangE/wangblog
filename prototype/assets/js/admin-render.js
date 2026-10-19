/* ============================================================
 * WangBlog 后台渲染层：读取 WBApi 数据，填充后台页面占位容器。
 * 渲染完成后调用 admin.js 暴露的 WBAdmin.init* 绑定交互。
 * ============================================================ */
(function () {
  "use strict";

  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  /* 侧栏「评论」入口的待审角标（看板/文章/评论三页共用） */
  async function renderNavBadge() {
    const badge = document.querySelector(".admin-nav__badge");
    if (!badge) return;
    const dash = await WBApi.dashboard();
    badge.textContent = dash.pendingComments;
  }

  /* ================= 看板 ================= */
  async function initDashboard() {
    const dash = await WBApi.dashboard();

    // 统计卡
    document.querySelector("[data-render='stat-grid']").innerHTML = dash.stats
      .map(
        (s) => `<div class="stat-card">
          <p class="stat-card__label">${esc(s.label)}</p>
          <p class="stat-card__value"${s.valueColor ? ` style="color:var(--${s.valueColor});"` : ""}>${esc(s.value)}</p>
          <p class="stat-card__sub${s.subClass ? ` stat-card__sub--${s.subClass}` : ""}">${s.subHtml}</p>
        </div>`
      )
      .join("");

    // 访问量趋势（26 个点，x 步进 20）
    const t = dash.trend;
    const points = t.values.map((y, i) => `${i * 20},${y}`).join(" ");
    const lastX = (t.values.length - 1) * 20;
    const lastY = t.values[t.values.length - 1];
    document.querySelector("[data-render='trend-panel']").innerHTML = `
          <h2 class="panel__title">${esc(t.title)} <small>${esc(t.period)}</small></h2>
          <svg viewBox="0 0 520 160" width="100%" role="img" aria-label="近30天访问量折线图">
            <line x1="0" y1="130" x2="520" y2="130" stroke="var(--border)" stroke-width="1"/>
            <line x1="0" y1="90" x2="520" y2="90" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 4"/>
            <line x1="0" y1="50" x2="520" y2="50" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 4"/>
            <polyline fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" points="${points}"/>
            <circle cx="${lastX}" cy="${lastY}" r="4" fill="var(--accent)"/>
            <text x="0" y="150" font-size="11" fill="var(--text-tertiary)">${esc(t.startLabel)}</text>
            <text x="480" y="150" font-size="11" fill="var(--text-tertiary)">${esc(t.endLabel)}</text>
          </svg>`;

    // 热门文章 Top 5
    document.querySelector("[data-render='top-posts']").innerHTML = `
          <h2 class="panel__title">${esc(dash.topPosts.title)} <small>${esc(dash.topPosts.period)}</small></h2>
          <div class="top-list">${dash.topPosts.items
            .map(
              (p) => `<div class="top-list__item"><span class="top-list__rank${p.hot ? " top-list__rank--hot" : ""}">${p.rank}</span><a class="top-list__name" href="../post.html?slug=${encodeURIComponent(p.slug)}">${esc(p.title)}</a><span class="top-list__bar" style="width:${p.barWidth}px;"></span><span class="top-list__num">${esc(p.num)}</span></div>`
            )
            .join("")}</div>`;

    // 系统状态（圆环周长 188.5）
    const C = 188.5;
    document.querySelector("[data-render='system-panel']").innerHTML = `
          <h2 class="panel__title">系统状态</h2>
          <div class="gauge-row">${dash.system.gauges
            .map(
              (g) => `<div class="gauge">
              <svg width="72" height="72"><circle class="gauge__track" cx="36" cy="36" r="30" fill="none" stroke-width="6"/><circle cx="36" cy="36" r="30" fill="none" stroke="var(--${g.color})" stroke-width="6" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${(C * (1 - g.percent / 100)).toFixed(1)}"/></svg>
              <p class="gauge__val">${g.percent}%</p><p class="gauge__label">${esc(g.label)}</p>
            </div>`
            )
            .join("")}</div>
          <p style="font-size:var(--fs-caption);color:var(--text-secondary);margin:var(--space-6) 0 0;">${dash.system.health
            .map((h, i) => `<span class="health-dot health-dot--${h.level}"${i ? ' style="margin-left:var(--space-4);"' : ""}></span>${esc(h.label)}`)
            .join("")}
          </p>`;

    // 待办
    document.querySelector("[data-render='todo-panel']").innerHTML = `
          <h2 class="panel__title">待办</h2>
          <div class="top-list">${dash.todos
            .map(
              (t) => `<div class="top-list__item"><span class="health-dot health-dot--${t.level}"></span><span class="top-list__name">${esc(t.text)}</span><a class="link-btn" href="${esc(t.href)}">${esc(t.actionText)}</a></div>`
            )
            .join("")}</div>`;
  }

  /* ================= 文章管理 ================= */
  const STATUS_BADGE = {
    pinned: (p) => '<span class="status-badge status-badge--pinned">置顶</span>',
    published: () => '<span class="status-badge status-badge--published">已发布</span>',
    scheduled: (p) => `<span class="status-badge status-badge--scheduled">定时 · ${esc(p.scheduledAt)}</span>`,
    draft: () => '<span class="status-badge status-badge--draft">草稿</span>',
  };

  async function initAdminPosts() {
    const [posts, tax] = await Promise.all([WBApi.posts(), WBApi.taxonomy()]);
    const s = tax.postsSummary;

    document.querySelector("[data-render='posts-tbody']").innerHTML = posts
      .map((p) => {
        const isDraft = p.status === "draft";
        const sub = isDraft ? p.draftNote : `/posts/${p.slug}`;
        const tags = p.tags.length ? ` <span class="cell-meta">${p.tags.map((t) => "#" + esc(t)).join(" ")}</span>` : "";
        return `<tr data-id="${esc(p.id || "")}">
              <td><input type="checkbox" aria-label="选择"></td>
              <td><a class="cell-title" href="editor.html?slug=${encodeURIComponent(p.slug)}">${esc(p.title)}</a><div class="cell-meta">${esc(sub || "")}</div></td>
              <td>${STATUS_BADGE[p.status](p)}</td>
              <td class="col-hide-m"><span class="badge badge--cat">${esc(p.category)}</span>${tags}</td>
              <td class="col-hide-m cell-meta">${p.commentCount == null ? "—" : p.commentCount}</td>
              <td class="col-hide-m cell-meta">${esc(p.updatedAt)}</td>
              <td><div class="row-actions"><a class="link-btn" href="editor.html?slug=${encodeURIComponent(p.slug)}">${isDraft ? "继续写" : "编辑"}</a>${isDraft || p.status === "scheduled" ? "" : `<a class="link-btn" href="../post.html?slug=${encodeURIComponent(p.slug)}">预览</a>`}<button class="link-btn" style="color:var(--error);" data-trash>回收站</button></div></td>
            </tr>`;
      })
      .join("");

    document.querySelector("[data-render='posts-summary']").textContent =
      `共 ${s.total} 篇 · 已发布 ${s.published} · 草稿 ${s.draft} · 定时 ${s.scheduled}`;

    window.WBAdmin && window.WBAdmin.initPostsTable();
  }

  /* ================= 评论审核 ================= */
  async function initAdminComments() {
    const data = await WBApi.comments();
    const r = data.review;

    document.querySelector("[data-render='review-tabs']").innerHTML = r.tabs
      .map((t) => `<button${t.active ? ' class="is-active"' : ""} role="tab">${esc(t.label)}（${t.count}）</button>`)
      .join("");

    document.querySelector("[data-render='review-list']").innerHTML = r.pending
      .map(
        (c) => `<div class="review-card"${c.id ? ` data-id="${esc(c.id)}"` : ""}>
        <div class="review-card__head">
          <strong>${esc(c.author)}</strong><span>${esc(c.contact)}</span><span>${esc(c.timeAgo)}</span>
          ${c.flag ? `<span class="status-badge status-badge--scheduled">${esc(c.flag)}</span>` : ""}
        </div>
        <p class="review-card__body">${c.bodyHtml}</p>
        <p class="review-card__quote">评论于：《${esc(c.postTitle)}》</p>
        <div class="review-card__actions">
          ${c.actions.map((a) => `<button class="btn btn--${a.style}" data-action="${a.action}">${esc(a.label)}</button>`).join("")}
        </div>
      </div>`
      )
      .join("");
  }

  /* ================= 编辑器（?slug= 编辑已有文章；无参数为新建） ================= */
  async function initEditor() {
    const slug = new URLSearchParams(location.search).get("slug");
    const post = slug ? await WBApi.post(slug) : null;

    const statusBadge = document.querySelector(".editor-topbar .status-badge");
    const STATUS_TEXT = { draft: "草稿", published: "已发布", pinned: "已发布 · 置顶", scheduled: "定时发布" };

    if (!post) {
      // 新建模式（或 slug 不存在）：空白编辑器
      if (slug) toast404();
      statusBadge.textContent = "草稿";
      window.WBAdmin && window.WBAdmin.initEditor(null);
      return;
    }

    const e = post.editor || {};
    document.querySelector(".editor-title-input").value = post.title;
    document.querySelector("#md-editor").value = e.markdown || "";
    document.querySelector("[data-field='slug']").value = post.slug;
    document.querySelector("[data-field='category']").value = post.category || "";
    document.querySelector("[data-field='tags']").value = e.tagsInput || (post.tags || []).join(", ");
    document.querySelector("[data-render='modal-category']").textContent = post.category || "未分类";
    document.querySelector("[data-render='modal-tags']").textContent =
      e.modalTags || (post.tags || []).map((t) => "#" + t).join(" ") || "无";
    if (post.scheduledAt) {
      const dt = document.querySelector("[data-field='scheduledAt']");
      if (dt) dt.value = post.scheduledAt.replace(" ", "T").slice(0, 16);
    }
    statusBadge.className = "status-badge status-badge--" + (post.status === "pinned" ? "published" : post.status);
    statusBadge.textContent = STATUS_TEXT[post.status] || post.status;

    // 内容填充完成后初始化编辑器交互（预览渲染 / 自动保存 / 发布流）
    window.WBAdmin && window.WBAdmin.initEditor(post);

    function toast404() { /* slug 无效时静默回退新建模式即可 */ }
  }

  /* ================= 路由 ================= */
  renderNavBadge().catch((e) => console.error("[admin-render]", e));
  const routes = [
    ["[data-render='stat-grid']", initDashboard],
    ["[data-render='posts-tbody']", initAdminPosts],
    ["[data-render='review-list']", initAdminComments],
    ["#md-editor", initEditor],
  ];
  routes.forEach(([sel, fn]) => {
    if (document.querySelector(sel)) fn().catch((e) => console.error("[admin-render]", e));
  });
})();
