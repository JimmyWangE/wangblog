---
title: LCP 从 4.2s 到 1.8s：一次完整的首屏优化记录
date: 2025-11-30 21:30
status: published
category: 前端
tags: 性能优化, WebVitals
cover: {"text": "1.8s", "from": "#22c55e", "to": "#06b6d4"}
views: 2050
excerpt: 首屏优化的三板斧：关键 CSS 内联、字体子集化、缓存头调优。每一步都有可复现的测量数据。
---

首屏优化的三板斧：关键 CSS 内联、字体子集化、缓存头调优。

## 基线

| 指标 | 优化前 | 优化后 |
| --- | --- | --- |
| LCP | 4.2s | 1.8s |
| FCP | 2.9s | 1.1s |
| CLS | 0.12 | 0.01 |

## 第一板斧：关键 CSS 内联

把首屏需要的样式内联进 `<head>`，其余样式异步加载：

```html
<link rel="preload" href="/app.css" as="style" onload="this.rel='stylesheet'">
```

## 第二板斧：字体子集化

中文字体从 8MB 降到首屏 300KB。

## 第三板斧：缓存头

参见《深入 HTTP 缓存》一文。三步合计，LCP 降低了 $\frac{4.2-1.8}{4.2} \approx 57\%$。
