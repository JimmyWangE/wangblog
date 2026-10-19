"""认证 API——架构文档 §5.3 #9-#11：密码步 → TOTP 步 → 令牌刷新。

流程对齐前端 admin/login.html：
  密码错误 → 40103；连续 5 次 → 锁定 15 分钟（42301 + retryAfter，前端倒计时）
  密码正确 → 返回 ticket（5 分钟有效）→ 任意 6 位 TOTP（演示模式）→ 双令牌
"""
import time

from fastapi import APIRouter
from pydantic import BaseModel

from . import db
from .helpers import ERR_LOGIN_FAILED, ERR_LOCKED, ERR_PARAM, ERR_UNAUTHORIZED, ok, raise_err
from .security import (check_locked, clear_login_fails, consume_ticket, decode_token, issue_ticket,
                       issue_tokens, record_login_fail, revoke_refresh, verify_password, verify_totp)

router = APIRouter(prefix="/api/auth", tags=["认证"])


class LoginIn(BaseModel):
    username: str
    password: str


class TotpIn(BaseModel):
    ticket: str
    code: str


class RefreshIn(BaseModel):
    refreshToken: str


@router.post("/login")
def login(body: LoginIn):
    username = (body.username or "").strip()
    if not username or not body.password:
        raise_err(ERR_PARAM, "用户名与密码不能为空")
    user = db.q1("SELECT * FROM users WHERE username=?", (username,))

    if user:
        left = check_locked(user)
        if left:
            raise_err(ERR_LOCKED, f"已连续 {5} 次失败，账户锁定中", {"retryAfter": left})

    if not user or not verify_password(body.password, user["password_hash"]):
        if user:
            locked_for = record_login_fail(user)
            if locked_for:
                return_error = {"retryAfter": locked_for}
                raise_err(ERR_LOCKED, "已连续 5 次失败，账户锁定 15 分钟", return_error)
        raise_err(ERR_LOGIN_FAILED, "用户名或密码错误")

    clear_login_fails(user["id"])
    db.exec_("INSERT INTO audit_logs(user_id,action,detail,created_at) VALUES(?,?,?,?)",
             (user["id"], "login.password", "密码校验通过，进入 TOTP", db.now()))
    return ok({"ticket": issue_ticket(user["id"]), "ticketExpiresIn": 300, "next": "totp"})


@router.post("/totp")
def totp(body: TotpIn):
    # 先消费票据（一次性，防重放与爆破），再校验动态码
    user_id = consume_ticket(body.ticket)
    if not user_id:
        raise_err(ERR_UNAUTHORIZED, "登录票据已过期，请重新登录")
    code = (body.code or "").strip()
    if not code.isdigit() or len(code) != 6:
        raise_err(ERR_PARAM, "请输入 6 位动态码", {"field": "code"})
    user = db.q1("SELECT * FROM users WHERE id=?", (user_id,))
    if not user or not verify_totp(user, code):
        raise_err(ERR_LOGIN_FAILED, "动态码错误")
    db.exec_("INSERT INTO audit_logs(user_id,action,detail,created_at) VALUES(?,?,?,?)",
             (user_id, "login.success", "TOTP 通过", db.now()))
    return ok(issue_tokens(user["id"], user["username"]))


@router.post("/refresh")
def refresh(body: RefreshIn):
    payload = decode_token(body.refreshToken, "refresh")
    if not payload:
        raise_err(ERR_UNAUTHORIZED, "刷新令牌无效或已过期")
    user = db.q1("SELECT * FROM users WHERE id=?", (payload["sub"],))
    if not user:
        raise_err(ERR_UNAUTHORIZED, "用户不存在")
    revoke_refresh(payload["jti"])  # 轮换：旧 refresh 立即失效
    return ok(issue_tokens(user["id"], user["username"]))
