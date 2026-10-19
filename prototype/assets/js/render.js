/* ============================================================
 * WangBlog 前台渲染层：读取 WBApi 数据，填充页面占位容器。
 * 页面通过容器存在性自动识别（见末尾路由）。
 * 本文件只负责「渲染 + 与数据相关的交互」，通用交互在 site.js。
 * ============================================================ */
(function () {
  "use strict";

  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const postUrl = (p) => "post.html" + (p && p.slug ? "?slug=" + encodeURIComponent(p.slug) : "");

  /* 极简 Markdown 渲染（与后台编辑器预览同一规则）：
     用于没有预渲染 detail.contentHtml 的文章（如新发布的文章） */
  function mdRender(md) {
    const html = String(md || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/^### (.*)$/gm, "<h3>$1</h3>")
      .replace(/^## (.*)$/gm, "<h2>$1</h2>")
      .replace(/^# (.*)$/gm, "<h1>$1</h1>")
      .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
        `<div class="code-block"><div class="code-block__bar"><span>${lang || "text"}</span></div><pre>${code}</pre></div>`)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/^> (.*)$/gm, "<blockquote>$1</blockquote>")
      .replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>");
    return "<p>" + html + "</p>";
  }

  /* 从渲染后的正文中提取 h2/h3 目录 */
  function extractToc(container) {
    return Array.from(container.querySelectorAll("h2, h3")).map((h, i) => {
      if (!h.id) h.id = "sec-" + (i + 1);
      return { id: h.id, label: h.textContent };
    });
  }

  /* ================= 首页 ================= */
  async function initHome() {
    const cfg = await WBApi.siteConfig();
    const hero = document.querySelector(".hero");
    if (hero) {
      hero.querySelector(".hero__title").innerHTML = cfg.home.heroTitleHtml;
      hero.querySelector(".hero__desc").textContent = cfg.home.heroDesc;
      const links = hero.querySelector(".hero__links");
      links.innerHTML = cfg.home.heroLinks
        .map((l) =>
          l.toast
            ? `<a href="${esc(l.href)}" onclick="wbToast('${esc(l.toast)}');return false;">${esc(l.label)}</a>`
            : `<a href="${esc(l.href)}">${esc(l.label)}</a>`
        )
        .join("");
    }

    const posts = await WBApi.posts();
    const list = document.querySelector("[data-render='post-list']");
    const ordered = [...posts.filter((p) => p.status === "pinned"), ...(await WBApi.publishedPosts()).filter((p) => p.status !== "pinned")];
    list.innerHTML = ordered
      .map((p) => {
        const pinned = p.status === "pinned";
        const cover = p.cover
          ? `<div class="post-card__cover" aria-hidden="true"><div style="width:100%;height:100%;background:linear-gradient(135deg,${p.cover.from},${p.cover.to});display:grid;place-items:center;color:#fff;font-family:var(--font-mono);font-size:${p.cover.fontSize};font-weight:700;">${esc(p.cover.text)}</div></div>`
          : "";
        return `<article class="post-card${pinned ? " post-card--pinned" : ""}">
      <div class="post-card__body">
        ${pinned ? '<span class="pin-badge">置顶</span>' : ""}
        <h2 class="post-card__title"><a href="${postUrl(p)}">${esc(p.title)}</a></h2>
        <p class="post-card__excerpt">${esc(p.excerpt)}</p>
        <div class="post-card__meta">
          <time>${p.date}</time><span class="badge badge--cat">${esc(p.category)}</span>
          ${p.tags.map((t) => `<a class="tag-chip" href="archive.html">${esc(t)}</a>`).join("")}
          <span>${p.readingMinutes} 分钟阅读 · ${p.commentCount} 评论</span>
        </div>
      </div>
      ${cover}
    </article>`;
      })
      .join("");
  }

  /* ================= 文章详情页（?slug= 指定文章，缺省为最新一篇） ================= */
  async function initPost() {
    const slug = new URLSearchParams(location.search).get("slug");
    const published = await WBApi.publishedPosts();
    const post = await WBApi.post(slug || "http-cache-deep-dive"); // 缺省展示内容最完整的一篇

    if (!post) { // slug 不存在：给出明确提示而非空白页
      document.querySelector("[data-render='post-header']").innerHTML =
        `<h1>文章不存在</h1><div class="post-header__meta"><span>可能已被删除或移入回收站</span></div>`;
      document.querySelector("[data-render='post-content']").innerHTML =
        `<p><a href="index.html">← 返回首页</a></p>`;
      return;
    }

    const d = post.detail || {};
    document.title = `${post.title} — 向明笔记`;
    document.querySelector('meta[name="description"]').setAttribute("content",
      d.description || post.excerpt || post.title);

    document.querySelector("[data-render='breadcrumb']").innerHTML =
      `<a href="index.html">首页</a><span>/</span><a href="archive.html#categories">${esc(d.breadcrumbCategory || post.category || "文章")}</a><span>/</span><span>${esc(d.breadcrumbShort || post.title)}</span>`;

    document.querySelector("[data-render='post-header']").innerHTML = `
        <h1>${esc(post.title)}</h1>
        <div class="post-header__meta">
          <time>${post.date}</time><span>·</span><span class="badge badge--cat">${esc(post.category || "未分类")}</span><span>·</span>
          <span>${post.readingMinutes || Math.max(1, Math.round(((post.editor || {}).markdown || "").length / 500))} 分钟阅读</span><span>·</span><span>${post.commentCount || 0} 评论</span>
        </div>`;

    // 正文：优先使用种子预渲染 HTML，否则用 Markdown 实时渲染，均无则提示
    const contentEl = document.querySelector("[data-render='post-content']");
    const mdText = (post.editor || {}).markdown || "";
    contentEl.innerHTML = d.contentHtml ||
      (mdText.trim() ? mdRender(mdText)
                     : `<p class="cell-meta">本文暂无正文内容（原型演示数据，仅《深入 HTTP 缓存》一篇含完整正文）。</p>`);

    // 上一篇 / 下一篇（按发布日期排序的相邻文章）
    const idx = published.findIndex((p) => p.slug === post.slug);
    const prev = idx > 0 ? published[idx - 1] : null;
    const next = idx >= 0 && idx < published.length - 1 ? published[idx + 1] : null;
    document.querySelector("[data-render='post-nav']").innerHTML = `
        ${prev ? `<a href="${postUrl(prev)}"><span class="post-nav__label">‹ 上一篇</span><span class="post-nav__title">${esc(prev.title)}</span></a>` : "<span></span>"}
        ${next ? `<a href="${postUrl(next)}"><span class="post-nav__label">下一篇 ›</span><span class="post-nav__title">${esc(next.title)}</span></a>` : "<span></span>"}`;

    // 相关文章：同标签优先，其次同分类
    const related = published
      .filter((p) => p.slug !== post.slug)
      .map((p) => ({ p, score: p.tags.filter((t) => (post.tags || []).includes(t)).length * 2 + (p.category === post.category ? 1 : 0) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((x) => x.p);
    document.querySelector("[data-render='related']").innerHTML =
      (d.related || related.map((p) => ({ title: p.title, meta: `${p.date} · ${p.category}`, slug: p.slug })))
        .map((r) => `<a class="related__item" href="${r.slug ? postUrl(r) : postUrl()}"><strong>${esc(r.title)}</strong><span>${esc(r.meta)}</span></a>`)
        .join("") || `<p class="cell-meta">暂无相关文章</p>`;

    // 评论列表（先于 TOC，拿到真实评论数）
    const comments = await WBApi.postComments(post.slug);
    document.querySelector("#comment-list").innerHTML = comments
      .map(
        (c) => `<div class="comment">
            <div class="comment__avatar"${c.isAuthor ? ' style="background:var(--success-soft);color:var(--success);"' : ""}>${esc(c.avatarText)}</div>
            <div>
              <div class="comment__meta"><strong>${esc(c.author)}</strong>${c.isAuthor ? '<span class="badge pin-badge">作者</span> ' : ""}${c.time}</div>
              <p class="comment__body">${esc(c.body)}</p>
            </div>
          </div>`
      )
      .join("") || `<p class="cell-meta">还没有评论，来抢沙发～</p>`;

    // TOC（侧栏 + 移动端抽屉）：优先种子数据，否则从正文提取
    const toc = (d.toc && d.toc.length ? d.toc : extractToc(contentEl));
    const tocHtml =
      toc.map((t, i) => `<a href="#${t.id}"${i === 0 ? ' class="is-active"' : ""}>${esc(t.label)}</a>`).join("") +
      `<a href="#comments">评论（${comments.length}）</a>`;
    document.querySelector("[data-render='toc']").insertAdjacentHTML("beforeend", tocHtml);
    document.querySelector("[data-render='toc-drawer']").innerHTML =
      toc.map((t) => `<a href="#${t.id}" data-toc-open>${esc(t.label)}</a>`).join("") +
      `<a href="#comments" data-toc-open>评论（${comments.length}）</a>`;

    // 动态内容就绪后，重建 TOC 监听（site.js 暴露）
    window.wbInitTocSpy && window.wbInitTocSpy();
  }

  /* ================= 归档页 ================= */
  async function initArchive() {
    const [tax, posts] = await Promise.all([WBApi.taxonomy(), WBApi.archivablePosts()]);

    document.querySelector("[data-render='archive-total']").textContent = `共 ${tax.totalPosts} 篇`;

    document.querySelector("[data-render='category-list']").innerHTML = tax.categories
      .map((c) => `<a class="related__item" href="#"><strong>${esc(c.name)}</strong><span>${c.count} 篇文章</span></a>`)
      .join("");

    // 按 年 → 月 分组
    const byYear = new Map();
    posts.forEach((p) => {
      const [y, m, dd] = p.date.split("-");
      if (!byYear.has(y)) byYear.set(y, new Map());
      const byMonth = byYear.get(y);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push({ dd, title: p.title, slug: p.slug });
    });

    const yearCount = Object.fromEntries(tax.years.map((y) => [String(y.year), y.count]));
    let html = "";
    for (const [y, byMonth] of byYear) {
      html += `<h2 class="archive-year">${y} <small>${yearCount[y] || 0} 篇</small></h2>`;
      for (const [m, items] of byMonth) {
        html += `<p class="archive-month">${m} 月</p>`;
        items.forEach((it) => {
          html += `<div class="archive-item"><time>${m}-${it.dd}</time><a href="${postUrl(it)}">${esc(it.title)}</a></div>`;
        });
      }
    }
    document.querySelector("[data-render='archive-list']").innerHTML = html;
  }

  /* ================= 搜索页 ================= */
  async function initSearch() {
    const [cfg, posts] = await Promise.all([WBApi.siteConfig(), WBApi.publishedPosts()]);
    const sc = cfg.search;
    const input = document.querySelector("#search-input");
    const results = document.querySelector("#search-results");
    const empty = document.querySelector("#search-empty");
    const meta = document.querySelector("#search-meta");
    input.placeholder = sc.placeholder;

    // 空态热门标签
    empty.querySelector(".hero__links").innerHTML = sc.hotTags
      .map((t) => `<a href="archive.html">#${esc(t)}</a>`)
      .join("");

    const highlight = (text, q) =>
      esc(text).replace(new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), (m) => `<mark>${m}</mark>`);

    const itemHtml = (p, q, snippet) => `<div class="search-result">
      <a href="${postUrl(p)}">${q ? highlight(p.title, q) : esc(p.title)}</a>
      <p>${snippet ? highlight(snippet, q) : esc(p.excerpt)}</p>
      <time>${p.date} · ${esc(p.category)}</time>
    </div>`;

    // 初始演示态：预置关键词「缓存」的三条结果（含摘要片段与 mark 高亮）
    const demoSlugs = Object.keys(sc.demoSnippets);
    const renderDemo = () => {
      results.innerHTML = posts
        .filter((p) => demoSlugs.includes(p.slug))
        .map((p) => itemHtml(p, sc.demoKeyword, sc.demoSnippets[p.slug]))
        .join("");
    };
    renderDemo();

    let timer;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const q = input.value.trim();
        if (!q) {
          empty.style.display = "none";
          results.style.display = "";
          meta.firstChild.textContent = "输入关键词开始检索 ";
          renderDemo();
          return;
        }
        const lower = q.toLowerCase();
        const hits = posts.filter(
          (p) =>
            p.title.toLowerCase().includes(lower) ||
            p.excerpt.toLowerCase().includes(lower) ||
            p.tags.some((t) => t.toLowerCase().includes(lower)) ||
            p.category.toLowerCase().includes(lower)
        );
        empty.style.display = hits.length ? "none" : "";
        results.style.display = hits.length ? "" : "none";
        meta.firstChild.textContent = `找到 ${hits.length} 篇与「${q}」相关的文章 `;
        results.innerHTML = hits.map((p) => itemHtml(p, q, null)).join("");
      }, 300); // 300ms 防抖，对齐 PRD 6.6.2
    });

    document.querySelectorAll(".search-sort button").forEach((b) =>
      b.addEventListener("click", () => {
        document.querySelectorAll(".search-sort button").forEach((x) => x.classList.remove("is-active"));
        b.classList.add("is-active");
      })
    );
  }

  /* ================= 关于页 ================= */
  async function initAbout() {
    const cfg = await WBApi.siteConfig();
    const a = cfg.about;
    document.querySelector("[data-render='about-author']").innerHTML = `
    <div style="width:88px;height:88px;border-radius:50%;background:var(--accent);color:var(--accent-contrast);display:grid;place-items:center;font-family:var(--font-serif);font-size:32px;font-weight:700;flex-shrink:0;">${esc(a.author.avatarText)}</div>
    <div>
      <h2 style="font-family:var(--font-serif);margin:0 0 var(--space-2);">${esc(a.author.name)}</h2>
      <p style="margin:0;color:var(--text-secondary);font-size:var(--fs-small);">${esc(a.author.bio)}</p>
      <p style="margin:var(--space-2) 0 0;font-size:var(--fs-small);">
        <a href="mailto:${esc(a.author.email)}">${esc(a.author.email)}</a> · ${a.author.links.map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>`).join(" · ")}
      </p>
    </div>`;
    document.querySelector("[data-render='about-blog']").textContent = a.blogIntro;
  }

  /* ================= 404 页 ================= */
  async function initNotFound() {
    const cfg = await WBApi.siteConfig();
    const nf = cfg.notFound;
    document.querySelector("[data-render='nf-title']").textContent = nf.title;
    document.querySelector("[data-render='nf-desc']").textContent = nf.desc;
    document.querySelector("[data-render='nf-recommend']").innerHTML = nf.recommend
      .map((r) => `<a class="related__item" href="${postUrl()}"><strong>${esc(r.title)}</strong><span>${esc(r.meta)}</span></a>`)
      .join("");
  }

  /* ================= 路由：按容器识别页面 ================= */
  const routes = [
    ["[data-render='post-list']", initHome],
    ["[data-render='post-content']", initPost],
    ["[data-render='archive-list']", initArchive],
    ["#search-results", initSearch],
    ["[data-render='about-author']", initAbout],
    ["[data-render='nf-recommend']", initNotFound],
  ];
  routes.forEach(([sel, fn]) => {
    if (document.querySelector(sel)) fn().catch((e) => console.error("[render]", e));
  });
})();
