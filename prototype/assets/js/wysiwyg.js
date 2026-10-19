/* WangBlog 所见即所得（WYSIWYG）Markdown 编辑器封装
 * 基于 HyperMD（CodeMirror 5）：同一编辑区内实时渲染 Markdown，
 * 光标所在行/片段显示源码，移开后恢复排版效果（类 Typora 体验）。
 *
 * 暴露 window.WBEditor：
 *   WBEditor.supported           运行环境是否具备依赖（HyperMD/CodeMirror）
 *   WBEditor.mount(textarea, opts)  把 textarea 升级为 WYSIWYG 编辑器
 *     opts.onChange()            内容变化回调（已同步 textarea.value 并派发 input 事件）
 *     opts.onSave()              Ctrl/Cmd+S 回调
 *     图片粘贴、拖拽和文件选择统一上传至 WBApi.admin.uploadImages
 *   返回句柄 { cm, getValue(), setValue(v), focus(), exec(cmd), insertImage(url, alt) }
 *
 * 工具栏命令（exec 的 cmd 参数）：
 *   bold / italic / strikethrough / inlineCode / codeBlock / quote
 *   h1..h6 / ul / ol / task / link / image / table / hr / toc
 */
(function () {
  "use strict";

  var supported = !!(window.CodeMirror && window.HyperMD);

  /* ---------------- 选区/行操作小工具 ---------------- */

  // 切换行内标记（**、*、~~、`）：有选区包选区，无选区插占位并选中中间文字
  function toggleInline(cm, mark, placeholder) {
    var sel = cm.getSelection();
    if (sel) {
      if (sel.startsWith(mark) && sel.endsWith(mark) && sel.length >= mark.length * 2) {
        cm.replaceSelection(sel.slice(mark.length, -mark.length));
      } else {
        cm.replaceSelection(mark + sel + mark);
      }
    } else {
      cm.replaceSelection(mark + placeholder + mark);
      var cur = cm.getCursor();
      cm.setSelection({ line: cur.line, ch: cur.ch - placeholder.length - mark.length },
                      { line: cur.line, ch: cur.ch - mark.length });
    }
    cm.focus();
  }

  // 切换行前缀（"> "、"- "、"1. "、"- [ ] "）：作用于选区覆盖的所有行
  function toggleLinePrefix(cm, prefix) {
    cm.operation(function () {
      var from = cm.getCursor("from"), to = cm.getCursor("to");
      // 判断：所有行都已有该前缀 → 移除；否则统一加上
      var allHave = true;
      for (var i = from.line; i <= to.line; i++) {
        var t = cm.getLine(i);
        if (t.trim() && t.indexOf(prefix) !== 0) { allHave = false; break; }
      }
      for (var j = from.line; j <= to.line; j++) {
        var line = cm.getLine(j);
        if (!line.trim() && !allHave) { cm.replaceRange(prefix, { line: j, ch: 0 }); continue; }
        if (allHave && line.indexOf(prefix) === 0) {
          cm.replaceRange("", { line: j, ch: 0 }, { line: j, ch: prefix.length });
        } else if (!allHave && line.indexOf(prefix) !== 0) {
          cm.replaceRange(prefix, { line: j, ch: 0 });
        }
      }
    });
    cm.focus();
  }

  // 标题：把当前行行首的 # 序列设置/切换为 n 级
  function setHeading(cm, level) {
    cm.operation(function () {
      var from = cm.getCursor("from"), to = cm.getCursor("to");
      for (var i = from.line; i <= to.line; i++) {
        var line = cm.getLine(i);
        if (!line.trim()) continue;
        var m = line.match(/^(#{1,6})\s+/);
        var cur = m ? m[1].length : 0;
        var body = m ? line.slice(m[0].length) : line;
        if (cur === level) {
          cm.replaceRange(body, { line: i, ch: 0 }, { line: i, ch: line.length }); // 再按一次取消标题
        } else {
          var hashes = "######".slice(0, level) + " ";
          cm.replaceRange(hashes + body, { line: i, ch: 0 }, { line: i, ch: line.length });
        }
      }
    });
    cm.focus();
  }

  function insertLink(cm) {
    var sel = cm.getSelection();
    var url = window.prompt("链接地址：", "https://");
    if (url === null) return;
    if (url === "https://" || url === "") url = "";
    var text = sel || "链接文字";
    cm.replaceSelection("[" + text + "](" + url + ")");
    if (!url) { // 未填地址：选中 URL 占位处方便继续输入
      var cur = cm.getCursor();
      cm.setCursor({ line: cur.line, ch: cur.ch - 1 });
    }
    cm.focus();
  }

  function insertImageMd(cm, url, alt) {
    var before = cm.getRange({ line: 0, ch: 0 }, cm.getCursor());
    var prefix = before && !before.endsWith("\n") ? "\n\n" : before.endsWith("\n\n") ? "" : "\n";
    cm.replaceSelection(prefix + "![" + (alt || "image") + "](" + url + ")\n");
    cm.focus();
  }

  function insertTable(cm) {
    var tpl = "\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |\n";
    cm.replaceSelection(tpl);
    cm.focus();
  }

  function insertToc(cm) { cm.replaceSelection("\n[TOC]\n"); cm.focus(); }

  // 任务列表：普通行 → "- [ ] 行"；列表行 "- 行" → "- [ ] 行"；已是任务则去掉复选框
  function toggleTask(cm) {
    cm.operation(function () {
      var from = cm.getCursor("from"), to = cm.getCursor("to");
      for (var i = from.line; i <= to.line; i++) {
        var line = cm.getLine(i);
        var m = line.match(/^(\s*(?:[-*+]|\d+\.)\s+)\[([ xX])\]\s+/);
        if (m) { // 已是任务项：去掉复选框，还原为普通列表项
          cm.replaceRange(m[1], { line: i, ch: 0 }, { line: i, ch: m[0].length });
          continue;
        }
        var li = line.match(/^(\s*)([-*+]|\d+\.)\s+/);
        if (li) { // 列表项 → 任务项
          cm.replaceRange(li[1] + li[2] + " [ ] ", { line: i, ch: 0 }, { line: i, ch: li[0].length });
        } else if (line.trim()) { // 普通行 → 任务项
          cm.replaceRange("- [ ] ", { line: i, ch: 0 });
        } else {
          cm.replaceRange("- [ ] ", { line: i, ch: 0 });
        }
      }
    });
    cm.focus();
  }

  function insertCodeBlock(cm) {
    var sel = cm.getSelection();
    cm.replaceSelection("\n```\n" + sel + "\n```\n");
    var cur = cm.getCursor();
    cm.setCursor({ line: cur.line - 2, ch: 0 }); // 光标落入代码区
    cm.focus();
  }

  /* ---------------- 命令表 ---------------- */
  var COMMANDS = {
    bold:          function (cm) { toggleInline(cm, "**", "加粗文字"); },
    italic:        function (cm) { toggleInline(cm, "*", "斜体文字"); },
    strikethrough: function (cm) { toggleInline(cm, "~~", "删除线文字"); },
    inlineCode:    function (cm) { toggleInline(cm, "`", "code"); },
    codeBlock:     insertCodeBlock,
    quote:         function (cm) { toggleLinePrefix(cm, "> "); },
    ul:            function (cm) { toggleLinePrefix(cm, "- "); },
    ol:            function (cm) { toggleLinePrefix(cm, "1. "); },
    task:          toggleTask,
    link:          insertLink,
    image:         function (cm) {
      var url = window.prompt("图片地址（也可以直接 Ctrl+V 粘贴剪贴板图片）：", "https://");
      if (url === null || url === "" || url === "https://") return;
      insertImageMd(cm, url, "image");
    },
    table: insertTable,
    toc:   insertToc,
    hr:    function (cm) { cm.replaceSelection("\n\n---\n\n"); cm.focus(); }
  };
  "h1 h2 h3 h4 h5 h6".split(" ").forEach(function (h, i) {
    COMMANDS[h] = function (cm) { setHeading(cm, i + 1); };
  });

  /* 图片统一入口：占位标记跟随编辑，异步结果只替换原位置，绝不使用当前光标。 */
  function bindImageUploads(cm) {
    var panel = document.getElementById("editor-uploads");
    var picker = document.getElementById("editor-image-file");
    var jobs = [], sequence = 0;
    var allowed = /^(image\/(png|jpeg|gif|webp|svg\+xml))$/;
    function notify(message) { if (window.wbToast) window.wbToast(message); }
    function remove(job) {
      var range = job.mark.find();
      job.cancelled = true;
      job.mark.clear();
      if (range) cm.replaceRange("", range.from, range.to, "+input");
      job.row.remove();
      jobs = jobs.filter(function (item) { return item !== job; });
      panel.hidden = !jobs.length;
    }
    async function run(job) {
      if (job.busy || job.cancelled) return;
      if (!job.mark.find()) { remove(job); return; }
      job.busy = true;
      job.row.classList.remove("is-error");
      job.label.textContent = job.file.name + " · 上传中…";
      job.progress.hidden = false;
      job.retry.hidden = true;
      try {
        var result = await WBApi.admin.uploadImages([job.file]);
        if (job.cancelled) return;
        if (!result.ok) throw new Error(result.message || "上传失败");
        var item = result.data.items && result.data.items[0];
        if (!item || !/^\/uploads\/|^https?:\/\//.test(item.url)) throw new Error("上传接口未返回有效图片地址");
        var range = job.mark.find();
        if (!range) { remove(job); return; } // 占位已被用户删除，不再插回正文
        var alt = (item.alt || job.file.name || "image").replace(/[\\[\]\r\n]/g, " ");
        var url = item.url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
        job.mark.clear();
        cm.replaceRange("![" + alt + "](" + url + ")", range.from, range.to, "+input");
        job.cancelled = true;
        job.row.remove();
        jobs = jobs.filter(function (entry) { return entry !== job; });
        panel.hidden = !jobs.length;
        notify("图片已上传并插入");
      } catch (error) {
        if (job.cancelled) return;
        job.row.classList.add("is-error");
        job.label.textContent = job.file.name + " · " + error.message;
        job.progress.hidden = true;
        job.retry.hidden = false;
        notify("图片上传失败，可点击重试");
      } finally { job.busy = false; }
    }
    function enqueue(files, position) {
      if (cm.getOption("readOnly")) { notify("请切换到编辑模式后上传图片"); return; }
      if (position) cm.setCursor(position);
      files.forEach(function (file) {
        if (!allowed.test(file.type) || file.size > 5 * 1024 * 1024 || !file.size) {
          notify("仅支持 png/jpg/gif/webp/svg，单张图片须大于 0 且不超过 5MB"); return;
        }
        var token = "<!-- 图片上传中: " + Date.now() + "-" + (++sequence) + " -->";
        // 不覆盖选中文章内容；每张图片独占一行，markText 随后续输入移动。
        var at = cm.getCursor("to");
        var prefix = at.ch ? "\n\n" : "";
        cm.replaceRange(prefix + token + "\n\n", at, at, "+input");
        var from = prefix ? { line: at.line + 2, ch: 0 } : at;
        var mark = cm.markText(from, { line: from.line, ch: from.ch + token.length }, {});
        var row = document.createElement("div"); row.className = "upload-placeholder";
        var label = document.createElement("span");
        var progress = document.createElement("progress"); progress.setAttribute("aria-label", "图片上传中");
        var retry = document.createElement("button"); retry.type = "button"; retry.textContent = "重试";
        var cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "移除";
        row.append(label, progress, retry, cancel); panel.appendChild(row); panel.hidden = false;
        var job = { file: file, mark: mark, row: row, label: label, progress: progress, retry: retry };
        jobs.push(job);
        retry.addEventListener("click", function () { run(job); });
        cancel.addEventListener("click", function () { remove(job); });
        cm.setCursor({ line: from.line + 2, ch: 0 });
        run(job);
      });
    }
    cm.getInputField().addEventListener("paste", function (event) {
      var data = event.clipboardData;
      var files = Array.prototype.slice.call((data && data.items) || [])
        .filter(function (item) { return item.kind === "file" && item.type.indexOf("image/") === 0; })
        .map(function (item) { return item.getAsFile(); }).filter(Boolean);
      if (!files.length) return;
      event.preventDefault(); event.stopPropagation(); enqueue(files);
    }, true);
    var wrapper = cm.getWrapperElement();
    wrapper.addEventListener("dragover", function (event) {
      if (Array.prototype.indexOf.call(event.dataTransfer.types, "Files") < 0) return;
      event.preventDefault(); event.dataTransfer.dropEffect = "copy";
    });
    wrapper.addEventListener("drop", function (event) {
      var files = Array.prototype.slice.call(event.dataTransfer.files || []);
      if (!files.length) return;
      event.preventDefault(); event.stopPropagation();
      enqueue(files, cm.coordsChar({ left: event.clientX, top: event.clientY }, "window"));
    }, true);
    picker.addEventListener("change", function () { enqueue(Array.prototype.slice.call(picker.files)); picker.value = ""; });
    return {
      pick: function () { if (!cm.getOption("readOnly")) picker.click(); },
      pending: function () { return jobs.length > 0; },
      reset: function () { jobs.slice().forEach(remove); }
    };
  }

  /* ---------------- 主入口 ---------------- */
  function mount(textarea, opts) {
    opts = opts || {};
    if (!supported || !textarea) return null;

    var cm = HyperMD.fromTextArea(textarea, {
      mode: "hypermd",
      theme: "hypermd-light",
      lineNumbers: false,
      lineWrapping: true,
      autofocus: false,
      foldGutter: true,
      gutters: ["CodeMirror-foldgutter"],
      /* HyperMD 折叠渲染：图片/链接/代码块即时渲染，光标进入显示源码 */
      hmdFold: { image: true, link: true, math: false, html: false, emoji: false, code: true },
      /* Enter 延续列表/引用、Tab 缩进（keyMap 叠加在默认键位上） */
      keyMap: "hypermd",
      extraKeys: (function () {
        var keys = {
          "Ctrl-B": function () { COMMANDS.bold(cm); },
          "Cmd-B":  function () { COMMANDS.bold(cm); },
          "Ctrl-I": function () { COMMANDS.italic(cm); },
          "Cmd-I":  function () { COMMANDS.italic(cm); },
          "Ctrl-K": function () { COMMANDS.link(cm); },
          "Cmd-K":  function () { COMMANDS.link(cm); },
          "Ctrl-Shift-Z": "redo",
          "Cmd-Shift-Z":  "redo",
          "Ctrl-S": function () { if (opts.onSave) opts.onSave(); },
          "Cmd-S":  function () { if (opts.onSave) opts.onSave(); }
        };
        for (var n = 1; n <= 6; n++) {
          (function (level) {
            keys["Ctrl-" + level] = function () { setHeading(cm, level); };
            keys["Cmd-" + level]  = function () { setHeading(cm, level); };
          })(n);
        }
        Object.keys(keys).forEach(function (key) {
          var command = keys[key];
          if (typeof command === "function" && key !== "Ctrl-S" && key !== "Cmd-S") {
            keys[key] = function () { if (!cm.getOption("readOnly")) command(); };
          }
        });
        return keys;
      })()
    });

    /* 内容变化：同步回 textarea（admin.js 的 collectPayload 读 textarea.value），
     * 并派发 input 事件，复用既有「脏标记 → 防抖 → 自动保存」链路 */
    cm.on("change", function () {
      cm.save(); // 写回 textarea.value
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      if (typeof opts.onChange === "function") opts.onChange();
    });

    var uploads = bindImageUploads(cm);
    var view = "wysiwyg";

    var handle = {
      cm: cm,
      getValue: function () { return cm.getValue(); },
      setValue: function (v) {
        uploads.reset();
        // 先清理折叠 widget 标记，避免 HyperMD fold 插件在全文替换后引用过期坐标崩溃
        try { cm.getAllMarks().forEach(function (m) { m.clear(); }); } catch (e) {}
        cm.setValue(v || "");
        cm.save();
      },
      focus: function () { cm.focus(); },
      exec: function (cmd) {
        if (view === "preview") return;
        if (cmd === "upload") uploads.pick();
        else if (COMMANDS[cmd]) COMMANDS[cmd](cm);
      },
      hasUploads: uploads.pending,
      setMode: function (mode) {
        view = mode;
        var scroll = cm.getScrollInfo(), selection = cm.listSelections();
        if (mode === "source") HyperMD.switchToNormal(cm);
        else HyperMD.switchToHyperMD(cm);
        cm.setOption("readOnly", mode === "preview" ? "nocursor" : false);
        cm.setOption("lineNumbers", mode === "source");
        cm.getWrapperElement().classList.toggle("is-preview", mode === "preview");
        cm.setSelections(selection);
        cm.refresh(); cm.scrollTo(scroll.left, scroll.top);
        if (mode !== "preview") cm.focus();
      },
      insertImage: function (url, alt) { insertImageMd(cm, url, alt); },
      refresh: function () { cm.refresh(); }
    };
    textarea._wbEditor = handle;
    return handle;
  }

  window.WBEditor = { supported: supported, mount: mount, COMMANDS: COMMANDS };
})();
