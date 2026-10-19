/* ==========================================================================
 * Typora 式写作编辑器（基于本地构建的 Vditor）
 *
 * - 即时渲染（IR）：像 Typora 一样，光标所在块显示 Markdown 标记，离开即渲染
 * - 所见即所得 / 分屏预览 / 发布效果预览，一键无缝切换，内容零丢失
 * - 自动保存（停笔 1.2s）+ 本地灾备 + 多窗口冲突检测 + Ctrl/⌘+S
 * - 图片粘贴 / 拖拽 / 选择上传，直接插入 Markdown
 * - 大纲、专注模式、打字机滚动、字数统计、历史版本、发布流水线
 * ========================================================================== */
import { admin, invalidate } from "../lib/api.js";
import { loadScript, loadStyle, enhance } from "../lib/enhance.js";
import { toast, modal, theme, confirmDialog } from "../lib/ui.js";
import { $, $$, html, raw, mount, icon, debounce, esc, hashGradient, urlFor, toStr } from "../lib/util.js";
import { go, STATUS } from "./state.js";

const CDN = "/assets/vendor/vditor";
const PREF_KEY = "wb-editor-prefs";
const BACKUP_KEY = (id) => `wb-draft-backup:${id}`;
const MODES = [
  { id: "ir", label: "即时渲染", tip: "Typora 风格：所见即所得，光标处显示 Markdown 标记" },
  { id: "wysiwyg", label: "所见即所得", tip: "富文本式编辑，完全隐藏 Markdown 语法" },
  { id: "sv", label: "分屏预览", tip: "左侧源码，右侧实时预览" },
];

const loadPrefs = () => { try { return { mode: "ir", toolbar: true, outline: false, focus: false, typewriter: false, ...JSON.parse(localStorage.getItem(PREF_KEY) || "{}") }; } catch { return { mode: "ir", toolbar: true }; } };
const savePrefs = (p) => { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* noop */ } };
const readBackup = (id) => { try { return JSON.parse(localStorage.getItem(BACKUP_KEY(id)) || "null"); } catch { return null; } };
const writeBackup = (id, data) => { try { localStorage.setItem(BACKUP_KEY(id), JSON.stringify({ ...data, t: Date.now() })); } catch { /* noop */ } };
const dropBackup = (id) => { try { localStorage.removeItem(BACKUP_KEY(id)); } catch { /* noop */ } };

