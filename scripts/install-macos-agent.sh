#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
LABEL="com.podcast-memory.server"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${LAUNCH_AGENTS_DIR}/${LABEL}.plist"
DOMAIN="gui/${UID}"
APP_SUPPORT_DIR="${HOME}/Library/Application Support/Podcast Memory"
RUNTIME_ROOT="${APP_SUPPORT_DIR}/runtime"
DATA_DIR="${APP_SUPPORT_DIR}/data"
LOG_DIR="${HOME}/Library/Logs/Podcast Memory"
RELEASE_ID="$(date '+%Y%m%d-%H%M%S')"
RELEASE_DIR="${RUNTIME_ROOT}/releases/${RELEASE_ID}"
SOURCE_DB="${PROJECT_DIR}/.data/podcast-memory.sqlite"
INSTALLED_DB="${DATA_DIR}/podcast-memory.sqlite"
PODCAST_CODEX_BIN_PATH="${PODCAST_MEMORY_CODEX_BIN:-/Applications/ChatGPT.app/Contents/Resources/codex}"
CODEX_READY=0
PUBLIC_ORIGIN_FILE="${APP_SUPPORT_DIR}/public-origin"
PUBLIC_ORIGIN=""
[[ -f "${PUBLIC_ORIGIN_FILE}" ]] && PUBLIC_ORIGIN="$(<"${PUBLIC_ORIGIN_FILE}")"
TAILSCALE_LOGIN_FILE="${APP_SUPPORT_DIR}/tailscale-login"
TAILSCALE_LOGIN=""
[[ -f "${TAILSCALE_LOGIN_FILE}" ]] && TAILSCALE_LOGIN="$(<"${TAILSCALE_LOGIN_FILE}")"
if [[ -n "${PUBLIC_ORIGIN}" && -z "${TAILSCALE_LOGIN}" ]]; then
  print -u2 "发现远程来源但没有绑定 Tailscale 登录身份；请重新运行 setup-tailscale-serve.sh。"
  exit 5
fi

if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  print -u2 "没有找到可执行的 Node.js，请先安装 Node 22.13 或更新版本。"
  exit 1
fi
if [[ -x "${PODCAST_CODEX_BIN_PATH}" ]] && \
  "${PODCAST_CODEX_BIN_PATH}" login status 2>&1 | /usr/bin/grep -qi "Logged in using ChatGPT"; then
  CODEX_READY=1
else
  print -u2 "提醒：尚未检测到 ChatGPT 方式的 Codex 登录；同步仍会运行，但自动快速回顾会等待登录。"
fi

launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
LISTENING_PIDS="$(/usr/sbin/lsof -tiTCP:8787 -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "${LISTENING_PIDS}" ]]; then
  print -u2 "8787 端口仍被进程 ${LISTENING_PIDS//$'\n'/, } 占用。请先停止手动启动的服务，再重新安装。"
  exit 3
fi
OPEN_DB_PIDS="$(/usr/sbin/lsof -t -- "${INSTALLED_DB}" "${INSTALLED_DB}-wal" "${SOURCE_DB}" "${SOURCE_DB}-wal" 2>/dev/null || true)"
if [[ -n "${OPEN_DB_PIDS}" ]]; then
  print -u2 "播客数据库仍被进程 ${OPEN_DB_PIDS//$'\n'/, } 使用。请先停止手动启动的回声服务，再重新安装。"
  exit 4
fi

mkdir -p "${LAUNCH_AGENTS_DIR}" "${RELEASE_DIR}" "${DATA_DIR}" "${LOG_DIR}"
chmod 700 "${APP_SUPPORT_DIR}" "${RUNTIME_ROOT}" "${RELEASE_DIR}" "${DATA_DIR}" "${LOG_DIR}"
/usr/bin/ditto "${PROJECT_DIR}/src" "${RELEASE_DIR}/src"
/usr/bin/ditto "${PROJECT_DIR}/public" "${RELEASE_DIR}/public"
/usr/bin/ditto "${PROJECT_DIR}/package.json" "${RELEASE_DIR}/package.json"
[[ -d "${PROJECT_DIR}/extension" ]] && /usr/bin/ditto "${PROJECT_DIR}/extension" "${RELEASE_DIR}/extension"
[[ -d "${PROJECT_DIR}/dist" ]] && /usr/bin/ditto "${PROJECT_DIR}/dist" "${RELEASE_DIR}/dist"

# SQLite 处于 WAL 模式，必须使用在线备份 API 生成一致快照，不能直接复制三件套。
if [[ -f "${INSTALLED_DB}" ]]; then
  INSTALL_BACKUP_DIR="${DATA_DIR}/backups/installer"
  INSTALL_BACKUP="${INSTALL_BACKUP_DIR}/podcast-memory-${RELEASE_ID}.sqlite"
  mkdir -p "${INSTALL_BACKUP_DIR}"
  /usr/bin/sqlite3 "${INSTALLED_DB}" ".backup '${INSTALL_BACKUP}'"
  [[ "$(/usr/bin/sqlite3 "${INSTALL_BACKUP}" 'PRAGMA quick_check;')" == "ok" ]]
  chmod 600 "${INSTALL_BACKUP}"
