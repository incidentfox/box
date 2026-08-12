#!/usr/bin/env bash
# keeper.sh — always-on supervisor for Box.
#
# Keeps two things alive and restarts them if they die:
#   1. the Box node server (port from .env, default 7321)
#   2. a public tunnel so you can reach it from your phone (no open firewall ports)
#
# Tunnel modes (TUNNEL_MODE in .env):
#   quick  (default) — Cloudflare "quick tunnel": a free https://<random>.trycloudflare.com
#                      URL, no account or domain needed. URL changes on restart; the current
#                      one is written to ~/.cc-mobile/url.txt.
#   named            — a stable Cloudflare named tunnel you set up once. Set TUNNEL_NAME and
#                      (optionally) TUNNEL_HOSTNAME. See concierge/40-stable-url.md.
#   none             — local only (http://localhost:PORT). Use your own reverse proxy.
#
# Run it from @reboot cron (install.sh wires this), or just `./scripts/keeper.sh &`.
set -u

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR" || exit 1

# Load config from .env (PORT / TUNNEL_MODE / TUNNEL_NAME / TUNNEL_HOSTNAME).
[ -f "$APP_DIR/.env" ] && { set -a; . "$APP_DIR/.env"; set +a; }
PORT="${PORT:-7321}"
TUNNEL_MODE="${TUNNEL_MODE:-quick}"

STATE_DIR="$HOME/.cc-mobile"; mkdir -p "$STATE_DIR"
SRV_LOG="$STATE_DIR/server.log"
TUN_LOG="$STATE_DIR/tunnel.log"
URL_FILE="$STATE_DIR/url.txt"
# On systemd hosts, keep each server generation in its own transient unit.  The
# keeper intentionally survives server cutovers, but a server restart must reap
# every Box-owned descendant instead of inheriting old session/worker processes.
# Non-systemd installs retain the portable nohup path below.
SERVER_UNIT_PREFIX="${BOX_SERVER_UNIT_PREFIX:-box-app-server}"
SERVER_UNIT_FILE="$STATE_DIR/server-unit"
# Keep Box from consuming the host when an agent or tool subprocess grows without
# bound. The server and its descendants share this cgroup, so a finite MemoryHigh
# throttles the HTTP server when any child crosses it and can make every route hang
# while the host still has free RAM. Leave the shared soft throttle disabled;
# MemoryMax and MemorySwapMax remain last-resort fuses.
SERVER_MEMORY_HIGH="${BOX_SERVER_MEMORY_HIGH:-infinity}"
SERVER_MEMORY_MAX="${BOX_SERVER_MEMORY_MAX:-10G}"
SERVER_MEMORY_SWAP_MAX="${BOX_SERVER_MEMORY_SWAP_MAX:-2G}"

# Single-instance guard (cron tick + manual launch dedupe).
# flock is Linux-only (util-linux); fall back to a PID-file lock on macOS/BSD.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$STATE_DIR/keeper.lock"
  flock -n 9 || { echo "keeper already running; exiting"; exit 0; }
else
  PIDFILE="$STATE_DIR/keeper.pid"
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
    echo "keeper already running; exiting"; exit 0
  fi
  echo $$ > "$PIDFILE"
  trap 'rm -f "$PIDFILE"' EXIT
fi

# Claude Code must use your full login credentials, not an inference-only token that
# might be injected into the environment — otherwise remote-control is disallowed.
unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_OAUTH_TOKEN ANTHROPIC_API_KEY

