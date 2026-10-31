/* 通用 UI：主题、Toast、Modal/确认框、滚动显现、光斑、计数动画 */
import { esc, icon, toStr } from "./util.js";

/* ---------------- 主题（默认浅色） ---------------- */
const THEME_KEY = "wb-theme";
export const theme = {
  get: () => document.documentElement.dataset.theme || "light",
  set(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(THEME_KEY, t); } catch { /* noop */ }
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "dark" ? "#05060a" : "#f7f8fc");
    window.dispatchEvent(new CustomEvent("themechange", { detail: t }));
  },
  toggle() { theme.set(theme.get() === "dark" ? "light" : "dark"); },
};

/* ---------------- Toast ---------------- */
let stack;
export function toast(msg, type = "info", ms = 2600) {
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toast-stack";
    stack.setAttribute("role", "status");
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
  }
  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  el.innerHTML = `<span class="toast__dot"></span><span>${esc(msg)}</span>`;
  stack.appendChild(el);
  setTimeout(() => { el.classList.add("is-leaving"); setTimeout(() => el.remove(), 260); }, ms);
}

/* ---------------- Modal ---------------- */
export function modal({ title = "", body = "", foot = "", width, onMount, closable = true } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true" ${width ? `style="width:min(${width}px,100%)"` : ""}>
    ${title ? `<div class="modal__head"><div class="modal__title">${esc(title)}</div>
      ${closable ? `<button class="icon-btn" data-close aria-label="关闭">${toStr(icon("x"))}</button>` : ""}</div>` : ""}
    <div class="modal__body">${toStr(body)}</div>${foot ? `<div class="modal__foot">${toStr(foot)}</div>` : ""}</div>`;
  const prevFocus = document.activeElement;
  let closed = false;
  const close = (v) => {
    if (closed) return;
    closed = true;
    overlay.classList.add("is-leaving");
    document.removeEventListener("keydown", onKey);
    setTimeout(() => { overlay.remove(); prevFocus?.focus?.(); }, 180);
    api.resolve(v);
  };
  const onKey = (e) => { if (e.key === "Escape" && closable) close(null); };
  overlay.addEventListener("mousedown", (e) => { if (e.target === overlay && closable) close(null); });
  overlay.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(null); });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
  const api = { el: overlay.querySelector(".modal"), close, resolve: () => {} };
  api.result = new Promise((r) => { api.resolve = r; });
  onMount && onMount(api);
  setTimeout(() => (overlay.querySelector("[autofocus]") || overlay.querySelector("input,textarea,button.btn--primary"))?.focus(), 30);
  return api;
}

export function confirmDialog({ title = "确认操作", message = "", okText = "确定", danger = false } = {}) {
  const m = modal({
    title, width: 420,
    body: `<p class="muted" style="line-height:1.7">${esc(message)}</p>`,
    foot: `<button class="btn btn--ghost" data-close>取消</button>
           <button class="btn ${danger ? "btn--danger" : "btn--primary"}" data-ok>${esc(okText)}</button>`,
    onMount: (api) => api.el.querySelector("[data-ok]").addEventListener("click", () => api.close(true)),
  });
  return m.result.then(Boolean);
}

export function promptDialog({ title, label = "", value = "", placeholder = "", okText = "确定" }) {
  const m = modal({
    title, width: 440,
    body: `<label class="field"><span class="field__label">${esc(label)}</span>
      <input class="input" data-input value="${esc(value)}" placeholder="${esc(placeholder)}" autofocus></label>`,
    foot: `<button class="btn btn--ghost" data-close>取消</button><button class="btn btn--primary" data-ok>${esc(okText)}</button>`,
    onMount: (api) => {
      const input = api.el.querySelector("[data-input]");
      const ok = () => api.close(input.value.trim());
      api.el.querySelector("[data-ok]").addEventListener("click", ok);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") ok(); });
    },
  });
  return m.result;
}

/* ---------------- 滚动显现 ---------------- */
let revealObs;
export function reveal(root = document) {
  if (!("IntersectionObserver" in window)) { root.querySelectorAll(".reveal").forEach((e) => e.classList.add("is-in")); return; }
  revealObs = revealObs || new IntersectionObserver((entries) => {
    entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add("is-in"); revealObs.unobserve(en.target); } });
  }, { rootMargin: "0px 0px -6% 0px" });
  root.querySelectorAll(".reveal:not(.is-in)").forEach((el, i) => {
    el.style.transitionDelay = `${Math.min(i % 8, 6) * 50}ms`;
    revealObs.observe(el);
  });
}

/* ---------------- 鼠标跟随光斑（事件委托） ---------------- */
export function initSpotlight() {
  document.addEventListener("pointermove", (e) => {
    const el = e.target.closest?.(".spotlight");
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  }, { passive: true });
}

/* ---------------- 数字滚动 ---------------- */
export function countUp(el, to, { duration = 1400, format = (n) => n.toLocaleString() } = {}) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = format(to); return; }
  const start = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - start) / duration);
    const eased = 1 - Math.pow(1 - p, 4);
    el.textContent = format(Math.round(to * eased));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ---------------- 顶部路由进度条 ---------------- */
let bar, barTimer;
export const routeBar = {
  start() {
    if (!bar) { bar = document.createElement("div"); bar.className = "route-bar"; document.body.appendChild(bar); }
    clearTimeout(barTimer);
    bar.classList.add("is-active");
    bar.style.width = "0";
    requestAnimationFrame(() => { bar.style.width = "65%"; });
  },
  done() {
    if (!bar) return;
    bar.style.width = "100%";
    barTimer = setTimeout(() => { bar.classList.remove("is-active"); bar.style.width = "0"; }, 350);
  },
};

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove(); return ok;
  }
}
