---
title: Web 字体子集化：把 8MB 字体压到 300KB
date: 2026-10-30 09:00
status: scheduled
category: 前端
tags: 性能优化
views: 0
excerpt: 中文字体动辄数 MB，全量加载不可接受。按字频切分子集 + unicode-range 按需加载的完整实践。
---

中文字体动辄数 MB，全量加载不可接受。

## 思路

按字频把字体切成几十个分片，配合 `unicode-range`，浏览器只下载页面实际用到的分片。

```css
@font-face {
  font-family: "Noto Serif SC";
  src: url(/fonts/noto-01.woff2) format("woff2");
  unicode-range: U+4E00-4E5F;
}
```
