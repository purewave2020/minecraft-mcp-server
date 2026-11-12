#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$PROJECT_DIR"

# Finder 启动的终端可能还没有将 nvm 安装的 Node.js 加入 PATH。
if ! command -v node >/dev/null 2>&1; then
    for node_bin in "$HOME"/.nvm/versions/node/*/bin; do
        if [ -x "$node_bin/node" ]; then
            export PATH="$node_bin:$PATH"
        fi
    done
fi

if [ ! -x .venv/bin/python ]; then
    echo '缺少 Python 环境，请按 LOCAL_SETUP.md 安装。'
    exit 1
fi

mkdir -p .local
chmod 700 .local
touch .local/danmu.log
chmod 600 .local/danmu.log
.venv/bin/python -u main.py "$@" 2>&1 | tee -a .local/danmu.log
