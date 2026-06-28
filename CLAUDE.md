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
