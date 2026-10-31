/* ==========================================================================
 * 数据访问层（前台 + 后台唯一入口）
 * - 统一响应包络 {code, message, data}
 * - GET 内存缓存 + 并发去重（stale-while-revalidate），页面切换几乎零等待
 * - 后台请求自动携带 Access Token，过期后用 Refresh Token 静默续期并重放
 * ========================================================================== */
const TOKEN_KEY = "wb_access_token";
const REFRESH_KEY = "wb_refresh_token";
const ERR_TOKEN_INVALID = 40101;

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 隐私模式 */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* noop */ } },
};

export class ApiError extends Error {
  constructor(message, code, data) { super(message); this.code = code; this.data = data || {}; }
}

let onAuthExpired = () => {};
export const setAuthExpiredHandler = (fn) => { onAuthExpired = fn; };

let refreshing = null;
async function refreshTokens() {
  if (refreshing) return refreshing;
  const rt = store.get(REFRESH_KEY);
  if (!rt) return false;
  refreshing = fetch("/api/auth/refresh", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refreshToken: rt }),
  }).then((r) => r.json()).then((j) => {
    if (j && j.code === 0) {
      store.set(TOKEN_KEY, j.data.accessToken);
      store.set(REFRESH_KEY, j.data.refreshToken);
      return true;
    }
    return false;
  }).catch(() => false).finally(() => { setTimeout(() => { refreshing = null; }, 0); });
  return refreshing;
}

/** 底层请求：失败抛出 ApiError */
export async function request(path, { method = "GET", body, auth = false, headers = {}, signal, timeout = 20000 } = {}, retried = false) {
  const h = { ...headers };
  const isForm = body instanceof FormData;
  if (body !== undefined && !isForm) h["Content-Type"] = "application/json";
  if (auth) {
    const t = store.get(TOKEN_KEY);
    if (t) h.Authorization = "Bearer " + t;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), isForm ? 90000 : timeout);
  if (signal) signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  let res;
  try {
    res = await fetch(path, { method, headers: h, signal: ctrl.signal,
      body: isForm ? body : body !== undefined ? JSON.stringify(body) : undefined });
  } catch (e) {
    if (signal && signal.aborted) throw new ApiError("请求已取消", -2);
    throw new ApiError(ctrl.signal.aborted ? "请求超时，请检查网络" : "网络错误，无法连接服务器", -1);
  } finally { clearTimeout(timer); }
  if (res.status === 204) return {};
  const json = await res.json().catch(() => null);
  if (!json) throw new ApiError(`服务异常（${res.status}）`, res.status);
  if (auth && json.code === ERR_TOKEN_INVALID && !retried) {
    if (await refreshTokens()) return request(path, { method, body, auth, headers, signal, timeout }, true);
    auth_.clear();
    onAuthExpired();
    throw new ApiError("登录已过期，请重新登录", json.code);
  }
  if (json.code !== 0) throw new ApiError(json.message || "请求失败", json.code, json.data);
  return json.data;
}

/* ---- 带缓存的 GET ---- */
const cache = new Map(); // key → {t, data, promise}
const TTL = 60_000;
/** 新鲜 → 直接返回；过期但有旧数据 → 先返回旧数据并后台刷新；无数据 / force → 等待请求 */
export function cachedGet(path, { ttl = TTL, force = false } = {}) {
  const hit = cache.get(path);
  if (hit && hit.data !== undefined && !force) {
    if (Date.now() - hit.t >= ttl && !hit.promise) revalidate(path);
    return Promise.resolve(hit.data);
  }
  if (hit && hit.promise) return hit.promise;
  return revalidate(path);
}
function revalidate(path) {
  const entry = cache.get(path) || {};
  const p = request(path)
    .then((data) => { cache.set(path, { t: Date.now(), data }); return data; })
    .catch((e) => { const c = cache.get(path); if (c) delete c.promise; if (c && c.data === undefined) cache.delete(path); throw e; });
  cache.set(path, { ...entry, promise: p });
  p.catch(() => {});
  return p;
}
export const peek = (path) => cache.get(path)?.data;
export const invalidate = (prefix = "") => { for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k); };

