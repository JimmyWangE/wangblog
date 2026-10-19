---
title: 给博客加上结构化数据：Article 与 BreadcrumbList
date: 2026-09-23 10:32
status: draft
category: 前端
tags: SEO, 结构化数据
views: 0
excerpt: 让搜索引擎理解「这是一篇文章、作者是谁、发布于何时」：JSON-LD 结构化数据的最小可用实现。
---

搜索引擎理解网页内容，靠的是**语义化 HTML**；而让它理解「这是一篇文章、作者是谁、发布于何时」，靠的是结构化数据。

## 为什么需要 Article 标记

添加 `Article` 类型的 JSON-LD 后，搜索结果页可以展示发布日期、作者等富摘要信息。

## 最小可用实现

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "文章标题",
  "datePublished": "2026-09-23"
}
</script>
```

> 面包屑用 `BreadcrumbList`，个人信息用 `Person`，三者覆盖博客 90% 的场景。
