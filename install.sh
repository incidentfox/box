#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Box installer — sets up the self-hosted "Claude Code in your pocket" app.
#
#  Usage:
#    ./install.sh                 # interactive: asks about optional keys + harness
#    ./install.sh --yes           # non-interactive: defaults, no prompts (for agents)
#    ./install.sh --no-harness    # skip installing the Claude Code harness
#    ./install.sh --no-cron       # don't add the @reboot keeper cron line
#    ./install.sh --no-start      # set up everything but don't start the server
#    ./install.sh --port 7321     # override the port
#
#  Safe to re-run. It never overwrites your .env or an existing ~/.claude/settings.json.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

# ---- args -------------------------------------------------------------------
ASSUME_YES=0; DO_HARNESS=1; DO_CRON=1; DO_START=1; PORT_OVERRIDE=""; NEED_CLAUDE_LOGIN=0
while [ $# -gt 0 ]; do case "$1" in
  --yes|-y) ASSUME_YES=1 ;;
  --no-harness) DO_HARNESS=0 ;;
  --no-cron) DO_CRON=0 ;;
  --no-start) DO_START=0 ;;
  --port) shift; PORT_OVERRIDE="${1:-}" ;;
  -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  *) echo "unknown flag: $1" >&2; exit 1 ;;
esac; shift; done

bold(){ printf '\033[1m%s\033[0m\n' "$*"; }
ok(){   printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
info(){ printf '  • %s\n' "$*"; }
ask(){ # ask "prompt" "default" -> echoes answer (default if --yes or no TTY)
  local p="$1" d="${2:-}"; local a=""
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then echo "$d"; return; fi
  read -r -p "$p" a < /dev/tty || a=""
  echo "${a:-$d}"
}

bold "📦 Installing Box in $APP_DIR"
echo

# ---- platform + package manager --------------------------------------------
OS="$(uname -s)"; ARCH="$(uname -m)"
PM=""
if   command -v apt-get >/dev/null 2>&1; then PM="apt"
elif command -v brew    >/dev/null 2>&1; then PM="brew"
elif command -v dnf     >/dev/null 2>&1; then PM="dnf"
elif command -v pacman  >/dev/null 2>&1; then PM="pacman"
fi
SUDO=""; [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"

pkg_install(){ # pkg_install <pkgs...>  (best-effort; never fatal)
  [ -n "$PM" ] || { warn "no known package manager — install manually: $*"; return 1; }
  case "$PM" in
    apt)    $SUDO apt-get update -qq >/dev/null 2>&1; $SUDO apt-get install -y -qq "$@" >/dev/null 2>&1 ;;
    brew)   brew install "$@" >/dev/null 2>&1 ;;
    dnf)    $SUDO dnf install -y -q "$@" >/dev/null 2>&1 ;;
    pacman) $SUDO pacman -Sy --noconfirm "$@" >/dev/null 2>&1 ;;
  esac
}

bold "1) Checking prerequisites"

# Node 18+
if command -v node >/dev/null 2>&1 && [ "$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)" -ge 18 ]; then
  ok "node $(node -v)"
else
  warn "node 18+ not found — attempting install"
  case "$PM" in
    apt) curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - >/dev/null 2>&1; pkg_install nodejs ;;
    brew) pkg_install node ;;
    *) pkg_install nodejs ;;
  esac
  command -v node >/dev/null 2>&1 && ok "node $(node -v)" || { warn "could not install node — install Node 18+ then re-run"; }
fi

# git, dtach, and node-pty build deps
command -v git >/dev/null 2>&1 || pkg_install git
command -v git >/dev/null 2>&1 && ok "git" || warn "git missing"

if command -v dtach >/dev/null 2>&1; then ok "dtach"; else warn "installing dtach (session persistence)"; pkg_install dtach; command -v dtach >/dev/null 2>&1 && ok "dtach" || warn "dtach missing (sessions won't persist across SSH drops)"; fi

# build toolchain for node-pty (native module)
if [ "$OS" = "Linux" ]; then
  case "$PM" in
    apt) pkg_install build-essential python3 ;;
    dnf) pkg_install gcc-c++ make python3 ;;
    pacman) pkg_install base-devel python ;;
  esac
fi

# claude CLI — required; Box drives the user's logged-in CLI. Auto-install if missing.
if ! command -v claude >/dev/null 2>&1; then
  warn "claude CLI not found — installing (@anthropic-ai/claude-code)"
  npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || $SUDO npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || true
  hash -r 2>/dev/null || true
