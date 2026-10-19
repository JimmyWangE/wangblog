# WangBlog 后端（FastAPI）

总体说明、部署与配置见仓库根目录 `README.md`。本文件列出接口一览。

所有接口返回统一包络 `{code, message, data, requestId}`，`code = 0` 表示成功。后台接口需 `Authorization: Bearer <accessToken>`。
交互式文档：启动后访问 `/docs`。

## 前台（无需登录）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/site/config` | 站点配置（文案、作者、友链） |
| GET | `/api/home` | 首页聚合：置顶、热门、最新评论、分类、标签、统计 |
| GET | `/api/posts?page&pageSize&category&tag&year&sort&excludePinned` | 文章列表 |
| GET | `/api/posts/{slug}` | 文章详情（HTML、目录、上下篇、相关），支持 ETag |
| GET / POST | `/api/posts/{slug}/comments` | 评论树 / 提交评论（`parentId` 回复） |
| POST | `/api/posts/{slug}/like` | 点赞 / 取消点赞 |
| GET | `/api/taxonomy` | 分类、标签、年份与全站统计 |
| GET | `/api/archive?category&tag` | 按年份分组的归档 |
| GET | `/api/search?q` | 多关键词搜索，结果带 `<mark>` 高亮 |
| POST | `/api/events` | 阅读事件（view / read_finish） |
| GET | `/rss.xml`、`/sitemap.xml`、`/robots.txt` | 订阅与搜索引擎 |

## 认证

`POST /api/auth/login` → `POST /api/auth/totp` → 获得双令牌；`POST /api/auth/refresh` 轮换；`POST /api/auth/logout`；`GET /api/auth/me`。
连续失败 5 次锁定 15 分钟（`42301`，`data.retryAfter` 为剩余秒数）。

## 后台

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/dashboard` | 看板聚合 |
| GET / POST | `/api/admin/posts` | 列表（`status`、`q`、`category`、`tag`）/ 新建 |
| GET | `/api/admin/posts/{id}` | 编辑器初始化数据 |
| PUT | `/api/admin/posts/{id}/draft` | 保存正文与元数据（`baseUpdatedAt` 乐观锁，冲突 `40902`） |
| POST | `/api/admin/posts/{id}/publish` | 立即 / 定时发布，返回 `taskId` |
| GET | `/api/admin/tasks/{taskId}` | 发布流水线进度 |
| POST | `/api/admin/posts/{id}/unpublish` · `/restore` | 撤回为草稿 · 从回收站恢复 |
| DELETE | `/api/admin/posts/{id}[?purge=true]` | 移入回收站 / 彻底删除 |
| POST | `/api/admin/posts/batch` | 批量 publish / trash / restore / unpublish / setCategory / addTags |
| GET | `/api/admin/posts/{id}/versions[/{v}]` | 历史版本 |
| POST | `/api/admin/render` | 按前台规则渲染 Markdown（预览） |
| POST | `/api/admin/uploads` | 图片上传（字段 `files`，≤5MB，png/jpg/gif/webp/avif） |
| GET | `/api/admin/comments?status` | 评论审核队列 |
| POST | `/api/admin/comments/{id}/{approve\|spam\|delete\|pending\|reply}` | 审核操作 / 作者回复 |
| GET | `/api/admin/taxonomy` | 分类与标签（含数量） |
| POST / PUT / DELETE | `/api/admin/categories[/{id}]` | 分类管理 |
| PUT / DELETE | `/api/admin/tags/{id}` | 标签重命名（同名合并）/ 删除 |
| GET / PUT | `/api/admin/site` | 站点设置 |
| PUT | `/api/admin/me/password` | 修改密码（会注销全部会话） |

## 错误码

`40001` 参数错误 · `40101` 未登录/令牌过期 · `40103` 用户名或密码错误 · `40401` 不存在 · `40901` slug 冲突 · `40902` 编辑冲突 · `41301` 文件过大 · `41501` 文件类型不支持 · `42301` 账户锁定 · `42901` 请求过于频繁 · `50001` 服务内部错误
