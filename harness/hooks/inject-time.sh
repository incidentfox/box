#!/usr/bin/env bash
# UserPromptSubmit hook — give the agent CURRENT-TIME awareness on every user message.
#
# Without this, the agent can't tell whether you replied 30 seconds or 10 hours later and
# drifts into assuming one continuous session / a stale date. stdout from a UserPromptSubmit
# hook is injected as context ahead of the prompt, so this stamps every message with the time.
#
# Set TZ to your timezone (e.g. America/New_York). Defaults to the system timezone.

# Only for real interactive sessions — never inside `claude -p` automation.
bash "$HOME/.claude/hooks/_skip-automated.sh" && exit 0

TZ="${BOX_TZ:-${TZ:-}}" date "+Current time (your timezone): %A, %B %-d %Y, %-I:%M %p %Z. Treat this as authoritative for \"now\"; do not assume a single continuous session or carry over a stale date from earlier in the conversation."
