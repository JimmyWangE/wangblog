/* 文章管理：状态页签 / 搜索 / 分类筛选 / 批量操作 / 行内操作，全部无刷新 */
import { admin, invalidate } from "../../lib/api.js";
import { toast, confirmDialog, promptDialog } from "../../lib/ui.js";
import { $, $$, html, mount, icon, debounce, fmtNum, urlFor } from "../../lib/util.js";
import { STATUS } from "../state.js";

const TABS = [["", "全部", "all"], ["published", "已发布", "published"], ["draft", "草稿", "draft"], ["scheduled", "定时", "scheduled"], ["trashed", "回收站", "trashed"]];

export async function postsView(main, ctx) {
  document.title = "文章 — 管理后台";
  const st = { status: ctx.query.status || "", q: ctx.query.q || "", visibility: ctx.query.visibility || "", category: "", page: 1, pageSize: 15, selected: new Set(), data: null };
  mount(main, html`<div class="topline"><div><h1>文章</h1><p data-sum>管理全部文章与草稿</p></div>
      <div class="topline__actions"><a class="btn btn--primary" href="/admin/editor/new">${icon("plus")}新建文章</a></div></div>
    <div class="toolbar-row">
      <div class="tabs" data-tabs></div>
      <div class="search">${icon("search")}<input class="input" placeholder="搜索标题 / slug / 正文" value="${st.q}" data-q></div>
      <select class="select" data-cat style="width:140px"><option value="">全部分类</option></select>
      <select class="select" data-visibility-filter aria-label="筛选文章可见性" style="width:155px">
        <option value="">全部可见性</option><option value="public" ${st.visibility === "public" ? "selected" : ""}>Public · 公开</option>
        <option value="private" ${st.visibility === "private" ? "selected" : ""}>Private · 私密</option></select>
    </div>
    <div class="card table-card"><div class="table-scroll" data-table></div><div class="pager" data-pager></div></div>
    <div data-batch></div>`);

  admin.taxonomy().then((t) => {
    $("[data-cat]", main).insertAdjacentHTML("beforeend", t.categories.map((c) => `<option>${c.name.replace(/</g, "&lt;")}</option>`).join(""));
  }).catch(() => {});

  const syncUrl = () => {
    const q = new URLSearchParams();
    if (st.status) q.set("status", st.status);
    if (st.q) q.set("q", st.q);
    if (st.visibility) q.set("visibility", st.visibility);
    history.replaceState(null, "", "/admin/posts" + (q.toString() ? "?" + q : ""));
  };

  async function load() {
    syncUrl();
    const table = $("[data-table]", main);
    if (!st.data) mount(table, html`<div style="padding:16px">${Array.from({ length: 6 }, () => html`<div class="skeleton" style="height:42px;margin:8px 0"></div>`)}</div>`);
    else table.style.opacity = ".55";
    try {
      st.data = await admin.posts({ status: st.status, q: st.q, visibility: st.visibility, category: st.category, page: st.page, pageSize: st.pageSize });
    } catch (e) { mount(table, html`<div class="empty">${e.message}</div>`); return; }
    table.style.opacity = "";
    paint();
  }

  function paint() {
    const d = st.data;
    $("[data-sum]", main).textContent = `共 ${d.counts.all} 篇 · 已发布 ${d.counts.published} · 草稿 ${d.counts.draft}`;
    mount($("[data-tabs]", main), TABS.map(([v, l, k]) => html`<button class="${st.status === v ? "is-active" : ""}" data-tab="${v}">${l}<span class="n">${d.counts[k]}</span></button>`));
    const trash = st.status === "trashed";
    mount($("[data-table]", main), d.list.length ? html`<table class="table">
      <thead><tr><th style="width:36px"><input type="checkbox" class="checkbox" data-all ${d.list.every((p) => st.selected.has(p.id)) ? "checked" : ""}></th>
        <th>标题</th><th class="hide-sm">状态</th><th>可见性</th><th class="hide-sm">分类</th><th class="hide-sm">阅读</th><th class="hide-sm">评论</th><th class="hide-sm">更新</th><th></th></tr></thead>
      <tbody>${d.list.map((p) => html`<tr class="${st.selected.has(p.id) ? "is-selected" : ""}">
        <td><input type="checkbox" class="checkbox" data-sel="${p.id}" ${st.selected.has(p.id) ? "checked" : ""}></td>
        <td class="title-cell"><a href="${trash ? "#" : `/admin/editor/${p.id}`}">${p.status === "pinned" ? "📌 " : ""}${p.title}</a>
          <small>/${p.slug} · ${fmtNum(p.words)} 字${p.tags.length ? " · #" + p.tags.join(" #") : ""}</small></td>
        <td class="hide-sm"><span class="status-dot ${STATUS[p.status]?.cls}">${STATUS[p.status]?.label}${p.status === "scheduled" && p.scheduledAt ? " " + p.scheduledAt.slice(5, 16) : ""}</span></td>
        <td><select class="select" data-visibility="${p.id}" aria-label="${p.title}的可见性" style="width:145px">
          <option value="public" ${p.visibility !== "private" ? "selected" : ""}>Public · 公开</option>
          <option value="private" ${p.visibility === "private" ? "selected" : ""}>Private · 私密</option></select></td>
        <td class="hide-sm">${p.category || html`<span class="faint">—</span>`}</td>
        <td class="num hide-sm">${fmtNum(p.views)}</td><td class="num hide-sm">${p.commentCount}</td>
        <td class="num hide-sm" title="${p.updatedAt}">${p.updatedAgo}</td>
        <td><div class="row-actions">${trash ? html`
          <button class="icon-btn" title="恢复" data-act="restore" data-id="${p.id}">${icon("undo")}</button>
          <button class="icon-btn" title="彻底删除" data-act="purge" data-id="${p.id}">${icon("trash")}</button>` : html`
          <a class="icon-btn" title="编辑" href="/admin/editor/${p.id}">${icon("edit")}</a>
          ${["published", "pinned"].includes(p.status) ? html`${p.visibility !== "private" ? html`<a class="icon-btn" title="查看" href="${urlFor.post(p.slug)}" target="_blank" data-native>${icon("external")}</a>` : ""}
            <button class="icon-btn" title="${p.status === "pinned" ? "取消置顶" : "置顶"}" data-act="pin" data-id="${p.id}" data-pinned="${p.status === "pinned"}">${icon("pin")}</button>
            <button class="icon-btn" title="撤回为草稿" data-act="unpublish" data-id="${p.id}">${icon("archive")}</button>`
            : html`<button class="icon-btn" title="立即发布" data-act="publish" data-id="${p.id}">${icon("send")}</button>`}
          <button class="icon-btn" title="移入回收站" data-act="trash" data-id="${p.id}">${icon("trash")}</button>`}</div></td>
      </tr>`)}</tbody></table>` : html`<div class="empty"><div class="empty__icon">${icon("file")}</div><div class="empty__title">${trash ? "回收站是空的" : "没有找到文章"}</div>
        ${trash ? "" : html`<a class="btn btn--primary btn--sm" href="/admin/editor/new">${icon("plus")}写第一篇</a>`}</div>`);
    const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
    mount($("[data-pager]", main), html`<span>第 ${d.page} / ${pages} 页 · ${d.total} 条</span><span class="btns">
      <button class="btn btn--sm" data-page="${d.page - 1}" ${d.page <= 1 ? "disabled" : ""}>${icon("arrowLeft")}</button>
      <button class="btn btn--sm" data-page="${d.page + 1}" ${d.page >= pages ? "disabled" : ""}>${icon("arrowRight")}</button></span>`);
    paintBatch();
  }

  function paintBatch() {
    const n = st.selected.size;
    const trash = st.status === "trashed";
    mount($("[data-batch]", main), n ? html`<div class="batch-bar"><b>已选 ${n} 篇</b><span style="flex:1"></span>
      ${trash ? html`<button class="btn btn--sm" data-batch-act="restore">${icon("undo")}恢复</button>` : html`
        <button class="btn btn--sm" data-batch-act="publish">${icon("send")}发布</button>
        <button class="btn btn--sm" data-batch-act="setCategory">${icon("folder")}设置分类</button>
        <button class="btn btn--sm" data-batch-act="addTags">${icon("tag")}添加标签</button>
        <button class="btn btn--sm" data-batch-act="unpublish">${icon("archive")}撤回</button>
        <button class="btn btn--sm" data-batch-act="setPublic">${icon("eye")}设为 Public</button>
        <button class="btn btn--sm" data-batch-act="setPrivate">${icon("shield")}设为 Private</button>
        <button class="btn btn--sm btn--danger" data-batch-act="trash">${icon("trash")}删除</button>`}
      <button class="btn btn--sm btn--ghost" data-batch-act="clear">取消</button></div>` : "");
  }

  const done = (msg) => { toast(msg, "success"); invalidate("/api/"); load(); };

  main.addEventListener("click", async (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab) { st.status = tab.dataset.tab; st.page = 1; st.selected.clear(); return load(); }
    const pg = e.target.closest("[data-page]");
    if (pg && !pg.disabled) { st.page = Number(pg.dataset.page); return load(); }
    const act = e.target.closest("[data-act]");
    if (act) {
      const id = act.dataset.id;
      try {
        switch (act.dataset.act) {
          case "trash": await admin.trash(id); done("已移入回收站"); break;
          case "restore": await admin.restore(id); done("已恢复"); break;
          case "purge":
            if (await confirmDialog({ title: "彻底删除", message: "该文章及其评论、历史版本将被永久删除，无法恢复。", okText: "彻底删除", danger: true })) {
              await admin.trash(id, true); done("已彻底删除");
            } break;
          case "unpublish": await admin.unpublish(id); done("已撤回为草稿"); break;
          case "publish": await admin.publish(id); toast("发布任务已提交", "success"); setTimeout(() => { invalidate("/api/"); load(); }, 1800); break;
          case "pin": await admin.saveDraft(id, { pinned: act.dataset.pinned !== "true" }); done(act.dataset.pinned === "true" ? "已取消置顶" : "已置顶"); break;
        }
      } catch (err) { toast(err.message, "error"); }
      return;
    }
    const b = e.target.closest("[data-batch-act]");
    if (b) {
      const ids = [...st.selected];
      let a = b.dataset.batchAct;
      if (a === "clear") { st.selected.clear(); return paint(); }
      let payload = {};
      if (a === "setPublic" || a === "setPrivate") { payload = { visibility: a === "setPublic" ? "public" : "private" }; a = "setVisibility"; }
      if (a === "setCategory") { const c = await promptDialog({ title: "设置分类", label: "分类名称（不存在会自动创建）" }); if (!c) return; payload = { category: c }; }
      if (a === "addTags") { const t = await promptDialog({ title: "添加标签", label: "多个标签用逗号分隔" }); if (!t) return; payload = { tags: t.split(/[,，\s]+/).filter(Boolean) }; }
      if (a === "trash" && !(await confirmDialog({ title: "批量删除", message: `确定将 ${ids.length} 篇文章移入回收站？`, okText: "删除", danger: true }))) return;
      try { const r = await admin.batch(ids, a, payload); st.selected.clear(); done(`已处理 ${r.affected} 篇`); }
      catch (err) { toast(err.message, "error"); }
    }
  });
  main.addEventListener("change", async (e) => {
    if (e.target.matches("[data-visibility]")) {
      const select = e.target, id = select.dataset.visibility;
      const post = st.data.list.find((p) => p.id === id);
      const previous = post.visibility;
      select.disabled = true;
      try {
        await admin.saveDraft(id, { visibility: select.value });
        done(select.value === "private" ? "已设为 Private，访客无法查看" : "已设为 Public，已发布文章对访客可见");
      } catch (err) { select.value = previous; toast(err.message, "error"); }
      finally { select.disabled = false; }
      return;
    }
    if (e.target.matches("[data-sel]")) {
      e.target.checked ? st.selected.add(e.target.dataset.sel) : st.selected.delete(e.target.dataset.sel);
      e.target.closest("tr").classList.toggle("is-selected", e.target.checked);
      paintBatch();
    }
    if (e.target.matches("[data-all]")) {
      st.data.list.forEach((p) => (e.target.checked ? st.selected.add(p.id) : st.selected.delete(p.id)));
      paint();
    }
    if (e.target.matches("[data-cat]")) { st.category = e.target.value; st.page = 1; load(); }
    if (e.target.matches("[data-visibility-filter]")) { st.visibility = e.target.value; st.page = 1; st.selected.clear(); load(); }
  });
  const onSearch = debounce(() => { st.q = $("[data-q]", main).value.trim(); st.page = 1; load(); }, 300);
  $("[data-q]", main).addEventListener("input", onSearch);
  await load();
}
