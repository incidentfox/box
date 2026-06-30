# Box — repository guide for Claude Code

This is the **Box** source: a self-hosted web app that runs real Claude Code / Codex sessions
on this machine, driven from a phone. This file is auto-loaded, so if the user just said
something short like *"install this"*, you already know what they mean.

## 👉 If the user asks you to install / set up / deploy Box

**Follow [`INSTALL.md`](INSTALL.md)** — a step-by-step playbook written for you. In short:
collect the user's choices + any API keys, run `./install.sh`, verify, and report the phone
**URL + access token**. See [`AGENTS.md`](AGENTS.md) for the full quick-start and the capability
notes — most importantly: a **terminal** agent (you) can't complete the interactive `claude`
browser login, so ask the user to run `claude` once and log in; a computer-use agent can do it.

## Contributing — `main` is protected: **every change ships via a PR**

`main` on `incidentfox/box` is a **protected branch**: direct pushes are rejected (for everyone,
admins included), and force-pushes / branch deletion are blocked. So **never hand-patch `main` or
push to it directly — open a pull request.** No review is required (0 approvals), so you can merge
your own PR immediately; the gate only enforces *that a PR was used*. There's no CI, so nothing
else blocks the merge. (This rule exists because a directly-merged change once broke the app and
un-PR'd edits got left in the live tree — the PR trail is the record + the safety net.)

The loop for any change:

1. **Branch off the latest `main`, in your own worktree** (so parallel agents don't share a tree):
   `git fetch origin && git worktree add <dir> -b <type>/<short-desc> origin/main`
2. **Commit**, then **open + merge the PR** (squash is the convention; titles read `box: … (#N)`):
   ```
   gh pr create --fill
   gh pr merge --auto --squash --delete-branch   # repo auto-merge is enabled
   ```
3. **Deploy** *(server changes only — `public/` is served from disk, no restart needed)*: the live
   app runs from the canonical checkout under `box-app.service`. Reconcile it to `main`, then let
   the keeper respawn the server:
   ```
   git -C <canonical> fetch origin && git -C <canonical> merge --ff-only origin/main
   pkill -f "node server/index.mjs"   # keeper restarts it in ~30s; dtach bridges survive
   ```
   ⚠️ Before reconciling, check the canonical tree isn't dirty with un-PR'd edits (`git status`);
   if it is, **fast-forward — don't `reset --hard`** — so you don't discard someone's work.

**Emergency override** (rare, admin only): lift protection in Settings → Branches, or
`gh api -X DELETE repos/incidentfox/box/branches/main/protection`, push, then re-apply it.

## Otherwise

This is just the app source — see `README.md` (backend `server/index.mjs`, frontend `public/`,
supervisor `scripts/keeper.sh`, optional harness in `harness/`). Keys live only in `.env`
(gitignored) — never commit or echo them.

### Linear: real workspace OR the built-in local clone (`lib/linear-lite/`)

The Board + "needs you" inbox don't require a Linear account. With **no `LINEAR_API_KEY`**, the
server boots a local, SQLite-backed clone of the slice of Linear's GraphQL the app uses
(`lib/linear-lite/`, DB at `~/.cc-mobile/linear-lite.db`). The seam is one function:
`linearGql()` in `server/index.mjs` routes to `linearLite.gql()` in local mode, else to
`api.linear.app`. `harness/needs-me.mjs` falls back to the same DB. `bin/linear-lite.mjs import`
pushes local issues into a real Linear when the user connects one. `LINEAR_LOCAL=off` disables
the Board instead of falling back. Contract test: `node lib/linear-lite/test.mjs` (replays the
exact query strings the server sends — keep it in sync if you change a Linear query).

> ⚠️ This box exports `EXTRA_ENV_FILE` / `LINEAR_API_KEY`, so a plain `node server/index.mjs`
> here talks to the **real** IncidentFox Linear. To exercise LOCAL mode, unset those:
> `env -u EXTRA_ENV_FILE -u LINEAR_API_KEY -u LINEAR_TEAM_ID -u NEEDS_LABEL HOME=<tmp> PORT=<alt> node server/index.mjs`.

> ⚠️ **Never boot a second server against the live `STATE_DIR` (`~/.cc-mobile`).** It's hard-coded
> (not env-overridable), so a throwaway instance shares the SAME state files as the running app.
> Two processes doing read-modify-write on e.g. `archived.json` can tear a non-atomic write and
> wipe it (this happened once — 350 archived ids → 6). State writes are now atomic (`writeJsonAtomic`),
> but still: to test locally, point `HOME` at an isolated dir (symlink in `.claude`/`.cargo`, fresh
> `.cc-mobile`) and use an alt `PORT`, and never fire write endpoints (`POST /archive`, rename, etc.)
> from a test instance.

> Don't confuse this file with `harness/CLAUDE.md`: that one is the *operating-pattern* guide
> meant to be copied into the **user's own** working directory, not this repo.
