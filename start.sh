#!/usr/bin/env bash
# ==========================================================
#  xy-wxhb launcher  (macOS / Linux)
#
#  和 start.bat 等价：找一个 3.8+ 的 Python，起本地服务，
#  然后自动打开浏览器。
# ==========================================================
set -e
cd "$(dirname "$0")"

PY=""

check_py() {
  # $1 = 候选命令；能跑且 >= 3.8 就采用
  [ -n "$PY" ] && return 0
  [ -z "$1" ] && return 0
  command -v "$1" >/dev/null 2>&1 || [ -x "$1" ] || return 0
  if "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; then
    PY="$1"
  fi
}

# 1. 环境变量
[ -n "${XY_WXHB_PYTHON:-}" ] && [ -x "$XY_WXHB_PYTHON" ] && PY="$XY_WXHB_PYTHON"

# 2. 随包携带的便携 Python
check_py "./python/bin/python3"
check_py "./python/bin/python"

# 3. PATH 里的
check_py python3
check_py python

if [ -z "$PY" ]; then
  cat <<'EOF'

  ==========================================================
   没找到 Python 3.8 或更高版本
  ==========================================================

   本工具需要一个 3.8+ 的 Python 来当本地静态服务器
  （只是起服务，不需要装任何第三方包）。

     macOS:   brew install python3
     Ubuntu:  sudo apt install python3
     Fedora:  sudo dnf install python3

   已经装在非标准位置的话，指定路径再启动：
     XY_WXHB_PYTHON=/opt/python3/bin/python3 ./start.sh
EOF
  exit 1
fi

[ -f "serve.py" ] || { echo "  找不到 serve.py，请确认它和 start.sh 在同一个目录。"; exit 1; }

echo "  Python  $("$PY" -V 2>&1)"
exec "$PY" -u serve.py "$@"
