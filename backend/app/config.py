"""全局配置：所有项均可通过环境变量覆盖（见 README「配置说明」）。"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent  # backend/


class Settings:
    # 服务
    HOST: str = os.getenv("WB_HOST", "127.0.0.1")
    PORT: int = int(os.getenv("WB_PORT", "8310"))
    DEBUG: bool = os.getenv("WB_DEBUG", "false").lower() == "true"

    # 安全
    SECRET: str = os.getenv("WB_SECRET", "dev-secret-change-me-in-prod")
    ACCESS_TTL: int = int(os.getenv("WB_ACCESS_TTL", str(12 * 3600)))      # Access Token 12h（编辑场景；过期由前端静默刷新）
    REFRESH_TTL: int = int(os.getenv("WB_REFRESH_TTL", str(14 * 86400)))   # Refresh Token 14d
    DEMO_TOTP: bool = os.getenv("WB_DEMO_TOTP", "true").lower() == "true"  # 演示模式：任意 6 位数字通过
    ADMIN_PASSWORD: str = os.getenv("WB_ADMIN_PASSWORD", "admin123")       # 首次建库时 admin 初始密码
    LOGIN_MAX_FAILS: int = int(os.getenv("WB_LOGIN_MAX_FAILS", "5"))
    LOGIN_LOCK_MINUTES: int = int(os.getenv("WB_LOGIN_LOCK_MINUTES", "15"))

    # 数据
    DB_PATH: str = os.getenv("WB_DB", str(BASE_DIR / "wangblog.db"))
    SEED_DIR: Path = Path(os.getenv("WB_SEED_DIR", str(BASE_DIR.parent / "prototype" / "data")))
    SITE_SEED: Path = Path(os.getenv("WB_SITE_SEED", str(BASE_DIR.parent / "prototype" / "assets" / "config" / "site.json")))

    # 上传（生产环境替换为 OSS/MinIO，见 routers_admin.uploads 注释）
    UPLOAD_DIR: Path = Path(os.getenv("WB_UPLOAD_DIR", str(BASE_DIR / "uploads")))
    UPLOAD_MAX_BYTES: int = int(os.getenv("WB_UPLOAD_MAX_BYTES", str(5 * 1024 * 1024)))  # 5MB

    # 限流
    SEARCH_RATE_PER_MINUTE: int = int(os.getenv("WB_SEARCH_RATE", "20"))
    COMMENT_RATE_PER_HOUR: int = int(os.getenv("WB_COMMENT_RATE", "5"))

    # 看板/发布
    CERT_DAYS: int = int(os.getenv("WB_CERT_DAYS", "12"))                  # 证书剩余天数（生产由 blackbox 探测注入）
    PUBLISH_STEP_DELAY: float = float(os.getenv("WB_PUBLISH_STEP_DELAY", "0.3"))  # 发布流水线每步耗时（秒）


settings = Settings()
