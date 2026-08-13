#!/bin/zsh
set -euo pipefail

LABEL="com.podcast-memory.server"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
DOMAIN="gui/${UID}"

launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
if [[ -f "${PLIST_PATH}" ]]; then
  rm -f "${PLIST_PATH}"
fi

print "回声后台服务已停止并取消登录自启动。"
print "SQLite 数据库、平台令牌、已安装运行副本和所有文字回顾均未删除。"
print "资料仍保存在：${HOME}/Library/Application Support/Podcast Memory"
