# Box — repository guide for Claude Code

This is the **Box** source: a self-hosted web app that runs real Claude Code / Codex sessions
on this machine, driven from a phone. Use the installation or contribution workflow that
matches the requested task.

## First installation

Use [`INSTALL.md`](INSTALL.md) when installing Box on a new host. See [`AGENTS.md`](AGENTS.md)
for credential handling, interactive login, and setup boundaries. For updates to an existing host,
use the contributing workflow below.

## Contributing — `main` is protected: **every change ships via a PR**

`main` on `incidentfox/box` is a **protected branch**: direct pushes are rejected (for everyone,
admins included), and force-pushes / branch deletion are blocked. So **never hand-patch `main` or
push to it directly — open a pull request.** No review is required (0 approvals), so you can merge
your own PR once relevant local checks and CI pass. `.github/workflows/ci.yml` defines the
current CI checks. (This rule exists because a directly-merged change once broke the app and
un-PR'd edits got left in the live tree — the PR trail is the record + the safety net.)

For changes whose scope includes shipping, finish this workflow. Honor an explicit edit-only or
review-only request:

1. **Branch off the latest `main`, in your own worktree** (so parallel agents don't share a tree):
   `git fetch origin && git worktree add <dir> -b <type>/<short-desc> origin/main`
2. **Commit**, then **open + merge the PR** (squash is the convention; titles read `box: … (#N)`):
   ```
   gh pr create --fill
   gh pr merge --auto --squash --delete-branch   # repo auto-merge is enabled
   ```
3. **Deploy**: the live app runs from the canonical checkout under `box-app.service`. Inspect
   the service's `WorkingDirectory` and canonical `git status`, then reconcile the intended merged
   source with a fast-forward. Preserve unrelated edits; never use `reset --hard` to reconcile.
   Server changes also require a restart (`public/` is served from disk): identify the actual server
   Node process using the [scoped restart procedure](README.md#restarting-an-existing-installation),
   then terminate only that verified PID so the keeper respawns it. Preserve the keeper and session
   bridges. Verify the replacement process and the affected local/public workflow before reporting completion.

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
> `.cc-mobile`) and use an alt `PORT`. Exercise write endpoints (`POST /archive`, rename, etc.) only
> against verified isolated test state and synthetic records; never against the live state or real Linear.

> Don't confuse this file with `harness/CLAUDE.md`: that one is the *operating-pattern* guide
> meant to be copied into the **user's own** working directory, not this repo.
