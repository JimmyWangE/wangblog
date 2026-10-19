---
title: Nginx 性能调优：gzip、brotli 与静态缓存策略
date: 2026-09-05 21:20
status: published
category: 运维
tags: Nginx, 性能优化
views: 1640
excerpt: 同样的内容，调优前后 TTFB 相差 3 倍。从压缩算法选型到缓存分层，一份面向个人站长的 Nginx 性能清单。
---

同样的内容，调优前后 TTFB 相差 3 倍。

## 压缩算法对比

| 算法 | 压缩率 | CPU 开销 | 兼容性 |
| --- | --- | --- | --- |
| gzip -6 | 基准 | 低 | 全部 |
| brotli -5 | 好 15~20% | 中 | 现代浏览器 |
| brotli -11（预压缩） | 好 25% | 构建期 | 现代浏览器 |

## 推荐配置

```nginx
gzip on;
gzip_comp_level 6;
gzip_types text/css application/javascript application/json image/svg+xml;

brotli on;
brotli_comp_level 5;
brotli_static on;   # 优先使用构建期预压缩的 .br 文件
```

## 文件句柄缓存

```nginx
open_file_cache max=2000 inactive=60s;
open_file_cache_valid 120s;
```

> 调优的第一步永远是测量。先用 `curl -w "%{time_starttransfer}"` 记下基线。
