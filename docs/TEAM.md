# Team — sharing a Box with people you work with

Box is a single-user machine that grew a second seat. This document says exactly what
that second seat is: what a teammate can reach, what they can't, and — the part that
matters most — **what the boundary is not**.

Code: `server/team.mjs` (state + policy), `server/child-env.mjs` (what a spawned agent
inherits), `public/team.js` (the Team screen), team routes in `server/index.mjs`.

## The model in one paragraph

The owner mints an invite code (`BOX-XXXX-XXXX`). Redeeming it once yields a durable
guest token. A guest sees only what has been shared with them: a list of shared chats,
a set of folders, and the keys the team publishes. Everything else on this box —
every other chat, every other route — is refused. Sharing a chat also admits **the
folder that chat runs in**, so the owner and the guest are working in the same place
instead of the guest being silently relocated somewhere else.

## What a guest can do

| | Guest | Owner |
|---|---|---|
| Open chats shared with them, and their own | ✅ | ✅ |
| Enumerate every chat on the box | ❌ | ✅ |
| Send messages, attributed by name | ✅ | ✅ |
| Read/write files under an admitted root | ✅ | ✅ (anywhere) |
| Browse outside the admitted roots | ❌ | ✅ |
| Bash mode (`⌘` in the composer) | ❌ | ✅ |
| Share / unshare a chat, add / remove roots | ❌ | ✅ |
| Add a team secret | ✅ | ✅ |
| Read a team secret's value back | ❌ | ❌ |
| Invite, rename, or remove members | ❌ | ✅ |

New endpoints are **owner-only by default**. `GUEST_ROUTES` / `GUEST_PATH_RES` in
`server/index.mjs` is an explicit allowlist; a route that isn't named there is refused
for a guest without anyone having to remember to protect it.

## Folders (roots)

The team can reach:

- **the shared workspace** — a scratch folder (`BOX_TEAM_WORKSPACE`, default
  `~/development/shared`), always reachable, where a guest's own new chats start; plus
- **every folder admitted by sharing a chat**, and any the owner adds by hand.

Sharing a chat adds its folder with `auto: true`; unsharing withdraws it again *unless*
another shared chat still lives there, or the owner had pinned it manually. Manual roots
(`auto: false`) survive unshares — removing one is a deliberate act on the Team screen.

Containment is checked with `realpathSync` on **both** sides, so a symlink inside a root
that points outside the team's folders is not a way out. A path that doesn't exist yet
falls back to its nearest existing ancestor, so creating a new file inside a root works
without pre-registering it.

Some directories are refused outright, along with any ancestor of one:

```
/  /etc  /root  /run  /proc  /sys  /var  /boot  /dev
$HOME itself, ~/.ssh  ~/.aws  ~/.gnupg  ~/.config  ~/.claude  ~/.cc-mobile  ~/.local
```

Admitting `$HOME` would hand back every credential the environment filter below just
took away, which is the whole reason the filter exists.

## Team secrets

Keys the team deliberately publishes (`OPENAI_API_KEY`, and so on) live in
`<STATE_DIR>/team-secrets.json`, mode `0600`, written atomically. They are injected into
every agent this box spawns — the owner's sessions too.

Values leave the module in exactly one direction: into a spawned process's environment.
No route returns a value, for anyone, including the owner; the Team screen shows a key
name, who added it, and a hint (`sk-…4f`). Losing the value means pasting it again, which
is the correct trade for a screen you read on a phone.

Keys that decide *how a program runs* are refused — `PATH`, `LD_PRELOAD`, `NODE_OPTIONS`,
`BASH_ENV`, `GIT_SSH_COMMAND`, `CC_AUTH_TOKEN`, and friends. A guest may add secrets, and
those secrets reach the owner's agents; without this list, "add a team secret" would be
"run arbitrary code as the owner".

## What a spawned agent inherits

`server/child-env.mjs` is the single source of truth. It used to be three drifted copies,
which is precisely why the leak below survived as long as it did.

**Stripped for everyone, owner included:** `CC_AUTH_TOKEN` (the box's own login token — an
agent holding it can authenticate to this server *as the owner*), plus the Claude/Codex
credential and session-inheritance vars that were already being removed.

**For a guest's process, an allowlist rather than a denylist:**

```
PATH HOME USER LOGNAME SHELL PWD OLDPWD SHLVL TMPDIR LANG TERM COLORTERM TZ _
LC_*  XDG_*
```

Nothing else. Not `SSH_AUTH_SOCK` (a live agent socket is push access to every repo the
owner can push to, with no credential ever visible to notice), not `AWS_*`, not the
integration key someone adds next month. A denylist would have inherited that key
silently; this is the one place where "deny by default" is worth the friction.

Team secrets are applied *after* the filter, so a published key reaches a guest's agent
even though no ambient key does.

## What this is NOT

**The guest boundary is not a sandbox.** Say it plainly, because the UI implies
otherwise if you let it:

- A guest-started agent runs as the box's **unix user**, with the owner's `HOME`. It can
  read any file that user can read — `~/.ssh/id_ed25519`, `/run/software-factory/secrets.env`,
  `~/.config/gh/hosts.yml` — by asking the agent to read it. The cwd clamp constrains the
  *file browser* and the agent's working directory, not the process's ability to open a path.
- Bash mode is refused for guests, which removes the trivial one-liner, not the capability.
- Therefore: **invite people you would give a shell to.** Everything above closes the
  accidental leaks — the token that shouldn't have been in the environment, the folder
  nobody meant to share. None of it turns a trusted teammate into an untrusted one.

Isolating that properly means a separate unix user or a container per guest. That is a
real option and a bigger change; it is not what this is.

**Where the honesty lives in the product:** the guest's Team screen carries a "Where your
work lives" note saying their chats run on the host's machine and the host can read them,
plus a one-tap path to installing their own Box. Someone who wants genuinely private work
should have it on their own machine — that's the elegant answer, not a stricter clamp here.

## Operational notes

- A guest's restriction is a property of the **session**, not the turn: a long-lived agent
  (`claude --remote-control` under `dtach`) has its environment fixed at spawn. A session
  started by a guest is guest-restricted for its whole life; one started by the owner is
  not, even when a guest later sends a message into it. Bash mode is separately refused
  per-turn, so a guest can't shell out through an owner-started chat.
- Removing a member drops their live sockets immediately. Unsharing a chat evicts guests
  from it immediately. Removing a root needs no eviction: containment is re-checked on
  every frame and every filesystem request.
- `BOX_TEAM=0` disables the whole feature. With no invite minted, nothing can be redeemed,
  so the default-on state is still closed.

## Tests

`server/team.test.mjs` — invites, redemption, attribution, roots (admission, refcounted
withdrawal, manual pinning, forbidden paths, symlink containment), secrets (metadata never
carries a value, reserved keys refused).

`server/child-env.test.mjs` — the environment filter, including the case that matters most:
an unknown, not-secret-looking variable is excluded from a guest's process by default.
