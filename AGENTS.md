# Box — repository instructions

Box runs real Claude Code / Codex sessions on a machine the user controls, with a phone UI,
voice, files, skills, and an optional operating harness.

## First installation

When installing Box on a new host, follow [`INSTALL.md`](INSTALL.md). Ask only for setup choices
or credentials that are missing from the current context. Verify the installation and report the
public URL from `~/.cc-mobile/url.txt`; explain how the user can retrieve the access token locally
without printing it in chat or logs. Existing-host updates use the contributing workflow below.

For CLI authentication, use the available terminal/browser capabilities and existing login state.
Ask the user to complete a login step only when it requires their interaction. The `concierge/`
guides cover optional server provisioning, API keys, and Linear setup. Stop and ask before anything
that costs money (paid plans, a VPS, a domain).

## Guardrails

- Treat API keys/tokens like passwords. Put them only in `.env` (gitignored); never commit or echo them.
- Don't expose anything publicly except through the built-in Cloudflare tunnel.
- `install.sh` defaults the harness to `bypassPermissions` (so the box can work hands-off);
  mention this to the user — they can dial it back in `~/.claude/settings.json`.

## Contributing — `main` is protected: **PR-only**

`main` on `incidentfox/box` is a **protected branch** — direct pushes are rejected (admins
included), force-pushes/deletions blocked. **Never push to `main`; ship every change through a
pull request.** No approval is required (0 reviewers), so you can merge your own PR; the gate just
enforces that a PR was used. Run the checks relevant to the change and wait for CI before merging;
`.github/workflows/ci.yml` defines the current CI checks. Branch off the latest `main` in an isolated
worktree, then `gh pr create --fill && gh pr merge --auto --squash --delete-branch` (auto-merge is
enabled; squash convention → `box: … (#N)`). For deploying server changes to a live host (reconcile
the canonical checkout + restart so the keeper respawns), see the **Contributing** section of
`CLAUDE.md`.

## If you're just exploring the code

See `README.md` for the architecture: `server/index.mjs` is the backend, `public/` the
frontend (plain JS, no build), `scripts/keeper.sh` the always-on supervisor, `harness/` the
optional Claude Code harness. Note: `harness/CLAUDE.md` is the operating-pattern guide meant
to be copied into the *user's own* code directory — it is not about this repo.
