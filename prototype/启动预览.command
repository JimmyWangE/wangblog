#!/bin/bash
# 向明笔记 · 前端原型一键预览
# 用法：在 Finder 中双击本文件，或在终端执行 bash 启动预览.command
cd "$(dirname "$0")"
PORT=8321

# 若端口已有服务在跑，直接打开浏览器即可
if curl -s -o /dev/null --max-time 1 "http://localhost:$PORT/index.html"; then
  echo "预览服务已在运行：http://localhost:$PORT"
else
  echo "正在启动预览服务…"
  # 优先使用 WorkBuddy 托管 Python，退回系统 python3
  PY="/Users/jimmy/.workbuddy/binaries/python/versions/3.13.12/bin/python3"
  [ -x "$PY" ] || PY="$(command -v python3)"
  nohup "$PY" -m http.server "$PORT" --bind 127.0.0.1 > /tmp/wangblog-preview.log 2>&1 &
  sleep 1
  echo "预览服务已启动：http://localhost:$PORT"
fi

# 打开默认浏览器（想指定 Edge 可把下一行改为 open -a "Microsoft Edge"）
open "http://localhost:$PORT/index.html"
echo "关闭此窗口不会停止服务；停止服务可执行：lsof -ti :$PORT | xargs kill"