const qs = (o) => {
  const p = new URLSearchParams();
  Object.entries(o || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") p.set(k, v); });
  const s = p.toString();
  return s ? "?" + s : "";
};
const enc = encodeURIComponent;

/* ---- 前台 ---- */
export const api = {
  site: () => cachedGet("/api/site/config", { ttl: 300_000 }),
  // 每次访问重新检查公开权限，不以浏览器内存中的旧文章绕过 Private 设置。
  home: () => request("/api/home"),
  posts: (o) => request("/api/posts" + qs(o)),
  post: (slug) => request(`/api/posts/${enc(slug)}`),
  comments: (slug) => request(`/api/posts/${enc(slug)}/comments`),
  submitComment: (slug, body) => request(`/api/posts/${enc(slug)}/comments`, { method: "POST", body,
    headers: { "Idempotency-Key": "c-" + Date.now() + "-" + Math.random().toString(36).slice(2) } }),
  like: (slug) => request(`/api/posts/${enc(slug)}/like`, { method: "POST" }),
  taxonomy: () => request("/api/taxonomy"),
  archive: (o) => request("/api/archive" + qs(o)),
  search: (q, o = {}, signal) => request("/api/search" + qs({ q, ...o }), { signal }),
  track: (body) => {
    const data = JSON.stringify(body);
    if (navigator.sendBeacon) navigator.sendBeacon("/api/events", new Blob([data], { type: "application/json" }));
    else fetch("/api/events", { method: "POST", body: data, headers: { "Content-Type": "application/json" }, keepalive: true }).catch(() => {});
  },
};

/* ---- 认证 ---- */
export const auth_ = {
  login: (username, password) => request("/api/auth/login", { method: "POST", body: { username, password } }),
  totp: async (ticket, code) => {
    const d = await request("/api/auth/totp", { method: "POST", body: { ticket, code } });
    store.set(TOKEN_KEY, d.accessToken);
    store.set(REFRESH_KEY, d.refreshToken);
    return d;
  },
  me: () => request("/api/auth/me", { auth: true }),
  logout: async () => {
    const rt = store.get(REFRESH_KEY);
    auth_.clear();
    if (rt) await request("/api/auth/logout", { method: "POST", body: { refreshToken: rt } }).catch(() => {});
  },
  clear: () => { store.del(TOKEN_KEY); store.del(REFRESH_KEY); },
  isLoggedIn: () => !!store.get(TOKEN_KEY),
};

/* ---- 后台 ---- */
const A = (path, opt = {}) => request("/api/admin" + path, { ...opt, auth: true });
export const admin = {
  dashboard: () => A("/dashboard"),
  posts: (o) => A("/posts" + qs(o)),
  post: (id) => A(`/posts/${id}`),
  createPost: (body) => A("/posts", { method: "POST", body }),
  saveDraft: (id, body) => A(`/posts/${id}/draft`, { method: "PUT", body }),
  publish: (id, mode = "now", scheduledAt = null) => A(`/posts/${id}/publish`, { method: "POST",
    body: { mode, scheduledAt }, headers: { "Idempotency-Key": `pub-${id}-${Date.now()}` } }),
  task: (taskId) => A(`/tasks/${taskId}`),
  unpublish: (id) => A(`/posts/${id}/unpublish`, { method: "POST" }),
  restore: (id) => A(`/posts/${id}/restore`, { method: "POST" }),
  trash: (id, purge = false) => A(`/posts/${id}${purge ? "?purge=true" : ""}`, { method: "DELETE" }),
  batch: (ids, action, payload = {}) => A("/posts/batch", { method: "POST", body: { ids, action, payload } }),
  versions: (id) => A(`/posts/${id}/versions`),
  version: (id, v) => A(`/posts/${id}/versions/${v}`),
  render: (contentMd) => A("/render", { method: "POST", body: { contentMd } }),
  upload: (files) => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f, f.name || "image.png"));
    return A("/uploads", { method: "POST", body: fd });
  },
  comments: (o) => A("/comments" + qs(o)),
  review: (id, action) => A(`/comments/${id}/${action}`, { method: "POST" }),
  reply: (id, content) => A(`/comments/${id}/reply`, { method: "POST", body: { content } }),
  taxonomy: () => A("/taxonomy"),
  createCategory: (body) => A("/categories", { method: "POST", body }),
  updateCategory: (id, body) => A(`/categories/${id}`, { method: "PUT", body }),
  deleteCategory: (id) => A(`/categories/${id}`, { method: "DELETE" }),
  renameTag: (id, name) => A(`/tags/${id}`, { method: "PUT", body: { name } }),
  deleteTag: (id) => A(`/tags/${id}`, { method: "DELETE" }),
  site: () => A("/site"),
  saveSite: (body) => A("/site", { method: "PUT", body }),
  changePassword: (oldPassword, newPassword) => A("/me/password", { method: "PUT", body: { oldPassword, newPassword } }),
};