fi
if command -v claude >/dev/null 2>&1; then
  ok "claude CLI present ($(claude --version 2>/dev/null | head -1))"
  # Logged in? Box drives the user's logged-in CLI (no API key needed on a subscription).
  if [ -f "$HOME/.claude/.credentials.json" ] || [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    ok "claude appears logged in"
  else
    warn "claude is installed but NOT logged in"
    NEED_CLAUDE_LOGIN=1
  fi
else
  warn "couldn't auto-install claude — run: npm install -g @anthropic-ai/claude-code"
  NEED_CLAUDE_LOGIN=1
fi

# codex CLI — optional
command -v codex >/dev/null 2>&1 && ok "codex CLI present (Codex chats enabled)" || info "codex CLI not found — Codex chats disabled (optional)"

# cloudflared — for the public tunnel
if command -v cloudflared >/dev/null 2>&1; then
  ok "cloudflared present (public tunnel available)"
else
  warn "cloudflared not found — installing (gives you a public URL with no port-forwarding)"
  if [ "$PM" = brew ]; then pkg_install cloudflared
  elif [ "$OS" = "Linux" ]; then
    cfarch="amd64"; case "$ARCH" in aarch64|arm64) cfarch="arm64";; armv7l) cfarch="arm";; esac
    $SUDO curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cfarch}" -o /usr/local/bin/cloudflared 2>/dev/null \
      && $SUDO chmod +x /usr/local/bin/cloudflared 2>/dev/null
  fi
  command -v cloudflared >/dev/null 2>&1 && ok "cloudflared installed" || warn "cloudflared not installed — Box will run local-only (http://localhost). Install it later for phone access."
fi
echo

# ---- npm install ------------------------------------------------------------
bold "2) Installing app dependencies (this builds node-pty — may take a minute)"
if npm install --no-audit --no-fund >/dev/null 2>&1; then ok "dependencies installed"; else warn "npm install hit an error — see: npm install"; fi
echo

# ---- .env -------------------------------------------------------------------
bold "3) Configuration (.env)"
if [ -f .env ]; then
  ok ".env already exists — leaving it untouched"
else
  cp .env.example .env
  # Generate an auth token
  TOK="$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))' 2>/dev/null || head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  # portable in-place edit
  sed -i.bak "s|^CC_AUTH_TOKEN=.*|CC_AUTH_TOKEN=$TOK|" .env && rm -f .env.bak
  # Default the tunnel to quick mode
  grep -q '^TUNNEL_MODE=' .env || printf '\nTUNNEL_MODE=quick\n' >> .env

  # Optional interactive key collection
  if [ "$ASSUME_YES" != 1 ] && [ -t 0 ]; then
    NAME="$(ask '  Your name (for the morning brief) [you]: ' 'you')"
    [ -n "$NAME" ] && sed -i.bak "s|^OWNER_NAME=.*|OWNER_NAME=$NAME|" .env && rm -f .env.bak
    EL="$(ask '  ElevenLabs API key for voice (optional, Enter to skip): ' '')"
    [ -n "$EL" ] && { sed -i.bak "s|^# ELEVENLABS_API_KEY=.*|ELEVENLABS_API_KEY=$EL|" .env; grep -q '^ELEVENLABS_API_KEY=' .env || echo "ELEVENLABS_API_KEY=$EL" >> .env; rm -f .env.bak; }
    LK="$(ask '  Linear API key for Board + needs-you inbox (optional, Enter to skip): ' '')"
    if [ -n "$LK" ]; then
      grep -q '^LINEAR_API_KEY=' .env && sed -i.bak "s|^LINEAR_API_KEY=.*|LINEAR_API_KEY=$LK|" .env || echo "LINEAR_API_KEY=$LK" >> .env
      TK="$(ask '  Linear team key (e.g. ENG): ' '')"; [ -n "$TK" ] && echo "LINEAR_TEAM_KEY=$TK" >> .env
      warn "Set LINEAR_TEAM_ID in .env too (the team UUID) — see concierge/30-linear.md"
      rm -f .env.bak
    fi
  fi
  ok ".env created (token generated)"
fi
[ -n "$PORT_OVERRIDE" ] && { grep -q '^PORT=' .env && sed -i.bak "s|^PORT=.*|PORT=$PORT_OVERRIDE|" .env || echo "PORT=$PORT_OVERRIDE" >> .env; rm -f .env.bak; ok "port set to $PORT_OVERRIDE"; }
echo

