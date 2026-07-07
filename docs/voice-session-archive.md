# Voice Session Archive Runbook

The voice assistant exposes `archive_session` for hands-free session cleanup.

- Use `scope: "idle_recent"` when Jimmy asks to clean up stale sessions.
- Use `query` when he names one session.
- The tool only archives sessions whose status is `idle`, `finished`, `done`, or `completed`.
- It refuses `working`, `live`, and `needs_input` sessions and returns a narration-ready reason.
- Archive actions are reversible metadata changes. They call the same session archive endpoint used by the UI.
- Audit rows are appended to `STATE_DIR/voice-assistant/session-archive-audit.jsonl`; rows include ids, titles, agents, statuses, and skip reasons, not transcript text.

For a no-mutation check, call the tool with `dry_run: true`.
