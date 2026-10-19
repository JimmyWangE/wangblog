---
title: CSS 容器查询：响应式设计的新范式
date: 2026-09-08 20:00
status: published
category: 前端
tags: CSS, 响应式
cover: {"text": "@container", "from": "#ec4899", "to": "#f97316"}
views: 1210
excerpt: 媒体查询关注视口，容器查询关注组件本身。当卡片可以感知自己的宽度，组件级响应式才真正成立。兼容性与降级方案一文讲清。
---

媒体查询关注**视口**，容器查询关注**组件本身**。

## 为什么需要容器查询

同一张文章卡片，放在主栏里宽 720px，放在侧栏里只有 280px。媒体查询只知道窗口有多宽，却不知道卡片自己有多宽。

## 基础用法

```css
.card-wrap {
  container-type: inline-size;
  container-name: card;
}

@container card (min-width: 480px) {
  .card {
    display: grid;
    grid-template-columns: 160px 1fr;
  }
}
```

## 容器查询单位

`cqw`、`cqh` 让字号可以跟随容器缩放：

```css
.card__title { font-size: clamp(1rem, 4cqw, 1.5rem); }
```

## 兼容性与降级

现代浏览器均已支持。对于旧浏览器，默认样式写成单列布局，容器查询作为**渐进增强**即可。
