#!/usr/bin/env bash
# cc-rc-supervisor: keep registered Claude sessions alive AND connected on Remote Control.
#
# Two failure modes are handled:
#   1. Dead session  - the dtach socket is gone (process died). Relaunch, resume by id.
#   2. Stale RC       - the process is alive but its Remote Control transport dropped
#                       and didn't recover (the "alive but not on the surface" case).
#                       Detected from the per-session --debug-file [remote-bridge] log:
#                       if the latest transport event is a disconnect/error that has
#                       persisted past STALE_SECS, the session is recycled.
#
# Fail-safe by design: if there is no debug signal, or the latest transport event is a
# healthy "connected", the session is left ALONE -- a healthy/working session is never
# bounced. Idempotent; safe on a 2-min cron tick.
#
# Token note: unset the inference-only vault token + API key so claude uses the FULL
# Max OAuth login (full scope -> Remote Control allowed). See box-claude-token-env-conflict.
set -uo pipefail
export PATH="$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
REG="${CC_RC_REGISTRY:-$HOME/.config/cc-rc-sessions.tsv}"
STATE_DIR="${BOX_STATE_DIR:-$HOME/.cc-mobile}"
LOG="$STATE_DIR/cc-rc-supervisor.log"
DBGDIR="$STATE_DIR/rc-debug"
CLAUDE="$(command -v claude || echo /usr/bin/claude)"
STALE_SECS="${CC_RC_STALE_SECS:-90}"   # how long RC must be down before recycling
DBG_MAX_BYTES=$((25*1024*1024))        # truncate a debug log past this size
mkdir -p "$(dirname "$LOG")" "$DBGDIR" 2>/dev/null || true
log(){ echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG" 2>/dev/null; }

[ -f "$REG" ] || { log "no registry at $REG"; exit 0; }
[ -x "$CLAUDE" ] || { log "claude binary missing at $CLAUDE"; exit 1; }

# A dtach socket counts as live only if some process still holds it open.
socket_live(){
  local s="$1"
  [ -S "$s" ] || return 1
  if command -v fuser >/dev/null 2>&1; then
    fuser "$s" >/dev/null 2>&1 && return 0 || return 1
  fi
  pgrep -af "dtach .*${s}" >/dev/null 2>&1
}

# ISO8601 ("2026-06-02T14:52:56.569Z") at start of a debug line -> epoch seconds.
ts_epoch(){ date -d "$1" +%s 2>/dev/null || echo 0; }

# Return 0 (stale) only when the debug log's latest RC transport event is a
# disconnect/error AND it has been down longer than STALE_SECS. Any uncertainty
# (no log, parse failure, latest event healthy) returns 1 (leave it alone).
rc_stale(){
  local name="$1" dbg="$DBGDIR/${name}.log"
  [ -f "$dbg" ] || return 1
  local good bad gt=0 bt=0 now
  good=$(grep -aE '\[remote-bridge\].*(transport connected|Created session)' "$dbg" 2>/dev/null | tail -1 | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z' | head -1)
  bad=$(grep -aiE '\[remote-bridge\].*(disconnect|transport closed|transport error|transport failed|connection error|reconnect)' "$dbg" 2>/dev/null | tail -1 | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z' | head -1)
  [ -n "$bad" ] || return 1                      # never disconnected -> healthy
  bt=$(ts_epoch "$bad"); [ "$bt" -gt 0 ] || return 1
  [ -n "$good" ] && gt=$(ts_epoch "$good")
  now=$(date +%s)
  [ "$bt" -gt "$gt" ] && [ $(( now - bt )) -gt "$STALE_SECS" ]   # latest event is the drop, and it stuck
}

# Kill the dtach master + claude child bound to a socket/name, then clear the socket.
kill_session(){
  local name="$1" sock="$2"
  command -v fuser >/dev/null 2>&1 && fuser -k "$sock" >/dev/null 2>&1
  pkill -f "claude --resume .* --remote-control ${name} " >/dev/null 2>&1
  sleep 2
  command -v fuser >/dev/null 2>&1 && fuser -k -KILL "$sock" >/dev/null 2>&1
  rm -f "$sock"
}

launch_session(){
  local name="$1" dir="$2" id="$3" sock="$4" dbg="$DBGDIR/${name}.log"
  # keep debug logs bounded
  if [ -f "$dbg" ] && [ "$(stat -c%s "$dbg" 2>/dev/null || echo 0)" -gt "$DBG_MAX_BYTES" ]; then
    tail -n 3000 "$dbg" > "$dbg.tmp" 2>/dev/null && mv "$dbg.tmp" "$dbg"
  fi
  # ensure the session jsonl is resolvable from this dir's project folder (resume looks there)
  local proj src
  proj="$HOME/.claude/projects/$(printf '%s' "$dir" | sed 's#/#-#g')"
  if [ ! -f "$proj/$id.jsonl" ]; then
    src=$(ls "$HOME/.claude/projects"/*/"$id.jsonl" 2>/dev/null | head -1)
    [ -n "$src" ] && { mkdir -p "$proj"; cp -n "$src" "$proj/$id.jsonl"; }
  fi
  (
    cd "$dir" || exit 1
    unset CLAUDE_CODE_OAUTH_TOKEN CLAUDE_OAUTH_TOKEN ANTHROPIC_API_KEY
    exec setsid dtach -n "$sock" -r winch -z \
      "$CLAUDE" --resume "$id" --remote-control "$name" \
      --debug-file "$dbg" --dangerously-skip-permissions
  ) >/dev/null 2>&1
}

launched=0; recycled=0; gc=0; GC_NAMES=()
while IFS=$'\t' read -r name dir id flag created; do
  case "$name" in ''|'#'*) continue;; esac
  [ -n "$dir" ] && [ -n "$id" ] || { log "bad row: name=$name dir=$dir id=$id"; continue; }
  [ -d "$dir" ] || { log "skip $name: dir missing ($dir)"; continue; }
  sock="/tmp/cc-rc-${name}.dtach"
  is_ephemeral=0; case "$flag" in *ephemeral*) is_ephemeral=1;; esac

  if socket_live "$sock"; then
    # Process alive — reconnect RC only if its transport is stuck down. Same policy for
    # curated and ephemeral: "auto-resume remote-control when it drops, for LIVE sessions".
    if rc_stale "$name"; then
      log "RC stale for $name (down > ${STALE_SECS}s) -> recycling"
      kill_session "$name" "$sock"
      recycled=$((recycled+1))
    else
      continue
    fi
  elif [ "$is_ephemeral" = 1 ]; then
    # Socket dead + ephemeral (a `cnew` parallel session): it has ENDED — do NOT
    # resurrect it (that's the curated rows' job). GC the registry row once it's been
    # gone past a grace window keyed off createdEpoch, so a session still booting (row
    # written, socket not up yet) is never culled. Unknown/empty epoch -> wait, don't cull.
    now=$(date +%s)
    case "$created" in
      ''|*[!0-9]*)
        # transition-era row with no createdEpoch — fall back to the session's jsonl mtime
        jf=$(ls "$HOME/.claude/projects"/*/"$id.jsonl" 2>/dev/null | head -1)
        if [ -n "$jf" ]; then age=$(( now - $(stat -c %Y "$jf" 2>/dev/null || echo "$now") )); else age=0; fi
        ;;
      *) age=$(( now - created ));;
    esac
    if [ "$age" -gt 180 ]; then
      log "GC ephemeral $name (gone ${age}s) -> dropping from registry"
      GC_NAMES+=("$name"); gc=$((gc+1))
    else
      log "ephemeral $name socket down but young (${age}s) -> grace, waiting"
    fi
    continue
  fi

  [ -e "$sock" ] && { rm -f "$sock"; }
  log "launching $name (resume ${id:0:8}) in $dir"
  launch_session "$name" "$dir" "$id" "$sock"
  launched=$((launched+1))
done < "$REG"

# Prune GC'd ephemeral rows. Re-read $REG fresh (an awk pass) so a cnew append that
# landed during this tick is preserved; match only on the first tab-field (rcName).
if [ "${#GC_NAMES[@]}" -gt 0 ]; then
  tmp=$(mktemp 2>/dev/null) || tmp=""
  if [ -n "$tmp" ]; then
    if awk -F'\t' -v names="$(printf '%s\n' "${GC_NAMES[@]}")" '
         BEGIN { n=split(names, a, "\n"); for (i=1;i<=n;i++) if (a[i]!="") drop[a[i]]=1 }
         /^#/ || $1=="" { print; next }
         drop[$1] { next }
         { print }' "$REG" > "$tmp" 2>/dev/null; then
      mv "$tmp" "$REG"
    else
      rm -f "$tmp"
    fi
  fi
fi

log "tick done (launched=$launched recycled=$recycled gc=$gc)"
exit 0
