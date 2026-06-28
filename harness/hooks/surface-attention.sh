#!/usr/bin/env bash
# SessionStart hook — surface your open "needs you" items at the top of every new session,
# so a decision you owe yourself can't get lost across compaction / new chats.
#
# Backed by Linear: items are issues on your team labelled with NEEDS_LABEL (default
# "needs-me"). Requires LINEAR_API_KEY + LINEAR_TEAM_KEY in the environment; if they're
# unset, this prints nothing and is a harmless no-op.
#
# Output is injected into the session context.

# Only for real interactive sessions — never inside `claude -p` automation.
bash "$HOME/.claude/hooks/_skip-automated.sh" && exit 0

# Resolve this repo's harness dir so the hook works regardless of where it's symlinked from.
HARNESS_DIR="${BOX_HARNESS_DIR:-$HOME/.claude/box-harness}"
[ -f "$HARNESS_DIR/needs-me.mjs" ] || exit 0
node "$HARNESS_DIR/needs-me.mjs" --list 2>/dev/null || exit 0