# ---- harness ----------------------------------------------------------------
if [ "$DO_HARNESS" = 1 ]; then
  bold "4) Installing the Claude Code harness (hooks + needs-you helper)"
  mkdir -p "$HOME/.claude/hooks"
  for h in _skip-automated.sh inject-time.sh surface-attention.sh; do
    cp "harness/hooks/$h" "$HOME/.claude/hooks/$h" && chmod +x "$HOME/.claude/hooks/$h"
  done
  ok "hooks → ~/.claude/hooks/"
  # make the harness scripts reachable for the SessionStart hook
  ln -sfn "$APP_DIR/harness" "$HOME/.claude/box-harness"
  ok "harness → ~/.claude/box-harness (symlink)"
  # put the `google` CLI on PATH (Gmail/Calendar/Drive power-up; needs OAuth setup later)
  mkdir -p "$HOME/.local/bin"
  ln -sfn "$APP_DIR/harness/google" "$HOME/.local/bin/google"
  ok "google CLI → ~/.local/bin/google (run 'node harness/google-auth.mjs' to enable — see concierge/50-power-ups.md)"
  case ":$PATH:" in *":$HOME/.local/bin:"*) :;; *) info "add ~/.local/bin to your PATH to use 'google' directly";; esac

  if [ -f "$HOME/.claude/settings.json" ]; then
    cp "harness/settings.json.example" "$HOME/.claude/settings.box.json"
    warn "~/.claude/settings.json exists — wrote the template to ~/.claude/settings.box.json instead."
    info "Merge its \"hooks\", \"remoteControlAtStartup\", and \"permissions\" keys into your settings.json."
  else
    node -e 'const fs=require("fs");const o=JSON.parse(fs.readFileSync("harness/settings.json.example","utf8"));delete o._comment;fs.writeFileSync(process.env.HOME+"/.claude/settings.json",JSON.stringify(o,null,2))' \
      && ok "wrote ~/.claude/settings.json (hooks + remote-control enabled)"
  fi
  info "Operating-pattern guide: harness/CLAUDE.md — copy it to your code dir as CLAUDE.md."
  echo
fi

# ---- cron -------------------------------------------------------------------
if [ "$DO_CRON" = 1 ]; then
  bold "5) Always-on (keeper @reboot)"
  KEEPER_LINE="@reboot $APP_DIR/scripts/keeper.sh >> \$HOME/.cc-mobile/keeper.log 2>&1"
  if crontab -l 2>/dev/null | grep -Fq "$APP_DIR/scripts/keeper.sh"; then
    ok "keeper already in crontab"
  else
    ( crontab -l 2>/dev/null; echo "$KEEPER_LINE" ) | crontab - 2>/dev/null \
      && ok "added @reboot keeper to crontab" \
      || warn "couldn't edit crontab — add manually:  $KEEPER_LINE"
  fi
  chmod +x scripts/keeper.sh harness/scripts/cc-rc-supervisor.sh 2>/dev/null
  echo
fi

# ---- start ------------------------------------------------------------------
if [ "$DO_START" = 1 ]; then
  bold "6) Starting Box"
  if pgrep -f "node server/index.mjs" >/dev/null 2>&1; then
    ok "server already running"
  else
    nohup bash scripts/keeper.sh >> "$HOME/.cc-mobile/keeper.log" 2>&1 &
    ok "keeper launched"
  fi
  # wait for the public URL
  URL_FILE="$HOME/.cc-mobile/url.txt"; URL=""
  for _ in $(seq 1 20); do [ -s "$URL_FILE" ] && { URL="$(cat "$URL_FILE")"; break; }; sleep 1; done
  echo
  TOKEN_VAL="$(grep '^CC_AUTH_TOKEN=' .env | cut -d= -f2-)"
  [ -n "$URL" ] || URL="(tunnel still starting — re-check ~/.cc-mobile/url.txt in a few seconds)"
  # Crisp, unmistakable hand-off block — an installing agent should relay this verbatim.
  echo "┌──────────────────────────────────────────────────────────────"
  bold "│ ✅ Box is up — REPORT THIS TO THE USER:"
  echo  "│   URL:   $URL"
  echo  "│   Token: $TOKEN_VAL"
  echo  "│   → Open the URL on your phone, enter the token, then Share → Add to Home Screen."
  [ "$NEED_CLAUDE_LOGIN" = 1 ] && bold "│   ⚠ LAST STEP: run 'claude' on this machine and log in (one-time browser sign-in)."
  echo "└──────────────────────────────────────────────────────────────"
  info "Voice + a Linear board are optional — add keys to .env and restart (pkill -f 'node server/index.mjs') to enable."
else
  bold "✅ Setup complete (not started)."
  echo "   Start it with:  ./scripts/keeper.sh &   (or reboot — the @reboot cron will)."
fi

echo
info "Logs: ~/.cc-mobile/server.log  +  ~/.cc-mobile/tunnel.log"
info "Re-run this script any time; it's idempotent."
