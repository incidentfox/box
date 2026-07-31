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

export function cancelQueuedMessage(queue, qid, { now = Date.now(), undoMs = 10000 } = {}) {
  const next = Array.isArray(queue) ? [...queue] : [];
  const index = next.findIndex((message) => message && message.qid === qid);
  if (index < 0) return { queue: next, undo: null };
  const [message] = next.splice(index, 1);
  return {
    queue: next,
    undo: { qid, message, index, expiresAt: Number(now) + Math.max(1000, Number(undoMs) || 10000) },
  };
}

export function restoreCanceledMessage(queue, undo, { now = Date.now() } = {}) {
  const next = Array.isArray(queue) ? [...queue] : [];
  if (!undo || !undo.message || Number(now) > Number(undo.expiresAt || 0)) return { queue: next, restored: false };
  if (next.some((message) => message && message.qid === undo.qid)) return { queue: next, restored: true };
  const index = Math.max(0, Math.min(next.length, Number(undo.index) || 0));
  next.splice(index, 0, undo.message);
  return { queue: next, restored: true };
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
