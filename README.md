<div align="center">

# 📦 Box

**Your own always-on Claude Code, in your pocket.**

Box is a self-hosted web app that runs **real Claude Code (and Codex) sessions on your own
server** and lets you drive them from your phone as a clean, native chat UI — with voice,
file attach, `/skills`, a session list, and a task board. Fire off *"work this task
autonomously"* from a coffee shop; come back to a finished result you can ship.

</div>

---

## Why it's good

- **Real sessions, not a toy.** Every chat is a genuine `claude --remote-control` session on
  your machine — the same session is live on your desktop and in the official app at once.
- **Made for phones.** Chat bubbles, streaming, voice input, image attach, `@file` and
  `/skill` pickers, a composer that behaves above the keyboard. Add it to your home screen
  and it's an app (PWA).
- **Always on.** A keeper process + a Cloudflare tunnel keep it reachable with **no open
  ports and no domain required** — you get a public `https://…trycloudflare.com` URL for free.
- **Codex too.** If the `codex` CLI is installed, Codex chats show up alongside Claude.
- **The harness is the magic.** Optional hooks + an operating-pattern `CLAUDE.md` make
  hands-off *"work this ticket → merge & deploy → file the leftovers"* sessions actually work.
- **Optional task board.** Plug in a free Linear account to get an in-app kanban board and a
  *"needs you"* inbox for the decisions only you can make.

## Install it in one move

Clone the repo, start an agent inside it, and tell it to install:

```bash
git clone https://github.com/<you>/box.git
cd box
claude        # or: codex
```
then say:
> **install this**

The agent reads [`INSTALL.md`](INSTALL.md), asks you the handful of things only you can
decide (your name, whether you want voice / a task board), collects any API keys, and sets
everything up — printing your phone URL and access token at the end.

### …or just run the installer

```bash
./install.sh
```

It checks prerequisites (and installs what it can), runs `npm install`, generates an access
token, starts the server behind a Cloudflare quick-tunnel, and prints your URL + token. Safe
to re-run. Flags: `--yes` (non-interactive), `--no-harness`, `--no-cron`, `--no-start`,
`--port N`.

## Requirements

- A machine that's on when you want to reach it (a small VPS is perfect — see
  [`concierge/10-provision-server.md`](concierge/10-provision-server.md)). Linux or macOS.
- **Node 18+**, **git**, **dtach** — the installer adds these if missing.
- The **`claude` CLI**, logged in (`npm i -g @anthropic-ai/claude-code`, then run `claude`
  once). Box drives your logged-in CLI; **it does not need an API key** if you're on a Claude
  subscription. `codex` is optional.
- **cloudflared** for the public tunnel — the installer adds it; without it, Box runs
  local-only.

## Configuration

Everything is optional except the access token (auto-generated). Edit `.env` (see
[`.env.example`](.env.example)) and restart (`pkill -f "node server/index.mjs"`; the keeper
respawns it):

| Key | What it does |
|---|---|
| `CC_AUTH_TOKEN` | The password you type to log in. Auto-generated if blank. |
| `PORT` | Server port (default `7321`). |
| `CC_WORKSPACE` | Default directory for new chats / where `/skills` are scanned. |
| `OWNER_NAME` | Your name, used in the per-session morning brief. |
| `TUNNEL_MODE` | `quick` (free random URL, default), `named` (your domain), or `none`. |
| `ELEVENLABS_API_KEY` / `DEEPGRAM_API_KEY` | Enable voice input (optional). |
| `LINEAR_API_KEY` + `LINEAR_TEAM_ID` + `LINEAR_TEAM_KEY` + `NEEDS_LABEL` | Enable the Board + "needs you" inbox (optional). |

When an integration isn't configured, its UI hides itself — Box stays a clean chat app.

## The harness (optional, recommended)

`install.sh` (unless `--no-harness`) sets up the bits that make autonomous work shine:

- **Hooks** (`~/.claude/hooks/`): inject the current time into every turn, and surface your
  open *"needs you"* items at the start of each session.
- **`needs-me.mjs`**: a tiny Linear-backed inbox CLI for "only the human can decide this."
- **[`harness/CLAUDE.md`](harness/CLAUDE.md)**: the operating pattern — copy it into your
  code directory as `CLAUDE.md` so your agents work the right way: do the whole task, verify,
  report, keep durable state in tickets/memory, isolate code in git worktrees, escalate
  sparingly.
- **`cc-rc-supervisor.sh`** (optional cron): keeps remote-controlled sessions alive across
  reboots and reconnects dropped bridges.

## Concierge (let a computer-use agent do the boring setup)

Don't want to hunt for API keys or rent a server yourself? The [`concierge/`](concierge/)
folder has ready-to-paste prompts for a **computer-use agent** (e.g. Claude with computer
use, or the Codex/ChatGPT desktop agent) to: provision a VPS, sign up for services and grab
API keys, create a Linear team, and set up a stable custom-domain tunnel. You bring back the
keys; Box does the rest.

## How it works

```
 Phone PWA ──HTTPS/WSS──► Cloudflare tunnel ──► your box: node server (:7321)
  chat / voice / files       (no open ports)        │  each turn spawns / resumes:
                                                     ▼
                          claude --remote-control …   (persisted in dtach)
                          codex exec --json …
                          → streams text + tool chips back to the phone
```

The backend (`server/index.mjs`) lists your `~/.claude` sessions, drives Claude over a
remote-control bridge and Codex over `codex exec`, and serves the plain-JS frontend in
`public/` (no build step). `scripts/keeper.sh` supervises the server + tunnel.

## Security

- The app is gated by `CC_AUTH_TOKEN` — anyone with the URL **and** the token can run code as
  your user. Keep the token secret; treat the URL as semi-public.
- The harness defaults to `bypassPermissions` so agents act without prompts (the point of a
  hands-off box). Want more friction? Edit `~/.claude/settings.json`.
- Everything runs as you, on your machine. No third-party server sees your code or sessions —
  only the Cloudflare tunnel relays traffic to your box.

## License

[GPL-3.0-or-later](LICENSE). Built on top of [Claude Code](https://claude.com/claude-code).
