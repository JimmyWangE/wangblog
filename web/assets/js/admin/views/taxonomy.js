/* 分类与标签管理 */
import { admin, invalidate } from "../../lib/api.js";
import { toast, confirmDialog, modal, promptDialog } from "../../lib/ui.js";
import { $, html, mount, icon, urlFor } from "../../lib/util.js";

export async function taxonomyView(main) {
  document.title = "分类与标签 — 管理后台";
  mount(main, html`<div class="topline"><div><h1>分类与标签</h1><p>标签重命名为已有名称时会自动合并</p></div>
    <div class="topline__actions"><button class="btn btn--primary" data-new-cat>${icon("plus")}新建分类</button></div></div>
    <div class="settings-grid"><section class="card table-card" data-cats></section><section class="card card--pad" data-tags></section></div>`);

  async function load() {
    let t;
    try { t = await admin.taxonomy(); } catch (e) { toast(e.message, "error"); return; }
    mount($("[data-cats]", main), html`<table class="table"><thead><tr><th>分类</th><th>描述</th><th>排序</th><th>文章</th><th></th></tr></thead>
      <tbody>${t.categories.map((c) => html`<tr><td><b>${c.name}</b></td><td class="faint">${c.description || "—"}</td><td class="num">${c.sort}</td><td class="num">${c.count}</td>
        <td><div class="row-actions"><button class="icon-btn" data-edit-cat="${c.id}" title="编辑">${icon("edit")}</button>
        <button class="icon-btn" data-del-cat="${c.id}" data-name="${c.name}" title="删除">${icon("trash")}</button></div></td></tr>`)}</tbody></table>`);
    mount($("[data-tags]", main), html`<div class="card__title">${icon("hash")}标签（${t.tags.length}）</div>
      <div class="tag-cloud">${t.tags.map((x) => html`<span class="chip" style="padding-right:4px">#${x.name}<span class="chip__count">${x.count}</span>
        <button class="icon-btn" style="width:24px;height:24px" data-rename="${x.id}" data-name="${x.name}" title="重命名">${icon("edit")}</button>
        <button class="icon-btn" style="width:24px;height:24px" data-del-tag="${x.id}" data-name="${x.name}" title="删除">${icon("x")}</button></span>`)}</div>`);
    main._cats = t.categories;
  }

  const catForm = (c = {}) => modal({
    title: c.id ? "编辑分类" : "新建分类", width: 460,
    body: html`<div class="form-grid"><label class="field"><span class="field__label">名称</span><input class="input" data-f="name" value="${c.name || ""}" autofocus></label>
      <label class="field"><span class="field__label">描述</span><input class="input" data-f="description" value="${c.description || ""}"></label>
      <label class="field"><span class="field__label">排序（越小越靠前）</span><input class="input" type="number" data-f="sort" value="${c.sort ?? 0}"></label></div>`,
    foot: html`<button class="btn btn--ghost" data-close>取消</button><button class="btn btn--primary" data-ok>保存</button>`,
    onMount: (m) => $("[data-ok]", m.el).addEventListener("click", async () => {
      const body = { name: $('[data-f="name"]', m.el).value.trim(), description: $('[data-f="description"]', m.el).value.trim(), sort: Number($('[data-f="sort"]', m.el).value) || 0 };
      if (!body.name) return toast("名称不能为空", "warning");
      try { c.id ? await admin.updateCategory(c.id, body) : await admin.createCategory(body); m.close(true); toast("已保存", "success"); invalidate("/api/"); load(); }
      catch (e) { toast(e.message, "error"); }
    }),
  });

  main.addEventListener("click", async (e) => {
    if (e.target.closest("[data-new-cat]")) catForm();
    const ec = e.target.closest("[data-edit-cat]");
    if (ec) catForm(main._cats.find((c) => c.id === ec.dataset.editCat));
    const dc = e.target.closest("[data-del-cat]");
    if (dc && await confirmDialog({ title: "删除分类", message: `删除「${dc.dataset.name}」后，其下文章将变为未分类。`, okText: "删除", danger: true })) {
      await admin.deleteCategory(dc.dataset.delCat).then(() => { toast("已删除", "success"); invalidate("/api/"); load(); }, (x) => toast(x.message, "error"));
    }
    const rn = e.target.closest("[data-rename]");
    if (rn) {
      const name = await promptDialog({ title: "重命名标签", label: "新名称（与已有标签同名将合并）", value: rn.dataset.name });
      if (name && name !== rn.dataset.name) await admin.renameTag(rn.dataset.rename, name).then((r) => { toast(r.merged ? "已合并" : "已重命名", "success"); invalidate("/api/"); load(); }, (x) => toast(x.message, "error"));
    }
    const dt = e.target.closest("[data-del-tag]");
    if (dt && await confirmDialog({ title: "删除标签", message: `删除标签「${dt.dataset.name}」？文章本身不受影响。`, okText: "删除", danger: true })) {
      await admin.deleteTag(dt.dataset.delTag).then(() => { toast("已删除", "success"); invalidate("/api/"); load(); }, (x) => toast(x.message, "error"));
    }
  });
  await load();
}
