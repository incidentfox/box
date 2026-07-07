# Voice assistant — audio-pipeline hardening (half-duplex + self-echo guard)

**Ticket:** INC-1088 — *Voice agent self-interruption and misattribution: stops itself
mid-speech and treats own output as user input.*

## The problem

The box voice assistant is browser ↔ OpenAI Realtime over WebRTC: the mic track goes up,
the TTS track comes down and plays out the phone/car speaker, and **OpenAI runs the VAD +
transcription server-side**. On a loud hands-free speaker (a car), the mic hears the
assistant's own TTS. Because the turn detector and transcriber live at OpenAI, that echo:

1. **fires the VAD** (`input_audio_buffer.speech_started`) mid-reply → the agent thinks the
   user barged in and **cuts itself off** (self-interruption), and
2. **gets transcribed as a user turn** → the model **responds to its own words**
   (misattribution → "continues incorrectly").

Acoustic echo cancellation (AEC) in `getUserMedia` helps but does not fully cancel a loud
car speaker, and it can't gate what OpenAI hears.

## The fix (defense in depth)

Since the VAD/ASR are server-side, the only place we can stop the model from hearing itself
is at the **mic**, in the browser (`public/voice.js`). Policy is minted by the server
(`/api/voice/token` → `audioPolicy`) so it's tunable without a client redeploy.

1. **Half-duplex mic gating (primary).** While the assistant's TTS is playing, the outgoing
   mic track is disabled (`track.enabled = false`), so OpenAI receives silence and cannot
   VAD-trigger or transcribe the echo. The gate:
   - **closes** on the first assistant audio chunk (`response.output_audio_transcript.delta`);
   - **re-opens** `tailMs` (default 600 ms) after `response.done`, to let the WebRTC
     jitter-buffer / `<audio>` tail drain before we listen again;
   - has a **max-hold safety** (default 20 s): a dropped `response.done` can never wedge the
     mic shut for the rest of a drive;
   - stays **open during "thinking"/tool calls** (no audio yet), so the user can still add
     context while work runs;
   - composes with manual mute (muted stays muted).
   Half-duplex is **ON by default** and is mutually exclusive with barge-in — you cannot
   interrupt a reply if the mic is muted while it plays — so enabling
   `VOICE_ASSISTANT_INTERRUPT_RESPONSE` turns half-duplex OFF.

2. **Self-echo misattribution guard (secondary).** If a "user" transcription still comes
   back (the brief onset window before the gate closes, or when barge-in mode is on), it is
   compared against the assistant's recent utterances. A high token-overlap match is treated
   as loopback: the bubble is removed, the item is **deleted from the model's context**
   (`conversation.item.delete`), and it is not logged as a user turn. Conservative by design
   — utterances shorter than `echoMinTokens` (4) are never flagged, so real commands like
   "yes" / "stop" / "next" always get through.

3. **Echo/VAD tuning.** Stronger `getUserMedia` constraints (system AEC hint, high-pass,
   mono, plus best-effort `advanced` hints browsers ignore if unsupported). `server_vad`
   `threshold` and `silence_duration_ms` are now configurable to de-sensitize a noisy car.

4. **Model instruction.** A persona line tells the model that its own words echoed back are
   loopback, not the user — belt-and-braces for barge-in mode.

## Telemetry (AC #4)

Every incident is a persisted diagnostic event (`~/.cc-mobile/voice-assistant/diagnostics/`):

- `half_duplex_gate_closed` / `half_duplex_gate_open` — gate lifecycle;
- `self_interrupt_candidate` — VAD fired during an active response (a self-interruption
  suspect; ideally ~0 with half-duplex on);
- `self_echo_dropped` — the guard discarded a self-transcribed "user" turn;
- `false_interrupt_armed` / `false_interrupt_resume` — the existing noise-recovery path;
- `audio_incidents` — an end-of-call rollup (`{selfInterrupt, misattribution}`) also sent to
  the server on the end-of-call beacon.

