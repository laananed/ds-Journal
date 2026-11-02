#!/usr/bin/env bash
# 一次性装置：静态服务 + 无头 Chrome + 复现脚本，跑完立即回收（仅测试用）
set -u
ROOT="C:/Programme/demo/SeekJournal"
PY="C:/Users/Free/.workbuddy/binaries/python/versions/3.13.12/python.exe"
NODE="C:/Users/Free/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
PROFILE="$(mktemp -d)/profile"
export no_proxy=127.0.0.1,localhost
export NO_PROXY=127.0.0.1,localhost

cd "$ROOT/frontend/dist" || exit 1
"$PY" -m http.server 5411 --bind 127.0.0.1 >/tmp/sj-http-5411.log 2>&1 &
HTTP_PID=$!
"$CHROME" --headless=new --no-proxy-server --disable-gpu --hide-scrollbars \
  --remote-debugging-port=9231 --user-data-dir="$PROFILE" about:blank >/tmp/sj-chrome-9231.log 2>&1 &
CHROME_PID=$!

cd "$ROOT" || exit 1
"$NODE" s04-ui-round2/repro-checklist.mjs
RC=$?

# 只回收本脚本启动的两个子进程；不按镜像名杀 chrome，避免影响用户自己开的浏览器。
kill "$CHROME_PID" 2>/dev/null
pkill -P "$CHROME_PID" 2>/dev/null
kill "$HTTP_PID" 2>/dev/null
wait "$CHROME_PID" 2>/dev/null
rm -rf "$PROFILE" 2>/dev/null
exit $RC
