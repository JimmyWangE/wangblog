/* WangBlog 后台交互（依赖 site.js 提供主题切换与 wbToast）
 * 与动态渲染内容耦合的初始化暴露为 window.WBAdmin.init*，
 * 由 admin-render.js 在数据渲染完成后调用。 */
(function () {
  "use strict";
  function toast(msg) { window.wbToast ? window.wbToast(msg) : alert(msg); }

  /* ============ 登录：密码步 → TOTP 步 → 锁定态 ============
   * 远程模式（检测到后端）：走真实 /api/auth/*，成功后存 JWT；
   * mock 模式（本地预览无后端）：保留演示逻辑。 */
  const loginForm = document.querySelector("#login-form");
  if (loginForm) {
    const stepPwd = document.querySelector("#step-password");
    const stepTotp = document.querySelector("#step-totp");
    const err = document.querySelector("#login-error");
    const lock = document.querySelector("#login-lock");
    const submitBtn = loginForm.querySelector("button[type=submit]");
    const digits = Array.from(document.querySelectorAll(".totp-row input"));
    let fails = 0;
    let remote = false;
    let ticket = null;

    // 模式探测：更新提示文案
    (window.WBApi ? WBApi.isRemote() : Promise.resolve(false)).then((r) => {
      remote = r;
      if (r) {
        const hint = document.querySelector("#login-hint");
        if (hint) hint.textContent = "已连接后端服务：请使用管理员账号登录。";
        const th = document.querySelector("#totp-hint");
        if (th) th.textContent = "（演示环境：任意 6 位数字均可通过）";
      }
    });

    function showLock(seconds) {
      lock.classList.add("is-visible");
      submitBtn.disabled = true;
      let left = seconds;
      const t = setInterval(() => {
        left--;
        lock.textContent = `已锁定，请 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} 后重试`;
        if (left <= 0) { clearInterval(t); lock.classList.remove("is-visible"); submitBtn.disabled = false; fails = 0; }
      }, 1000);
      lock.textContent = `已连续 5 次失败，账户锁定 ${Math.ceil(seconds / 60)} 分钟`;
    }

    function gotoTotp() {
      err.classList.remove("is-visible");
      stepPwd.style.display = "none";
      stepTotp.style.display = "";
      stepTotp.querySelector("input").focus();
    }

    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const username = loginForm.querySelector("[name=username]").value.trim();
      const pwd = loginForm.querySelector("[name=password]").value;

      if (remote) {
        submitBtn.disabled = true;
        const r = await WBApi.auth.login(username, pwd);
        submitBtn.disabled = false;
        if (r.ok) {
          ticket = r.data.ticket;
          gotoTotp();
        } else if (r.code === 42301) {
          showLock((r.data && r.data.retryAfter) || 15 * 60);
        } else {
          err.textContent = r.message || "用户名或密码错误";
          err.classList.add("is-visible");
        }
        return;
      }

      // mock 演示逻辑：密码任意非空进入 TOTP；密码为 "wrong" 计一次失败
      if (pwd === "wrong") {
        fails++;
        err.textContent = "用户名或密码错误";
        err.classList.add("is-visible");
        if (fails >= 5) showLock(15 * 60);
        return;
      }
      gotoTotp();
    });

    async function submitTotp() {
      const code = digits.map((d) => d.value).join("");
      if (remote) {
        const r = await WBApi.auth.totp(ticket, code);
        if (r.ok) { location.href = "index.html"; return; }
        err.textContent = r.message || "动态码错误";
        err.classList.add("is-visible");
        digits.forEach((d) => (d.value = ""));
        digits[0].focus();
        if (r.code === 40101) { // 票据过期：退回密码步
          stepTotp.style.display = "none";
          stepPwd.style.display = "";
        }
        return;
      }
      location.href = "index.html"; // mock 演示：直接进后台
    }

    // TOTP 自动分段聚焦 + 支持粘贴
    digits.forEach((inp, i) => {
      inp.addEventListener("input", () => {
        inp.value = inp.value.replace(/\D/g, "").slice(0, 1);
        if (inp.value && i < 5) digits[i + 1].focus();
        if (digits.every((d) => d.value)) submitTotp();
      });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Backspace" && !inp.value && i > 0) digits[i - 1].focus();
      });
      inp.addEventListener("paste", (e) => {
        e.preventDefault();
        const text = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 6);
        text.split("").forEach((ch, j) => { if (digits[j]) digits[j].value = ch; });
        if (text.length === 6) submitTotp();
      });
    });
  }

  window.WBAdmin = {
    /* ============ 文章列表：批量选择 + 移入回收站（渲染完成后调用） ============ */
    initPostsTable() {
      const table = document.querySelector("#posts-table");
      if (!table) return;
      const bulkBar = document.querySelector("#bulk-bar");
      const bulkCount = document.querySelector("#bulk-count");
      const boxes = Array.from(table.querySelectorAll("tbody input[type=checkbox]"));
      const headBox = table.querySelector("thead input[type=checkbox]");
      function refresh() {
        const n = boxes.filter((b) => b.checked).length;
        bulkBar.classList.toggle("is-visible", n > 0);
        bulkCount.textContent = `已选 ${n} 篇`;
      }
      boxes.forEach((b) => b.addEventListener("change", refresh));
      headBox && headBox.addEventListener("change", () => { boxes.forEach((b) => (b.checked = headBox.checked)); refresh(); });

      const selectedIds = () =>
        boxes.filter((b) => b.checked).map((b) => b.closest("tr").dataset.id).filter(Boolean);

      async function trashIds(ids, rows) {
        const remote = await WBApi.isRemote();
        if (!remote) { toast("本地预览模式：操作仅演示，未改动数据"); return; }
        if (!WBApi.auth.isLoggedIn()) { toast("请先登录后台"); location.href = "login.html"; return; }
        let okCount = 0;
        for (const id of ids) {
          const r = await WBApi.admin.trash(id);
          if (r.ok) okCount++;
          else { toast(`删除失败：${r.message}`); break; }
        }
        if (okCount) {
          WBApi.invalidate();
          rows.forEach((tr) => tr.remove());
          refresh();
          toast(`已将 ${okCount} 篇文章移入回收站`);
        }
      }

      bulkBar && bulkBar.querySelectorAll("button").forEach((b) =>
        b.addEventListener("click", () => {
          const ids = selectedIds();
          if (!ids.length) return;
          if (b.textContent.includes("回收站")) {
            const rows = boxes.filter((x) => x.checked).map((x) => x.closest("tr"));
            if (confirm(`确定将选中的 ${ids.length} 篇文章移入回收站？`)) trashIds(ids, rows);
          } else {
            toast(`「${b.textContent}」批量操作暂未开放，请逐篇编辑`);
          }
        })
      );

      /* 行内「回收站」按钮（admin-render 渲染的 [data-trash]） */
      table.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-trash]");
        if (!btn) return;
        const tr = btn.closest("tr");
        const title = tr.querySelector(".cell-title").textContent;
        if (confirm(`确定将《${title}》移入回收站？`)) trashIds([tr.dataset.id], [tr]);
      });
    },

    /* ============ 编辑器：WYSIWYG 挂载 / 自动保存 / 发布流 ============
     * post：当前文章（含 id/slug/status），null 表示新建文章。
     * 所见即所得由 wysiwyg.js（HyperMD）提供：同一编辑区实时渲染 Markdown，
     * 光标所在处显示源码。内容变化经 cm → textarea 同步并派发 input 事件，
     * 统一走下方「脏标记 → 防抖 → 自动保存」链路。
     * 远程模式下自动保存与发布走真实 API；mock 模式保留演示行为。 */
    initEditor(post) {
      const editor = document.querySelector("#md-editor");
      if (!editor) return;
      const badge = document.querySelector("#save-badge");
      let saveTimer, debounce;
      const state = {
        id: (post && post.id) || null,
        slug: (post && post.slug) || "",
        status: (post && post.status) || "draft",
      };
      let remote = false;
      WBApi.isRemote().then((r) => (remote = r));

      function setBadge(state, text) {
        badge.className = "save-badge" + (state ? " save-badge--" + state : "");
        badge.textContent = text;
      }

      /* ---- 草稿保存（远程模式：真实写库） ---- */
      function field(sel) { return document.querySelector(sel); }
      function collectPayload() {
        const slug = field("[data-field='slug']").value.trim();
        return {
          title: document.querySelector(".editor-title-input").value.trim(),
          contentMd: editor.value,
          slug: slug || undefined, // 空则不修改（后端自动生成/保持）
          category: field("[data-field='category']").value.trim(),
          tags: field("[data-field='tags']").value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
          excerpt: field("[data-field='excerpt']").value.trim(),
          scheduledAt: field("[data-field='scheduledAt']").value || null,
        };
      }
      async function ensureId(payload) {
        if (state.id) return true;
        const r = await WBApi.admin.createPost(payload.title || "未命名文章", payload.slug, payload.category);
        if (!r.ok) { toast(`创建文章失败：${r.message}`); return false; }
        state.id = r.data.id;
        state.slug = r.data.slug;
        history.replaceState(null, "", "editor.html?slug=" + encodeURIComponent(state.slug));
        return true;
      }
      async function saveDraft(showError) {
        if (!WBApi.auth.isLoggedIn()) { toast("登录状态已失效，请重新登录"); location.href = "login.html"; return null; }
        const payload = collectPayload();
        if (!(await ensureId(payload))) return null;
        const r = await WBApi.admin.saveDraft(state.id, payload);
        if (r.ok) {
          if (payload.slug) state.slug = payload.slug;
          WBApi.invalidate();
        } else if (showError) toast(`保存失败：${r.message}`);
        return r;
      }

      /* Ctrl/Cmd+S 立即保存（WYSIWYG 内快捷键与页面全局共用此入口） */
      async function saveNow() {
        if (!remote) { setBadge("", "已保存（本地演示）"); return; }
        setBadge("saving", "保存中…");
        const r = await saveDraft(true);
        if (r && r.ok) setBadge("", r.data.savedAt);
        else if (r) setBadge("error", "保存失败");
      }

      /* ---- 挂载 WYSIWYG 编辑器（HyperMD / 类 Typora 实时渲染） ----
       * 快捷键：Ctrl/⌘+B 加粗、+I 斜体、+K 链接、+1~6 标题、+S 保存、
       * +Z 撤销、+Shift+Z 重做；Tab/Shift+Tab 缩进列表；Enter 延续列表与引用。
       * 粘贴剪贴板图片由 wysiwyg.js 在编辑器输入框 capture 阶段处理。 */
      const wysiwyg = (window.WBEditor && WBEditor.supported)
        ? WBEditor.mount(editor, {
            onSave: () => { saveNow(); },
            onPasteImage: (n) => toast(n > 1 ? `已插入 ${n} 张图片` : "图片已插入"),
            onPasteError: () => toast("图片读取失败，请重试"),
          })
        : null;

      document.querySelectorAll("[data-editor-mode]").forEach((button) => {
        button.addEventListener("click", () => {
          if (!wysiwyg) return;
          wysiwyg.setMode(button.dataset.editorMode);
          document.querySelectorAll("[data-editor-mode]").forEach((item) =>
            item.setAttribute("aria-pressed", String(item === button)));
          document.querySelectorAll(".editor-toolbar [data-cmd]").forEach((item) =>
            (item.disabled = button.dataset.editorMode === "preview"));
        });
      });

      /* 工具栏按钮 → 编辑器命令 */
      document.querySelectorAll(".editor-toolbar [data-cmd]").forEach((b) =>
        b.addEventListener("click", () => { if (wysiwyg) wysiwyg.exec(b.dataset.cmd); })
      );

      editor.addEventListener("input", () => {
        setBadge("saving", "未保存更改");
        clearTimeout(debounce);
        debounce = setTimeout(async () => {
          setBadge("saving", "保存中…");
          if (remote) {
            const r = await saveDraft(true);
            if (r && r.ok) { setBadge("", r.data.savedAt); return; }
            if (!r) return; // 已跳转登录
            setBadge("saving", "保存失败，待重试");
            return;
          }
          // mock 演示：模拟保存耗时后显示已保存
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => {
            const now = new Date();
            setBadge("", `已保存 ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`);
          }, 700);
        }, 1500);
      });

      /* 全局 Ctrl/Cmd+S：焦点在标题/设置输入框时也能保存 */
      document.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
          if (e.defaultPrevented) return;
          e.preventDefault();
          saveNow();
        }
      });

      /* ============================================================
       * 粘贴图片（纯 textarea 兜底，仅当 WYSIWYG 未成功挂载时启用；
       * WYSIWYG 模式下由 wysiwyg.js 在 CodeMirror 输入框上处理）
       * ============================================================ */
      if (!wysiwyg) {
        function readFileAsDataURL(file) {
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          });
        }
        function insertAtCursor(text) {
          const start = editor.selectionStart;
          editor.setRangeText(text, start, editor.selectionEnd, "end");
          editor.dispatchEvent(new Event("input", { bubbles: true }));
          editor.focus();
        }
        editor.addEventListener("paste", (e) => {
          const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
          const imageFiles = items
            .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
            .map((it) => it.getAsFile())
            .filter(Boolean);
          if (!imageFiles.length) return;
          e.preventDefault();
          Promise.all(imageFiles.map(readFileAsDataURL))
            .then((urls) => {
              const pad = (n) => String(n).padStart(2, "0");
              const now = new Date();
              const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
              const before = editor.value.slice(0, editor.selectionStart);
              const prefix = before && !before.endsWith("\n") ? "\n\n" : before.endsWith("\n\n") ? "" : "\n";
              const md = urls.map((u, i) => `![pasted-${stamp}${urls.length > 1 ? "-" + (i + 1) : ""}](${u})`).join("\n\n");
              insertAtCursor(prefix + md + "\n");
              toast(imageFiles.length > 1 ? `已插入 ${imageFiles.length} 张图片` : "图片已插入");
            })
            .catch(() => toast("图片读取失败，请重试"));
        });
      }

      setBadge("", (post && post.editor && post.editor.savedAt) || "已保存");

      /* 发布流：确认卡 → 构建进度 → 成功（远程模式接真实发布流水线） */
      const publishModal = document.querySelector("#publish-modal");
      const buildModal = document.querySelector("#build-modal");
      const doneModal = document.querySelector("#done-modal");
      document.querySelectorAll("[data-publish]").forEach((b) =>
        b.addEventListener("click", () => {
          document.querySelector("#pub-title").textContent =
            document.querySelector(".editor-title-input").value || "未命名文章";
          // 弹窗中的分类/标签与当前设置面板同步
          document.querySelector("[data-render='modal-category']").textContent =
            field("[data-field='category']").value || "未分类";
          document.querySelector("[data-render='modal-tags']").textContent =
            field("[data-field='tags']").value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
              .map((t) => "#" + t).join(" ") || "无";
          publishModal.classList.add("is-open");
        })
      );
      document.querySelectorAll("[data-modal-close]").forEach((b) =>
        b.addEventListener("click", () => b.closest(".modal-mask").classList.remove("is-open"))
      );

      function runBuildAnimation() { // mock 演示：纯前端动画
        const steps = Array.from(buildModal.querySelectorAll(".build-step"));
        steps.forEach((s) => (s.className = "build-step"));
        let i = 0;
        (function next() {
          if (i > 0) { steps[i - 1].classList.replace("is-running", "is-done"); steps[i - 1].querySelector(".build-step__icon").textContent = "✓"; }
          if (i === steps.length) {
            setTimeout(() => { buildModal.classList.remove("is-open"); doneModal.classList.add("is-open"); }, 400);
            return;
          }
          steps[i].classList.add("is-running");
          i++;
          setTimeout(next, 900);
        })();
      }

      function markPublished() {
        const sb = document.querySelector(".editor-topbar .status-badge");
        if (sb) { sb.className = "status-badge status-badge--published"; sb.textContent = "已发布"; }
      }

      async function runRealPublish(taskId) { // 远程：轮询后端发布任务驱动构建弹窗
        const steps = Array.from(buildModal.querySelectorAll(".build-step"));
        steps.forEach((s) => (s.className = "build-step"));
        buildModal.classList.add("is-open");
        for (;;) {
          const r = await WBApi.admin.taskStatus(taskId);
          if (!r.ok) { buildModal.classList.remove("is-open"); toast(`发布状态查询失败：${r.message}`); return; }
          r.data.steps.forEach((st, i) => {
            if (!steps[i]) return;
            steps[i].className = "build-step" + (st.status === "done" ? " is-done" : st.status === "running" ? " is-running" : "");
            if (st.status === "done") steps[i].querySelector(".build-step__icon").textContent = "✓";
          });
          if (r.data.status === "done") {
            WBApi.invalidate();
            const commitEl = document.querySelector("#done-commit");
            if (commitEl && r.data.gitCommit) commitEl.textContent = r.data.gitCommit;
            const viewEl = document.querySelector("#done-view-link");
            if (viewEl) viewEl.href = "../post.html?slug=" + encodeURIComponent(state.slug);
            setTimeout(() => { buildModal.classList.remove("is-open"); doneModal.classList.add("is-open"); markPublished(); }, 400);
            return;
          }
          await new Promise((res) => setTimeout(res, 400));
        }
      }

      document.querySelector("#pub-confirm").addEventListener("click", async () => {
        if (wysiwyg && wysiwyg.hasUploads()) {
          toast("请先完成图片上传，或移除失败图片后再发布"); return;
        }
        publishModal.classList.remove("is-open");
        if (!remote) { buildModal.classList.add("is-open"); runBuildAnimation(); return; }
        // 远程：先保存草稿 → 创建发布任务 → 轮询任务状态
        setBadge("saving", "保存中…");
        const s = await saveDraft(true);
        if (!s || !s.ok) { if (s) setBadge("saving", "保存失败"); return; }
        setBadge("", s.data.savedAt);
        const scheduledAt = field("[data-field='scheduledAt']").value;
        const pub = await WBApi.admin.publish(state.id, scheduledAt ? "schedule" : "now",
          scheduledAt ? scheduledAt.replace("T", " ") : null);
        if (!pub.ok) { toast(`发布失败：${pub.message}`); return; }
        runRealPublish(pub.data.taskId);
      });
    },
  };

  /* ============ 退出登录 + 后台登录守卫 ============ */
  document.addEventListener("click", (e) => {
    const out = e.target.closest("[data-logout]");
    if (!out) return;
    e.preventDefault();
    if (window.WBApi) WBApi.auth.logout();
    toast("已退出登录");
    setTimeout(() => (location.href = "login.html"), 300);
  });

  // 远程模式下，后台页面（除登录页）未登录则跳转登录
  if (!document.querySelector("#login-form") && window.WBApi) {
    WBApi.isRemote().then((remote) => {
      if (remote && !WBApi.auth.isLoggedIn()) location.href = "login.html";
    });
  }

  /* ============ 评论审核（事件委托，兼容动态渲染） ============ */
  document.addEventListener("click", async (e) => {
    const b = e.target.closest(".review-card__actions .btn, .review-card__actions .link-btn");
    if (b) {
      const card = b.closest(".review-card");
      const action = b.dataset.action || b.textContent.trim();
      const label = { approve: "通过", delete: "删除", spam: "标记垃圾" }[action] || action;
      const remote = window.WBApi ? await WBApi.isRemote() : false;
      const commentId = card.dataset.id;

      if (remote && commentId) {
        if (!WBApi.auth.isLoggedIn()) { toast("请先登录后台"); location.href = "login.html"; return; }
        const r = await WBApi.admin.reviewComment(commentId, action);
        if (!r.ok) { toast(`操作失败：${r.message}`); return; }
        WBApi.invalidate();
      }
      // UI 反馈（两种模式一致）
      if (action === "approve" || action === "通过") { card.style.opacity = 0.4; toast(remote ? "已通过并公开显示" : "已通过并公开显示（演示）"); }
      else if (action === "delete" || action === "删除") { card.remove(); toast(remote ? "已删除" : "已删除（演示）"); }
      else if (action === "spam" || action === "垃圾") { card.remove(); toast(remote ? "已标记为垃圾评论" : "已标记为垃圾评论（演示）"); }
      return;
    }
    const tab = e.target.closest(".tabs button");
    if (tab) {
      document.querySelectorAll(".tabs button").forEach((x) => x.classList.remove("is-active"));
      tab.classList.add("is-active");
    }
  });
})();
