# Slack Activity Events

Box can poll Slack and write relevant messages into the local factory activity
stream at `~/.factory/events.jsonl`. The event writer uses the same Slack
configuration as the voice assistant and `harness/slack.mjs` tools.

## Manual Commands

```bash
node harness/slack.mjs recent 5
node harness/slack.mjs emit-recent
node harness/slack.mjs emit-recent --emit-existing
```

`emit-recent` records seen message IDs in `~/.cc-mobile/slack-events.json`.
On a fresh state it seeds the cursor without emitting old messages. Use
`--emit-existing` only when intentionally backfilling the current recent window.

Useful environment variables:

```bash
SLACK_USER_TOKEN=xoxp-or-xoxc-token
SLACK_BOT_TOKEN=xoxb-token
SLACK_COOKIE=xoxd-cookie-for-xoxc-token
SLACK_CHANNELS="#ops,C123..."
SLACK_CONTEXT_MAX_MESSAGES=12
SLACK_EVENT_MAX_PER_RUN=10
```

## Install On A Box

From the canonical checkout:

```bash
node scripts/install-slack-events.mjs
systemctl --user daemon-reload
systemctl --user enable --now box-slack-events.timer
systemctl --user start box-slack-events.service
systemctl --user list-timers box-slack-events.timer
```

The timer runs every five minutes. The service reads optional local overrides
from `~/.config/box/slack-events.env`, while the factory box deployment can also
load Slack credentials from `/run/software-factory/secrets.env` through
`harness/slack.mjs`.
