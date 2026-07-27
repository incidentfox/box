// Which speech-to-text engine transcribes the phone mic, and how its output is cleaned.
//
// Measured on 14 of the box's own saved dictation clips (2026-07-27, 8 provider configs).
// Deepgram nova-3 `language=multi` — the previous primary — DOES NOT TRANSCRIBE MANDARIN:
// batch returned an empty string and streaming returned space-separated Cantonese salad
// behind German and Korean partials. It was also tied for worst on the domain vocabulary
// used here every day (Carisk→"Kerask", Codex→"Kodak", Claude Code→"clock code",
// payer list→"pair list", W-9→"FW nine"; 50% vs Scribe's 85%).
//
// ElevenLabs Scribe v2 was the only engine to get the Mandarin clip completely right —
// correct characters, Chinese punctuation, and the embedded English proper nouns kept as
// English — with zero hallucinations across all 14 clips. Its one cost is latency: 17.5s
// on a 62s clip vs Deepgram's 1.4s.
//
// So: Scribe leads, Deepgram is the fallback, and `STT_ENGINE=deepgram` flips it back
// without a code change (a self-hoster with only one key still works either way).

export const STT_ENGINES = ['eleven', 'deepgram'];

// Resolve the try-order for a request. `preferred` is STT_ENGINE (or a per-connection
// `?engine=` override); engines whose key is missing drop out, so the order degrades to
// "whatever is actually configured" rather than failing.
export function sttEngineOrder(preferred, available = {}) {
  const want = STT_ENGINES.includes(preferred) ? preferred : 'eleven';
  return [want, ...STT_ENGINES.filter((e) => e !== want)].filter((e) => available[e]);
}

// Scribe annotates non-speech with bracketed tags. On a near-silent clip the ENTIRE
// transcript is one tag, which would paste "[pause]" into the prompt box as if it were
// dictation — 10 rows of the box's own voice log are exactly that. `tag_audio_events=false`
// suppresses them at the source on the batch API; this is the belt-and-braces pass that
// also covers the realtime socket, which has no such parameter.
const NON_SPEECH_TAG = /\[(?:pause|silence|inhales?|exhales?|breath|background noise|noise|music|laughter|laughs|applause|clears throat|coughs?|sighs?)\]/gi;

export function stripNonSpeechTags(text) {
  return (text || '').replace(NON_SPEECH_TAG, ' ').replace(/\s+/g, ' ').trim();
}
