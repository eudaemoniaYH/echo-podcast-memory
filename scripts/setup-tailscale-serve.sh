#!/bin/zsh
set -euo pipefail

find_tailscale() {
  local candidate
  for candidate in \
    "$(command -v tailscale 2>/dev/null || true)" \
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale" \
    "/opt/homebrew/bin/tailscale" \
    "/usr/local/bin/tailscale"; do
    if [[ -n "${candidate}" && -x "${candidate}" ]]; then
      print "${candidate}"
      return 0
    fi
  done
  return 1
}

TAILSCALE_BIN="$(find_tailscale || true)"
if [[ -z "${TAILSCALE_BIN}" ]]; then
  print -u2 "尚未安装 Tailscale。请先在 Mac 与 iPhone 安装 Tailscale，并登录同一个账号。"
  print -u2 "官方安装说明：https://tailscale.com/download/mac"
  exit 2
fi

STATUS_JSON="$(${TAILSCALE_BIN} status --json 2>/dev/null || true)"
BACKEND_STATE="$(print -r -- "${STATUS_JSON}" | plutil -extract BackendState raw -o - - 2>/dev/null || true)"
if [[ "${BACKEND_STATE}" != "Running" ]]; then
  print -u2 "Tailscale 尚未登录或未连接。请先打开 Tailscale 完成登录，再重新运行此脚本。"
  exit 3
fi

DNS_NAME="$(print -r -- "${STATUS_JSON}" | plutil -extract Self.DNSName raw -o - - 2>/dev/null || true)"
DNS_NAME="${DNS_NAME%.}"
if [[ -z "${DNS_NAME}" ]]; then
  print -u2 "无法读取这台 Mac 的 Tailscale DNS 名称。请确认 MagicDNS 已启用。"
  exit 4
fi

USER_ID="$(print -r -- "${STATUS_JSON}" | plutil -extract Self.UserID raw -o - - 2>/dev/null || true)"
TAILSCALE_LOGIN=""
if [[ -n "${USER_ID}" ]]; then
  TAILSCALE_LOGIN="$(print -r -- "${STATUS_JSON}" | plutil -extract "User.${USER_ID}.LoginName" raw -o - - 2>/dev/null || true)"
fi
if [[ -z "${TAILSCALE_LOGIN}" ]]; then
  print -u2 "无法确认当前 Tailscale 登录身份；为避免其他 tailnet 用户读取收听资料，已停止配置。"
  exit 5
fi

${TAILSCALE_BIN} serve --bg http://127.0.0.1:8787
PRIVATE_URL="https://${DNS_NAME}/"
ORIGIN_FILE="${HOME}/Library/Application Support/Podcast Memory/public-origin"
LOGIN_FILE="${HOME}/Library/Application Support/Podcast Memory/tailscale-login"
mkdir -p "${ORIGIN_FILE:h}"
print -r -- "https://${DNS_NAME}" > "${ORIGIN_FILE}"
print -r -- "${TAILSCALE_LOGIN}" > "${LOGIN_FILE}"
chmod 600 "${ORIGIN_FILE}" "${LOGIN_FILE}"

print "回声已通过 Tailscale Serve 私密发布，仅同一 tailnet 内的设备可访问。"
print "iPhone 地址：${PRIVATE_URL}"
print "已记录唯一受信任来源；正在重新安装后台服务以应用配置。"
"${SCRIPT_DIR}/install-macos-agent.sh"
print "在 iPhone Safari 打开该地址，然后选择：分享 → 添加到主屏幕 → 作为 Web App 打开。"
print "此脚本不会启用 Funnel，也不会把回声公开到互联网。"
