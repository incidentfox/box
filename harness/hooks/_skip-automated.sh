#!/usr/bin/env bash
# Shared gate: exit 0 (=> the calling hook should SKIP) when this Claude session is an
# AUTOMATED / headless `claude -p` run rather than a real interactive session you started.
#
# Why: hooks like time-injection and attention-surfacing only make sense for interactive
# sessions; inside automation they waste tokens and pollute the prompt.
#
# Usage at the top of a hook:   bash "$HOME/.claude/hooks/_skip-automated.sh" && exit 0
#
# Set CC_AUTOMATED=1 wherever you spawn headless `claude -p` automations.

[ -n "$CC_AUTOMATED" ] && exit 0

# Add your own automation working-dir markers here if you run scheduled agents in
# dedicated directories, e.g.:  *cron-agent*|*nightly-*)
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
case "$dir" in
  *box-automation*) exit 0 ;;
esac
exit 1
