/* 分类 / 标签文章列表：动态加载 + 无限滚动 + 侧栏切换不刷新 */
import { api } from "../../lib/api.js";
import { reveal } from "../../lib/ui.js";
import { $, html, mount, icon, toStr } from "../../lib/util.js";
import { state } from "../state.js";
import { postCard, postCardSkeleton, tagCloud, categoryList, emptyState } from "../components.js";

export async function listView(outlet, ctx) {
  const { kind } = ctx;
  const name = ctx.params.name;
  const isCat = kind === "category";
  document.title = `${isCat ? "分类" : "标签"}：${name} — ${state.site.site?.name || ""}`;
  const desc = isCat ? (state.site.categories || {})[name] : "";

  mount(outlet, html`
    <div class="container">
      <header class="page-head view-enter">
        <nav class="crumbs"><a href="/">首页</a><span class="sep">/</span><a href="/categories">${isCat ? "分类" : "标签"}</a></nav>
        <div class="page-head__kicker" style="margin-top:16px">${icon(isCat ? "folder" : "hash")}${isCat ? "Category" : "Tag"}</div>
        <h1 class="page-head__title">${isCat ? "" : "#"}<span class="grad-text">${name}</span></h1>
        <p class="page-head__desc" data-desc>${desc || ""}</p>
      </header>
      <div class="layout">
        <div><div class="post-list" data-list>${postCardSkeleton(3)}</div><div class="load-more" data-more></div></div>
        <aside class="sidebar" data-sidebar></aside>
      </div>
    </div>`);

  api.taxonomy().then((t) => {
    if (ctx.isStale()) return;
    mount($("[data-sidebar]", outlet), html`${categoryList(t.categories.filter((c) => c.count))}${tagCloud(t.tags, isCat ? "" : name)}`);
    reveal(outlet);
  }).catch(() => {});

  const list = $("[data-list]", outlet), more = $("[data-more]", outlet);
  let page = 0, hasMore = true, loading = false;
  async function load() {
    if (loading || !hasMore) return;
    loading = true;
    mount(more, html`<span class="spinner faint"></span>`);
    try {
      const d = await api.posts({ page: page + 1, pageSize: 8, [isCat ? "category" : "tag"]: name });
      if (ctx.isStale()) return;
      if (page === 0) {
        list.innerHTML = "";
        $("[data-desc]", outlet).textContent = `${desc ? desc + " · " : ""}共 ${d.total} 篇文章`;
      }
      page = d.page; hasMore = d.hasMore;
      list.insertAdjacentHTML("beforeend", toStr(d.list.map(postCard)));
      if (!d.total) mount(list, emptyState("暂无文章", `「${name}」下还没有公开文章`));
      mount(more, hasMore ? html`<button class="btn" data-load>加载更多</button>` : d.total ? html`<div class="end-mark">— END —</div>` : "");
      reveal(list);
    } catch (e) {
      mount(more, html`<button class="btn" data-load>${icon("refresh")}${e.message}，点击重试</button>`);
    } finally { loading = false; }
  }
  more.addEventListener("click", (e) => { if (e.target.closest("[data-load]")) load(); });
  const io = new IntersectionObserver((en) => { if (en[0].isIntersecting && page > 0) load(); }, { rootMargin: "400px" });
  io.observe(more);
  await load();
  return () => io.disconnect();
}
