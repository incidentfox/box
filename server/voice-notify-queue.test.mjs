/* Regression tests for the voice notification queue (INC-1084).
 *
 * Covers the three failure modes from the ticket:
 *   1. Attribution — a notification is NEVER sent as user speech (always role:"system").
 *   2. Interruption — a notification NEVER fires response.create while the user is speaking.
 *   3. Dropped messages — the user's utterance is never truncated by a notification;
 *      the notification is buffered and delivered only at a real end-of-turn gap.
 * Plus buffering (queue depth, FIFO, reconnect survival) and telemetry.
 *
 * The module injects all side effects, so we drive it with a fake `send` sink, a fake
 * timer, and a `diag` recorder — fully deterministic, no browser, no network.
 */

import assert from 'node:assert/strict';
import '../public/voice-notify-queue.js';

const { createNotifyQueue, shouldSpeakUpdate, isEmptyTranscript, isTurnDetectedCancellation } = globalThis.VoiceNotify;
assert.ok(typeof createNotifyQueue === 'function', 'createNotifyQueue is published');

// ---- test harness --------------------------------------------------------------
function harness(settleMs = 1000) {
  const sent = [];
  const diags = [];
  const timers = [];
  let nextId = 1;
  const q = createNotifyQueue({
    settleMs,
    send: (m) => { sent.push(m); return true; },
    diag: (source, event, data) => diags.push({ source, event, data }),
    setTimer: (fn) => { const id = nextId++; timers.push({ id, fn }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
  });
  return {
    q, sent, diags,
    // fire the currently-armed settle timer (the backstop)
    fireSettle() { const t = timers.shift(); if (t) t.fn(); return !!t; },
    pendingTimers() { return timers.length; },
    responseCreates() { return sent.filter((m) => m.type === 'response.create').length; },
    items() { return sent.filter((m) => m.type === 'conversation.item.create'); },
    diagEvents() { return diags.map((d) => d.event); },
  };
}

function withFailingSend(settleMs = 1000) {
  const sent = [];
  let ok = false;
  const q = createNotifyQueue({
    settleMs,
    send: (m) => { if (!ok) return false; sent.push(m); return true; },
    diag: () => {},
    setTimer: (fn) => 0,
    clearTimer: () => {},
  });
  return { q, sent, allow() { ok = true; } };
}

// ================================================================================
// 1. ATTRIBUTION — a notification is always a system event, never user speech.
// ================================================================================
{
  const h = harness();
  h.q.enqueue('research finished: 12 competitors found');
  const items = h.items();
  assert.equal(items.length, 1, 'one conversation item sent when idle');
  const item = items[0].item;
  assert.equal(item.role, 'system', 'notification role is system, never user');
  assert.equal(item.content[0].type, 'input_text', 'notification is input_text, not audio');
  assert.match(item.content[0].text, /research finished/, 'text preserved');
  assert.equal(h.responseCreates(), 1, 'idle delivery triggers exactly one response.create');
}

// ================================================================================
// 2. INTERRUPTION — never fire response.create while the user is mid-utterance.
// ================================================================================
{
  const h = harness();
  h.q.onUserSpeechStart();                 // user starts talking
  const r = h.q.enqueue('deep research landed');
  assert.equal(r.delivered, false, 'not delivered while user is speaking');
  assert.equal(r.queued, true, 'held in the queue instead');
  assert.equal(h.responseCreates(), 0, 'NO response.create while user speaks (no interruption)');
  assert.equal(h.items().length, 0, 'nothing injected into the conversation mid-utterance');
  assert.equal(h.q.pendingCount(), 1, 'buffered');
}

// A notification arriving while the assistant is already responding is also held.
{
  const h = harness();
  h.q.onResponseStart();
  h.q.enqueue('agent finished its pass');
  assert.equal(h.responseCreates(), 0, 'not delivered during an active assistant response');
  assert.equal(h.q.pendingCount(), 1);
}

// ================================================================================
// 3. DROPPED MESSAGES — user speaks, THEN the queued notice is delivered after the
//    user's own turn completes. The user's utterance is never cut off.
// ================================================================================
{
  const h = harness();
  h.q.onUserSpeechStart();
  h.q.enqueue('background task done');      // arrives mid-sentence → buffered
  h.q.onUserSpeechStop();                   // user finished — still no delivery yet
  assert.equal(h.responseCreates(), 0, 'no delivery on speech_stop (user turn about to be answered)');
  h.q.onResponseStart();                    // model answers the user
  h.q.onResponseDone();                     // ...and finishes
  assert.equal(h.responseCreates(), 1, 'notification delivered after the user is fully answered');
  assert.equal(h.items().length, 1, 'exactly the queued notification, in order');
  assert.equal(h.q.pendingCount(), 0, 'queue drained');
}

// Silent-turn backstop: user speaks but the model produces no response.done
// (e.g. side chatter). The settle timer delivers the notice once truly idle.
{
  const h = harness(1000);
  h.q.onUserSpeechStart();
  h.q.enqueue('note: invoice job finished');
  h.q.onUserSpeechStop();                   // arms the settle backstop
  assert.equal(h.responseCreates(), 0, 'nothing yet');
  assert.equal(h.pendingTimers(), 1, 'settle timer armed after speech stop');
  h.fireSettle();                           // quiet window elapses, still idle
  assert.equal(h.responseCreates(), 1, 'backstop delivers when no response.done ever comes');
}

// The settle backstop stands down if the user starts speaking again inside the window.
{
  const h = harness(1000);
  h.q.onUserSpeechStart();
  h.q.enqueue('x');
  h.q.onUserSpeechStop();                   // arms settle
  assert.equal(h.pendingTimers(), 1);
  h.q.onUserSpeechStart();                  // user resumes → cancel settle
  assert.equal(h.pendingTimers(), 0, 'settle canceled when the user speaks again');
  const r = h.q.enqueue('y');
  assert.equal(h.responseCreates(), 0, 'still nothing while speaking');
  assert.equal(h.q.pendingCount(), 2, 'both notices buffered');
}

// ================================================================================
// 4. BUFFERING — multiple notices batch, deliver FIFO, and only ONE response.create.
// ================================================================================
{
  const h = harness();
  h.q.onResponseStart();
  h.q.enqueue('first');
  h.q.enqueue('second');
  h.q.enqueue('third');
  assert.equal(h.q.pendingCount(), 3, 'all buffered during active response');
  h.q.onResponseDone();
  const items = h.items();
  assert.equal(items.length, 3, 'all three flushed');
  assert.deepEqual(items.map((m) => m.item.content[0].text), ['first', 'second', 'third'], 'FIFO order preserved');
  assert.equal(h.responseCreates(), 1, 'a single response.create for the whole batch');
}

// ================================================================================
// 5. RECONNECT — reset() clears turn state but KEEPS queued notices; they deliver
//    once the channel is (re)opened.
// ================================================================================
{
  const h = harness();
  h.q.onResponseStart();
  h.q.enqueue('task done during a drop');
  h.q.setChannelOpen(false);                // dead zone
  h.q.reset();                              // fresh connection, turn state cleared
  assert.equal(h.q.pendingCount(), 1, 'queued notice survives the reconnect');
  assert.equal(h.responseCreates(), 0, 'not delivered while channel closed');
  h.q.setChannelOpen(true);                 // reconnected
  assert.equal(h.responseCreates(), 1, 'delivered once the channel is back');
  assert.equal(h.items()[0].item.role, 'system', 'still a system event after reconnect');
}

// ================================================================================
// 6. TELEMETRY — the events needed to prove queued handling + no mid-speech delivery.
// ================================================================================
{
  const h = harness();
  h.q.onUserSpeechStart();
  h.q.enqueue('telemetry check');
  const ev = h.diagEvents();
  assert.ok(ev.includes('notify_queued'), 'emits notify_queued when held');
  const queued = h.diags.find((d) => d.event === 'notify_queued');
  assert.equal(queued.data.reason, 'user_speaking', 'records WHY it was held');
  h.q.onUserSpeechStop();
  h.q.onResponseStart();
  h.q.onResponseDone();
  assert.ok(h.diagEvents().includes('notify_delivered'), 'emits notify_delivered on flush');
  const delivered = h.diags.find((d) => d.event === 'notify_delivered');
  assert.equal(delivered.data.cause, 'response_done', 'records the delivery trigger');
}

// ================================================================================
// 7. SEND FAILURE — a refused send re-queues the notice (no silent drop).
// ================================================================================
{
  const f = withFailingSend();
  const r = f.q.enqueue('must not be lost');
  assert.equal(r.delivered, false, 'not delivered while send fails');
  assert.equal(f.q.pendingCount(), 1, 're-queued after send failure');
  f.allow();
  f.q.onResponseDone();                      // triggers a retry
  assert.equal(f.q.pendingCount(), 0, 'delivered on retry once the channel works');
  assert.ok(f.sent.some((m) => m.type === 'conversation.item.create'), 'the notice eventually went out');
}

// ================================================================================
// 8. SPEECH POLICY — routine completions stay visual-only; only explicit/urgent
//    server events are allowed to create a new spoken turn.
// ================================================================================
{
  assert.equal(shouldSpeakUpdate({ kind: 'task_done', audible: false }), false);
  assert.equal(shouldSpeakUpdate({ kind: 'watch_pr_ready', audible: true }), true);
  assert.equal(shouldSpeakUpdate({ kind: 'task_failed', audible: true }), true);
  assert.equal(shouldSpeakUpdate({}), false);
}

// Empty/noise turns and turn-detected cancellations are the exact double-reply pattern
// captured in the 2026-07-10 production transcript.
{
  assert.equal(isEmptyTranscript(''), true);
  assert.equal(isEmptyTranscript('   '), true);
  assert.equal(isEmptyTranscript('check the upgrade'), false);
  assert.equal(isTurnDetectedCancellation({ status: 'cancelled', status_details: { type: 'cancelled', reason: 'turn_detected' } }), true);
  assert.equal(isTurnDetectedCancellation({ status: 'completed' }), false);
  assert.equal(isTurnDetectedCancellation({ status: 'cancelled', status_details: { reason: 'client_cancelled' } }), false);
}

console.log('voice-notify-queue ok');
