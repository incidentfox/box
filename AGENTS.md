# AGENTS.md — read this first

You're an AI agent looking at the **Box** repository. Box is a self-hosted web app that runs
real Claude Code / Codex sessions on a machine you control, driven from a phone (native chat
UI, voice, files, skills, always-on). This file (and `CLAUDE.md`) are auto-loaded so you know
what to do — most likely the user just told you to **"install this."**

## 👉 If you were told to "install this" (or set up / deploy / get Box running)

**Follow [`INSTALL.md`](INSTALL.md) step by step — it's written for you.** Short version:

1. **Be on the host.** Box must be installed on the machine that will RUN it (a server / VPS /
   always-on box, or the user's own machine for local use).
   - If this repo **isn't cloned yet**: `git clone https://github.com/incidentfox/box.git && cd box`
   - If there's **no server yet** and you have computer use: `concierge/10-provision-server.md`.
2. **Ask the user** the few choices in INSTALL.md (their name; voice? Linear board?) and
   collect any API keys (or use the `concierge/` prompts to fetch them).
3. **Run the installer:** `./install.sh` (or `./install.sh --yes` after you've written `.env`).
   It's idempotent — safe to re-run if a prerequisite was missing.
4. **Verify, then report:** `curl -s -H "Authorization: Bearer $TOKEN" localhost:$PORT/api/config`
   should return JSON; the public URL is in `~/.cc-mobile/url.txt`. Give the user the **URL +
   token** and tell them: *open it on your phone → enter the token → Add to Home Screen.*

## What you can do depends on what kind of agent you are

- **Terminal coding agent (Claude Code / Codex CLI):** you can run every shell step. You
  **cannot** complete the interactive `claude` browser login — ask the user to run `claude`
  once and log in. (Box drives the user's logged-in CLI; no API key needed on a subscription.)
- **Computer-use agent (browser + desktop):** you can *also* do the browser parts — complete
  the `claude` login OAuth yourself, sign up for API keys (`concierge/20-api-keys.md`), set up
  Linear (`concierge/30-linear.md`), even provision a server (`concierge/10-provision-server.md`).
  **Stop and ask the user before anything that costs money** (paid plans, a VPS, a domain).

## Guardrails

- Treat API keys/tokens like passwords. Put them only in `.env` (gitignored); never commit or echo them.
- Don't expose anything publicly except through the built-in Cloudflare tunnel.
- `install.sh` defaults the harness to `bypassPermissions` (so the box can work hands-off);
  mention this to the user — they can dial it back in `~/.claude/settings.json`.

## Contributing — `main` is protected: **PR-only**

`main` on `incidentfox/box` is a **protected branch** — direct pushes are rejected (admins
included), force-pushes/deletions blocked. **Never push to `main`; ship every change through a
pull request.** No approval is required (0 reviewers), so you can merge your own PR; the gate just
enforces that a PR was used, and there's no CI to wait on. Branch off the latest `main` (ideally a
worktree), then `gh pr create --fill && gh pr merge --auto --squash --delete-branch` (auto-merge is
enabled; squash convention → `box: … (#N)`). For deploying server changes to a live host (reconcile
the canonical checkout + restart so the keeper respawns), see the **Contributing** section of
`CLAUDE.md`.

## If you're just exploring the code

See `README.md` for the architecture: `server/index.mjs` is the backend, `public/` the
frontend (plain JS, no build), `scripts/keeper.sh` the always-on supervisor, `harness/` the
optional Claude Code harness. Note: `harness/CLAUDE.md` is the operating-pattern guide meant
to be copied into the *user's own* code directory — it is not about this repo.
