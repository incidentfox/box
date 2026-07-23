// Restore a message that was already removed from the pending queue when the
// previous Box process died. Keep the same qid so a partially-written state
// file cannot enqueue it twice.
export function recoverPersistedQueue(state = {}) {
  const queue = Array.isArray(state.queue) ? [...state.queue] : [];
  const inflight = state.inflight && typeof state.inflight === 'object' ? state.inflight : null;
  if (inflight) {
    const recovered = { ...inflight, recovered: true };
    const idx = queue.findIndex((msg) => msg && msg.qid && msg.qid === inflight.qid);
    if (idx >= 0) queue[idx] = { ...queue[idx], recovered: true };
    else queue.unshift(recovered);
  }
  return queue;
}

export const CODEX_RECOVERY_PROMPT = 'Continue the interrupted task from the immediately preceding user request. Inspect the conversation and current workspace state, preserve completed work, and finish only what remains. Do not repeat completed external writes.';
export const CODEX_RECOVERY_DISPLAY = '↻ Continuing the interrupted turn after Box restarted';

export function prepareRecoveredCodexMessage(message, { originalLanded = false } = {}) {
  if (!message || !message.recovered || message.agent !== 'codex' || !originalLanded) return message;
  return {
    ...message,
    text: CODEX_RECOVERY_PROMPT,
    displayText: CODEX_RECOVERY_DISPLAY,
    recoveredOriginalLanded: true,
  };
}
