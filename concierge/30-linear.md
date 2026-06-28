# Concierge prompt — set up Linear for the Box Board + "needs you" inbox

**You probably don't need this.** Box's in-app **task board** and **"needs you"** inbox work
out of the box with **no Linear account** — Box ships a built-in, local clone of Linear backed
by a SQLite file (`~/.cc-mobile/linear-lite.db`). Just install and use the Board.

Follow this prompt **only** to drive a *real* Linear workspace (e.g. you already live in
Linear). If you connect Linear later, push everything you created locally up to it with:
`node bin/linear-lite.mjs import --key <lin_api_…> --team-key <KEY>`. A free Linear personal
plan is enough.

**Paste everything below into a computer-use agent.**

---

You are helping me set up Linear access for a self-hosted app called "Box". Drive the browser;
I'll handle my login. Treat the API key like a password. Free plan is fine — don't upgrade.

1. Go to <https://linear.app> and help me sign in or create a free workspace.
2. If I don't have a team yet, create one (any name — e.g. "Personal"). Note its **team key**
   — the short prefix on issue ids, like `ENG` in `ENG-123`. Tell it to me.
3. Create a Personal API key: **Settings → Security & access → Personal API keys → New key**.
   Name it "Box". Copy the key and give it to me as: *"put this in `.env` as
   `LINEAR_API_KEY=...`"*.
4. Create a label called **`needs-me`** on that team (Settings → team → Labels), or just tell
   me Box will create it automatically on first use.
5. Report back, in one copyable block, the values for `.env`:
   - `LINEAR_API_KEY=...`
   - `LINEAR_TEAM_KEY=...`  (the short key from step 2, e.g. `ENG`)
   - `NEEDS_LABEL=needs-me`
   - and note: **`LINEAR_TEAM_ID` still needed** — see below.

### Getting `LINEAR_TEAM_ID` (the team UUID)
Box also needs the team's UUID. Easiest: the Box install agent can fetch it automatically once
`LINEAR_API_KEY` + `LINEAR_TEAM_KEY` are in `.env`. If you want it now, run this in a terminal
(replace the key), and copy the `id` of your team:

```bash
curl -s https://api.linear.app/graphql \
  -H "Authorization: <LINEAR_API_KEY>" -H "Content-Type: application/json" \
  -d '{"query":"{ teams { nodes { id key name } } }"}'
```

The `id` that matches your team key → `LINEAR_TEAM_ID=...` in `.env`.
