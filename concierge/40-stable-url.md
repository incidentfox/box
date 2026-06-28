# Concierge prompt — give Box a stable custom URL

By default Box uses a free Cloudflare "quick tunnel" whose URL changes whenever it restarts.
That's fine to start, but for a permanent `box.yourdomain.com` you want a **named tunnel**.
This needs a domain on Cloudflare (free) and a couple of commands on the server.

**Paste everything below into a computer-use agent** for the account/domain steps; the actual
tunnel commands run on your server (the agent can guide you, or your Box install agent can do
them).

---

You are helping me give my self-hosted "Box" app a stable URL using a Cloudflare named tunnel.
Drive the browser for the Cloudflare account/domain parts; I'll run the server commands. Free
tier only — don't buy anything unless I ask.

1. Help me sign in / sign up at <https://dash.cloudflare.com> (free).
2. Make sure I have a domain on Cloudflare:
   - If I already have one, confirm it's added as a zone (nameservers pointing to Cloudflare).
   - If not, I can register one (ask me first — this costs money) or use one I own.
3. Tell me the **subdomain** I'll use, e.g. `box.mydomain.com`.

Then give me these exact server commands to run (replace `box` / the hostname with mine), and
explain each in one line:

```bash
# one-time: authenticate cloudflared with my Cloudflare account (opens a browser)
cloudflared tunnel login

# create a named tunnel
cloudflared tunnel create box

# route my subdomain to it
cloudflared tunnel route dns box box.mydomain.com
```

Finally, tell me to set these in Box's `.env` and restart the keeper:

```
TUNNEL_MODE=named
TUNNEL_NAME=box
TUNNEL_HOSTNAME=box.mydomain.com
```

```bash
pkill -f "node server/index.mjs"   # keeper respawns server + the named tunnel
```

After that, `https://box.mydomain.com` is my permanent Box URL. Summarize what I did and the
final URL.
