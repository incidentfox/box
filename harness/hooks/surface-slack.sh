#!/usr/bin/env bash
# SessionStart hook — surface bounded recent Slack context for new interactive sessions.
# Requires a Slack Web API token in the environment / Box .env / EXTRA_ENV_FILE:
# SLACK_USER_TOKEN, SLACK_BOT_TOKEN, or SLACK_TOKEN. With no token, this is silent.

bash "$HOME/.claude/hooks/_skip-automated.sh" && exit 0

HARNESS_DIR="${BOX_HARNESS_DIR:-$HOME/.claude/box-harness}"
[ -f "$HARNESS_DIR/slack.mjs" ] || exit 0

CTX="$(node "$HARNESS_DIR/slack.mjs" context 2>/dev/null || true)"
[ -n "$CTX" ] || exit 0

printf '\n<slack_context>\n%s\n</slack_context>\n' "$CTX"
