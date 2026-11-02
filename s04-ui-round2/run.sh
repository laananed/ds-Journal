#!/usr/bin/env bash
# 一次性装置：静态服务 + 无头 Chrome + 指定脚本，跑完立即回收（仅测试用）
# 用法：bash s04-ui-round2/run.sh verify-checklist.mjs
set -u
ROOT="C:/Programme/demo/SeekJournal"
SCRIPT="${1:-repro-checklist.mjs}"
PORT="${2:-5411}"
DPORT="${3:-9231}"
PY="C:/Users/Free/.workbuddy/binaries/python/versions/3.13.12/python.exe"
NODE="C:/Users/Free/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
PROFILE="$(mktemp -d)/profile"
export no_proxy=127.0.0.1,localhost
export NO_PROXY=127.0.0.1,localhost
export APP_URL="http://127.0.0.1:$PORT/"
export CDP_URL="http://127.0.0.1:$DPORT"

cd "$ROOT/frontend/dist" || exit 1
"$PY" -m http.server "$PORT" --bind 127.0.0.1 >/tmp/sj-http-$PORT.log 2>&1 &
HTTP_PID=$!
"$CHROME" --headless=new --no-proxy-server --disable-gpu --hide-scrollbars \
  --remote-debugging-port="$DPORT" --user-data-dir="$PROFILE" about:blank >/tmp/sj-chrome-$DPORT.log 2>&1 &
CHROME_PID=$!

cd "$ROOT" || exit 1
"$NODE" "s04-ui-round2/$SCRIPT"
RC=$?

kill "$CHROME_PID" 2>/dev/null
pkill -P "$CHROME_PID" 2>/dev/null
kill "$HTTP_PID" 2>/dev/null
wait "$CHROME_PID" 2>/dev/null
rm -rf "$PROFILE" 2>/dev/null
exit $RC
