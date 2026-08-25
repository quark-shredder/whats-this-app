#!/bin/bash
# Runs everything on this Mac: Ollama (Metal) + the app server.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
export OLLAMA_HOST=127.0.0.1:11435
export OLLAMA_MODELS="$HERE/ollama-local/models"

pgrep -f "ollama serve" >/dev/null || {
  echo "starting ollama…"
  (cd "$HERE/ollama-local" && nohup ./ollama serve > serve.log 2>&1 < /dev/null &)
  sleep 5
}

MODEL="${MODEL:-qwen2.5vl:3b}" \
OLLAMA_URL="http://127.0.0.1:11435" \
PORT="${PORT:-8080}" \
  node "$HERE/server/server.js"
