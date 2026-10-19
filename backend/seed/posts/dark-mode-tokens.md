---
title: 给博客加上暗色模式：从设计令牌开始
date: 2026-08-28 20:10
status: published
category: 前端
tags: CSS, 设计
cover: {"text": "◐", "from": "#0f172a", "to": "#6366f1"}
views: 1105
excerpt: 暗色模式不是简单反色。从设计令牌（Design Tokens）出发，一套可维护的双主题配色方案。
---

暗色模式不是简单反色。

## 三层令牌结构

1. **原始令牌**：`--gray-900: #0b0d12`
2. **语义令牌**：`--bg`、`--text`、`--border`
3. **组件令牌**：`--card-bg`、`--code-bg`

```css
:root {
  --bg: #ffffff;
  --text: #0f172a;
}
:root[data-theme="dark"] {
  --bg: #07080d;
  --text: #e2e8f0;
}
```

## 几个容易忽略的细节

- 暗色下阴影几乎无效，改用**边框与微光**区分层级
- 纯白文字太刺眼，正文用 `#cbd5e1` 左右的灰
- 图片可以加 `filter: brightness(.9)` 降低眩光
