/* WangBlog 前台交互（纯交互，不含数据；数据渲染见 render.js） */
(function () {
  "use strict";

  /* --- 主题：localStorage 记忆 + 跟随系统初值 --- */
  const root = document.documentElement;
  const saved = localStorage.getItem("wb-theme");
  if (saved) root.dataset.theme = saved;
  else if (window.matchMedia("(prefers-color-scheme: dark)").matches) root.dataset.theme = "dark";

  function bindThemeToggles() {
    document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const next = root.dataset.theme === "dark" ? "light" : "dark";
        root.dataset.theme = next;
        localStorage.setItem("wb-theme", next);
        toast(next === "dark" ? "已切换到暗色模式" : "已切换到明亮模式");
      });
    });
  }

  /* --- Toast --- */
  let toastEl;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("is-visible");
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.remove("is-visible"), 2200);
  }
  window.wbToast = toast;

  /* --- 顶栏滚动隐藏（阅读零干扰） --- */
  const header = document.querySelector(".site-header");
  if (header) {
    let lastY = 0;
    window.addEventListener("scroll", () => {
      const y = window.scrollY;
      if (y > 400 && y > lastY) header.classList.add("is-hidden");
      else header.classList.remove("is-hidden");
      lastY = y;
    }, { passive: true });
  }

  /* --- 移动端抽屉 --- */
  const drawer = document.querySelector(".nav-drawer");
  document.querySelectorAll("[data-nav-open]").forEach((b) =>
    b.addEventListener("click", () => drawer && drawer.classList.add("is-open"))
  );
  document.querySelectorAll("[data-nav-close]").forEach((b) =>
    b.addEventListener("click", () => drawer && drawer.classList.remove("is-open"))
  );

  /* --- 阅读进度条 --- */
  const fill = document.querySelector(".progress-bar__fill");
  if (fill) {
    window.addEventListener("scroll", () => {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      fill.style.width = (max > 0 ? (h.scrollTop / max) * 100 : 0) + "%";
    }, { passive: true });
  }

  /* --- TOC scroll-spy（暴露为可重入函数，文章页渲染完成后由 render.js 调用） --- */
  let spyObserver;
  function initTocSpy() {
    const tocLinks = document.querySelectorAll(".post-toc a, .toc-drawer a");
    if (!tocLinks.length) return;
    if (spyObserver) spyObserver.disconnect();
    const map = new Map();
    tocLinks.forEach((a) => {
      const id = a.getAttribute("href");
      const el = id && document.querySelector(id);
      if (el) { if (!map.has(el)) map.set(el, []); map.get(el).push(a); }
    });
    spyObserver = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          tocLinks.forEach((a) => a.classList.remove("is-active"));
          (map.get(e.target) || []).forEach((a) => a.classList.add("is-active"));
        }
      });
    }, { rootMargin: "-80px 0px -70% 0px" });
    map.forEach((_, el) => spyObserver.observe(el));
  }
  window.wbInitTocSpy = initTocSpy;

  /* --- TOC 抽屉（移动端） --- */
  const tocDrawer = document.querySelector(".toc-drawer");
  document.querySelectorAll("[data-toc-open]").forEach((b) =>
    b.addEventListener("click", () => tocDrawer && tocDrawer.classList.toggle("is-open"))
  );

  /* --- 代码块复制（事件委托，兼容渲染层动态插入的内容） --- */
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".code-block__copy");
    if (!btn) return;
    const code = btn.closest(".code-block").querySelector("pre").innerText;
    try {
      await navigator.clipboard.writeText(code);
      btn.textContent = "已复制 ✓";
      btn.classList.add("is-copied");
    } catch {
      btn.textContent = "复制失败";
    }
    setTimeout(() => { btn.textContent = "复制"; btn.classList.remove("is-copied"); }, 1500);
  });

  /* --- 分享：复制链接 --- */
  document.querySelectorAll("[data-share-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(location.href); toast("链接已复制"); }
      catch { toast("复制失败，请手动复制地址栏链接"); }
    });
  });

  /* --- 评论提交 mock（先审后发分支；搜索交互已迁移至 render.js） --- */
  const commentForm = document.querySelector("#comment-form");
  if (commentForm) {
    commentForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const ta = commentForm.querySelector("textarea");
      const name = commentForm.querySelector("[name=nick]").value.trim() || "游客";
      if (!ta.value.trim()) { toast("评论内容不能为空"); return; }
      const pending = document.createElement("div");
      pending.className = "comment comment--pending";
      pending.innerHTML =
        '<div class="comment__avatar">' + name.slice(0, 1).toUpperCase() + "</div>" +
        "<div><div class='comment__meta'><strong>" + name + "</strong>刚刚 " +
        "<span class='badge pin-badge pending-badge'>审核通过后展示</span></div>" +
        "<p class='comment__body'></p></div>";
      pending.querySelector(".comment__body").textContent = ta.value.trim();
      document.querySelector("#comment-list").prepend(pending);
      ta.value = "";
      toast("评论已提交，审核通过后展示");
    });
  }

  bindThemeToggles();
  initTocSpy();
})();
