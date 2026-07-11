# Voice Session History & Transcript Access

How the voice assistant reads an agent session's **full conversation context** —
hands-free, read-only, and without ever asking the agent to summarize itself.

## The problem this solves

`read_session_output` and `check_session` only surface an agent's **latest** message.
When Jimmy (driving) asks *"what did that agent and I actually decide earlier?"* or
*"read me the whole thread"*, the old options were bad:

- Read only the last reply — missing the context he asked for.
- Message the live agent asking it to summarize itself — slow, lossy, and it can
  derail a working agent.

The three read tools below let voice reach the **persisted transcript directly**, so
it answers from the real conversation instead of a self-summary.

## The read tools

| Tool | Returns | Use it for |
|---|---|---|
| `check_session` | latest reply + auto summary if truncated | "what's it doing right now" |
| `read_session_output` | the agent's **complete latest** artifact (summary or paginated full) | "the full list / all of them" from the last message |
| `read_session_history` | the **whole ordered conversation** (or just the prompts) | "what did we discuss earlier / the full context" |
| `request_full_artifact` | emails the complete output — or the full transcript — to Jimmy | "send me the whole thing" |

### `read_session_history` — full conversation context

Read-only. Finds one session by title / topic / id and reads its persisted transcript
(Claude JSONL, or Codex/mac message sidecar) — **no message is sent to the live agent**.

```
read_session_history {
  query:      "words from the title/topic, or the full session id",
  include:    "full" | "prompts",   // default "full"
  page:       1,                     // include:full — 1-based; follow next_page
  page_size:  1800,                  // include:full — chars/page (max 6000)
  limit:      80                     // include:prompts — max prompts (max 200)
}
```

- **`include: "full"`** (default) — the ordered `user`/`assistant` turns rendered as a
  role-labelled transcript, **paginated whole-line** so no turn is cut mid-sentence.
  Walk it with `page: 2, 3, …` using the `next_page` cursor. Returns `turn_count`,
  `total_pages`, `has_more`, and `secrets_redacted`.
- **`include: "prompts"`** — just the user prompts, in order ("what did I ask earlier").
  Returns `prompt_count`, `total_prompts_found`, and `truncated`.

Every successful result carries a **`transcript_ref`** — a reliable handle to the full
conversation:

```json
"transcript_ref": {
  "session_id": "…",
  "agent": "claude",
  "export_path": "/api/sessions/<id>/export"
}
```

`export_path` is the authenticated Box endpoint that returns the entire conversation as
markdown. For hands-free delivery, the result also includes an `email_hint` pointing at
`request_full_artifact transcript:true`.

Agent coverage: **claude**, **codex**, and **mac** sessions are readable. `gemini`/`agy`
sessions return a clear "not supported" note rather than a wrong answer.

### `request_full_artifact transcript:true`

`request_full_artifact` emails the complete artifact to Jimmy on explicit request. Pass
`transcript: true` to email the **entire ordered conversation** (all turns) instead of
only the latest output. The email is redacted (see below) and labelled *"Full transcript"*.

## Safe handling

### Secrets

Any text the voice layer surfaces — spoken, paginated, or **emailed off the box** — is
run through `redactSecrets()` first. It replaces each credential with a
`[redacted:<kind>]` marker and reports the count (`secrets_redacted` in tool results).
Recognised shapes include:

- Provider keys: OpenAI (`sk-…`, `sk-proj-…`), Anthropic (`sk-ant-…`), Stripe
  (`sk_live_…`), Google (`AIza…`, `ya29.…`), GitHub (`ghp_…`, `github_pat_…`), Slack
  (`xox[baprs]-…`), AWS access-key ids (`AKIA…`), JWTs (`eyJ….….…`).
- `Authorization: Bearer/Basic/Token <blob>` headers (scheme kept, blob dropped).
- Connection URLs with an inline password (`postgres://user:pass@host` → password only).
- Labeled secrets (`password=`, `api_key:`, `client_secret=` …) with a quoted or long value.

The generic "label = value" rule is deliberately conservative, so ordinary prose
("password policy is fine", "the token was rotated") is never mangled. Redaction is
idempotent and runs in linear time.

It is applied in `check_session`, `read_session_output`, `read_session_history`, and
`request_full_artifact`. This complements — it does not replace — the existing
`file_access` deny-list that blocks voice from touching `.env` / key / credential
**paths** in the first place.

### Long outputs & truncation

- **Latest artifact** (`read_session_output`) and **full transcript**
  (`read_session_history include:full`) both paginate whole-line via `paginateText`;
  the model pages through `next_page` and never reads a wall of text aloud.
- **Transcript tail bound.** A Claude transcript is read from a bounded 4 MB tail. When
  a thread is longer than that window, older turns are dropped and the result sets
  `older_turns_omitted: true` with a note to email the complete file
  (`request_full_artifact transcript:true`) or open `export_path` — nothing is silently
  presented as "the whole thing" when it isn't.
- Per-turn text is capped before rendering so one giant turn can't dominate a page.

### Read-only + audit

`read_session_history` never writes. Every call appends a row to
`~/.cc-mobile/voice-assistant/session-history-audit.jsonl` — the matched session,
`agent`, `include` mode, source, turn/redaction counts, page, and (for the Codex prompt
path) the exact rollout/sidecar paths and queries consulted. Rows record **metadata,
not transcript text**.

## For the model — when to reach for which

- "What's it doing now?" → `check_session`.
- "Give me the full list / everything from its last message" → `read_session_output`.
- "What did we discuss / the whole thread / the earlier context" →
  `read_session_history` (`include:full`, page through). **Do not** message the agent to
  summarize itself.
- "What did I ask it earlier?" → `read_session_history include:prompts`.
- "Email me the whole conversation" → `request_full_artifact transcript:true`.

## Deployment notes

Server-side only. After merge, fast-forward the canonical checkout and restart the Box
server so `box-app.service` reloads `server/voice-assistant.mjs`. No data migration.

Tests: `npm run test:voice-session-history` (handler-level integration) plus the pure
helpers (`redactSecrets`, `claudeTurnsFromJsonl`, `codexTurnsFromMessages`,
`buildTranscriptView`) in `server/voice-assistant.test.mjs`.
