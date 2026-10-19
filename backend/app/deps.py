"""FastAPI 依赖：JWT 鉴权、客户端 IP、幂等键。"""
import json

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import db
from .helpers import ERR_UNAUTHORIZED, raise_err
from .security import decode_token

_bearer = HTTPBearer(auto_error=False)


def current_user(cred: HTTPAuthorizationCredentials | None = Depends(_bearer)) -> dict:
    if not cred:
        raise_err(ERR_UNAUTHORIZED, "未登录或令牌已过期")
    payload = decode_token(cred.credentials, "access")
    if not payload:
        raise_err(ERR_UNAUTHORIZED, "未登录或令牌已过期")
    user = db.q1("SELECT * FROM users WHERE id=?", (payload["sub"],))
    if not user:
        raise_err(ERR_UNAUTHORIZED, "用户不存在")
    return user


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def check_idempotency(key: str | None) -> dict | None:
    """命中幂等键 → 返回缓存的响应 data（防评论重复提交 / 发布重复触发，§5.1）。"""
    if not key:
        return None
    row = db.q1("SELECT response FROM idempotency_keys WHERE key=?", (key,))
    return json.loads(row["response"]) if row else None


def store_idempotency(key: str | None, data) -> None:
    if key:
        db.exec_("INSERT OR IGNORE INTO idempotency_keys(key,response,created_at) VALUES(?,?,?)",
                 (key, json.dumps(data, ensure_ascii=False), db.now()))
