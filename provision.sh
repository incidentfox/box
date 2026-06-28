#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Box provision — run from your LAPTOP to turn a server you can SSH into into a Box.
#
#    ./provision.sh user@your-server                 # basic
#    ./provision.sh user@your-server --key ~/.ssh/id_ed25519
#    ./provision.sh user@your-server -- --no-harness # pass args through to install.sh
#
#  It runs bootstrap.sh on the server over SSH (with a TTY), which installs everything
#  and starts Box. The one remaining step is logging in: SSH in and run `claude` once.
#
#  (Don't have a server at all? See concierge/00-install-this.md to have a computer-use
#  agent rent + set one up for you.)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

TARGET="${1:-}"; shift || true
[ -n "$TARGET" ] || { echo "usage: ./provision.sh user@host [--key <ssh_key>] [-- <install.sh args>]"; exit 1; }

KEY=(); EXTRA=()
while [ $# -gt 0 ]; do case "$1" in
  --key) shift; KEY=(-i "$1") ;;
  --) shift; EXTRA=("$@"); break ;;
  *) EXTRA+=("$1") ;;
esac; shift || true; done

RAW="https://raw.githubusercontent.com/incidentfox/box/main/bootstrap.sh"
echo "→ provisioning Box on $TARGET (installs deps + clones + starts) ..."
ssh -t "${KEY[@]}" "$TARGET" "curl -fsSL $RAW | bash -s -- ${EXTRA[*]:-}"
echo
echo "✅ Done. If Box reported it needs a login, SSH in and run:  claude   (one-time browser sign-in)."
echo "   Your Box URL + token were printed above (also in ~/.cc-mobile/url.txt and ~/box/.env on the server)."
