/* 评论审核：待审 / 已通过 / 垃圾，通过、标记、删除、作者回复均为无刷新操作 */
import { admin, invalidate } from "../../lib/api.js";
import { toast } from "../../lib/ui.js";
import { $, html, raw, mount, icon, debounce, urlFor } from "../../lib/util.js";
import { refreshBadge } from "../main.js";

const TABS = [["pending", "待审核"], ["approved", "已通过"], ["spam", "垃圾评论"]];
const hue = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

export async function commentsView(main) {
  document.title = "评论 — 管理后台";
  const st = { status: "pending", q: "", page: 1, data: null };
  mount(main, html`<div class="topline"><div><h1>评论</h1><p>审核访客评论，回复会以作者身份公开展示</p></div></div>
    <div class="toolbar-row"><div class="tabs" data-tabs></div>
      <div class="search">${icon("search")}<input class="input" placeholder="搜索内容或昵称" data-q></div></div>
    <div class="review-list" data-list></div><div class="pager" data-pager style="border:0"></div>`);

  async function load() {
    const list = $("[data-list]", main);
    if (!st.data) mount(list, [1, 2, 3].map(() => html`<div class="skeleton" style="height:110px;border-radius:14px"></div>`));
    try { st.data = await admin.comments({ status: st.status, q: st.q, page: st.page, pageSize: 15 }); }
    catch (e) { mount(list, html`<div class="empty">${e.message}</div>`); return; }
    const d = st.data;
    mount($("[data-tabs]", main), TABS.map(([v, l]) => html`<button class="${st.status === v ? "is-active" : ""}" data-tab="${v}">${l}<span class="n">${d.counts[v]}</span></button>`));
    mount(list, d.list.length ? d.list.map((c) => html`<article class="card review" data-id="${c.id}">
      <div class="comment__avatar" style="--h:${hue(c.author)}">${c.author.slice(0, 1).toUpperCase()}</div>
      <div><div class="review__meta"><b>${c.author}</b>${c.isAuthor ? html`<span class="badge badge--grad">作者</span>` : ""}
          ${c.flag ? html`<span class="badge badge--warning">${icon("shield")}${c.flag}</span>` : ""}
          <span>${c.email || "未留邮箱"}</span>${c.ip ? html`<span class="mono">${c.ip}</span>` : ""}<span title="${c.time}">${c.timeAgo}</span></div>
        <div class="review__body">${c.replyTo ? html`<span class="faint">回复 @${c.replyTo}：</span>` : ""}${raw(c.html)}</div>
        <div class="review__post">${icon("file")} 《<a href="${urlFor.post(c.postSlug)}#comments" target="_blank" data-native>${c.postTitle}</a>》</div>
        <div class="review__actions">
          ${st.status !== "approved" ? html`<button class="btn btn--sm btn--primary" data-act="approve">${icon("check")}${c.flag ? "仍要通过" : "通过"}</button>` : ""}
          ${!c.isAuthor ? html`<button class="btn btn--sm" data-act="reply">${icon("reply")}回复</button>` : ""}
          ${st.status === "pending" ? html`<button class="btn btn--sm" data-act="spam">${icon("shield")}垃圾</button>` : ""}
          ${st.status === "spam" ? html`<button class="btn btn--sm" data-act="pending">${icon("undo")}移回待审</button>` : ""}
          <button class="btn btn--sm btn--danger" data-act="delete">${icon("trash")}删除</button>
        </div>
        <div class="review__reply" data-reply-box hidden><textarea class="textarea" placeholder="以作者身份回复（支持 Markdown，回复后该评论自动通过）"></textarea>
          <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn btn--sm btn--ghost" data-act="cancel-reply">取消</button>
          <button class="btn btn--sm btn--primary" data-act="send-reply">${icon("send")}发送回复</button></div></div>
      </div></article>`) : html`<div class="empty"><div class="empty__icon">${icon("check")}</div><div class="empty__title">${st.status === "pending" ? "全部审核完毕 🎉" : "暂无评论"}</div></div>`);
    const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
    mount($("[data-pager]", main), pages > 1 ? html`<span>第 ${d.page}/${pages} 页</span><span class="btns">
      <button class="btn btn--sm" data-page="${d.page - 1}" ${d.page <= 1 ? "disabled" : ""}>上一页</button>
      <button class="btn btn--sm" data-page="${d.page + 1}" ${d.page >= pages ? "disabled" : ""}>下一页</button></span>` : "");
  }

  main.addEventListener("click", async (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab) { st.status = tab.dataset.tab; st.page = 1; return load(); }
    const pg = e.target.closest("[data-page]");
    if (pg && !pg.disabled) { st.page = Number(pg.dataset.page); return load(); }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const card = b.closest("[data-id]");
    const id = card.dataset.id;
    const act = b.dataset.act;
    const box = $("[data-reply-box]", card);
    if (act === "reply") { box.hidden = false; $("textarea", box).focus(); return; }
    if (act === "cancel-reply") { box.hidden = true; return; }
    b.classList.add("is-loading");
    try {
      if (act === "send-reply") {
        const text = $("textarea", box).value.trim();
        if (!text) { toast("回复内容不能为空", "warning"); b.classList.remove("is-loading"); return; }
        await admin.reply(id, text);
        toast("回复已发布", "success");
      } else {
        await admin.review(id, act);
        toast({ approve: "已通过", spam: "已标记为垃圾评论", delete: "已删除", pending: "已移回待审" }[act], "success");
      }
      card.style.transition = "all .3s"; card.style.opacity = "0"; card.style.transform = "translateX(20px)";
      invalidate("/api/");
      setTimeout(load, 250);
      refreshBadge();
    } catch (err) { toast(err.message, "error"); b.classList.remove("is-loading"); }
  });
  $("[data-q]", main).addEventListener("input", debounce((e) => { st.q = e.target.value.trim(); st.page = 1; load(); }, 300));
  await load();
}