export async function editorView(root, ctx) {
  document.title = "写作 — 管理后台";
  const prefs = loadPrefs();
  const isNew = ctx.params.id === "new";
  const S = {
    id: isNew ? null : ctx.params.id, post: null, dirty: false, saving: false, lastSaved: null, baseUpdatedAt: null,
    meta: { slug: "", category: "", tags: [], excerpt: "", cover: null, pinned: false }, panel: null, vditor: null, tax: null,
  };

  mount(root, html`<div class="editor-page"><div style="display:grid;place-items:center;height:100vh"><span class="spinner" style="width:28px;height:28px;color:var(--accent)"></span></div></div>`);

  // 并行：编辑器资源 + 文章数据 + 分类标签
  const vditorReady = Promise.all([loadStyle(`${CDN}/dist/index.css`), loadScript(`${CDN}/dist/index.min.js`)]);
  try {
    const [post, tax] = await Promise.all([S.id ? admin.post(S.id) : Promise.resolve(null), admin.taxonomy().catch(() => ({ categories: [], tags: [] })), vditorReady]);
    S.post = post; S.tax = tax;
  } catch (e) {
    mount(root, html`<div class="empty" style="height:100vh"><div class="empty__title">${e.message}</div><a class="btn" href="/admin/posts">返回文章列表</a></div>`);
    return;
  }
  if (ctx.isStale()) return;

  let content = "";
  if (S.post) {
    const p = S.post;
    content = p.contentMd;
    S.baseUpdatedAt = p.rev;
    Object.assign(S.meta, { slug: p.slug, category: p.category, tags: [...p.tags], excerpt: p.excerpt, cover: p.cover, pinned: p.status === "pinned" });
    // 本地灾备比服务器新：提示恢复
    const bk = readBackup(S.id);
    if (bk && bk.content !== content && bk.t > Date.parse(p.rev.replace(" ", "T")) + 2000) {
      setTimeout(async () => {
        if (await confirmDialog({ title: "发现未同步的本地草稿", message: `本地有一份 ${new Date(bk.t).toLocaleString()} 的未保存内容，是否恢复？`, okText: "恢复" })) {
          S.vditor.setValue(bk.content); if (bk.title) titleEl.value = bk.title; autoGrow(); markDirty();
        } else dropBackup(S.id);
      }, 400);
    }
  } else {
    const bk = readBackup("new");
    if (bk?.content) setTimeout(async () => {
      if (await confirmDialog({ title: "恢复上次未保存的新文章？", message: "检测到上次新建文章时留下的本地内容。", okText: "恢复" })) {
        S.vditor.setValue(bk.content); titleEl.value = bk.title || ""; autoGrow(); markDirty();
      } else dropBackup("new");
    }, 400);
  }

  const st = S.post ? STATUS[S.post.status] : STATUS.draft;
  mount(root, html`<div class="editor-page ed-mode-${prefs.mode} ${prefs.toolbar ? "" : "ed-toolbar-hidden"} ${prefs.focus ? "ed-focus" : ""}">
    <header class="ed-top">
      <a class="icon-btn" href="/admin/posts" title="返回文章列表 (Esc)">${icon("arrowLeft")}</a>
      <div class="ed-top__crumb"><span>文章</span><span>/</span><b data-crumb>${S.post?.title || "新文章"}</b>
        <span class="status-dot ${st.cls}" data-status>${st.label}</span></div>
      <span class="save-state ${S.post ? "is-saved" : ""}" data-save-state>${S.post ? "已保存" : "未保存"}</span>
      <span class="ed-top__spacer"></span>
      <div class="seg" role="tablist" aria-label="编辑模式">${MODES.map((m) => html`<button data-mode="${m.id}" title="${m.tip}" class="${prefs.mode === m.id ? "is-active" : ""}"><span class="dot"></span><span class="lbl">${m.label}</span><span class="lbl-sm">${m.label.slice(0, 2)}</span></button>`)}</div>
      <button class="icon-btn ed-hide-sm ${prefs.toolbar ? "is-on" : ""}" data-toggle="toolbar" title="显示 / 隐藏工具栏">${icon("panel")}</button>
      <button class="icon-btn ed-hide-sm ${prefs.outline ? "is-on" : ""}" data-toggle="outline" title="大纲">${icon("list")}</button>
      <button class="icon-btn ${prefs.focus ? "is-on" : ""}" data-toggle="focus" title="专注模式 (F8)">${icon("focus")}</button>
      <button class="icon-btn ed-hide-sm" data-theme-toggle title="切换主题">${icon("moon")}</button>
      <button class="icon-btn ed-hide-sm" data-panel="history" title="历史版本">${icon("history")}</button>
      <button class="icon-btn" data-panel="meta" title="文章设置">${icon("settings")}</button>
      <button class="btn btn--sm ed-hide-sm" data-preview>${icon("eye")}预览</button>
      <button class="btn btn--sm btn--primary" data-publish>${icon("send")}${S.post && ["published", "pinned"].includes(S.post.status) ? "更新" : "发布"}</button>
    </header>
    <div class="ed-body">
      <div class="ed-doc"><div class="ed-doc__inner">
        <textarea class="ed-title" rows="1" placeholder="无标题" maxlength="200" aria-label="文章标题" data-title>${S.post?.title === "无标题文章" ? "" : S.post?.title || ""}</textarea>
        <div class="ed-meta-line" data-meta-line></div>
        <div id="vditor"></div>
      </div></div>
      <aside class="ed-panel" data-panel-box hidden></aside>
    </div>
    <footer class="ed-status">
      <span data-st-words>0 字</span><span data-st-read></span><span data-st-lines></span>
      <span class="grow"></span>
      <span class="ed-hide-sm">${icon("zap")}Ctrl/⌘+S 保存 · F8 专注 · 粘贴 / 拖拽图片自动上传</span>
      <span data-st-mode>${MODES.find((m) => m.id === prefs.mode)?.label}</span>
    </footer>
  </div>`);

  const page = $(".editor-page", root);
  const titleEl = $("[data-title]", root);
  const saveStateEl = $("[data-save-state]", root);
  const autoGrow = () => { titleEl.style.height = "auto"; titleEl.style.height = titleEl.scrollHeight + "px"; };
  autoGrow();

  /* ---------------- Vditor ---------------- */
  const dark = () => theme.get() === "dark";
  const vd = await new Promise((resolve) => {
    const v = new window.Vditor("vditor", {
      cdn: CDN, value: content, mode: prefs.mode, lang: "zh_CN", icon: "ant", minHeight: 520, width: "100%",
      theme: dark() ? "dark" : "classic",
      placeholder: "开始写作…  支持 Markdown：# 标题、**加粗**、- 列表、``` 代码块、$公式$，可直接粘贴 / 拖入图片",
      typewriterMode: !!prefs.typewriter,
      cache: { enable: false },
      counter: { enable: false },
      outline: { enable: !!prefs.outline, position: "left" },
      toolbarConfig: { pin: false, hide: false },
      tab: "  ",
      preview: {
        delay: 300, mode: "both",
        theme: { current: dark() ? "dark" : "light", path: `${CDN}/dist/css/content-theme` },
        hljs: { style: dark() ? "github-dark" : "github", lineNumber: false, enable: true },
        math: { engine: "KaTeX", inlineDigit: true },
        markdown: { toc: false, mark: true, footnotes: true, autoSpace: false, fixTermTypo: false, codeBlockPreview: true, mathBlockPreview: true },
      },
      hint: { delay: 150, emoji: { "+1": "👍", "-1": "👎", heart: "❤️", smile: "😄", tada: "🎉", rocket: "🚀", fire: "🔥", eyes: "👀", ok: "👌", warning: "⚠️", bulb: "💡", check: "✅", x: "❌", star: "⭐", memo: "📝", pin: "📌" } },
      toolbar: [
        "headings", "bold", "italic", "strike", "|",
        "line", "quote", "list", "ordered-list", "check", "|",
        "code", "inline-code", "link", "table", "upload", "|",
        "insert-before", "insert-after", "undo", "redo", "|",
        "edit-mode", "outline", "preview", "fullscreen",
        { name: "more", toolbar: ["export", "help"] },
      ],
      upload: {
        accept: "image/png,image/jpeg,image/gif,image/webp,image/avif", multiple: true, max: 5 * 1024 * 1024,
        handler: (files) => uploadFiles(files),
      },
      input: () => { markDirty(); scheduleStats(); },
      after: () => resolve(v),
    });
  });
  S.vditor = vd;

  /* ---------------- 状态与统计 ---------------- */
  const statsEl = { words: $("[data-st-words]", root), read: $("[data-st-read]", root), lines: $("[data-st-lines]", root) };
  const scheduleStats = debounce(() => {
    const md = vd.getValue();
    const plain = md.replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/[#>*`~_\-|[\]()]/g, " ");
    const words = (plain.match(/[一-鿿]/g) || []).length + (plain.match(/[A-Za-z0-9]+/g) || []).length;
    statsEl.words.innerHTML = toStr(html`${icon("file")}${words.toLocaleString()} 字`);
    statsEl.read.innerHTML = toStr(html`${icon("clock")}约 ${Math.max(1, Math.round(words / 300))} 分钟`);
    statsEl.lines.textContent = `${md.split("\n").length} 行 · ${md.length.toLocaleString()} 字符`;
  }, 200);
  scheduleStats();

  const setSave = (cls, text) => { saveStateEl.className = "save-state " + cls; saveStateEl.textContent = text; };
  function markDirty() {
    S.dirty = true;
    setSave("is-dirty", "未保存");
    writeBackup(S.id || "new", { title: titleEl.value, content: vd.getValue() });
    autoSave();
  }
  const autoSave = debounce(() => save(), 1200);

  /* ---------------- 保存 ---------------- */
  let savePromise = null;
  async function save({ silent = true, force = false } = {}) {
    if (savePromise) { await savePromise; if (!S.dirty && !force) return true; }
    if (!S.dirty && !force && S.id) return true;
    const title = titleEl.value.trim();
    const md = vd.getValue();
    if (!S.id && !title && !md.trim()) return true; // 空白新文章不建档
    savePromise = (async () => {
      setSave("is-saving", "保存中…");
      try {
        if (!S.id) {
          const created = await admin.createPost({ title: title || "无标题文章", category: S.meta.category || null });
          S.id = created.id; S.meta.slug = created.slug;
          history.replaceState(null, "", `/admin/editor/${S.id}`);
          dropBackup("new");
        }
        const r = await admin.saveDraft(S.id, { title: title || "无标题文章", contentMd: md, baseUpdatedAt: S.baseUpdatedAt });
        S.baseUpdatedAt = r.updatedAt;
        S.dirty = vd.getValue() !== md || titleEl.value.trim() !== title;
        S.meta.slug = r.slug;
        S.lastSaved = new Date();
        setSave(S.dirty ? "is-dirty" : "is-saved", S.dirty ? "未保存" : `已保存 ${String(S.lastSaved.getHours()).padStart(2, "0")}:${String(S.lastSaved.getMinutes()).padStart(2, "0")}`);
        if (!S.dirty) dropBackup(S.id);
        $("[data-crumb]", root).textContent = title || "新文章";
        if (!silent) toast("已保存", "success", 1400);
        if (S.dirty) autoSave();
        return true;
      } catch (e) {
        setSave("is-error", e.code === -1 ? "离线 · 已本地备份" : "保存失败");
        if (e.code === 40902) {
          toast(e.message, "error", 5000);
        } else if (!silent || e.code !== -1) toast(e.message, "error");
        return false;
      } finally { savePromise = null; }
    })();
    return savePromise;
  }

  async function saveMeta(patch, msg) {
    Object.assign(S.meta, patch);
    if (!S.id) { await save({ force: true }); if (!S.id) return; }
    try {
      const r = await admin.saveDraft(S.id, patch);
      S.baseUpdatedAt = r.updatedAt;
      S.meta.slug = r.slug;
      if (msg) toast(msg, "success", 1400);
      paintMetaLine();
    } catch (e) { toast(e.message, "error"); }
  }

  /* ---------------- 图片上传 ---------------- */
  async function uploadFiles(files) {
    const imgs = files.filter((f) => /^image\//.test(f.type));
    if (!imgs.length) return "仅支持图片文件";
    const big = imgs.find((f) => f.size > 5 * 1024 * 1024);
    if (big) return `「${big.name}」超过 5MB`;
    vd.tip(`正在上传 ${imgs.length} 张图片…`, 0);
    try {
      const d = await admin.upload(imgs);
      const md = d.items.map((it) => `![${it.alt}](${it.url})`).join("\n\n");
      vd.insertValue(md + "\n");
      vd.tip("上传成功", 1200);
      markDirty();
      return null;
    } catch (e) {
      vd.tip(`上传失败：${e.message}`, 3000);
      return e.message;
    }
  }

  /* ---------------- 模式切换 / 面板 ---------------- */
  const internal = () => vd.vditor;
  function setMode(mode) {
    const btn = internal().toolbar.elements["edit-mode"]?.querySelector(`button[data-mode="${mode}"]`);
    if (!btn) return;
    btn.dispatchEvent(new Event(/iPhone/.test(navigator.userAgent) ? "touchstart" : "click", { bubbles: true }));
    prefs.mode = mode; savePrefs(prefs);
    page.className = page.className.replace(/ed-mode-\w+/, `ed-mode-${mode}`);
    $$(".seg [data-mode]", root).forEach((b) => b.classList.toggle("is-active", b.dataset.mode === mode));
    $("[data-st-mode]", root).textContent = MODES.find((m) => m.id === mode)?.label;
    setTimeout(() => vd.focus(), 30);
  }
  function toggle(key) {
    prefs[key] = !prefs[key]; savePrefs(prefs);
    $(`[data-toggle="${key}"]`, root)?.classList.toggle("is-on", prefs[key]);
    if (key === "toolbar") page.classList.toggle("ed-toolbar-hidden", !prefs.toolbar);
    if (key === "focus") { page.classList.toggle("ed-focus", prefs.focus); toast(prefs.focus ? "专注模式：仅高亮当前段落（F8 退出）" : "已退出专注模式", "info", 1600); }
    if (key === "outline") {
      const btn = internal().toolbar.elements.outline?.firstElementChild;
      btn?.dispatchEvent(new Event("click", { bubbles: true }));
    }
  }

  function paintMetaLine() {
    const m = S.meta;
    mount($("[data-meta-line]", root), html`
      <button class="chip ${m.category ? "" : "add"}" data-panel="meta">${icon("folder")}${m.category || "选择分类"}</button>
      ${m.tags.map((t) => html`<button class="chip" data-panel="meta">#${t}</button>`)}
      <button class="chip add" data-panel="meta">${icon("tag")}${m.tags.length ? "编辑标签" : "添加标签"}</button>
      ${m.slug ? html`<span class="mono faint" style="font-size:12px">/post/${m.slug}</span>` : ""}
      ${m.pinned ? html`<span class="badge badge--grad">${icon("pin")}置顶</span>` : ""}`);
  }
  paintMetaLine();

  function openPanel(kind) {
    const box = $("[data-panel-box]", root);
    const body = $(".ed-body", root);
    if (S.panel === kind) { S.panel = null; box.hidden = true; body.classList.remove("has-panel"); return; }
    S.panel = kind; box.hidden = false; body.classList.add("has-panel");
    kind === "meta" ? paintMetaPanel(box) : paintHistory(box);
  }

  function paintMetaPanel(box) {
    const m = S.meta;
    const c = m.cover || {};
    const [ga, gb] = c.from ? [c.from, c.to] : hashGradient(m.slug || "x");
    const allTags = (S.tax?.tags || []).map((t) => t.name).filter((t) => !m.tags.includes(t)).slice(0, 14);
    mount(box, html`<h3>文章设置<button class="icon-btn" data-panel="meta" title="关闭">${icon("x")}</button></h3>
      <label class="field"><span class="field__label">URL 别名（slug）</span><input class="input mono" data-m="slug" value="${m.slug}" placeholder="my-post-title">
        <span class="field__hint">仅小写字母、数字和连字符，访问地址：/post/${m.slug || "…"}</span></label>
      <label class="field"><span class="field__label">分类</span><input class="input" data-m="category" list="cat-list" value="${m.category}" placeholder="选择或输入新分类">
        <datalist id="cat-list">${(S.tax?.categories || []).map((x) => html`<option value="${x.name}">`)}</datalist></label>
      <div class="field"><span class="field__label">标签</span>
        <div class="tag-input" data-tag-input>${m.tags.map((t) => html`<span class="chip">#${t}<button type="button" data-rm-tag="${t}" aria-label="移除">×</button></span>`)}
          <input placeholder="${m.tags.length ? "" : "输入后回车添加"}" data-tag-new></div>
        ${allTags.length ? html`<div class="tag-suggest">${allTags.map((t) => html`<button class="chip" type="button" data-add-tag="${t}">+ ${t}</button>`)}</div>` : ""}</div>
      <label class="field"><span class="field__label">摘要</span><textarea class="textarea" data-m="excerpt" placeholder="留空则自动截取正文开头">${m.excerpt}</textarea></label>
      <div class="field"><span class="field__label">封面</span>
        <div class="cover-preview"><div class="cover" style="--from:${ga};--to:${gb}"><span class="cover__text">${c.text || "Aa"}</span></div></div>
        <div class="cover-row"><input class="input" data-cover="text" value="${c.text || ""}" placeholder="封面文字，如 304、YAML">
          <input type="color" data-cover="from" value="${ga}" title="渐变起始色"><input type="color" data-cover="to" value="${gb}" title="渐变结束色"></div>
        ${m.cover ? html`<button class="btn btn--sm btn--ghost" style="margin-top:8px" data-clear-cover>移除封面</button>` : ""}</div>
      ${S.post && ["published", "pinned"].includes(S.post.status) ? html`<label class="field" style="display:flex;align-items:center;justify-content:space-between;margin-top:18px">
        <span class="field__label">在首页置顶</span><span class="switch"><input type="checkbox" data-pin ${m.pinned ? "checked" : ""}><span></span></span></label>` : ""}
      <div style="margin-top:22px;display:grid;gap:8px">
        ${S.post && ["published", "pinned"].includes(S.post.status) ? html`<a class="btn btn--block" href="${urlFor.post(m.slug)}" target="_blank" data-native>${icon("external")}查看线上文章</a>` : ""}
        <button class="btn btn--block btn--ghost" data-export>${icon("save")}导出 Markdown</button>
      </div>`);
  }

  async function paintHistory(box) {
    mount(box, html`<h3>历史版本<button class="icon-btn" data-panel="history">${icon("x")}</button></h3><div class="skeleton" style="height:120px"></div>`);
    if (!S.id) { mount(box, html`<h3>历史版本<button class="icon-btn" data-panel="history">${icon("x")}</button></h3><p class="faint">保存后才会产生版本记录。</p>`); return; }
    try {
      const d = await admin.versions(S.id);
      mount(box, html`<h3>历史版本<button class="icon-btn" data-panel="history">${icon("x")}</button></h3>
        <p class="faint" style="font-size:12.5px;margin-bottom:12px">自动保存每 10 分钟生成一个快照，发布时也会记录。</p>
        <div class="versions">${d.list.length ? d.list.map((v) => html`<div class="version"><div><b>v${v.version}</b><br><small>${v.createdAt} · ${v.ago} · ${v.size} 字符</small></div>
          <div class="btns"><button class="icon-btn" title="预览" data-ver-view="${v.version}">${icon("eye")}</button>
          <button class="icon-btn" title="恢复到此版本" data-ver-restore="${v.version}">${icon("undo")}</button></div></div>`) : html`<p class="faint">暂无历史版本</p>`}</div>`);
    } catch (e) { toast(e.message, "error"); }
  }

  async function previewRendered(md, title) {
    const m = modal({ title: title || "发布效果预览", width: 900, body: html`<div class="prose" data-pv><div class="skeleton sk-line"></div><div class="skeleton sk-line"></div></div>` });
    m.el.classList.add("preview-modal");
    try {
      const d = await admin.render(md);
      const box = $("[data-pv]", m.el);
      box.innerHTML = `<h1 style="margin-top:0">${esc(titleEl.value || "无标题")}</h1>` + d.html;
      enhance(box);
    } catch (e) { toast(e.message, "error"); }
    return m;
  }

  /* ---------------- 发布 ---------------- */
  async function publish() {
    if (!titleEl.value.trim()) { toast("请先填写标题", "warning"); titleEl.focus(); return; }
    if (!vd.getValue().trim()) { toast("正文还是空的", "warning"); return; }
    const ok = await save({ force: true });
    if (!ok) return;
    const live = S.post && ["published", "pinned"].includes(S.post.status);
    const tomorrow = new Date(Date.now() + 86400000); tomorrow.setMinutes(0, 0, 0);
    const local = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const m = modal({
      title: live ? "更新已发布文章" : "发布文章", width: 500,
      body: html`<div data-pub-form>
        ${!S.meta.category || !S.meta.tags.length ? html`<div class="alert alert--warn" style="margin-bottom:14px">${icon("bulb")}<span>建议先在「文章设置」中补充${!S.meta.category ? "分类" : ""}${!S.meta.category && !S.meta.tags.length ? "和" : ""}${!S.meta.tags.length ? "标签" : ""}，便于读者检索。</span></div>` : ""}
        <div class="radio-cards">
          <label class="radio-card"><input type="radio" name="mode" value="now" checked><span><b>立即${live ? "更新" : "发布"}</b><small>马上对读者可见</small></span></label>
          <label class="radio-card"><input type="radio" name="mode" value="schedule" ${live ? "disabled" : ""}><span><b>定时发布</b><small>到点自动上线</small></span></label>
        </div>
        <label class="field" style="margin-top:14px" data-sched hidden><span class="field__label">发布时间</span><input class="input" type="datetime-local" value="${local}" data-at></label>
      </div><div class="pub-steps" data-steps hidden></div>`,
      foot: html`<button class="btn btn--ghost" data-close>取消</button><button class="btn btn--primary" data-go>${icon("send")}确认${live ? "更新" : "发布"}</button>`,
    });
    const form = $("[data-pub-form]", m.el);
    form.addEventListener("change", () => { $("[data-sched]", m.el).hidden = form.querySelector("input[name=mode]:checked").value !== "schedule"; });
    $("[data-go]", m.el).addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const mode = form.querySelector("input[name=mode]:checked").value;
      const at = $("[data-at]", m.el).value;
      btn.classList.add("is-loading");
      try {
        const { taskId } = await admin.publish(S.id, mode, mode === "schedule" ? at : null);
        form.hidden = true;
        const steps = $("[data-steps]", m.el); steps.hidden = false;
        let task;
        for (let i = 0; i < 60; i++) {
          task = await admin.task(taskId);
          mount(steps, task.steps.map((s) => html`<div class="pub-step is-${s.status}"><span class="ic">${s.status === "done" ? icon("check") : s.status === "running" ? html`<span class="spinner" style="width:12px;height:12px"></span>` : s.status === "failed" ? icon("x") : ""}</span>${s.name}</div>`));
          if (task.status !== "running") break;
          await new Promise((r) => setTimeout(r, 350));
        }
        if (task.status === "done") {
          S.post = await admin.post(S.id);
          S.baseUpdatedAt = S.post.rev;
          const stt = STATUS[S.post.status];
          const sEl = $("[data-status]", root); sEl.className = `status-dot ${stt.cls}`; sEl.textContent = stt.label;
          $("[data-publish]", root).innerHTML = toStr(html`${icon("send")}${["published", "pinned"].includes(S.post.status) ? "更新" : "发布"}`);
          invalidate("/api/");
          mount($(".modal__body", m.el), html`<div class="pub-done"><div class="big">${icon("check")}</div>
            <h3>${mode === "schedule" ? "已加入定时发布" : live ? "更新成功" : "发布成功 🎉"}</h3>
            <p class="faint" style="margin-top:6px">${mode === "schedule" ? `将于 ${at.replace("T", " ")} 自动上线` : "读者现在可以看到这篇文章了"}</p></div>`);
          mount($(".modal__foot", m.el), html`<button class="btn" data-close>继续编辑</button>
            ${mode === "now" ? html`<a class="btn btn--primary" href="${urlFor.post(S.post.slug)}" target="_blank" data-native>${icon("external")}查看文章</a>` : ""}`);
        } else toast(task.error || "发布失败", "error");
      } catch (err) { toast(err.message, "error"); btn.classList.remove("is-loading"); }
    });
  }

  /* ---------------- 事件绑定 ---------------- */
  titleEl.addEventListener("input", () => { autoGrow(); markDirty(); });
  titleEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || (e.key === "ArrowDown" && titleEl.selectionStart === titleEl.value.length)) { e.preventDefault(); vd.focus(); } });

  root.addEventListener("click", async (e) => {
    const t = e.target;
    const modeBtn = t.closest(".seg [data-mode]");
    if (modeBtn) return setMode(modeBtn.dataset.mode);
    const tg = t.closest("[data-toggle]");
    if (tg) return toggle(tg.dataset.toggle);
    if (t.closest("[data-theme-toggle]")) return theme.toggle();
    const pn = t.closest("[data-panel]");
    if (pn) return openPanel(pn.dataset.panel);
    if (t.closest("[data-preview]")) return previewRendered(vd.getValue());
    if (t.closest("[data-publish]")) return publish();
    if (t.closest("[data-export]")) {
      const blob = new Blob([`# ${titleEl.value}\n\n${vd.getValue()}`], { type: "text/markdown" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${S.meta.slug || "post"}.md`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return;
    }
    const rm = t.closest("[data-rm-tag]");
    if (rm) { await saveMeta({ tags: S.meta.tags.filter((x) => x !== rm.dataset.rmTag) }); return paintMetaPanel($("[data-panel-box]", root)); }
    const add = t.closest("[data-add-tag]");
    if (add) { await saveMeta({ tags: [...S.meta.tags, add.dataset.addTag] }); return paintMetaPanel($("[data-panel-box]", root)); }
    if (t.closest("[data-tag-input]") && t.matches("[data-tag-input]")) $("[data-tag-new]", root)?.focus();
    if (t.closest("[data-clear-cover]")) { await saveMeta({ clearCover: true, cover: null }, "已移除封面"); S.meta.cover = null; return paintMetaPanel($("[data-panel-box]", root)); }
    const vv = t.closest("[data-ver-view]");
    if (vv) { const v = await admin.version(S.id, vv.dataset.verView); previewRendered(v.contentMd, `版本 v${v.version} · ${v.createdAt}`); }
    const vr = t.closest("[data-ver-restore]");
    if (vr && await confirmDialog({ title: "恢复历史版本", message: `将正文替换为 v${vr.dataset.verRestore}，当前内容会先保存为新版本。`, okText: "恢复" })) {
      await save({ force: true });
      const v = await admin.version(S.id, vr.dataset.verRestore);
      vd.setValue(v.contentMd); markDirty(); toast(`已恢复到 v${v.version}`, "success");
    }
  });

  root.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.matches("[data-m]")) {
      const k = t.dataset.m;
      const v = t.value.trim();
      if (k === "slug" && v && !/^[a-z0-9][a-z0-9-]*$/.test(v)) { toast("Slug 仅支持小写字母、数字与连字符", "warning"); t.value = S.meta.slug; return; }
      await saveMeta({ [k]: v }, "已更新");
      if (k === "category" && v && !S.tax.categories.some((c) => c.name === v)) S.tax.categories.push({ name: v });
    }
    if (t.matches("[data-cover]")) {
      const box = $("[data-panel-box]", root);
      const cover = { text: $('[data-cover="text"]', box).value.trim() || "Aa", from: $('[data-cover="from"]', box).value, to: $('[data-cover="to"]', box).value };
      await saveMeta({ cover }, "封面已更新");
      paintMetaPanel(box);
    }
    if (t.matches("[data-pin]")) await saveMeta({ pinned: t.checked }, t.checked ? "已置顶" : "已取消置顶");
  });
  root.addEventListener("keydown", async (e) => {
    if (e.target.matches("[data-tag-new]")) {
      const v = e.target.value.trim().replace(/^#/, "");
      if ((e.key === "Enter" || e.key === "," || e.key === "，") && v) {
        e.preventDefault();
        if (!S.meta.tags.includes(v)) await saveMeta({ tags: [...S.meta.tags, v] });
        paintMetaPanel($("[data-panel-box]", root));
        $("[data-tag-new]", root)?.focus();
      } else if (e.key === "Backspace" && !e.target.value && S.meta.tags.length) {
        await saveMeta({ tags: S.meta.tags.slice(0, -1) });
        paintMetaPanel($("[data-panel-box]", root));
        $("[data-tag-new]", root)?.focus();
      }
    }
  });

  // 全局快捷键
  const onKey = (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save({ silent: false, force: true }); }
    else if (e.key === "F8") { e.preventDefault(); toggle("focus"); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); previewRendered(vd.getValue()); }
    else if (e.altKey && mod && ["7", "8", "9"].includes(e.key)) { e.preventDefault(); setMode({ 7: "wysiwyg", 8: "ir", 9: "sv" }[e.key]); }
  };
  document.addEventListener("keydown", onKey);

  // 拖拽遮罩提示
  let dragDepth = 0, mask = null;
  const onDragEnter = (e) => {
    if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
    if (dragDepth++ === 0) {
      mask = document.createElement("div"); mask.className = "drop-mask";
      mask.innerHTML = toStr(html`<div>${icon("upload")}<b>松开即可上传图片</b><small class="faint">png / jpg / gif / webp，单张 ≤ 5MB</small></div>`);
      document.body.appendChild(mask);
    }
  };
  const onDragLeave = () => { if (--dragDepth <= 0) { dragDepth = 0; mask?.remove(); mask = null; } };
  const onDrop = () => { dragDepth = 0; mask?.remove(); mask = null; };
  document.addEventListener("dragenter", onDragEnter);
  document.addEventListener("dragleave", onDragLeave);
  document.addEventListener("drop", onDrop);

  // 主题同步
  const onTheme = () => {
    const d = dark();
    vd.setTheme(d ? "dark" : "classic", d ? "dark" : "light", d ? "github-dark" : "github", `${CDN}/dist/css/content-theme`);
  };
  window.addEventListener("themechange", onTheme);

  // 离开保护
  const onBeforeUnload = (e) => { if (S.dirty) { save(); e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", onBeforeUnload);
  const onVis = () => { if (document.hidden && S.dirty) save(); };
  document.addEventListener("visibilitychange", onVis);

  if (!titleEl.value) titleEl.focus(); else vd.focus();
  if (isNew) toast("开始写作吧：输入内容后会自动保存为草稿", "info", 2400);

  return () => {
    if (S.dirty) save();
    autoSave.cancel?.();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("dragenter", onDragEnter);
    document.removeEventListener("dragleave", onDragLeave);
    document.removeEventListener("drop", onDrop);
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("themechange", onTheme);
    window.removeEventListener("beforeunload", onBeforeUnload);
    mask?.remove();
    try { vd.destroy(); } catch { /* noop */ }
  };
}
