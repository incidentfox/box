#!/usr/bin/env bash
# Print the Claude permission mode Box should launch RC chats with — the same lookup as
# server/index.mjs cfg(): process env, then <box>/.env, then EXTRA_ENV_FILE. Anything that
# isn't one of the CLI's --permission-mode choices prints `auto`.
# Usage: claude-permission-mode.sh [box-root]   (BOX_ENV_FILE overrides <box-root>/.env)
root="${1:-$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)}"
envfile="${BOX_ENV_FILE:-$root/.env}"
env_get(){ # env_get KEY FILE → last value, surrounding quotes stripped (matches loadEnvFile)
  [ -f "$2" ] || return 0
  sed -n -E "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*(.*)[[:space:]]*$/\1/p" "$2" | tail -n 1 | sed -E "s/^[\"']//; s/[\"']$//"
}
extra="${EXTRA_ENV_FILE:-$(env_get EXTRA_ENV_FILE "$envfile")}"
mode="${CLAUDE_PERMISSION_MODE:-$(env_get CLAUDE_PERMISSION_MODE "$envfile")}"
[ -n "$mode" ] || mode="$(env_get CLAUDE_PERMISSION_MODE "$extra")"
case "$mode" in manual|acceptEdits|plan|auto|dontAsk|bypassPermissions) ;; *) mode=auto;; esac
printf '%s\n' "$mode"
