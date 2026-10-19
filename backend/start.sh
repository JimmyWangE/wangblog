#!/bin/bash
# WangBlog API - macOS/Linux one-click startup (same logic as start.bat)
set -e
cd "$(dirname "$0")"

PORT="${WB_PORT:-8310}"
LOG="[WangBlog]"

echo "============================================================"
echo "  WangBlog API startup script  (port: $PORT)"
echo "============================================================"

echo "$LOG [1/4] Checking Python..."
PY="$(command -v python3 || true)"
[ -z "$PY" ] && { echo "$LOG [ERROR] python3 not found, please install Python 3.10+"; exit 1; }
"$PY" -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" \
  || { echo "$LOG [ERROR] Python 3.10+ required: $("$PY" --version)"; exit 1; }
echo "$LOG Found $("$PY" --version)"

echo "$LOG [2/4] Preparing virtual environment..."
[ -x ".venv/bin/python" ] || "$PY" -m venv .venv
VENV_PY=.venv/bin/python

echo "$LOG [3/4] Checking dependencies..."
if ! "$VENV_PY" -c "import fastapi, uvicorn, jwt, multipart, pyotp, markdown_it, mdit_py_plugins, pygments" 2>/dev/null; then
  echo "$LOG Installing dependencies..."
  "$VENV_PY" -m pip install --upgrade pip
  "$VENV_PY" -m pip install -r requirements.txt
fi

echo "$LOG [4/4] Checking port $PORT ..."
if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/api/health"; then
  echo "$LOG [WARN] Port $PORT already serving, open http://127.0.0.1:$PORT/docs"
  exit 0
fi

echo "$LOG Starting: http://127.0.0.1:$PORT  (site: /  admin: /admin/  docs: /docs, Ctrl+C to stop)"
exec "$VENV_PY" -m uvicorn app.main:app --host "${WB_HOST:-127.0.0.1}" --port "$PORT"
