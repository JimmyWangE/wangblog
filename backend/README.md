# 向明笔记 · 后端服务（Python / FastAPI）

实现 `deliverables/backend-design/backend-architecture.md` 定义的全部模块与 23 个接口。
数据契约与前端 `prototype/assets/js/api.js` 的 `WBApi` 方法一一对应——**前端只需把 `ENDPOINTS`
指向本服务即可联调，页面代码零改动**。

## 快速开始

| 平台 | 方式 |
|---|---|
| Windows | 双击 `start.bat`（环境检查 → 依赖确认 → 启动，含日志与异常提示） |
| macOS / Linux | `bash start.sh` |

启动后：

- API 根地址：`http://127.0.0.1:8310`
- 交互式接口文档（Swagger）：`http://127.0.0.1:8310/docs`
- 健康检查：`GET /api/health`
- 演示账号：`admin / admin123`（TOTP 步任意 6 位数字；输入 `wrong` 模拟失败，5 次锁定 15 分钟）

## 目录结构

```
backend/
├── app/
│   ├── main.py            # 应用装配：路由/中间件/异常处理/静态资源
│   ├── config.py          # 全部环境变量配置（见下表）
│   ├── db.py              # SQLite 访问层 + Schema + 种子数据导入（生产换 PostgreSQL）
│   ├── security.py        # PBKDF2 密码哈希、JWT 双令牌、TOTP、登录锁定
│   ├── services.py        # TTL 缓存、限流、反垃圾、进程内事件总线与异步 worker
│   ├── helpers.py         # 响应包络/错误码/分页/ETag/搜索高亮
│   ├── deps.py            # JWT 鉴权依赖、客户端 IP、幂等键
│   ├── routers_public.py  # 前台 API（#1-#8，无需鉴权）
│   ├── routers_auth.py    # 认证 API（#9-#11）
│   └── routers_admin.py   # 后台 API（#12-#23，需鉴权）
├── tests/test_integration.py  # 整体集成测试（逐一验证全部接口）
├── requirements.txt
├── start.bat / start.sh
└── uploads/               # 上传文件（生产替换为 OSS/MinIO）
```

## 配置说明（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WB_HOST` / `WB_PORT` | `127.0.0.1` / `8310` | 监听地址 |
| `WB_SECRET` | `dev-secret-...` | JWT 签名密钥，**生产必须修改** |
| `WB_DB` | `./wangblog.db` | SQLite 路径；换 PG 时替换 `app/db.py` 连接层 |
| `WB_SEED_DIR` | `../prototype/data` | 种子数据目录（首次启动自动导入） |
| `WB_DEMO_TOTP` | `true` | 演示模式任意 6 位数字通过；生产设 `false` 启用真实 TOTP 校验 |
| `WB_ACCESS_TTL` / `WB_REFRESH_TTL` | `7200` / `1209600` | 令牌有效期（秒） |
| `WB_LOGIN_MAX_FAILS` / `WB_LOGIN_LOCK_MINUTES` | `5` / `15` | 登录失败锁定策略 |
| `WB_SEARCH_RATE` / `WB_COMMENT_RATE` | `20` / `5` | 搜索（次/分钟/IP）与评论（条/小时/IP）限流 |
| `WB_UPLOAD_DIR` / `WB_UPLOAD_MAX_BYTES` | `./uploads` / `5242880` | 上传目录与大小限制 |
| `WB_CERT_DAYS` | `12` | 看板证书剩余天数（生产由监控注入） |
| `WB_PUBLISH_STEP_DELAY` | `0.3` | 发布流水线每步模拟耗时（秒） |

## 架构映射说明

| 架构文档设计 | 本实现 | 生产切换点 |
|---|---|---|
| PostgreSQL 16 | SQLite（同一 SQL 层） | 替换 `app/db.py` 连接与占位符 |
| Redis（L2 缓存/锁定/限流） | 进程内 `TTLCache` / 计数器 | `app/services.py` 接口不变，实现换 redis-py |
| RabbitMQ + worker | `asyncio.Queue` + 后台协程 | 事件名/载荷不变（`post.published` 等），换 aio-pika |
| Elasticsearch + IK | SQL `LIKE` + 服务端 `<mark>` 高亮 | 替换 `routers_public.search` 查询实现，响应契约不变 |
| OSS / MinIO | 本地 `uploads/` 目录 + StaticFiles | 替换 `routers_admin.uploads` 的写入为 put_object |
| 网关限流/WAF | 服务层兜底限流 | 生产在 APISIX/Kong 收口 |

## 集成测试

```bash
# 服务运行中执行：
python tests/test_integration.py            # 默认打 http://127.0.0.1:8310
WB_BASE=http://127.0.0.1:8310 python tests/test_integration.py
```

覆盖：健康检查、站点配置、文章列表/详情（含 ETag/304）、评论提交（关键词/频控/幂等）、
分类标签、搜索高亮与排序、事件采集、认证全流程（40103/42301 锁定/TOTP/刷新轮换）、
后台文章 CRUD、草稿版本、发布流水线、批量操作、上传（含 415/413）、评论审核联动、看板聚合。
