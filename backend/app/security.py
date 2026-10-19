"""安全模块：密码哈希、JWT、TOTP、登录票据与锁定。

生产说明：密码哈希使用 stdlib PBKDF2-HMAC-SHA256（26 万次迭代）；
迁移 PostgreSQL/生产环境时建议替换为 Argon2id（架构文档 §4.2）。
"""
import base64
import hashlib
import hmac
import os
import time
import uuid
from datetime import datetime, timedelta

import jwt

from .config import settings
from . import db

_PBKDF2_ITERATIONS = 260_000
_tickets: dict[str, dict] = {}          # TOTP 临时票据（生产放 Redis，TTL 5min）
_refresh_whitelist: set[str] = set()    # Refresh Token jti 白名单（生产放 Redis）


# ---------------------------------------------------------------- 密码
def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _PBKDF2_ITERATIONS)
    return f"pbkdf2${_PBKDF2_ITERATIONS}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, iters, salt_b64, dk_b64 = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.b64decode(salt_b64), int(iters))
        return hmac.compare_digest(dk, base64.b64decode(dk_b64))
    except (ValueError, TypeError):
        return False


# ---------------------------------------------------------------- JWT
def issue_tokens(user_id: str, username: str) -> dict:
    now_ts = int(time.time())
    jti = uuid.uuid4().hex
    access = jwt.encode(
        {"sub": user_id, "username": username, "type": "access", "iat": now_ts, "exp": now_ts + settings.ACCESS_TTL},
        settings.SECRET, algorithm="HS256")
    refresh = jwt.encode(
        {"sub": user_id, "type": "refresh", "jti": jti, "iat": now_ts, "exp": now_ts + settings.REFRESH_TTL},
        settings.SECRET, algorithm="HS256")
    _refresh_whitelist.add(jti)
    return {"accessToken": access, "refreshToken": refresh, "expiresIn": settings.ACCESS_TTL}


def decode_token(token: str, expected_type: str = "access") -> dict | None:
    try:
        payload = jwt.decode(token, settings.SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    if payload.get("type") != expected_type:
        return None
    if expected_type == "refresh" and payload.get("jti") not in _refresh_whitelist:
        return None
    return payload


def revoke_refresh(jti: str) -> None:
    _refresh_whitelist.discard(jti)


# ---------------------------------------------------------------- 登录票据（密码步 → TOTP 步）
def issue_ticket(user_id: str) -> str:
    ticket = uuid.uuid4().hex
    _tickets[ticket] = {"user_id": user_id, "exp": time.time() + 300}  # 5 分钟有效
    return ticket


def consume_ticket(ticket: str) -> str | None:
    info = _tickets.pop(ticket, None)
    if not info or info["exp"] < time.time():
        return None
    return info["user_id"]


# ---------------------------------------------------------------- TOTP
def verify_totp(user: dict, code: str) -> bool:
    if settings.DEMO_TOTP:
        return code.isdigit() and len(code) == 6  # 演示模式：任意 6 位数字（对齐前端登录页提示）
    import pyotp
    return pyotp.TOTP(user["totp_secret"]).verify(code, valid_window=1)


# ---------------------------------------------------------------- 失败计数与锁定
def check_locked(user: dict) -> int | None:
    """返回剩余锁定秒数；未锁定返回 None。"""
    if not user.get("locked_until"):
        return None
    until = datetime.strptime(user["locked_until"], "%Y-%m-%d %H:%M:%S")
    left = (until - datetime.now()).total_seconds()
    return int(left) if left > 0 else None


def record_login_fail(user: dict) -> int | None:
    """记录一次失败；达到阈值则锁定并返回锁定时长（秒）。"""
    fails = (user.get("failed_attempts") or 0) + 1
    if fails >= settings.LOGIN_MAX_FAILS:
        until = datetime.now() + timedelta(minutes=settings.LOGIN_LOCK_MINUTES)
        db.exec_("UPDATE users SET failed_attempts=0, locked_until=?, updated_at=? WHERE id=?",
                 (until.strftime("%Y-%m-%d %H:%M:%S"), db.now(), user["id"]))
        return settings.LOGIN_LOCK_MINUTES * 60
    db.exec_("UPDATE users SET failed_attempts=?, updated_at=? WHERE id=?", (fails, db.now(), user["id"]))
    return None


def clear_login_fails(user_id: str) -> None:
    db.exec_("UPDATE users SET failed_attempts=0, locked_until=NULL, updated_at=? WHERE id=?", (db.now(), user_id))
