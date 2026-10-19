"""全局配置：所有项均可通过 WB_* 环境变量覆盖（见 README「配置说明」）。"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent  # backend/
ROOT_DIR = BASE_DIR.parent                          # 仓库根目录


def _bool(name: str, default: str) -> bool:
    return os.getenv(name, default).lower() in ("1", "true", "yes", "on")


class Settings:
    # 服务
    HOST: str = os.getenv("WB_HOST", "127.0.0.1")
    PORT: int = int(os.getenv("WB_PORT", "8310"))
    DEBUG: bool = _bool("WB_DEBUG", "false")
    # 允许的跨域来源（逗号分隔）。默认空 = 仅同源，生产推荐保持为空
    CORS_ORIGINS: list[str] = [o.strip() for o in os.getenv("WB_CORS_ORIGINS", "").split(",") if o.strip()]
    # 站点对外地址，用于 RSS / sitemap / 分享链接（如 https://blog.example.com）
    SITE_URL: str = os.getenv("WB_SITE_URL", "").rstrip("/")

    # 安全
    SECRET: str = os.getenv("WB_SECRET", "dev-secret-change-me-in-prod")
    ACCESS_TTL: int = int(os.getenv("WB_ACCESS_TTL", str(2 * 3600)))       # Access Token 2h（前端静默刷新）
    REFRESH_TTL: int = int(os.getenv("WB_REFRESH_TTL", str(14 * 86400)))   # Refresh Token 14d
    DEMO_TOTP: bool = _bool("WB_DEMO_TOTP", "true")                        # 演示模式：任意 6 位数字通过
    ADMIN_PASSWORD: str = os.getenv("WB_ADMIN_PASSWORD", "admin123")       # 首次建库时 admin 初始密码
    LOGIN_MAX_FAILS: int = int(os.getenv("WB_LOGIN_MAX_FAILS", "5"))
    LOGIN_LOCK_MINUTES: int = int(os.getenv("WB_LOGIN_LOCK_MINUTES", "15"))

    # 数据
    DB_PATH: str = os.getenv("WB_DB", str(BASE_DIR / "wangblog.db"))
    SEED_DIR: Path = Path(os.getenv("WB_SEED_DIR", str(BASE_DIR / "seed")))
    SEED_DEMO: bool = _bool("WB_SEED_DEMO", "true")  # 空库时是否导入演示文章

    # 前端：后端可直接托管 web/ 目录（单进程即可完整运行；生产也可交给 nginx）
    WEB_DIR: Path = Path(os.getenv("WB_WEB_DIR", str(ROOT_DIR / "web")))
    SERVE_WEB: bool = _bool("WB_SERVE_WEB", "true")

    # 上传（生产可替换为 OSS/MinIO，见 routers_admin.upload）
    UPLOAD_DIR: Path = Path(os.getenv("WB_UPLOAD_DIR", str(BASE_DIR / "uploads")))
    UPLOAD_MAX_BYTES: int = int(os.getenv("WB_UPLOAD_MAX_BYTES", str(5 * 1024 * 1024)))  # 5MB

    # 限流
    SEARCH_RATE_PER_MINUTE: int = int(os.getenv("WB_SEARCH_RATE", "30"))
    COMMENT_RATE_PER_HOUR: int = int(os.getenv("WB_COMMENT_RATE", "5"))
    COMMENT_AUTO_APPROVE: bool = _bool("WB_COMMENT_AUTO_APPROVE", "false")  # 未命中风控的评论是否免审

    # 看板 / 发布
    CERT_DAYS: int = int(os.getenv("WB_CERT_DAYS", "60"))                  # 证书剩余天数（生产由监控注入）
    PUBLISH_STEP_DELAY: float = float(os.getenv("WB_PUBLISH_STEP_DELAY", "0.25"))  # 发布流水线每步展示间隔（秒）
    SCHEDULER_INTERVAL: int = int(os.getenv("WB_SCHEDULER_INTERVAL", "30"))        # 定时发布扫描间隔（秒）


settings = Settings()
