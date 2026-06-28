# Concierge — let a computer-use agent do the boring setup

Box needs a few things that live behind web logins and signup flows: a server to run on, an
API key or two, maybe a Linear account, maybe a custom domain. You can do all of it by hand
in 15 minutes — or you can hand it to a **computer-use agent** (Claude with computer use, the
ChatGPT/Codex desktop agent, or any browser-driving agent) and just confirm the sensitive
moments.

Each file here is a **ready-to-paste prompt**. Open a computer-use agent, paste the file's
contents, and follow along. The agent does the clicking; **you** stay in control of anything
that matters.

| File | What the agent does for you |
|---|---|
| [`00-install-this.md`](00-install-this.md) | **The all-in-one prompt** — does the whole setup end to end (pick a host, provision if needed, clone, install, hand you the URL + token). Start here if you have nothing yet. |
| [`10-provision-server.md`](10-provision-server.md) | Rent a small always-on Linux VPS and give you SSH access. |
| [`20-api-keys.md`](20-api-keys.md) | Sign you in / up and fetch the optional API keys (ElevenLabs for voice, etc.). |
| [`30-linear.md`](30-linear.md) | Get a Linear API key + your team's UUID for the Board + "needs you" inbox. |
| [`40-stable-url.md`](40-stable-url.md) | Set up a stable `box.yourdomain.com` via a Cloudflare named tunnel. |
| [`50-power-ups.md`](50-power-ups.md) | **Make agents far more capable:** Google access (Gmail/Calendar/Drive), email-yourself, and a notes "brain". |

## Ground rules to give your agent (built into every prompt)

- **You log in; the agent navigates.** Type your own passwords into the real login pages.
  Don't paste long-term passwords into the agent's chat. Prefer "sign in with Google" or a
  one-time email code where possible.
- **Stop before money.** The agent must pause and get your explicit OK before any purchase,
  paid plan, or entering a card. Free tiers first.
- **Bring back exact values.** When the agent finds a key/id, it should copy it verbatim and
  tell you exactly which `.env` line it goes on. Treat API keys like passwords.
- **Smallest thing that works.** Free plans and the cheapest VPS are plenty for a personal Box.

## After the concierge

Once you have a server and any keys, run the normal install on that server: clone the repo,
start `claude`/`codex`, say **"install this"** (the agent reads [`../INSTALL.md`](../INSTALL.md)),
or just `./install.sh`. Paste the keys into `.env` when asked.
