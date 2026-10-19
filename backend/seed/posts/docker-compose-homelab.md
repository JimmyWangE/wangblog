---
title: Docker Compose 单机编排：个人服务的最佳姿势
date: 2026-09-15 22:05
status: published
category: 运维
tags: Docker, 自建
cover: {"text": "YAML", "from": "#2563eb", "to": "#a78bfa"}
views: 1980
excerpt: 一台 2C4G 的轻量服务器上要跑博客、评论系统和监控，如何用 Compose 把它们编排得井井有条？包含网络隔离、资源限制与自动重启的完整配置。
---

一台 2C4G 的轻量服务器，要同时跑博客、评论、监控三套服务。Kubernetes 显然太重，裸跑进程又难以维护——**Docker Compose 恰好处在甜点位**。

## 整体拓扑

```mermaid
flowchart TB
  U[用户] --> N[Nginx 网关]
  N --> B[blog 后端]
  N --> C[评论服务]
  B --> D[(SQLite 卷)]
  M[Prometheus] -.抓取.-> B
  M -.抓取.-> C
```

## 一份完整的 compose 文件

```yaml
services:
  blog:
    image: wangblog/backend:latest
    restart: unless-stopped
    networks: [internal]
    volumes:
      - ./data:/app/data
    deploy:
      resources:
        limits: { cpus: "1.0", memory: 512M }
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8310/api/health"]
      interval: 30s

  nginx:
    image: nginx:1.27-alpine
    ports: ["80:80", "443:443"]
    networks: [internal, public]
    depends_on:
      blog: { condition: service_healthy }

networks:
  internal: { internal: true }
  public: {}
```

## 三个关键点

1. **网络隔离**：业务容器只加入 `internal` 网络，只有网关暴露端口。
2. **资源限制**：给每个服务设上限，防止一个服务内存泄漏拖垮整机。
3. **健康检查 + 依赖**：`depends_on.condition` 让启动顺序真正可靠。

> 单机编排的核心不是“能跑”，而是“挂了能自己起来”。
