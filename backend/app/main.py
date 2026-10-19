"""应用入口：装配路由、中间件、静态资源与启动钩子。

运行：
  uvicorn app.main:app --host 127.0.0.1 --port 8310
  或直接 python -m app.main
"""
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import db
from .config import settings
from .helpers import ApiError, error_response
from .routers_admin import router as admin_router
from .routers_auth import router as auth_router
from .routers_public import router as public_router
from .routers_site import router as site_router, spa_response
from .services import start_workers


def _harden_legacy_accounts():
    """旧版种子数据曾创建固定口令的 reviewer 账号：检测到仍为默认口令时将其禁用。"""
    from .security import hash_password, verify_password
    r = db.q1("SELECT id, password_hash FROM users WHERE username='reviewer'")
    if r and verify_password("review123", r["password_hash"]):
        db.exec_("UPDATE users SET password_hash=?, updated_at=? WHERE id=?",
                 (hash_password(uuid.uuid4().hex + uuid.uuid4().hex), db.now(), r["id"]))
        print("[startup] 已禁用默认口令的 reviewer 账号")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    db.conn()
    db.seed_if_empty()
    _harden_legacy_accounts()
    n = db.rerender_outdated()
    workers = start_workers()
    print(f"[startup] db={settings.DB_PATH} rerendered={n} web={settings.WEB_DIR if settings.SERVE_WEB else 'off'}")
    if settings.SECRET.startswith("dev-secret"):
        print("[startup] ⚠ WB_SECRET 仍为默认值，生产环境务必修改")
    yield
    for w in workers:
        w.cancel()


app = FastAPI(title="向明笔记 API", version="2.0.0", lifespan=lifespan, docs_url="/docs", openapi_url="/openapi.json")

if settings.CORS_ORIGINS:
    app.add_middleware(CORSMiddleware, allow_origins=settings.CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def request_context(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    response.headers["X-Request-Id"] = uuid.uuid4().hex
    response.headers["X-Response-Time"] = f"{(time.time() - start) * 1000:.1f}ms"
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    path = request.url.path
    if path.startswith("/assets/vendor/") or path.startswith("/uploads/"):
        response.headers["Cache-Control"] = "public, max-age=2592000"
    elif path.startswith("/assets/"):
        response.headers["Cache-Control"] = "no-cache"  # ES 模块无构建指纹：靠 ETag 协商，部署即时生效
    elif path.startswith("/api/") and "cache-control" not in response.headers:
        response.headers["Cache-Control"] = "no-store"
    return response


@app.exception_handler(ApiError)
async def api_error_handler(request: Request, exc: ApiError):
    return error_response(exc)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    first = exc.errors()[0] if exc.errors() else {}
    field = ".".join(str(x) for x in first.get("loc", [])[1:])
    return JSONResponse(status_code=400, content={"code": 40001, "message": f"参数不合法：{field or '请求体'}",
                                                  "data": {"field": field}, "requestId": uuid.uuid4().hex})


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(request: Request, exc: StarletteHTTPException):
    path = request.url.path
    if exc.status_code == 404 and request.method == "GET" and settings.SERVE_WEB \
            and not path.startswith(("/api/", "/uploads/", "/assets/")):
        return spa_response(request, path.lstrip("/"))
    return JSONResponse(status_code=exc.status_code,
                        content={"code": exc.status_code * 100 + 1, "message": str(exc.detail), "data": {},
                                 "requestId": uuid.uuid4().hex})


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception):
    print(f"[error] {request.method} {request.url.path}: {exc!r}")
    return JSONResponse(status_code=500, content={
        "code": 50001, "message": "服务内部错误", "data": {}, "requestId": uuid.uuid4().hex})


@app.get("/api/health", tags=["系统"])
def health():
    post_count = db.q1("SELECT COUNT(*) AS c FROM posts")["c"]
    return {"code": 0, "message": "ok", "data": {"status": "up", "posts": post_count, "time": db.now()},
            "requestId": uuid.uuid4().hex}


app.include_router(public_router)
app.include_router(auth_router)
app.include_router(admin_router)
app.include_router(site_router)
settings.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(settings.UPLOAD_DIR)), name="uploads")

if settings.SERVE_WEB and settings.WEB_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(settings.WEB_DIR / "assets")), name="assets")

    @app.get("/", include_in_schema=False)
    def index(request: Request):
        return spa_response(request, "")

    @app.get("/favicon.svg", include_in_schema=False)
    @app.get("/favicon.ico", include_in_schema=False)
    def favicon():
        return FileResponse(settings.WEB_DIR / "favicon.svg", media_type="image/svg+xml")

    @app.get("/admin", include_in_schema=False)
    @app.get("/admin/", include_in_schema=False)
    def admin_index(request: Request):
        return spa_response(request, "admin")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host=settings.HOST, port=settings.PORT, reload=settings.DEBUG)
