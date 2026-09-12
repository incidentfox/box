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
   then terminate only that verified PID so the keeper respawns it. Preserve the keeper and unrelated
   session bridges; inspect the server unit's kill scope and preserve queue/recovery state as described
   in that procedure. Verify the replacement process and affected local/public workflow before completion.

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

**Never boot a second server against the live `STATE_DIR` (`~/.cc-mobile`).** State is rooted
in `HOME`; atomic writes do not make two servers safe against the same state. Clearing inherited
Linear variables alone is insufficient: the server also reads the checkout's `.env` and its
`EXTRA_ENV_FILE`. For local state/Linear endpoint tests, start from the repo with a fresh home and
clean environment, disable repository/host credential loading, and select an unused alternate port:

```bash
test_home=$(mktemp -d)
test_port=17321 # verify this port is unused before starting
test_token=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
mkdir -p "$test_home/workspace"
env -i PATH="$PATH" HOME="$test_home" PORT="$test_port" \
  CC_AUTH_TOKEN="$test_token" CC_WORKSPACE="$test_home/workspace" \
  BOX_IGNORE_LOCAL_ENV=1 BOX_HOST_SECRETS_FILE=/dev/null BOX_SKIP_META_PROBE=1 \
  BOX_TEAM=0 node server/index.mjs
```

Keep the test token private. Use synthetic fixtures under this home/workspace; do not symlink
live `.claude`, `.codex`, `.cc-mobile`, credential, or workspace directories into it. Verify the
test process's home/port and local SQLite mode before exercising write endpoints (archive, rename,
etc.); never target live state or real Linear. This isolates test configuration/state, not OS access:
do not launch agents or test host-management endpoints with this recipe. Stop only the test server
when finished.

> Don't confuse this file with `harness/CLAUDE.md`: that one is the *operating-pattern* guide
> meant to be copied into the **user's own** working directory, not this repo.