# A process's cwd, portably: /proc on Linux, lsof on macOS/BSD (no /proc there).
proc_cwd() {
  local p="$1"
  if [ -r "/proc/$p/cwd" ]; then
    readlink "/proc/$p/cwd" 2>/dev/null
  else
    lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
  fi
}
server_pids() {
  local p cwd
  pgrep -f "node server/index.mjs" 2>/dev/null | while read -r p; do
    [ -n "$p" ] || continue
    cwd="$(proc_cwd "$p")"
    [ "$cwd" = "$APP_DIR" ] && echo "$p"
  done
}
server_up() { [ -n "$(server_pids | head -n 1)" ]; }
systemd_user_available() {
  command -v systemd-run >/dev/null 2>&1 \
    && command -v systemctl >/dev/null 2>&1 \
    && systemctl --user show-environment >/dev/null 2>&1
}
ensure_node_pty() {
  if node -e 'require("node-pty")' >/dev/null 2>&1; then
    return 0
  fi

  echo "$(date -u +%FT%TZ) node-pty native module unavailable; rebuilding" >>"$SRV_LOG"
  if npm rebuild node-pty >>"$SRV_LOG" 2>&1 \
    && node -e 'require("node-pty")' >/dev/null 2>&1; then
    echo "$(date -u +%FT%TZ) node-pty native module rebuilt successfully" >>"$SRV_LOG"
    return 0
  fi

  echo "$(date -u +%FT%TZ) node-pty rebuild failed; server not started" >>"$SRV_LOG"
  return 1
}
start_server() {
  ensure_node_pty || return 1

  if systemd_user_available; then
    local unit="${SERVER_UNIT_PREFIX}-$(date +%s)-$$.service"
    printf '%s\n' "$unit" >"$SERVER_UNIT_FILE"
    echo "$(date -u +%FT%TZ) starting isolated server unit $unit" >>"$SRV_LOG"
    # A child helper OOM must not tear down the healthy Node server. If Node itself is
    # killed, its main process still exits and the keeper starts a fresh generation.
    if systemd-run --user --collect --unit="$unit" --working-directory="$APP_DIR" \
      --property=Type=exec \
      --property=KillMode=control-group \
      --property=OOMPolicy=continue \
      --property=MemoryHigh="$SERVER_MEMORY_HIGH" \
      --property=MemoryMax="$SERVER_MEMORY_MAX" \
      --property=MemorySwapMax="$SERVER_MEMORY_SWAP_MAX" \
      --property=Restart=no \
      --property=StandardOutput=append:"$SRV_LOG" \
      --property=StandardError=append:"$SRV_LOG" \
      node server/index.mjs >>"$SRV_LOG" 2>&1; then
      return 0
    fi
    echo "$(date -u +%FT%TZ) isolated server unit failed; falling back to direct launch" >>"$SRV_LOG"
  fi

  nohup node server/index.mjs >>"$SRV_LOG" 2>&1 9>&- &
}

tunnel_up()  { pgrep -f "cloudflared tunnel" >/dev/null 2>&1; }
start_tunnel() {
  command -v cloudflared >/dev/null 2>&1 || {
    echo "$(date -u +%FT%TZ) cloudflared not installed — serving locally at http://localhost:$PORT" >>"$TUN_LOG"
    echo "http://localhost:$PORT" > "$URL_FILE"; return; }
  case "$TUNNEL_MODE" in
    named)
      [ -n "${TUNNEL_HOSTNAME:-}" ] && echo "https://$TUNNEL_HOSTNAME" > "$URL_FILE"
      nohup cloudflared tunnel run "${TUNNEL_NAME:?set TUNNEL_NAME for named mode}" \
        >>"$TUN_LOG" 2>&1 9>&- & ;;
    none)
      echo "http://localhost:$PORT" > "$URL_FILE" ;;
    *)  # quick
      : > "$TUN_LOG"   # fresh log so we scrape THIS run's URL
      nohup cloudflared tunnel --url "http://localhost:$PORT" --no-autoupdate \
        >>"$TUN_LOG" 2>&1 9>&- & ;;
  esac
}

# Pull the trycloudflare URL out of the quick-tunnel log into url.txt.
scrape_quick_url() {
  [ "$TUNNEL_MODE" = quick ] || return 0
  local u
  u="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUN_LOG" 2>/dev/null | tail -1)"
  [ -n "$u" ] && echo "$u" > "$URL_FILE"
}

while true; do
  server_up || { echo "$(date -u +%FT%TZ) starting server" >>"$SRV_LOG"; start_server; }
  if [ "$TUNNEL_MODE" != none ]; then
    tunnel_up || { echo "$(date -u +%FT%TZ) starting tunnel ($TUNNEL_MODE)" >>"$TUN_LOG"; start_tunnel; sleep 5; }
    scrape_quick_url
  fi
  # Do not let the child sleep inherit fd 9: otherwise it keeps the singleton
  # flock alive briefly after systemd restarts the keeper.
  sleep 30 9>&-
done
