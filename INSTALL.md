# INSTALL — read this and set Box up for me

**You are an installation agent (Claude Code or Codex).** The user cloned this repo, started
you inside it, and said something like *"install this."* Your job: get **Box** running on
**this machine** and reachable from the user's phone, then hand back the URL + token. Do the
work — run the commands, don't just describe them. Keep the user in the loop for the few
choices and secrets only they can provide.

Box is a self-hosted web app that runs real Claude Code / Codex sessions on this machine,
driven from a phone as a native chat UI. See `README.md` for the product overview.

---

## Step 0 — Confirm context
- **Are you in the repo?** Verify this file, `install.sh`, `server/index.mjs`, and
  `package.json` exist in the current directory. If not — the repo isn't cloned yet — clone it
  and enter it: `git clone https://github.com/incidentfox/box.git && cd box`.
- **Are you on the host?** Box must be installed on the machine that will RUN it (a
  server / VPS / always-on box, or the user's own machine for local use). If the user wants Box
  on a server they haven't shelled into yet, connect there first; if there's no server at all
  and you have computer use, provision one via `concierge/10-provision-server.md` (get the
  user's OK before paying), then come back here.

## Step 1 — Ask the user the few things that matter
Ask concisely (one round). Defaults in brackets:
1. **Your name?** [used in the per-session "morning brief"]
2. **Voice input?** (mic→text). If yes, you'll need an **ElevenLabs** API key (optional). [no]
3. **Linear board + "needs you" inbox?** Unlocks the in-app task board and decision inbox.
   A free Linear personal plan works. If yes, you'll need a Linear API key + team. [no]
4. **Install the harness?** (hooks + the autonomous-work operating pattern). Strongly
   recommended — it's what makes hands-off "work this task" sessions good. [yes]
5. **Google access?** Lets agents read/send Gmail, check Calendar, and read Drive. Optional;
   if yes, you'll need a Google OAuth desktop-client JSON from Google Cloud. [no]

## Step 2 — Collect secrets (only what they chose)
Two paths — let the user pick:

- **Paste path (default):** ask the user to paste each key. Tell them where to get it:
  - ElevenLabs: <https://elevenlabs.io> → profile → API key.
  - Linear: Linear → Settings → Security & access → Personal API keys.
  - Google: follow `concierge/50-power-ups.md` to create a Google Cloud OAuth desktop
    client JSON with Gmail, Calendar, and Drive APIs enabled.
- **Concierge path:** if the user would rather have their *computer-use* agent fetch keys
  (or even provision a server), point them to the prompts in **`concierge/`** — they paste
  one of those into a computer-use agent and bring back the key. Files:
  `concierge/20-api-keys.md` (keys), `concierge/30-linear.md` (Linear key + team id),
  `concierge/50-power-ups.md` (Google access), `concierge/10-provision-server.md`
  (rent a VPS), `concierge/40-stable-url.md` (custom domain).

The `claude` CLI login is **interactive (a browser OAuth page)**. Box drives the user's
logged-in CLI, so it needs no Anthropic API key on a Claude subscription.
- If you're a **computer-use agent**, you can complete this login yourself: run `claude`, open
  the OAuth URL it prints, and finish the sign-in in the browser.
- If you're a **terminal-only agent**, you can't click the browser — ask the user to run
  `claude` once and log in (see Step 5). Check the state with: `ls ~/.claude/.credentials.json`
  (present ⇒ logged in) or `claude -p "say OK"` (works ⇒ logged in).

Write whatever keys you collected into `.env` (copy from `.env.example` first if `.env`
doesn't exist). Required: `CC_AUTH_TOKEN` (let `install.sh` generate it if blank). For
Linear you need `LINEAR_API_KEY`, `LINEAR_TEAM_KEY`, and `LINEAR_TEAM_ID` (the team UUID —
`concierge/30-linear.md` shows the one API call that fetches it).

## Step 3 — Run the installer
Once `.env` reflects the user's choices, run:

```bash
./install.sh --yes
```

(Use `--yes` since you've already seeded `.env`; drop it to let the script prompt the human
directly. Add `--no-harness` if they declined the harness, `--no-cron` to skip the @reboot
keeper. If they chose Google access and you have the downloaded OAuth JSON, add
`--google-client-json /path/client_secret.json`; use `--with-google` to run the OAuth setup
without a JSON file and paste the client id/secret interactively.) The installer:
checks/installs prereqs (node, dtach, build tools, cloudflared), runs `npm install`, ensures
`.env`, installs the bundled `google` CLI to `~/.local/bin/google`, installs the harness into
`~/.claude/`, adds the @reboot keeper to cron, starts the server + a Cloudflare quick-tunnel,
and prints the URL + token.

If `install.sh` reports a missing prerequisite it couldn't auto-install (often the `claude`
CLI or `node`), install it per its hint and re-run — the script is idempotent.

**Most common failure: `node-pty` didn't build.** It's the one native module and needs a
C/C++ toolchain. The installer now verifies this and prints the exact fix, but if you hit it:
install build tools and re-run (Linux apt: `sudo apt-get install -y build-essential python3`;
dnf: `sudo dnf install -y gcc-c++ make python3`; Arch: `sudo pacman -S base-devel python`;
macOS: `xcode-select --install`), or just `npm rebuild node-pty`. Full npm log:
`~/.cc-mobile/npm-install.log`.

## Step 4 — Verify it's actually up
Don't trust, verify:

```bash
PORT=$(grep -E '^PORT=' .env | cut -d= -f2-); PORT=${PORT:-7321}
TOKEN=$(grep -E '^CC_AUTH_TOKEN=' .env | cut -d= -f2-)
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:$PORT/api/config"   # expect JSON with "features"
cat ~/.cc-mobile/url.txt                                                          # the public URL
```

`/api/config` should return JSON; `features.linear` should be `true` only if you configured
Linear. If the tunnel URL is empty, wait ~10s and re-check `~/.cc-mobile/url.txt`
(cloudflared takes a moment), or check `~/.cc-mobile/tunnel.log`.

If they chose Google access, verify it too:

```bash
google status
google gmail list "is:unread" 5
```

If `google status` says "not authorized", the CLI is installed but OAuth has not been
completed yet. Run `node harness/google-auth.mjs --from /path/client_secret.json`, then retry
`google status`.

## Step 5 — Hand off to the user
Give them, clearly:
- **The URL** (from `~/.cc-mobile/url.txt`) and **the token** (from `.env`).
- *Open the URL on your phone → enter the token → Share → Add to Home Screen* (installs the PWA).
- If `claude` wasn't logged in: *run `claude` in a terminal on this machine once and log in;
  Box drives your logged-in CLI.* (Codex similarly: `codex` once, if they want Codex chats.)
- If you installed the harness: tell them the workflow — *"From the app, say 'work this task
  autonomously'; I'll do it and report back. Then say 'merge & deploy and file the leftovers
  as new tasks.'"* Mention `harness/CLAUDE.md` is the operating guide; suggest copying it into
  their main code directory as `CLAUDE.md`.
- If they enabled Google access: tell them agents can now use `google gmail list`,
  `google gmail get`, `google gmail send`, `google cal list`, and `google drive list`.

## Notes / troubleshooting
- **Quick tunnel URL changes on restart.** For a stable `box.yourdomain.com`, see
  `concierge/40-stable-url.md` (Cloudflare named tunnel) and set `TUNNEL_MODE=named` in `.env`.
- **No public access wanted?** Set `TUNNEL_MODE=none`; Box serves on `http://localhost:PORT`.
- **Restart after editing `.env`:** `pkill -f "node server/index.mjs"` — the keeper respawns
  it within ~30s with the new config.
- **Everything lives under** `~/.cc-mobile/` (logs, url.txt, uploads) and `~/.claude/` (the
  harness + your Claude sessions). Box reads your existing Claude sessions automatically.
- This is a powerful setup: the harness defaults to `bypassPermissions` so agents act without
  per-action prompts. If the user wants more friction, edit `~/.claude/settings.json`.
