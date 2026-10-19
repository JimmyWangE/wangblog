/* ============================================================
 * WangBlog 数据访问层（唯一数据入口）
 *
 * 双模式自动切换：
 *  - 检测到同源 /api/health 可用 → 远程模式，数据来自后端数据库
 *    （/api/web/* 兼容层，输出与 mock JSON 同构的数据）；
 *  - 否则 → mock 模式，读取本地 JSON（本地 file/http 预览行为不变）。
 * 后端接口变更时只需改下面的 URL 映射，页面代码零改动。
 * ============================================================ */
(function () {
  "use strict";

  /* 页面通过 <meta name="wb-base" content=""> 声明相对根路径
     前台页面为 ""，admin/ 下页面为 "../" */
  const BASE = (document.querySelector('meta[name="wb-base"]') || {}).content || "";

  /* ---- mock 模式：本地 JSON 文件 ---- */
  const ENDPOINTS = {
    siteConfig: BASE + "assets/config/site.json", // 静态展示数据（文案/配置，无后端）
    posts: BASE + "data/posts.json",
    comments: BASE + "data/comments.json",
    taxonomy: BASE + "data/taxonomy.json",
    dashboard: BASE + "data/dashboard.json",
  };

  /* ---- 远程模式：后端兼容层（数据库驱动，结构与 mock 完全一致） ---- */
  const REMOTE_ENDPOINTS = {
    siteConfig: BASE + "assets/config/site.json", // 文案配置仍走静态文件
    posts: "/api/web/posts",
    comments: "/api/web/comments",
    taxonomy: "/api/web/taxonomy",
    dashboard: "/api/web/dashboard",
  };

  const cache = {};

  /* 启动时探测一次后端是否可用，结果缓存为 Promise */
  let _remote = null;
  function detectRemote() {
    if (!_remote) {
      _remote = fetch("/api/health", { cache: "no-store" })
        .then((r) => r.ok)
        .catch(() => false);
    }
    return _remote;
  }

  async function get(key) {
    if (cache[key]) return cache[key];
    const remote = await detectRemote();
    const url = (remote ? REMOTE_ENDPOINTS : ENDPOINTS)[key];
    cache[key] = fetch(url).then((res) => {
      if (!res.ok) throw new Error(`数据加载失败: ${url} (${res.status})`);
      return res.json();
    });
    return cache[key];
  }

  /* ---- 身份令牌（后台写操作需要；localStorage 持久化） ---- */
  const TOKEN_KEY = "wb_access_token";
  const REFRESH_KEY = "wb_refresh_token";
  const ERR_TOKEN_INVALID = 40101; // 后端：未登录或令牌已过期

  /* Access Token 过期后用 Refresh Token 静默换新（并发请求共享同一次刷新） */
  let _refreshing = null;
  async function refreshTokens() {
    if (_refreshing) return _refreshing;
    const rt = localStorage.getItem(REFRESH_KEY);
    if (!rt) return false;
    _refreshing = fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: rt }),
    })
      .then((r) => r.json())
      .then((json) => {
        if (json && json.code === 0 && json.data && json.data.accessToken) {
          localStorage.setItem(TOKEN_KEY, json.data.accessToken);
          if (json.data.refreshToken) localStorage.setItem(REFRESH_KEY, json.data.refreshToken);
          return true;
        }
        return false;
      })
      .catch(() => false)
      .finally(() => { _refreshing = null; });
    return _refreshing;
  }

  function forceReLogin() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    // 后台页面跳转登录页；前台无感（写操作仅后台有）
    if (location.pathname.includes("/admin/") && !location.pathname.endsWith("login.html")) {
      location.href = "login.html";
    }
  }

  /* 统一调用后端：返回 { ok, code, message, data }，不抛异常，便于 UI 按错误码处理。
     带 auth 的请求遇 40101 时自动刷新令牌并重试一次；刷新失败则清空会话跳转登录。 */
  async function callApi(path, { method = "GET", body, auth = false, headers = {} } = {}, _retried = false) {
    try {
      const h = { ...headers };
      const multipart = body instanceof FormData;
      if (body !== undefined && !multipart) h["Content-Type"] = "application/json";
      if (auth) {
        const token = localStorage.getItem(TOKEN_KEY);
        if (token) h["Authorization"] = "Bearer " + token;
      }
      const controller = multipart ? new AbortController() : null;
      const timeout = controller ? setTimeout(() => controller.abort(), 60000) : null;
      let res;
      try {
        res = await fetch(path, { method, headers: h,
          body: multipart ? body : body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller ? controller.signal : undefined });
      } finally { if (timeout) clearTimeout(timeout); }
      const json = await res.json().catch(() => null);
      if (!json) return { ok: false, code: res.status, message: `服务异常（${res.status}）`, data: {} };

      if (auth && json.code === ERR_TOKEN_INVALID && !_retried) {
        const refreshed = await refreshTokens();
        if (refreshed) return callApi(path, { method, body, auth, headers }, true);
        forceReLogin();
        return { ok: false, code: json.code, message: "登录已过期，请重新登录", data: {} };
      }
      return { ok: res.ok && json.code === 0, code: json.code, message: json.message, data: json.data || {} };
    } catch (e) {
      return { ok: false, code: -1, message: "网络错误，无法连接服务器", data: {} };
    }
  }

  /* ---- 业务查询方法（页面只调这些，不直接 fetch） ---- */
  window.WBApi = {
    siteConfig: () => get("siteConfig"),
    taxonomy: () => get("taxonomy"),
    dashboard: () => get("dashboard"),
    comments: () => get("comments"),

    posts: () => get("posts").then((d) => d.posts),
    post: (slug) => get("posts").then((d) => d.posts.find((p) => p.slug === slug) || null),
    /** 已发布（含置顶），按日期倒序 */
    publishedPosts: () =>
      get("posts").then((d) =>
        d.posts
          .filter((p) => p.status === "published" || p.status === "pinned")
          .sort((a, b) => (a.date < b.date ? 1 : -1))
      ),
    /** 归档用：已发布 + 定时发布，按日期倒序 */
    archivablePosts: () =>
      get("posts").then((d) =>
        d.posts
          .filter((p) => p.status !== "draft")
          .sort((a, b) => (a.date < b.date ? 1 : -1))
      ),
    postComments: (slug) => get("comments").then((d) => d.byPost[slug] || []),

    /** 数据变更后调用：清空读缓存，下次读取拿到最新数据 */
    invalidate: () => Object.keys(cache).forEach((k) => delete cache[k]),

    /** 当前是否已连接真实后端（mock 模式下写操作走演示逻辑） */
    isRemote: () => detectRemote(),

    /* ---- 认证（远程模式专用） ---- */
    auth: {
      login: (username, password) => callApi("/api/auth/login", { method: "POST", body: { username, password } }),
      totp: (ticket, code) =>
        callApi("/api/auth/totp", { method: "POST", body: { ticket, code } }).then((r) => {
          if (r.ok) {
            localStorage.setItem(TOKEN_KEY, r.data.accessToken);
            if (r.data.refreshToken) localStorage.setItem(REFRESH_KEY, r.data.refreshToken);
          }
          return r;
        }),
      logout: () => { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(REFRESH_KEY); },
      isLoggedIn: () => !!localStorage.getItem(TOKEN_KEY),
    },

    /* ---- 后台写操作（远程模式专用，需先登录） ---- */
    admin: {
      uploadImages: async (files) => {
        if (!(await detectRemote())) return { ok: false, message: "图片上传需要连接服务器", data: {} };
        const body = new FormData();
        files.forEach((file) => body.append("files", file, file.name || "image.png"));
        return callApi("/api/admin/uploads", { method: "POST", auth: true, body });
      },
      createPost: (title, slug, category) =>
        callApi("/api/admin/posts", { method: "POST", auth: true, body: { title, slug, category } }),
      saveDraft: (id, payload) =>
        callApi(`/api/admin/posts/${id}/draft`, { method: "PUT", auth: true, body: payload }),
      publish: (id, mode, scheduledAt) =>
        callApi(`/api/admin/posts/${id}/publish`, { method: "POST", auth: true,
          body: { mode: mode || "now", scheduledAt: scheduledAt || null },
          headers: { "Idempotency-Key": "pub-" + id + "-" + Date.now() } }),
      taskStatus: (taskId) => callApi(`/api/admin/tasks/${taskId}`, { auth: true }),
      trash: (id) => callApi(`/api/admin/posts/${id}`, { method: "DELETE", auth: true }),
      reviewComment: (id, action) =>
        callApi(`/api/admin/comments/${id}/${action}`, { method: "POST", auth: true }),
    },
  };
})();
