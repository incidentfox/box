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

> Don't confuse this file with `harness/CLAUDE.md`: that one is the *operating-pattern* guide
> meant to be copied into the **user's own** working directory, not this repo.
