# WangBlog · 向明笔记

个人技术博客：深色科技风的阅读前台、Typora 式所见即所得的写作后台，以及 FastAPI + SQLite 的 REST 后端。
前端为**无构建步骤**的原生 ES Module 单页应用，后端一条命令即可同时提供 API 与页面。

![stack](https://img.shields.io/badge/FastAPI-SQLite-6366f1) ![stack](https://img.shields.io/badge/前端-原生%20ES%20Modules%20SPA-22d3ee) ![stack](https://img.shields.io/badge/编辑器-Vditor%20IR-c084fc)

## 亮点

**写作体验（后台编辑器）**

- 基于本地构建的 Vditor：默认「即时渲染」模式——像 Typora 一样，光标所在块显示 Markdown 标记、离开即渲染；可一键切换「所见即所得」「分屏预览」，内容零丢失。
- 大标题输入区 + 极简文档栏、可隐藏工具栏、大纲、专注模式（F8，仅高亮当前段落）、深浅主题同步。
- 停笔 1.2 秒自动保存；本地灾备（断网/崩溃后可恢复）；多窗口编辑冲突检测（乐观锁）；`Ctrl/⌘+S` 手动保存。
- 图片粘贴、拖拽、选择上传，自动插入 Markdown；服务端校验真实文件类型。
- 文章设置侧栏：slug、分类（可新建）、标签输入与推荐、摘要、渐变封面、置顶。
- 历史版本（预览 / 一键恢复）、「发布效果」预览（与前台完全一致的服务端渲染）、立即 / 定时发布与发布流水线进度。
- 支持代码高亮、表格、任务列表、脚注、KaTeX 公式、Mermaid 图表。

**阅读体验（前台）**

- 全站单页应用：History 路由、页面切换无整页刷新、View Transitions 动效、悬停预取、请求缓存（SWR）。
- 首页：粒子网络 Hero、打字机、终端风格「最新文章」、数据计数动画、置顶精选、分类筛选 + 无限滚动、热门 / 标签云 / 最新评论侧栏。
- 文章页：阅读进度、目录跟随高亮、代码一键复制、长代码折叠、图片灯箱、公式与图表懒加载、点赞、上下篇、相关推荐。
- 评论：无刷新提交与回复（两级楼中楼）、Markdown 安全子集、蜜罐 + 频控 + 关键词风控、先审后发。
- 归档时间线（分类 / 标签筛选可分享）、分类与标签总览、`⌘K` / `/` 全局搜索面板与搜索页。
- 深色为默认主题，可切换浅色；桌面与移动端响应式。
- SEO：后端为文章路由注入 title / description / OG / JSON-LD；RSS（全文）、sitemap、robots。

**后台管理**

- 仪表盘（PV/UV、30 天趋势图、分类分布、热门、草稿、定时、操作动态、安全告警）。
- 文章表格：状态页签、全文搜索、分类筛选、批量发布 / 设分类 / 加标签 / 撤回 / 删除、置顶、回收站与彻底删除。
- 评论审核：待审 / 已通过 / 垃圾，作者身份回复。分类与标签管理（标签重命名即合并）。站点设置（站点信息、首页文案、作者资料、友链、修改密码）。

## 目录

```text
wangblog/
├── backend/
│   ├── app/
│   │   ├── main.py            # 应用装配、中间件、缓存头、SPA 回退
│   │   ├── config.py          # WB_* 环境变量
│   │   ├── db.py              # Schema、增量迁移、渲染缓存、种子导入
│   │   ├── markdown.py        # Markdown → HTML（目录、Pygments 高亮、公式、图表、字数）
│   │   ├── routers_public.py  # 前台 API
│   │   ├── routers_admin.py   # 后台 API
│   │   ├── routers_auth.py    # 登录 / 二步验证 / 刷新 / 登出
│   │   ├── routers_site.py    # RSS、sitemap、robots、页面 meta 注入
│   │   ├── services.py        # 缓存、限流、事件总线、发布流水线、定时发布
│   │   └── security.py        # PBKDF2、JWT、TOTP、登录锁定
│   ├── seed/                  # 演示数据：posts/*.md、comments.json、site.json
│   ├── tests/test_api.py      # 进程内接口测试（临时库）
│   └── start.sh / start.bat
├── web/                       # 前端（nginx 或后端直接托管）
│   ├── index.html             # 前台 SPA 外壳
│   ├── admin/index.html       # 后台 SPA 外壳
│   └── assets/
│       ├── css/               # base（设计令牌）· site · prose（正文）· admin
│       ├── js/lib/            # api · router · ui · util · enhance
│       ├── js/site/           # 前台入口与视图
│       ├── js/admin/          # 后台入口、视图与 editor.js
│       └── vendor/vditor/     # 编辑器与 KaTeX / Mermaid / highlight.js（本地化，不依赖 CDN）
└── deploy/                    # nginx 与 systemd 示例
```

## 本地运行

```bash
git clone git@github.com:JimmyWangE/wangblog.git
cd wangblog/backend
bash start.sh            # Windows 双击 start.bat
```

脚本会创建虚拟环境、安装依赖并启动。打开：

- 前台：<http://127.0.0.1:8310/>
- 后台：<http://127.0.0.1:8310/admin/>（演示账号 `admin / admin123`，二步验证输入任意 6 位数字）
- 接口文档：<http://127.0.0.1:8310/docs>

首次启动且数据库为空时，会从 `backend/seed/` 导入演示文章（`WB_SEED_DEMO=false` 可关闭）。

手动方式：

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
cp .env.example .env && set -a && . ./.env && set +a
cd backend && .venv/bin/python -m uvicorn app.main:app --port 8310
```

## 部署

参考 `deploy/nginx.conf.example` 与 `deploy/wangblog-backend.service.example`，布局为 `/opt/wangblog/{backend,web}`：

- nginx 直接返回 `/assets/`（vendor 长缓存、业务模块协商缓存）；其余路径代理到后端，由后端负责 SPA 回退与页面 meta 注入。
- 环境变量放在 `/etc/wangblog.env`（`chmod 600`），至少设置 `WB_SECRET`（≥32 位随机串）、`WB_DEMO_TOTP=false`、`WB_SITE_URL`。
- 生产启用真实 TOTP 前，请先把管理员的 `totp_secret` 配置到验证器（或保持演示模式但务必使用强密码）。
- 修改前端无需重启；修改后端需 `systemctl restart wangblog-backend`。

### 从旧版升级

1. 目录 `prototype/` 已更名为 `web/`：更新 nginx `root` 与 systemd（`WB_WEB_DIR`），或直接使用新的示例配置。
2. 数据库**无需手工迁移**：启动时自动补齐新列、按新渲染器重新生成所有文章的 HTML 与目录；旧文章若只有预渲染 HTML 也会原样保留。
3. 旧版地址 `post.html?slug=xxx`、`archive.html` 等会被前台自动重定向到新路由。
4. 旧版种子中的 `reviewer / review123` 账号若仍为默认口令，启动时会被自动禁用。

## 配置

后台侧栏的 **RSS 与首页** 打开统一设置表单（`/admin/rss`）。在这里可修改站点名称与描述、首页标题与简介、作者资料、GitHub 地址及邮箱，以及 RSS 的语言、文章数量和全文/摘要模式。保存后刷新首页即可看到文案和图标链接变化，`/rss.xml` 与 `/feed` 同步更新。留空 GitHub 或邮箱可隐藏对应图标。

RSS 标题与简介沿用站点名称和描述；GitHub 使用 Atom related link，邮箱使用 RSS managingEditor，首页文案以 `urn:wangblog:site` 命名空间扩展输出。订阅文章来自已发布文章。所有配置统一保存在现有站点设置中，无需手工维护 XML 文件。

完整说明见 `backend/app/config.py`。常用：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WB_SECRET` | 开发默认值 | JWT 签名密钥，生产必须修改 |
| `WB_DB` | `backend/wangblog.db` | SQLite 路径 |
| `WB_UPLOAD_DIR` | `backend/uploads` | 图片目录（需备份） |
| `WB_SITE_URL` | 空 | 站点外部地址，用于 RSS / sitemap |
| `WB_DEMO_TOTP` | `true` | 演示模式：任意 6 位数字通过二步验证 |
| `WB_SERVE_WEB` / `WB_WEB_DIR` | `true` / `../web` | 后端是否托管前端 |
| `WB_COMMENT_AUTO_APPROVE` | `false` | 未触发风控的评论免审 |
| `WB_CORS_ORIGINS` | 空（仅同源） | 逗号分隔的跨域白名单 |

## 测试

```bash
cd backend
.venv/bin/python tests/test_api.py      # 或 .venv/bin/python -m pytest tests -q
```

测试在进程内运行，使用临时数据库与上传目录，不会影响任何真实数据。

## 技术说明

- 文章以 Markdown（`content_md`）为唯一事实源；保存时服务端渲染为 HTML 并缓存（`content_html` / `toc`），读者端无需 Markdown 解析器，代码高亮由 Pygments 在服务端完成。
- 前端没有打包步骤：直接以 ES Module 加载，修改即生效；第三方库全部本地化在 `web/assets/vendor/`，国内网络无需访问 CDN。
- `web/assets/vendor/vditor` 由 [Vditor](https://github.com/Vanessa219/vditor)（MIT）源码构建，保留其许可证。
- 缓存、限流、发布任务、登录票据在进程内；refresh 令牌白名单持久化在数据库中，重启不会掉线。
