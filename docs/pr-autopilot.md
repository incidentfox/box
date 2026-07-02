# Box PR Autopilot

Box has a local PR gate for this repository. It is intentionally box-side, not
GitHub-hosted, because the important smoke test is "can this checkout start Box
and get one agent response?"

## What It Does

`scripts/pr-autopilot.mjs` checks every open PR to `main`:

1. clones/checks out the PR in `~/.cache/box-pr-autopilot`;
2. runs `npm test`;
3. starts `server/index.mjs` on a temporary port with a temporary `HOME`;
4. opens `/ws`, subscribes to a new chat, sends one prompt, and waits for a
   response;
5. asks Codex for a read-only PR review;
6. posts a GitHub commit status and PR comment;
7. squash-merges passing PRs when auto-merge is enabled;
8. emits a harness event after merge so active agents know `main` changed.

The smoke uses a real Codex turn for same-repository or trusted PRs. Fork PRs use
a fake Codex executable by default, so untrusted server code is not given the live
Codex auth directory just to prove the WebSocket/chat plumbing still works.

## Manual Commands

```bash
npm test
npm run smoke:chat
npm run pr:autopilot
node scripts/pr-autopilot.mjs --once --dry-run
```

Useful environment variables:

```bash
BOX_PR_REPO=incidentfox/box
BOX_PR_AUTO_MERGE=1
BOX_PR_REAL_MODEL=trusted       # trusted | always | never
BOX_PR_TRUSTED_AUTHORS=alice,bob
BOX_PR_PROCESS_UNTRUSTED_FORKS=0
BOX_PR_REVIEW_MODEL=gpt-4.1-mini
BOX_PR_SMOKE_MODEL=gpt-4.1-mini
BOX_PR_EVENT_EMITTER=/home/factory/development/software-factory/harness/emit-event.mjs
BOX_PR_DRY_RUN=1
```

Add a `no-automerge` or `do-not-merge` label to keep the bot from merging a PR.
Draft PRs are skipped. Fork PRs are skipped unless the PR author or head repo
owner is listed in `BOX_PR_TRUSTED_AUTHORS`, or `BOX_PR_PROCESS_UNTRUSTED_FORKS=1`
is set.

## Install On A Box

From the canonical checkout:

```bash
node scripts/install-pr-autopilot.mjs
systemctl --user daemon-reload
systemctl --user enable --now box-pr-autopilot.timer
systemctl --user list-timers box-pr-autopilot.timer
```

The timer runs every three minutes. It does not fast-forward the live checkout
after a merge; it emits an event instead. Active agents should fetch/rebase their
own worktrees when they are ready.