elif [[ -f "${SOURCE_DB}" ]]; then
  /usr/bin/sqlite3 "${SOURCE_DB}" ".backup '${INSTALLED_DB}'"
  [[ "$(/usr/bin/sqlite3 "${INSTALLED_DB}" 'PRAGMA quick_check;')" == "ok" ]]
  chmod 600 "${INSTALLED_DB}"
  [[ -f "${PROJECT_DIR}/.data/pairing-code" ]] && \
    /usr/bin/ditto "${PROJECT_DIR}/.data/pairing-code" "${DATA_DIR}/pairing-code"
  [[ -d "${PROJECT_DIR}/.data/backups" ]] && \
    /usr/bin/ditto "${PROJECT_DIR}/.data/backups" "${DATA_DIR}/backups"
fi
for PRIVATE_FILE in "${INSTALLED_DB}" "${INSTALLED_DB}-wal" "${INSTALLED_DB}-shm" \
  "${LOG_DIR}/server.log" "${LOG_DIR}/server-error.log"; do
  [[ -e "${PRIVATE_FILE}" ]] && chmod 600 "${PRIVATE_FILE}"
done

TEMP_PLIST="$(mktemp "${TMPDIR:-/tmp}/podcast-memory-launchagent.XXXXXX")"
trap 'rm -f "${TEMP_PLIST}"' EXIT

cat > "${TEMP_PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${RELEASE_DIR}/src/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${RELEASE_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PORT</key>
    <string>8787</string>
    <key>SYNC_INTERVAL_MINUTES</key>
    <string>10</string>
    <key>XIAOYUZHOU_INCREMENTAL_HISTORY_PAGES</key>
    <string>3</string>
    <key>PODCAST_MEMORY_TRUST_PROXY</key>
    <string>1</string>
    <key>PODCAST_MEMORY_PUBLIC_ORIGIN</key>
    <string>${PUBLIC_ORIGIN}</string>
    <key>PODCAST_MEMORY_EXTENSION_ORIGIN</key>
    <string>chrome-extension://jkdldllomdgfgheailkjdihphlmegfnc</string>
    <key>PODCAST_MEMORY_TAILSCALE_LOGIN</key>
    <string>${TAILSCALE_LOGIN}</string>
    <key>PODCAST_MEMORY_DATA</key>
    <string>${DATA_DIR}</string>
    <key>APPLE_PODCASTS_DB_PATH</key>
    <string>${HOME}/Library/Group Containers/243LU875E5.groups.com.apple.podcasts/Documents/MTLibrary.sqlite</string>
    <key>APPLE_PODCASTS_READ_TIMEOUT_MS</key>
    <string>5000</string>
    <key>PODCAST_MEMORY_CODEX_BIN</key>
    <string>${PODCAST_CODEX_BIN_PATH}</string>
    <key>CODEX_SUMMARY_MODEL</key>
    <string>gpt-5.6-terra</string>
    <key>AUTO_SUMMARY_ENABLED</key>
    <string>1</string>
  </dict>
  <key>Umask</key>
  <integer>63</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>20</integer>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/server.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/server-error.log</string>
</dict>
</plist>
PLIST

plutil -lint "${TEMP_PLIST}" >/dev/null
install -m 600 "${TEMP_PLIST}" "${PLIST_PATH}"
launchctl bootstrap "${DOMAIN}" "${PLIST_PATH}"
launchctl enable "${DOMAIN}/${LABEL}"
launchctl kickstart -k "${DOMAIN}/${LABEL}"

for attempt in {1..20}; do
  SERVICE_INFO="$(launchctl print "${DOMAIN}/${LABEL}" 2>/dev/null || true)"
  if [[ "${SERVICE_INFO}" == *"state = running"* && "${SERVICE_INFO}" == *"${RELEASE_DIR}/src/server.js"* ]] && \
    /usr/bin/curl --silent --fail --max-time 2 "http://127.0.0.1:8787/api/automation" >/dev/null; then
    print "回声后台服务已安装并启动。"
    print "本机地址：http://127.0.0.1:8787"
    print "自动同步：每 10 分钟；登录后自动启动；异常退出后自动重启。"
    [[ "${CODEX_READY}" == "1" ]] && print "自动快速回顾：已连接 ChatGPT 订阅；听完后自动排队。"
    print "运行资料：${APP_SUPPORT_DIR}"
    exit 0
  fi
  sleep 0.5
done

print -u2 "LaunchAgent 已安装，但服务未能在 10 秒内响应。"
print -u2 "请查看：${LOG_DIR}/server-error.log"
exit 1
