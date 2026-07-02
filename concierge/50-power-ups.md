# Concierge prompt — power-ups that make Box agents much more capable

All optional, but together they turn Box from "a coding agent" into "an assistant that can act
on your behalf": read & send your email, see your calendar, read your Drive, email you results,
and remember durable facts across sessions.

| Power-up | What it unlocks | How |
|---|---|---|
| **Google access** | Agents read/send your **Gmail**, check your **Calendar**, read **Drive** | `harness/google` CLI + the OAuth setup below |
| **Email yourself** | Agents email you a result / digest when something's done | just `google gmail send you@example.com "..." "..."` (uses the access above) |
| **A "brain"** | Durable notes/memory the whole fleet can read & write | set `BRAIN_DIR` in `.env` to a notes folder (git repo of markdown is nice) |

The big one is **Google access**. The setup below is the part worth handing to a computer-use
agent. **Paste everything between the lines into a computer-use agent.**

---

You are setting up Google access for my self-hosted "Box" so its agents can use my Gmail,
Calendar, and Drive. Drive the browser for the Google Cloud steps; I'll approve the consent.
Free tier only; this costs nothing.

1. Go to https://console.cloud.google.com and help me sign in. Create a new project (any name,
   e.g. "box") or pick one.
2. **Enable APIs:** APIs & Services → Library → enable **Gmail API**, **Google Calendar API**,
   and **Google Drive API**.
3. **OAuth consent screen:** APIs & Services → OAuth consent screen → User type **External** →
   fill the minimal app name + my email → add me as a **Test user** (my own Google address).
   (Leave it in "Testing" — that's fine for personal use.)
4. **Create the client:** APIs & Services → Credentials → Create credentials → **OAuth client
   ID** → Application type **Desktop app** → Create. Download the JSON (the `client_secret_*.json`).
5. On the machine running Box, in the repo dir, run one of:
   `./install.sh --google-client-json <path-to-the-downloaded-json>`
   if Box is not installed yet, or:
   `node harness/google-auth.mjs --from <path-to-the-downloaded-json>`
   if Box is already installed. It prints a URL. Open it, approve access for my account, then it redirects to
   `http://localhost/?code=...` (the page won't load — that's expected). Copy the `code` from
   the address bar and paste it back into the prompt.
6. Verify: `google status`, then `google gmail list "is:unread" 5` should list my recent unread mail.
   Tell me it's working, and that agents can now use `google gmail|cal|drive ...`.

If `harness/google-auth.mjs` says "no refresh_token", revoke prior access at
https://myaccount.google.com/permissions for the app and re-run (Google only issues a refresh
token on first consent).

---

### After setup — what agents can do

```bash
google gmail list "is:unread newer_than:2d" 10     # triage
google gmail send you@example.com "done" "PR is up: ..."   # email yourself a result
google cal list 5                                   # what's next
google drive list "name contains 'invoice'" 20      # find a file
google status                                       # check whether OAuth is configured
```

Tell your agents these exist (it's already noted in `harness/CLAUDE.md`). Creds live in
`~/.config/box/google.env` (mode 600) — treat it like a password; never commit it.

### AgentMail (alternative to "email yourself")

If you'd rather not use your own Gmail to send, services like **AgentMail** give an agent its
own inbox + a simple send API. It's a paid service — only worth it if you want a dedicated
agent mailbox. For most people, `google gmail send` to your own address is simpler and free.
