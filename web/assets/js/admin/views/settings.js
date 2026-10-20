/* 站点设置：站点信息、首页文案、作者资料、友链、修改密码 */
import { admin, auth_, invalidate } from "../../lib/api.js";
import { toast } from "../../lib/ui.js";
import { $, $$, html, mount, icon } from "../../lib/util.js";
import { go } from "../state.js";

const get = (o, path) => path.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
const set = (o, path, v) => { const ks = path.split("."); let c = o; ks.slice(0, -1).forEach((k) => { c[k] = c[k] || {}; c = c[k]; }); c[ks.at(-1)] = v; };

export async function settingsView(main, ctx = {}) {
  const rssMode = ctx.url?.pathname.replace(/\/$/, "") === "/admin/rss";
  const title = rssMode ? "RSS 与首页设置" : "站点设置";
  document.title = `${title} — 管理后台`;
  let cfg;
  try { cfg = await admin.site(); } catch (e) { mount(main, html`<div class="empty">${e.message}</div>`); return; }
  cfg.about ||= {};
  cfg.about.author ||= {};
  cfg.about.author.github ??= (cfg.about.author.links || []).find((l) => /github/i.test(l.label))?.href || "";
  // 旧版数据库可能只有 heroTitleHtml 等字段，表单默认值与当前首页保持一致。
  cfg.home = { eyebrow: "Personal Tech Journal", titleLines: ["写作即思考，", "记录一名工程师的", "长期主义。"],
    highlight: "", desc: cfg.site?.description || "", typing: ["前端工程化", "运维实践", "内容主权"], ...cfg.home };
  cfg.rss = { language: "zh-CN", itemLimit: 20, fullContent: true, ...cfg.rss };
  const f = (label, path, { type = "text", hint = "", area = false, list = false, min = "", max = "" } = {}) => {
    let v = get(cfg, path);
    if (list) v = (v || []).join(list === "lines" ? "\n" : ", ");
    return html`<label class="field"><span class="field__label">${label}</span>
      ${area || list === "lines" ? html`<textarea class="textarea" data-path="${path}" data-list="${list || ""}" rows="3">${v || ""}</textarea>`
        : html`<input class="input" type="${type}" data-path="${path}" data-list="${list || ""}" value="${v ?? ""}" min="${min}" max="${max}">`}
      ${hint ? html`<span class="field__hint">${hint}</span>` : ""}</label>`;
  };
  const links = cfg.about?.friendLinks || [];
  mount(main, html`<div class="topline"><div><h1>${title}</h1><p>统一管理首页文案、社交链接和 RSS；保存后刷新首页即可查看变化</p></div>
      <div class="topline__actions"><a class="btn" href="/" data-native target="_blank" rel="noopener">${icon("external")}查看首页</a>
        <a class="btn" href="/rss.xml" data-native target="_blank" rel="noopener">${icon("rss")}查看 RSS</a>
        <button class="btn btn--primary" data-save>${icon("save")}保存设置</button></div></div>
    <div class="settings-grid">
      <section class="card card--pad"><div class="card__title">${icon("home")}站点信息</div><div class="form-grid">
        <div class="form-grid cols-2">${f("站点名称", "site.name")}${f("标语", "site.slogan")}</div>
        ${f("站点描述（SEO / RSS 简介）", "site.description", { area: true })}
        <div class="form-grid cols-2">${f("作者", "site.author")}${f("建站日期", "site.startDate", { type: "date" })}</div>
        <div class="form-grid cols-2">${f("ICP 备案号", "site.icp")}${f("公安备案号", "site.policeIcp")}</div>
        ${f("Logo 字符", "site.logoText", { hint: "显示在左上角渐变方块中，建议 1 个字符" })}
      </div></section>
      <section class="card card--pad"><div class="card__title">${icon("sparkles")}首页 Hero</div><div class="form-grid">
        ${f("顶部小标签", "home.eyebrow")}
        ${f("大标题（每行一句）", "home.titleLines", { list: "lines" })}
        ${f("渐变高亮词", "home.highlight", { hint: "需出现在大标题中" })}
        ${f("简介", "home.desc", { area: true })}
        ${f("打字机轮播词", "home.typing", { list: true, hint: "逗号分隔" })}
        ${f("搜索热门词", "search.hotTags", { list: true, hint: "逗号分隔" })}
      </div></section>
      <section class="card card--pad"><div class="card__title">${icon("user")}作者资料</div><div class="form-grid">
        <div class="form-grid cols-2">${f("显示名", "about.author.name")}${f("头像字符", "about.author.avatarText")}</div>
        ${f("个人简介", "about.author.bio", { area: true })}
        ${f("GitHub 地址", "about.author.github", { type: "url", hint: "用于首页及关于页的 GitHub 图标；留空可隐藏" })}
        ${f("联系邮箱", "about.author.email", { type: "email", hint: "用于首页邮件图标和 RSS 联系信息；留空可隐藏" })}
        ${f("关于本站（每段一行）", "about.blogIntro", { area: true })}
      </div></section>
      <section class="card card--pad"><div class="card__title">${icon("rss")}RSS 订阅</div><div class="form-grid">
        <p class="field__hint">订阅标题与简介同步使用站点名称和站点描述；GitHub、邮箱及首页文案也会写入 RSS。文章内容来自已发布文章。</p>
        ${f("订阅语言", "rss.language", { hint: "例如 zh-CN、en-US" })}
        ${f("输出文章数量", "rss.itemLimit", { type: "number", min: 1, max: 100, hint: "最近发布的 1–100 篇文章" })}
        <label class="field"><span class="field__label">文章输出方式</span><select class="input" data-path="rss.fullContent" data-boolean>
          <option value="true" ${cfg.rss.fullContent ? "selected" : ""}>全文与摘要</option>
          <option value="false" ${!cfg.rss.fullContent ? "selected" : ""}>仅摘要</option></select></label>
      </div></section>
      <section class="card card--pad"><div class="card__title">${icon("link")}友情链接</div>
        <div class="form-grid" data-links>${links.map(linkRow)}</div>
        <button class="btn btn--sm" style="margin-top:12px" data-add-link>${icon("plus")}添加友链</button>
        <div class="card__title" style="margin-top:28px">${icon("shield")}修改密码</div>
        <form class="form-grid" data-pwd>
          <input class="input" type="password" name="old" placeholder="当前密码" autocomplete="current-password">
          <input class="input" type="password" name="new" placeholder="新密码（至少 8 位）" autocomplete="new-password">
          <button class="btn" type="submit">更新密码</button></form>
      </section>
    </div>`);

  main.addEventListener("click", async (e) => {
    if (e.target.closest("[data-add-link]")) $("[data-links]", main).insertAdjacentHTML("beforeend", linkRow({}).s);
    if (e.target.closest("[data-del-link]")) e.target.closest(".link-edit").remove();
    if (e.target.closest("[data-save]")) {
      const btn = e.target.closest("[data-save]");
      if (btn.disabled) return;
      for (const el of $$("[data-path]", main)) if (!el.reportValidity()) return;
      const next = structuredClone(cfg);
      $$("[data-path]", main).forEach((el) => {
        let v = el.value;
        if (el.hasAttribute("data-boolean")) v = v === "true";
        else if (el.type === "number") v = el.valueAsNumber;
        else if (el.dataset.list === "lines") v = v.split("\n").map((s) => s.trim()).filter(Boolean);
        else if (el.dataset.list) v = v.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        set(next, el.dataset.path, v);
      });
      next.about = next.about || {};
      next.about.friendLinks = $$(".link-edit", main).map((r) => ({ name: $('[name="name"]', r).value.trim(), href: $('[name="href"]', r).value.trim(), desc: $('[name="desc"]', r).value.trim() })).filter((l) => l.name);
      btn.classList.add("is-loading");
      btn.disabled = true;
      try { await admin.saveSite(next); cfg = next; invalidate("/api/"); toast("设置已保存", "success"); }
      catch (err) { toast(err.message, "error"); }
      btn.classList.remove("is-loading");
      btn.disabled = false;
    }
  });
  $("[data-pwd]", main).addEventListener("submit", async (e) => {
    e.preventDefault();
    const fm = e.target;
    try {
      await admin.changePassword(fm.old.value, fm.new.value);
      toast("密码已修改，请重新登录", "success");
      auth_.clear();
      go("/admin/login", { replace: true });
    } catch (err) { toast(err.message, "error"); }
  });
}

function linkRow(l) {
  return html`<div class="link-edit"><input class="input" name="name" placeholder="名称" value="${l.name || ""}">
    <input class="input" name="href" placeholder="https://" value="${l.href || ""}">
    <input class="input" name="desc" placeholder="简介" value="${l.desc || ""}">
    <button class="icon-btn" type="button" data-del-link title="删除">${icon("trash")}</button></div>`;
}
