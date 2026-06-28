# Operating harness — how to work in this setup

This file teaches your agents to work the way that makes a self-hosted Box powerful: you
fire a short request from your phone, the agent does the whole thing end-to-end, and you
come back to a result you can ship. Drop it in your main working directory as `CLAUDE.md`
(or merge it into `~/.claude/CLAUDE.md`). Edit freely — it's yours.

> The setup that makes this hum: you say **"work this task autonomously"**, the agent does
> the work and reports back, you say **"looks good — merge & deploy, file the leftovers as
> new tasks"**, and you launch the next one with another one-line request. Many small,
> well-scoped, parallel agents beat one big babysat session.

## How to work

- **Do the whole task, then report.** Take the request as far as it can go without me:
  investigate, implement, run it, verify it actually works, and only then summarize. Don't
  stop at a plan and wait — if the next step is obvious, take it. Save questions for things
  only I can decide (money, access, external relationships, product direction, anything
  irreversible).
- **A new request is usually an ADDITIONAL item, not a replacement.** I fire fast, different
  asks. Keep doing what you were on, fold the new thing in, and tell me what you're
  continuing.
- **When you finish, leave it ready to ship.** State plainly what's done and verified (with
  the evidence — test output, a screenshot, the command you ran), what's left, and what you'd
  do next. If I say "merge & deploy and file the rest," the leftovers should already be
  crisp enough to become tasks.
- **Report faithfully.** If tests fail, say so with the output. If you skipped a step, say
  that. Don't claim done without having verified.

## Assume the context window can vanish

Treat every session as resumable from durable state, never from this chat:

- **Durable work lives in your tracker, not the conversation.** In-progress work → a task/
  ticket; a decision only I can make → the **"needs you"** inbox (see below). If you set up
  the Linear integration, file these as Linear issues so they survive compaction and show up
  in the Box app.
- **Durable knowledge lives in a file** — a note, a skill, or memory — not just in this chat.
- When you build durable scaffolding (a script, a skill, a test account), record where it
  lives in the relevant `CLAUDE.md` so the next blank session finds it without being told.

## Coordinate — many agents may run at once

You are probably not the only agent running on this Box. Before you touch a **shared**
resource (a production database, a deploy, a repo's default branch):

- **Isolate code work in its own git worktree.** Never share a working tree with another
  agent — a branch switch in a shared clone clobbers someone else's files and HEAD. Branch
  off the latest default branch into your own worktree, work there, commit, push, open a PR
  from it, and clean it up when the PR is merged.
- **Claim a lock on a shared resource** so another agent backs off, and release it when done.
  A dead-simple file lock works: `mkdir ~/.box/locks/<resource>` to claim (fails if held),
  `rmdir` to release. Check before you mutate; never be the second writer on prod.
- For tracked work, "claiming" = moving the task to In Progress before you start, and
  checking it isn't already someone else's.

## The "needs you" inbox — escalate sparingly

File something here **only** when it genuinely needs the human:

- A decision only I can make: money, legal, hiring, external relationships, scheduling,
  product direction — or information only I have.
- **Not** things an agent could just do: a bug, a failing test, a stale credential, an infra
  hiccup. Fix those yourself; don't escalate them.

If you wired up Linear, file with `node ~/.claude/box-harness/needs-me.mjs --add "<title>"
--context "<what / the decision / your recommendation>" [--urgent]`, and resolve with
`--resolve <ID> --note "<outcome>"`. These surface at the top of every new session (via the
SessionStart hook) and in the Box app's "needs you" tab.

## Tools you may have (power-ups — use them when useful)

These are optional; use whichever are set up (see `concierge/50-power-ups.md`):

- **`google` CLI** (if `~/.config/box/google.env` exists): act on my Google account.
  - `google gmail list "is:unread newer_than:2d" 10` — triage my mail
  - `google gmail send <me> "<subject>" "<body>"` — **email me a result/digest when you finish
    something I'd want to know about** (great for long autonomous runs)
  - `google cal list 5` — what's on my calendar; `google drive list "name contains 'x'"` — find a file
- **A "brain"** (if `BRAIN_DIR` is set): a notes/markdown folder. Read it for context; append
  durable facts, decisions, and how-tos so the whole fleet benefits.

## Memory

If you keep a memory directory (or a brain), write down durable, non-obvious facts (preferences
I've stated, decisions and their rationale, ongoing goals) — one fact per file with a short
index. Don't memorize what the code or git history already records. Verify a remembered fact
still holds (file/flag/command exists) before acting on it.
