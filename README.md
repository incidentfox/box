<div align="center">

# 📦 Box

**Your own always-on Claude Code, in your pocket.**

Box is a self-hosted web app that runs **real Claude Code (and Codex) sessions on your own
server** and lets you drive them from your phone as a clean, native chat UI — with voice,
file attach, `/skills`, a session list, and a task board. Fire off *"work this task
autonomously"* from a coffee shop; come back to a finished result you can ship.

<br>

<img src="docs/demo.gif" alt="Box on a phone — browse sessions, open a chat, type" width="280">

<br>

<table>
<tr>
<td><img src="docs/sessions.png" alt="Session list" width="280"></td>
<td><img src="docs/chat.png" alt="Chat with tool chips" width="280"></td>
</tr>
</table>

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

## Set it up

Box runs on a machine that's on when you want to reach it. Pick your situation:

### 🅰 You already have a server (you can SSH into it)

SSH in, then either **let an agent do it** — clone, start an agent in the repo, say *"install this"*:

```bash
git clone https://github.com/incidentfox/box.git && cd box
claude          # or: codex
```
> **install this**

…or **run the installer yourself**:

```bash
git clone https://github.com/incidentfox/box.git && cd box && ./install.sh
```

Either way you get: prerequisites installed, an access token generated, the server started
behind a free Cloudflare tunnel, and your **phone URL + token** printed. One manual step
remains — run `claude` once to log in (Box drives your logged-in CLI; no API key needed on a
subscription).

Even shorter — turn a **fresh** server into a Box without cloning first:

```bash
curl -fsSL https://raw.githubusercontent.com/incidentfox/box/main/bootstrap.sh | bash
```

### 🅱 You're on your laptop and need a server

- **Easiest:** open a **computer-use agent** (Claude with computer use, or the ChatGPT / Codex
  desktop app) and paste [`concierge/00-install-this.md`](concierge/00-install-this.md). It
  rents a cheap VPS (with your OK), installs Box there, logs in, and hands you the link.
- **Have SSH to a box already?** Provision it from your laptop in one shot:
  ```bash
  ./provision.sh user@your-server
  ```
- **DIY:** rent any small Linux VPS (see [`concierge/10-provision-server.md`](concierge/10-provision-server.md)),
  then follow 🅰 on it.

The agent path reads [`INSTALL.md`](INSTALL.md) (and the auto-loaded `AGENTS.md` / `CLAUDE.md`),
asks the few things only you can decide (name, voice?, task board?), collects any API keys, and
sets everything up.

<details><summary><code>install.sh</code> flags</summary>

`--yes` (non-interactive), `--no-harness`, `--no-cron`, `--no-start`, `--port N`. Idempotent —
safe to re-run.
</details>

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

## Power-ups (optional — make agents act on your behalf)

These turn Box from "a coding agent" into an assistant that can *do things*:

- **Google access** — the bundled **`google`** CLI lets agents read & send your **Gmail**,
  check your **Calendar**, and read your **Drive**. One-time setup:
  `node harness/google-auth.mjs` (full walkthrough, incl. the Google Cloud part for a
  computer-use agent, in [`concierge/50-power-ups.md`](concierge/50-power-ups.md)).
- **Email yourself** — once Google access is on, a long autonomous run can `google gmail send
  you@example.com "done" "..."` to ping you when it finishes.
- **A "brain"** — point `BRAIN_DIR` at a notes/markdown folder; agents read it for context and
  append durable facts so the whole fleet remembers.

Agents are told about these in `harness/CLAUDE.md`, so they'll use them when it helps.

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
