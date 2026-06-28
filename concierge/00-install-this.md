# Concierge prompt — "install Box for me" (master, for a computer-use agent)

This is the all-in-one prompt for when you have **nothing set up yet** and want an agent to do
the whole thing. Open a computer-use agent (Claude with computer use, or the ChatGPT / Codex
desktop agent), **paste everything below**, and follow along. It picks a place to run Box,
installs it, and hands you the link.

(Already have a server and just want it installed there? You can instead SSH in, `git clone
https://github.com/incidentfox/box.git && cd box`, run `claude` or `codex`, and say
*"install this"* — the agent reads the repo's `INSTALL.md` / `AGENTS.md` and takes it from there.)

---

You are setting up **Box** for me — a self-hosted app that runs Claude Code / Codex on a server
and lets me drive it from my phone. The source and full instructions are at
**https://github.com/incidentfox/box** (read its `INSTALL.md` and `AGENTS.md` — they're written
for an agent like you). Do the whole thing end to end. Pause only for my logins and for anything
that costs money.

1. **Decide where Box runs.**
   - If I tell you to use a machine I already have, connect to it (SSH or work locally).
   - Otherwise rent the cheapest always-on Linux VPS (≥1 GB RAM, Ubuntu LTS) by following
     https://github.com/incidentfox/box/blob/main/concierge/10-provision-server.md — **get my
     OK before paying.**
2. **Install prerequisites** on that machine: `git`, **Node 18+**, and the Claude Code CLI
   (`npm install -g @anthropic-ai/claude-code`). (`codex` is optional, for Codex chats.)
3. **Get the code:** `git clone https://github.com/incidentfox/box.git && cd box`
4. **Log in to Claude:** run `claude` and complete the browser login (you can do this — it's a
   normal OAuth page). Box uses my Claude subscription via this login; no API key needed.
   - Optional extras: if I want **voice**, grab an ElevenLabs key
     (https://github.com/incidentfox/box/blob/main/concierge/20-api-keys.md); if I want the
     in-app **task board**, set up Linear
     (https://github.com/incidentfox/box/blob/main/concierge/30-linear.md). Note any keys for the next step.
5. **Install:** run `./install.sh`. Answer its prompts with my choices and paste any keys you got.
6. **Verify and report.** Read `~/.cc-mobile/url.txt` (the public URL) and the access token
   (the `CC_AUTH_TOKEN` line in `.env`, also printed by the installer). Tell me, clearly:
   - the **URL** and the **token**, and
   - *"open the URL on your phone → enter the token → Share → Add to Home Screen."*

Keep me posted at each step, and ask before any purchase. If a step fails, show me the error
and what you'll try next.
