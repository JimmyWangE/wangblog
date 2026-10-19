/* ==========================================================================
 * 正文增强：代码复制/折叠、KaTeX 公式、Mermaid 图表、图片灯箱、标题锚点
 * 第三方库（KaTeX / Mermaid）按需懒加载，没有公式/图表的文章不下载任何额外资源
 * ========================================================================== */
import { copyText, theme } from "./ui.js";

const VENDOR = "/assets/vendor/vditor/dist/js";
const loaded = {};
export function loadScript(src) {
  if (!loaded[src]) {
    loaded[src] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.async = true; s.onload = resolve; s.onerror = () => { delete loaded[src]; reject(new Error("load " + src)); };
      document.head.appendChild(s);
    });
  }
  return loaded[src];
}
export function loadStyle(href) {
  if (!loaded[href]) {
    loaded[href] = new Promise((resolve) => {
      const l = document.createElement("link");
      l.rel = "stylesheet"; l.href = href; l.onload = resolve; l.onerror = resolve;
      document.head.appendChild(l);
    });
  }
  return loaded[href];
}

async function renderMath(root) {
  const nodes = root.querySelectorAll("[data-math]:not(.is-rendered)");
  if (!nodes.length) return;
  await Promise.all([loadStyle(`${VENDOR}/katex/katex.min.css`), loadScript(`${VENDOR}/katex/katex.min.js`)]);
  nodes.forEach((el) => {
    try {
      window.katex.render(el.textContent, el, { displayMode: el.dataset.math === "block", throwOnError: false, output: "html" });
      el.classList.add("is-rendered");
    } catch { /* 保留源码 */ }
  });
}

let mermaidSeq = 0;
async function renderMermaid(root) {
  const nodes = root.querySelectorAll("[data-mermaid]");
  if (!nodes.length) return;
  await loadScript(`${VENDOR}/mermaid/mermaid.min.js`);
  const m = window.mermaid;
  const dark = theme.get() === "dark";
  const font = getComputedStyle(document.body).fontFamily;
  m.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default",
    themeVariables: dark ? { primaryColor: "#1e2235", primaryBorderColor: "#818cf8", lineColor: "#818cf8",
      primaryTextColor: "#e7e9f0", fontFamily: font } : { fontFamily: font } });
  for (const el of nodes) {
    const src = el.dataset.src || el.textContent;
    el.dataset.src = src;
    try {
      const { svg } = await m.render(`mmd-${++mermaidSeq}`, src);
      el.innerHTML = svg;
      el.classList.add("is-rendered");
    } catch (e) {
      el.classList.remove("is-rendered");
      el.textContent = src;
    }
  }
}

function enhanceCode(root) {
  root.querySelectorAll(".code-block").forEach((block) => {
    if (block.dataset.enhanced) return;
    block.dataset.enhanced = "1";
    const lines = Number(block.dataset.lines || 0);
    if (lines > 28) {
      block.classList.add("is-collapsed");
      const btn = document.createElement("button");
      btn.className = "code-block__expand";
      btn.type = "button";
      btn.textContent = `展开全部 ${lines} 行`;
      btn.addEventListener("click", () => {
        const c = block.classList.toggle("is-collapsed");
        btn.textContent = c ? `展开全部 ${lines} 行` : "收起";
      });
      block.appendChild(btn);
    }
  });
}

function onCopyClick(e) {
  const btn = e.target.closest(".code-block__copy");
  if (!btn) return;
  const code = btn.closest(".code-block").querySelector("pre").innerText;
  copyText(code).then((ok) => {
    btn.textContent = ok ? "已复制 ✓" : "复制失败";
    btn.classList.toggle("is-done", ok);
    setTimeout(() => { btn.textContent = "复制"; btn.classList.remove("is-done"); }, 1600);
  });
}

function onImgClick(e) {
  const img = e.target.closest(".prose img");
  if (!img || img.closest("a")) return;
  const box = document.createElement("div");
  box.className = "lightbox";
  box.innerHTML = `<img src="${img.currentSrc || img.src}" alt="">${img.alt ? `<figcaption></figcaption>` : ""}`;
  if (img.alt) box.querySelector("figcaption").textContent = img.alt;
  const close = () => { box.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (ev) => { if (ev.key === "Escape") close(); };
  box.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(box);
}

function addAnchors(root) {
  root.querySelectorAll("h2[id], h3[id]").forEach((h) => {
    if (h.querySelector(".heading-anchor")) return;
    const a = document.createElement("a");
    a.className = "heading-anchor";
    a.href = "#" + h.id;
    a.textContent = "#";
    a.setAttribute("aria-label", "本节链接");
    h.appendChild(a);
  });
}

let bound = false;
export async function enhance(root) {
  if (!root) return;
  if (!bound) {
    bound = true;
    document.addEventListener("click", onCopyClick);
    document.addEventListener("click", onImgClick);
  }
  addAnchors(root);
  enhanceCode(root);
  root.querySelectorAll("img").forEach((img) => {
    img.loading = "lazy";
    img.addEventListener("error", () => img.classList.add("is-broken"), { once: true });
  });
  await Promise.allSettled([renderMath(root), renderMermaid(root)]);
}

/** 主题切换后重绘 mermaid */
export function rerenderMermaid(root) { return renderMermaid(root); }
