#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Box remote bootstrap — turn a FRESH Linux server into a Box in one command.
#
#  On the server (or piped in over SSH):
#    curl -fsSL https://raw.githubusercontent.com/incidentfox/box/main/bootstrap.sh | bash
#
#  From your laptop, against a server you can SSH into:
#    ssh -t user@your-server 'curl -fsSL https://raw.githubusercontent.com/incidentfox/box/main/bootstrap.sh | bash'
#
#  It installs git + Node + the claude CLI, clones Box, and runs ./install.sh (which
#  handles dtach, cloudflared, deps, .env, the harness, the @reboot keeper, and the
#  tunnel). The only manual step left is logging in: run `claude` once.
#
#  Env overrides: BOX_REPO (git url), BOX_DIR (clone dir, default ~/box),
#  BOX_BRANCH (default main). Extra args are passed through to install.sh.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="${BOX_REPO:-https://github.com/incidentfox/box.git}"
DEST="${BOX_DIR:-$HOME/box}"
BRANCH="${BOX_BRANCH:-main}"

say(){ printf '\033[1m• %s\033[0m\n' "$*"; }

PM=""
if   command -v apt-get >/dev/null 2>&1; then PM="apt"
elif command -v brew    >/dev/null 2>&1; then PM="brew"
elif command -v dnf     >/dev/null 2>&1; then PM="dnf"
elif command -v pacman  >/dev/null 2>&1; then PM="pacman"
fi
SUDO=""; [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"
pkg(){ case "$PM" in
  apt) $SUDO apt-get update -qq >/dev/null 2>&1; $SUDO apt-get install -y -qq "$@" >/dev/null 2>&1 ;;
  brew) brew install "$@" >/dev/null 2>&1 ;;
  dnf) $SUDO dnf install -y -q "$@" >/dev/null 2>&1 ;;
  pacman) $SUDO pacman -Sy --noconfirm "$@" >/dev/null 2>&1 ;;
  *) return 1 ;;
esac; }

say "Box bootstrap → $DEST (from $REPO)"

# 1) git + curl
command -v git  >/dev/null 2>&1 || { say "installing git";  pkg git  || true; }
command -v curl >/dev/null 2>&1 || pkg curl || true

# 2) Node 18+
if ! command -v node >/dev/null 2>&1 || [ "$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)" -lt 18 ]; then
  say "installing Node 20"
  case "$PM" in
    apt) curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - >/dev/null 2>&1; pkg nodejs ;;
    brew) pkg node ;;
    *) pkg nodejs || true ;;
  esac
fi
command -v node >/dev/null 2>&1 || { echo "✗ Node 18+ required but could not be installed. Install it and re-run." >&2; exit 1; }

# 3) claude CLI (install.sh also does this, but do it up front so the login hint is early)
command -v claude >/dev/null 2>&1 || { say "installing claude CLI"; npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || $SUDO npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || true; }

# 4) clone or update
if [ -d "$DEST/.git" ]; then
  say "updating existing clone"; git -C "$DEST" fetch -q origin "$BRANCH" && git -C "$DEST" checkout -q "$BRANCH" && git -C "$DEST" pull -q --ff-only || true
else
  say "cloning"; git clone -q --branch "$BRANCH" "$REPO" "$DEST"
fi

# 5) run the full installer (non-interactive when piped; pass through any extra args)
cd "$DEST"
say "running ./install.sh"
exec bash install.sh "$@"
