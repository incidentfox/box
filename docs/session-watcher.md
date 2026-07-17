# Session Watcher

The voice assistant can register Box sessions or background tasks for proactive
status updates. The server polls existing session/task status readers and emits
deduped watcher events into `/api/voice/updates`, so the browser's normal voice
notification queue announces them at a safe pause.

## What It Watches

Register through either surface:

```bash
POST /api/voice/watchers
{
  "query": "words from the session title",
  "triggers": ["finished", "needs_input", "blocked", "error", "pr_ready", "pr_merged"]
}
```

The Realtime voice layer exposes the same behavior as the `watch_session` tool.
It accepts `query`, exact `session_id`, or `task_id` from `check_tasks`.

Supported triggers:

- `finished` - a watched session/task moves from working/running to idle/done.
- `needs_input` - Box status changes to `needs_input`.
- `blocked` - status/text says the agent is blocked or waiting on Jimmy.
- `error` - failed task status or error-like output.
- `pr_ready` - output includes a GitHub PR URL or PR reference that is ready for review.
- `pr_merged` - output says the PR was merged, deployed, landed, or released.

## Noise Controls

The watcher stores a baseline snapshot at registration time and only emits future
transitions. Each event key is emitted once, each trigger type has a cooldown, and
a watcher expires automatically.

State and telemetry live under `~/.cc-mobile/voice-assistant/`:

- `session-watchers.json` - active watcher registrations and emitted keys.
- `session-watcher-events.jsonl` - registration, rearm, notification, expiry, and poll errors.

Environment knobs:

```bash
VOICE_SESSION_WATCHER_POLL_MS=12000
VOICE_SESSION_WATCHER_COOLDOWN_MS=120000
VOICE_SESSION_WATCHER_MAX_AGE_MS=28800000
```

## Deployment Notes

This is server-side code. After merging, fast-forward the canonical checkout and
restart the Box server process so `box-app.service` reloads `server/voice-assistant.mjs`.
No data migration is required; missing watcher state starts empty.
