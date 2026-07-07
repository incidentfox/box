/* Voice notification queue — buffers proactive announcements so they never interrupt
 * the user mid-utterance and are never fed to the model as if the user had said them.
 *
 * Context (INC-1084): background work (deep research, delegated agents) finishes while
 * Jimmy is DRIVING and mid-sentence. The old path injected a system message and fired
 * `response.create` the instant the assistant wasn't already talking — which, if the user
 * was speaking, committed their half-finished audio buffer as a turn and made the model
 * answer the notification + the user's partial words together. That (a) dropped the rest
 * of the user's sentence and (b) blended the notification into "what the user said".
 *
 * The fix is a tiny state machine with ONE invariant:
 *
 *     Never send `response.create` for a notification while the user is speaking
 *     or the assistant already has a response in flight.
 *
 * Notifications are held in a FIFO queue and delivered only at a genuine end-of-turn gap.
 * The notification item itself is always role:"system" / input_text, so even once the
 * model sees it, it is unambiguously a system event, not user speech.
 *
 * This file is deliberately dependency-free and works in BOTH environments:
 *   - Browser: loaded as a classic <script> before voice.js; publishes
 *     `globalThis.VoiceNotify.createNotifyQueue`.
 *   - Node (tests): `import './voice-notify-queue.js'` runs the IIFE for its side effect,
 *     then read `globalThis.VoiceNotify`. (Valid ESM — no top-level import/export.)
 *
 * Side effects are injected (`send`, `diag`, timers) so the machine is pure and testable.
 */

;(function () {
  const DEFAULT_SETTLE_MS = 1000;

  function createNotifyQueue(opts) {
    opts = opts || {};
    const send = opts.send || (() => false);
    const diag = opts.diag || (() => {});
    const settleMs = opts.settleMs != null ? opts.settleMs : DEFAULT_SETTLE_MS;
    const setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = opts.clearTimer || ((h) => clearTimeout(h));

    let userSpeaking = false;   // between input_audio_buffer.speech_started / .speech_stopped
    let activeResponse = false; // between response.created / response.done
    let channelOpen = true;     // data channel usable
    let settleTimer = null;
    const pending = [];         // FIFO of prepared conversation.item.create messages

    // Idle == a safe moment to speak a notification: the user is not mid-utterance,
    // the assistant is not mid-response, and we can actually send.
    function idle() { return !userSpeaking && !activeResponse && channelOpen; }

    function cancelSettle() {
      if (settleTimer != null) { clearTimer(settleTimer); settleTimer = null; }
    }

    // A backstop for the rare case where end-of-turn never produces a response.done
    // (e.g. the model stays silent). If the queue is non-empty and we're idle, deliver
    // after a quiet window; if anything becomes busy in the meantime we stand down.
    function armSettle() {
      if (!pending.length || settleTimer != null || !idle()) return;
      settleTimer = setTimer(() => { settleTimer = null; tryDeliver('settle'); }, settleMs);
    }

    // Build the injected item. ALWAYS role:"system" + input_text so the model can never
    // mistake a notification for something the user said.
    function makeItem(text) {
      return {
        type: 'conversation.item.create',
        item: { type: 'message', role: 'system', content: [{ type: 'input_text', text: String(text) }] },
      };
    }

    function reason() {
      if (userSpeaking) return 'user_speaking';
      if (activeResponse) return 'active_response';
      if (!channelOpen) return 'channel_closed';
      return 'idle';
    }

    // Queue a notification. Delivered now only if fully idle; otherwise held until the
    // next real end-of-turn gap. Returns { delivered, queued, depth }.
    function enqueue(text, meta) {
      pending.push(makeItem(text));
      if (!idle()) {
        diag('pipeline', 'notify_queued', { reason: reason(), chars: String(text).length, depth: pending.length, kind: (meta && meta.kind) || '' });
        return { delivered: false, queued: true, depth: pending.length };
      }
      const r = tryDeliver('enqueue');
      return { delivered: !!r.delivered, queued: !r.delivered, depth: pending.length };
    }

    function tryDeliver(cause) {
      if (!pending.length) return { delivered: false };
      if (!idle()) { armSettle(); return { delivered: false, held: reason() }; }
      cancelSettle();
      const batch = pending.splice(0);
      const failed = [];
      let sent = 0;
      for (const m of batch) { if (send(m)) sent++; else failed.push(m); }
      // Re-queue anything the channel refused; preserve FIFO order.
      if (failed.length) { pending.unshift(...failed); }
      if (sent > 0) {
        diag('pipeline', 'notify_delivered', { count: sent, cause });
        send({ type: 'response.create' });
        return { delivered: true, count: sent };
      }
      diag('pipeline', 'notify_send_failed', { cause, depth: pending.length });
      return { delivered: false };
    }

    return {
      enqueue,

      // ---- realtime-event hooks (wire these to the OpenAI data-channel events) ----
      onUserSpeechStart() {
        userSpeaking = true;
        cancelSettle(); // do NOT deliver over the user
        if (pending.length) diag('pipeline', 'notify_hold', { reason: 'user_speaking', depth: pending.length });
      },
      onUserSpeechStop() {
        userSpeaking = false;
        // Don't deliver immediately: the user's own utterance is about to get a response
        // (response.created will follow). Arm the backstop for the silent-turn case.
        armSettle();
      },
      onResponseStart() {
        activeResponse = true;
        cancelSettle();
      },
      onResponseDone() {
        activeResponse = false;
        // The assistant just finished its turn — the natural gap to speak a notification.
        tryDeliver('response_done');
      },
      setChannelOpen(v) {
        channelOpen = !!v;
        if (channelOpen) tryDeliver('channel_open');
        else cancelSettle();
      },

      // Reset transient turn state on a fresh connection WITHOUT dropping queued
      // notifications (a finished task shouldn't be lost to a reconnect).
      reset() {
        userSpeaking = false;
        activeResponse = false;
        cancelSettle();
      },

      // ---- introspection (telemetry + tests) ----
      pendingCount() { return pending.length; },
      isIdle() { return idle(); },
      state() { return { userSpeaking, activeResponse, channelOpen, pending: pending.length }; },
    };
  }

  const api = { createNotifyQueue };
  if (typeof globalThis !== 'undefined') globalThis.VoiceNotify = api;
})();