Roll it up with the exported helper (no live session needed):

```js
import { summarizeSelfEchoDiagnostics } from './server/voice-assistant.mjs';
import { readFileSync } from 'node:fs';
summarizeSelfEchoDiagnostics(readFileSync('<vsid>.jsonl', 'utf8'));
// → { self_interrupt_candidate, self_echo_dropped, calls, self_interrupt_total, misattribution_total, ... }
```

Health check: with half-duplex ON, `self_interrupt_candidate` and `misattribution_total`
should be ~0. A rising count means the gate/tail needs tuning for that device (raise
`tailMs`, or `VOICE_ASSISTANT_VAD_THRESHOLD` on server VAD).

## Configuration

All optional; safe defaults ship. See `.env.example`.

| Env var | Default | Meaning |
|---|---|---|
| `VOICE_ASSISTANT_HALF_DUPLEX` | ON (unless barge-in) | gate mic closed during TTS |
| `VOICE_ASSISTANT_HALF_DUPLEX_TAIL_MS` | 600 | mic stays gated this long after playback |
| `VOICE_ASSISTANT_HALF_DUPLEX_MAX_HOLD_MS` | 20000 | safety cap on gate-closed time |
| `VOICE_ASSISTANT_ECHO_GUARD` | 1 | drop self-echo "user" turns |
| `VOICE_ASSISTANT_ECHO_THRESHOLD` | 0.8 | token-overlap to call it echo (0.5–1.0) |
| `VOICE_ASSISTANT_ECHO_MIN_TOKENS` | 4 | never flag shorter utterances |
| `VOICE_ASSISTANT_VAD_THRESHOLD` | 0.65 | server VAD sensitivity |
| `VOICE_ASSISTANT_VAD_SILENCE_MS` | 800 | server VAD end-of-turn silence |
| `VOICE_ASSISTANT_INTERRUPT_RESPONSE` | 0 | barge-in (turns half-duplex OFF) |

## Deployment

Server + client change. `public/` is served from disk (no build), but the token endpoint
now mints `audioPolicy`, so **the server must be reconciled and restarted** for half-duplex
to activate; browsers pick up the new `voice.js` on reload.

```bash
# from the canonical checkout that box-app.service runs (see CLAUDE.md):
git -C <canonical> fetch origin && git -C <canonical> merge --ff-only origin/main
pkill -f "node server/index.mjs"   # keeper respawns in ~30s; dtach bridges survive
```

Then hard-reload the box app (`box.mindbill.org`) so the browser loads the new `voice.js`.

### Pre-deploy verification

- `npm test` — unit tests incl. the new `voiceAudioPolicy` / `selfEchoMatch` /
  `summarizeSelfEchoDiagnostics` / tuned-VAD cases.
- On-device (the real test — cannot be done headless): start Voice, ask something with a
  multi-sentence answer on a loud speaker, confirm the reply is **not** cut off and no
  echoed "user" bubble appears; then confirm you can speak again immediately after it
  finishes. Check `self_interrupt_candidate` ≈ 0 in diagnostics.

## Rollback plan

Low-risk, fully env-reversible without a code revert:

- **Disable half-duplex only:** set `VOICE_ASSISTANT_HALF_DUPLEX=0` and restart the server —
  reverts to the previous full-duplex mic behavior. The echo guard stays on.
- **Disable the echo guard only:** `VOICE_ASSISTANT_ECHO_GUARD=0` + restart.
- **Both off = original behavior:** set both to `0` + restart; the code paths become no-ops.
- **Full revert:** `git revert <merge sha>` on a branch → PR → merge → reconcile + restart.

If the mic ever seems "stuck" (can't talk after a reply), the max-hold safety re-opens it
within `MAX_HOLD_MS`; lowering `HALF_DUPLEX_TAIL_MS` shortens the post-reply deaf window.
