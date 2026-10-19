/* ==========================================================================
 * 轻量 History 路由
 * - 拦截站内 <a> 点击，pushState 切换视图，不整页刷新
 * - 支持 :param 路由、查询参数、滚动位置恢复、View Transitions 动画
 * - 每个视图返回可选的清理函数（解绑事件、停止动画）
 * ========================================================================== */
export class Router {
  constructor({ routes, outlet, base = "", notFound, onStart, onEnd, ignore = [] }) {
    this.routes = routes.map((r) => ({ ...r, ...compile(base + r.path) }));
    this.outlet = outlet;
    this.base = base;
    this.notFound = notFound;
    this.onStart = onStart || (() => {});
    this.onEnd = onEnd || (() => {});
    this.ignore = ignore;
    this.cleanup = null;
    this.token = 0;
    this.scrollPos = new Map();
    this.current = null;
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";

    document.addEventListener("click", (e) => this.onClick(e));
    window.addEventListener("popstate", () => this.resolve({ pop: true }));
  }

  onClick(e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest("a[href]");
    if (!a || a.target === "_blank" || a.hasAttribute("download") || a.dataset.native !== undefined) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    if (this.ignore.some((p) => url.pathname.startsWith(p))) return;
    if (!url.pathname.startsWith(this.base || "/")) return;
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return; // 页内锚点
    e.preventDefault();
    this.go(url.pathname + url.search + url.hash);
  }

  go(path, { replace = false } = {}) {
    const key = location.pathname + location.search;
    this.scrollPos.set(key, window.scrollY);
    if (path === location.pathname + location.search + location.hash && !replace) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    history[replace ? "replaceState" : "pushState"]({}, "", path);
    return this.resolve();
  }

  match(pathname) {
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1] || ""); });
        return { route: r, params };
      }
    }
    return null;
  }

  async resolve({ pop = false } = {}) {
    const token = ++this.token;
    const url = new URL(location.href);
    const found = this.match(url.pathname.replace(/\/+$/, "") || "/");
    const view = found ? found.route.view : this.notFound;
    const ctx = { params: found ? found.params : {}, query: Object.fromEntries(url.searchParams), url, router: this,
      isStale: () => token !== this.token };
    this.onStart(ctx);
    const swap = async () => {
      if (this.cleanup) { try { this.cleanup(); } catch { /* noop */ } this.cleanup = null; }
      const result = await view(this.outlet, ctx);
      if (token !== this.token) { if (typeof result === "function") result(); return; }
      this.cleanup = typeof result === "function" ? result : null;
    };
    try {
      const vt = document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches && this.current;
      if (vt) await document.startViewTransition(swap).updateCallbackDone;
      else await swap();
    } catch (err) {
      console.error(err);
    }
    if (token !== this.token) return;
    this.current = url.pathname;
    const saved = pop ? this.scrollPos.get(url.pathname + url.search) : null;
    if (url.hash) {
      const el = document.getElementById(decodeURIComponent(url.hash.slice(1)));
      if (el) el.scrollIntoView();
    } else window.scrollTo(0, saved || 0);
    this.onEnd(ctx);
  }

  start() { return this.resolve(); }
}

function compile(path) {
  const keys = [];
  const pattern = path.replace(/\/+$/, "").replace(/:(\w+)(\*)?/g, (_, k, star) => { keys.push(k); return star ? "(.*)" : "([^/]+)"; });
  return { re: new RegExp("^" + (pattern || "/") + "/?$"), keys };
}
