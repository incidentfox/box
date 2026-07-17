// Provider-neutral helpers for the experimental speech -> CLI-agent -> speech path.
// The transport remains deliberately thin: the existing Box session engines retain
// ownership of Codex/Claude context, tool streaming, and their normal safeguards.

export function voiceAssistantMode(value = 'adapter') {
  return String(value || 'adapter').trim().toLowerCase() === 'realtime' ? 'realtime' : 'adapter';
}

export function voiceAdapterAgent(value = 'codex') {
  const agent = String(value || 'codex').trim().toLowerCase();
  return agent === 'claude' ? 'claude' : 'codex';
}

export function voiceAdapterSessionKey(vsid) {
  const safe = String(vsid || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  return safe ? `voice-adapter-${safe}` : '';
}

export function voiceAdapterVAD({ threshold, silenceMs, minSpeechMs } = {}) {
  const num = (v, d) => v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v);
  return {
    // Browser RMS is 0..1. This is intentionally conservative for a moving car;
    // callers may tune it per deployment without changing the client bundle.
    // Phone browser waveform RMS is commonly 0.003–0.02 for ordinary speech. The
    // original 0.025 floor made adapter capture effectively deaf on many devices.
    threshold: Math.min(0.2, Math.max(0.001, num(threshold, 0.004))),
    silenceMs: Math.max(350, Math.min(3000, Math.round(num(silenceMs, 900)))),
    minSpeechMs: Math.max(200, Math.min(5000, Math.round(num(minSpeechMs, 350)))),
  };
}

export function buildVoiceAdapterPrompt(text, { agent = 'claude', firstTurn = false, interrupted = false } = {}) {
  const spoken = String(text || '').trim().slice(0, 6000);
  const bootstrap = firstTurn ? `
You are the conversational voice layer for Box, speaking to its owner hands-free. This is a persistent ${agent} Code session, so retain useful context across turns.

Voice rules:
- Answer in plain spoken language: normally one to three concise sentences, no markdown tables or long lists.
- Send one final answer for each voice turn. Do not narrate progress, tool use, or an "I'll check" acknowledgement before the answer.
- Never use Markdown, code fences, URLs, bullet markers, emoji, or raw structured data; everything will be spoken aloud.
- A transcript can be wrong; ask one focused clarification only if it materially changes the result.
- Use your normal tools when current evidence is needed, but do not narrate tool mechanics.
- Treat inspect/explain/status requests as read-only. For destructive, external, privacy-sensitive, financial, deployment, or irreversible actions, ask for explicit confirmation before acting.
- Do not claim a command, message, deployment, or edit happened unless the tool/session evidence shows it succeeded.
` : '';
  const interruption = interrupted ? `
This is a new instruction that interrupted work already under way in this same persistent session. Treat it as higher-priority context, then continue the earlier work unless this instruction changes or replaces it. Check the live state before repeating an action that may already have started. For substantial work, use safe background or parallel work when available so this conversation stays responsive; do not pretend background work completed before evidence shows it did.
` : '';
  return `${bootstrap}${interruption}\nUSER VOICE TRANSCRIPT:\n${spoken}`.trim();
}

export function spokenAdapterText(value, maxChars = 1400) {
  const limit = Math.max(200, Math.min(6000, Number(maxChars) || 1400));
  const text = String(value || '').replace(/\r/g, '').trim();
  if (text.length <= limit) return text;
  // Prefer a sentence boundary so truncation does not sound abruptly cut off.
  const cut = text.slice(0, limit);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (end >= Math.min(80, Math.floor(limit * 0.2))) return cut.slice(0, end + 1).trim();
  // A response with no usable sentence boundary may still be streamed as a
  // progress update. Never clip it inside a word: the final-answer deduper
  // relies on this text being a real prefix of the later complete response.
  const wordEnd = cut.lastIndexOf(' ');
  return ((wordEnd > 0 ? cut.slice(0, wordEnd) : cut).trimEnd() + '…').trim();
}
