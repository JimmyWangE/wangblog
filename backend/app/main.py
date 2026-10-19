"""应用入口：装配路由、中间件、静态资源与启动钩子。

运行：
  uvicorn app.main:app --host 127.0.0.1 --port 8310
  或直接 python -m app.main
"""
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .config import settings
from .helpers import ApiError, error_response
from .routers_admin import router as admin_router
from .routers_auth import router as auth_router
from .routers_public import router as public_router
from .routers_web import router as web_router
from .services import start_workers


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    db.conn()
    db.seed_if_empty()
    worker = start_workers()
    print(f"[startup] db={settings.DB_PATH}")
    print(f"[startup] seed ok, upload dir={settings.UPLOAD_DIR}")
    yield
    worker.cancel()


app = FastAPI(title="向明笔记 API", version="1.0.0", lifespan=lifespan,
              docs_url="/docs", openapi_url="/openapi.json")

app.add_middleware(
    CORSMiddleware,  # 开发环境放开跨域；生产由网关统一收口
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def request_context(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    response.headers["X-Request-Id"] = uuid.uuid4().hex
    response.headers["X-Response-Time"] = f"{(time.time() - start) * 1000:.1f}ms"
    return response


@app.exception_handler(ApiError)
async def api_error_handler(request: Request, exc: ApiError):
    return error_response(exc)


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception):
    return JSONResponse(status_code=500, content={
        "code": 50001, "message": "服务内部错误", "data": {}, "requestId": uuid.uuid4().hex})


@app.get("/api/health", tags=["系统"])
def health():
    post_count = db.q1("SELECT COUNT(*) AS c FROM posts")["c"]
    return {"code": 0, "message": "ok",
            "data": {"status": "up", "posts": post_count, "time": db.now()},
            "requestId": uuid.uuid4().hex}


app.include_router(public_router)
app.include_router(web_router)
app.include_router(auth_router)
app.include_router(admin_router)
settings.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)  # StaticFiles 在装配期即校验目录存在
app.mount("/uploads", StaticFiles(directory=str(settings.UPLOAD_DIR)), name="uploads")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host=settings.HOST, port=settings.PORT, reload=settings.DEBUG)
