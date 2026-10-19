---
title: Fail2ban + 密钥登录：个人服务器安全基线
date: 2026-08-14 22:30
status: published
category: 运维
tags: 自建, 安全
views: 980
excerpt: 关掉密码登录、配好 Fail2ban，是个人服务器最便宜也最有效的安全投资。
---

关掉密码登录、配好 Fail2ban，是个人服务器最便宜也最有效的安全投资。

## 第一步：只允许密钥登录

```bash
# /etc/ssh/sshd_config
PasswordAuthentication no
PermitRootLogin prohibit-password
```

## 第二步：Fail2ban

```ini
[sshd]
enabled  = true
maxretry = 5
bantime  = 1h
findtime = 10m
```

> 安全基线的意义在于：让自己不再是最容易被攻破的那台机器。
