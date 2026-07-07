# Voice session memory — design & privacy review

Cross-session memory for the realtime voice copilot (`server/voice-memory.mjs`,
wired into `server/voice-assistant.mjs`, `public/voice.js`). This is the privacy
review that ships with the feature (INC-1076).

## What it does

The voice copilot already keeps a per-session transcript so a mid-drive reconnect
feels seamless. This feature adds **durable, cross-session** memory:

1. **Dual storage** — text transcripts (already persisted) plus, as a *separate*
   opt-in, the raw **audio** of the user's mic.
2. **Retrieval** — when a new voice session starts, the most relevant prior sessions
   are summarized and folded into the model's instructions ("MEMORY FROM PRIOR VOICE
   SESSIONS"). Scoped, capped, text-only.
3. **Transcription error recovery** — stored audio can be re-transcribed (Deepgram →
   ElevenLabs) to recover a garbled transcript.
4. **Controls** — consent, retention window, disable, and permanent purge, all
   operable hands-free by voice.

## Data flow & where things live

State root: `<STATE_DIR>/voice-assistant/memory/` (single-owner, box-local).

| Artifact | Path | Written when |
|---|---|---|
| Consent + retention settings | `memory/config.json` | on any consent/config change |
| Per-session memory record (summary + keywords) | `memory/sessions/<vsid>.json` | on session end / next fresh mint |
| Raw audio clips | `memory/audio/<vsid>/<clip>` | only while audio opt-in is ON |
| Audit trail | `memory/audit.jsonl` | every consent/index/retrieve/audio/purge/config event |
| Raw transcript (working state for reconnect) | `voice-assistant/transcripts/<vsid>.jsonl` | during a call |

Audio never transits the server on the live path (WebRTC is browser↔OpenAI direct).
When — and only when — the owner opts into audio storage, the **client** records the
mic locally (`MediaRecorder`) and POSTs 20s chunks to `/api/voice/audio`, which the
server refuses (HTTP 403) unless audio storage is enabled.

## Privacy properties (the review)

- **Off by default.** `consent` starts `unset`; nothing is indexed or retrieved until
  the owner explicitly grants it. Verified by test (`indexSession` → `{skipped:'consent'}`,
  `retrieve` → `[]`).
- **Audio is a second, separate opt-in.** Granting memory does **not** enable audio;
  `storeAudio` defaults `false` and must be turned on deliberately. The upload endpoint
  hard-refuses (403) until then. Audio is the most sensitive artifact, so it gets the
  higher bar.
- **Consent is hands-free and explicit.** The persona offers memory once, briefly, and
  only acts on a spoken yes via the `voice_memory` tool — it never nags, and "forget
  everything" / "stop recording" are honored immediately.
- **Retrieval is scoped, capped, and text-only.** Only this box's own records, only
  within the retention window, ranked by keyword+recency, capped at
  `maxRetrievalSessions` (default 4), rendered into a length-bounded (~1.8 KB) block.
  Audio bytes are never sent to the model. The current session is excluded.
- **Bounded footprint.** Memory records store a *summary + keywords*, not the verbatim
  conversation. Audio is capped per session (`maxAudioClipsPerSession`, default 60) and
  chunk size is capped (8 MB) at the endpoint.
- **Retention is enforced.** Everything older than `retentionDays` (default 30, clamp
  1–365) is purged — memory records, audio dirs, **and** the raw transcript files.
  Purge runs on boot and every 6h.
- **Right to be forgotten.** `voice_memory(action:'purge')` / `POST /api/voice/memory
  {action:'purge'}` permanently deletes all stored voice data (records, audio,
  transcripts). Destructive, so the assistant confirms in one line first.
- **Auditable, without leaking content.** Every privacy-relevant action appends to
  `audit.jsonl` with timestamps, actor, ids, and counts — but **no verbatim transcript
  or re-transcribed text**. A test asserts the audit blob contains none of the
  conversation text.
- **No PHI/secrets in git.** All state lives under `STATE_DIR` (gitignored), never the
  repo. Consistent with the box's "never commit secrets or PHI" rule.

## Failure & abuse considerations

- If the transcriber isn't wired, `retranscribeClip` returns a clean error rather than
  throwing.
- Consent is re-read from disk on every gate check (`memoryOn`/`audioOn`/`retrievalOn`),
  so a mid-drive "stop" takes effect immediately server-side; disabling audio also stops
  the client recorder on the next (re)connect.
- `vsid`/clip names are sanitized (`[^\w.-]` stripped) before any path join — no path
  traversal from a caller-supplied id.
- Config writes are atomic (temp file + rename) so a crash can't tear `config.json`.

## Controls quick reference

Voice: *"remember our conversations"* → enable · *"also keep the audio"* → enable_audio
· *"stop recording"* → disable_audio · *"stop remembering"* → disable · *"forget
everything"* → purge · *"keep two weeks"* → set_retention.

HTTP (also usable by a settings UI): `POST /api/voice/memory` with
`{action: status|enable|enable_audio|disable_audio|disable|configure|purge|audit|clips|retranscribe}`.

## Tests

`server/voice-memory.test.mjs` (in `npm test`) covers: default-off gating, consent →
index/retrieve, too-short skip, retrieval relevance/scoping/cap, bounded preload, audio
gating + store + re-transcribe + clip cap, retention purge of aged data, purge-all,
config clamping, and the "no verbatim text in the audit log" property. `scripts/
voice-smoke.mjs` adds read-only status checks against a running server.
