/* 登录：密码 → 二步验证（TOTP），失败锁定倒计时 */
import { auth_ } from "../../lib/api.js";
import { toast } from "../../lib/ui.js";
import { $, $$, html, mount, icon } from "../../lib/util.js";
import { adminState, go } from "../state.js";

export function loginView(root, ctx) {
  document.title = "登录 — 管理后台";
  const next = ctx.query.next && ctx.query.next.startsWith("/admin") && !ctx.query.next.startsWith("/admin/login") ? ctx.query.next : "/admin/";
  if (auth_.isLoggedIn()) { go(next, { replace: true }); return; }
  let ticket = null, lockTimer = null;

  mount(root, html`<div class="login"><div class="login__card">
    <span class="logo__mark" style="width:46px;height:46px;border-radius:14px;display:grid;place-items:center;color:#fff;font:800 20px var(--font-mono);background:var(--grad);box-shadow:var(--glow)">W</span>
    <h1 data-title>欢迎回来</h1><p class="sub" data-sub>登录 WangBlog 管理后台</p>
    <div class="login__steps"><i class="on"></i><i data-step2></i></div>
    <form data-pwd autocomplete="on">
      <label class="field"><span class="field__label">用户名</span><input class="input" name="username" autocomplete="username" value="admin" required></label>
      <label class="field"><span class="field__label">密码</span><input class="input" name="password" type="password" autocomplete="current-password" required autofocus></label>
      <div class="login__err" data-err></div>
      <button class="btn btn--primary btn--lg btn--block" type="submit">继续 ${icon("arrowRight")}</button>
    </form>
    <form data-otp hidden>
      <div class="otp">${Array.from({ length: 6 }, (_, i) => html`<input class="input" inputmode="numeric" maxlength="1" aria-label="第 ${i + 1} 位" data-d>`)}</div>
      <p class="field__hint" data-otp-hint>请输入身份验证器中的 6 位动态码</p>
      <div class="login__err" data-err2></div>
      <button class="btn btn--primary btn--lg btn--block" type="submit">验证并登录</button>
      <button class="btn btn--ghost btn--block" type="button" data-back>${icon("arrowLeft")}返回</button>
    </form>
    <p class="faint" style="margin-top:22px;font-size:12px;text-align:center"><a href="/" data-native>← 返回站点</a></p>
  </div></div>`);

  const pwd = $("[data-pwd]", root), otp = $("[data-otp]", root);
  const digits = $$("[data-d]", root);
  const err = $("[data-err]", root), err2 = $("[data-err2]", root);

  const lock = (secs) => {
    const btn = $("button[type=submit]", pwd);
    btn.disabled = true;
    clearInterval(lockTimer);
    const tick = () => {
      err.textContent = `尝试次数过多，账户已锁定，${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} 后重试`;
      if (--secs < 0) { clearInterval(lockTimer); btn.disabled = false; err.textContent = ""; }
    };
    tick(); lockTimer = setInterval(tick, 1000);
  };

  pwd.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("button[type=submit]", pwd);
    btn.classList.add("is-loading"); err.textContent = "";
    try {
      const d = await auth_.login(pwd.username.value.trim(), pwd.password.value);
      ticket = d.ticket;
      pwd.hidden = true; otp.hidden = false;
      $("[data-step2]", root).classList.add("on");
      $("[data-title]", root).textContent = "二步验证";
      $("[data-sub]", root).textContent = "为保障安全，请完成动态码验证";
      if (d.demoTotp) $("[data-otp-hint]", root).textContent = "演示模式：输入任意 6 位数字即可通过";
      digits[0].focus();
    } catch (ex) {
      if (ex.code === 42301) lock(ex.data.retryAfter || 900);
      else err.textContent = ex.message;
      pwd.password.select();
    }
    btn.classList.remove("is-loading");
  });

  digits.forEach((inp, i) => {
    inp.addEventListener("input", () => {
      inp.value = inp.value.replace(/\D/g, "").slice(-1);
      if (inp.value && i < 5) digits[i + 1].focus();
      if (digits.every((d) => d.value)) otp.requestSubmit();
    });
    inp.addEventListener("keydown", (e) => { if (e.key === "Backspace" && !inp.value && i > 0) digits[i - 1].focus(); });
    inp.addEventListener("paste", (e) => {
      const t = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 6);
      if (t.length) { e.preventDefault(); t.split("").forEach((c, j) => { if (digits[j]) digits[j].value = c; }); if (t.length === 6) otp.requestSubmit(); }
    });
  });

  otp.addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = digits.map((d) => d.value).join("");
    if (code.length !== 6) { err2.textContent = "请输入完整的 6 位动态码"; return; }
    const btn = $("button[type=submit]", otp);
    btn.classList.add("is-loading"); err2.textContent = "";
    try {
      await auth_.totp(ticket, code);
      adminState.user = await auth_.me().catch(() => ({ username: pwd.username.value }));
      toast("登录成功，欢迎回来", "success");
      go(next, { replace: true });
    } catch (ex) {
      err2.textContent = ex.message;
      digits.forEach((d) => { d.value = ""; });
      digits[0].focus();
      if (ex.code === 40101) { otp.hidden = true; pwd.hidden = false; err.textContent = ex.message; }
    }
    btn.classList.remove("is-loading");
  });
  $("[data-back]", root).addEventListener("click", () => { otp.hidden = true; pwd.hidden = false; $("[data-step2]", root).classList.remove("on"); });
  return () => clearInterval(lockTimer);
}
