# WangBlog · 向明笔记

个人技术博客，包含阅读前台、写作管理后台和 REST API。前端使用原生 HTML/CSS/JavaScript，无构建步骤；后端使用 FastAPI 与 SQLite。

## 功能

- 首页、文章详情、分类标签、归档、搜索、关于页面、评论审核。
- 后台双步骤登录、文章管理、回收站、草稿自动保存和发布任务状态展示。
- 基于 CodeMirror 5 + HyperMD 的类 Typora Markdown 编辑：即时排版、源码与只读预览切换、工具栏、常用快捷键。
- 图片复制粘贴、拖拽与文件选择上传；上传状态、失败重试；上传成功后以 Markdown 图片语法插入原位置。
- JWT 双令牌与过期刷新、访问统计、缓存和接口限流。

## 技术栈

| 层 | 实现 |
| --- | --- |
| 前端 | HTML / CSS / JavaScript；CodeMirror 5.65.18、HyperMD 0.3.11 本地依赖 |
| 后端 | Python 3.10+（服务器为 3.11）、FastAPI、uvicorn |
| 数据 | SQLite；图片保存在后端 uploads 目录 |
| 认证 | PyJWT、pyotp、PBKDF2 密码哈希 |
| 部署 | nginx 静态托管与反向代理、systemd |

## 目录

```text
wangblog/
├── README.md
├── .env.example                 # 配置模板，不包含生产凭据
├── deploy/                      # nginx 与 systemd 部署示例
├── backend/
│   ├── app/
│   │   ├── main.py              # 应用入口、路由和静态上传文件
│   │   ├── config.py            # WB_* 环境变量配置
│   │   ├── db.py                # 数据模型、连接与示例数据导入
│   │   ├── security.py          # 密码、JWT 与 TOTP
│   │   ├── routers_public.py   # 公开接口
│   │   ├── routers_web.py      # 前端数据兼容接口
│   │   ├── routers_auth.py     # 登录与刷新
│   │   └── routers_admin.py    # 管理、草稿、上传与发布
│   ├── tests/
│   ├── requirements.txt
│   └── start.sh / start.bat
└── prototype/
    ├── *.html                   # 阅读前台
    ├── admin/                   # 管理后台及文章编辑器
    ├── assets/js/               # api.js 为统一数据访问入口
    ├── assets/css/
    ├── assets/vendor/editor/    # 编辑器依赖
    ├── assets/config/site.json  # 站点文案配置
    └── data/                    # 演示数据和首次建库种子
```

数据库、用户上传图片、备份、虚拟环境及生产凭据不提交。首次启动数据库为空时，会从 `prototype/data/` 导入演示内容；仓库不包含线上文章数据库。

## 本地运行

```bash
git clone git@github.com:JimmyWangE/wangblog.git
cd wangblog
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -r backend/requirements.txt
cp .env.example .env
```

编辑 `.env` 设置开发配置，再启动后端：

```bash
set -a
. ./.env
set +a
cd backend
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8310
```

后端健康检查：`http://127.0.0.1:8310/api/health`；OpenAPI：`http://127.0.0.1:8310/docs`。

另开终端启动静态前端：

```bash
cd wangblog
python3 -m http.server 8080 --bind 127.0.0.1 --directory prototype
```

访问 `http://127.0.0.1:8080/` 可浏览演示模式。前端通过同源 `/api/health` 探测后端，因此单独的 8080 静态服务不会连接 8310；完整登录、保存和上传联调需按下一节配置 nginx，让静态页面、`/api/` 和 `/uploads/` 在同源访问。

## 部署

当前服务器布局为 `/opt/wangblog/{backend,prototype}`。参考 `deploy/nginx.conf.example` 和 `deploy/wangblog-backend.service.example`，按实际路径和用户调整。

- nginx webroot 指向 `prototype`。
- `/api/` 和 `/uploads/` 代理至 `127.0.0.1:8310`。
- 上传路径必须使用 `location ^~ /uploads/`，避免被图片扩展名静态规则覆盖而产生 404。
- 将环境配置放在服务器专用文件中并限制读取权限；systemd 示例从 `/etc/wangblog.env` 读取。
- 修改 JS/CSS 后同步更新 HTML 中资源的 `?v=`，避免旧资源缓存。
- 配置检查通过后平滑 reload nginx。修改后端才需要重启后端服务；重启会使内存中的 refresh 白名单与发布任务失效。
- 当前示例仅提供 HTTP；HTTPS 需配置域名、证书与 443 监听。

```bash
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now wangblog-backend
sudo systemctl reload nginx
```

## 配置与接口约定

完整变量见 `backend/app/config.py` 和 `backend/README.md`。主要变量：`WB_SECRET`、`WB_ADMIN_PASSWORD`、`WB_DEMO_TOTP`、`WB_DB`、`WB_UPLOAD_DIR`、`WB_PORT`。

- `.env` 不会被应用自动加载；使用上面的 shell 导出或 systemd `EnvironmentFile`。
- `WB_ADMIN_PASSWORD` 只影响首次建库的管理员种子，修改变量不会重置现有用户密码。
- 默认 TOTP 演示模式允许任意 6 位数字；生产启用真实校验前需先配置管理员的 TOTP 验证器。
- REST API 响应包络：`{code, message, data, requestId}`。
- 后台接口携带 `Authorization: Bearer <accessToken>`；由 `api.js` 处理刷新与重放。
- 图片上传：`POST /api/admin/uploads`，multipart 字段为 `files`；单张不超过 5MB，支持 png/jpg/gif/webp/svg；返回 `data.items[{url,alt}]`。
- 文章正文按 `contentMd` 保存，图片保留普通 Markdown URL，不需要转换历史文章。

## 测试与自测

请在独立测试数据库和本地服务上运行：接口测试会创建、发布、删除测试文章，不能直接对生产服务运行。

```bash
cd backend
.venv/bin/python tests/test_integration.py
.venv/bin/python tests/test_e2e_publish.py
```

测试脚本默认使用本地演示管理员与演示 TOTP；集成脚本支持 `WB_BASE`，发布闭环脚本固定连接 `127.0.0.1:8310`。运行前请阅读脚本并匹配测试配置。

编辑器自测：输入标题、列表、引用、代码块、表格与链接；切换三种视图；测试 Ctrl/⌘+B、I、K、S、1～6；粘贴/拖拽图片后确认上传和图片 GET 均为 200；模拟断网测试失败重试；保存刷新后检查内容不丢失。

## 当前实现边界

发布流水线中的 Git 推送、构建与 CDN 部署步骤目前为模拟状态，不会因为本仓库建立而自动变成真实 CI/CD。缓存、限流、发布任务、登录票据和 refresh 白名单仍在进程内。图片存储为服务器本地磁盘，数据库与 uploads 目录需另行备份。

本仓库初始代码从现有服务器同步，第三方编辑器文件保留原文件头中的版权信息。
