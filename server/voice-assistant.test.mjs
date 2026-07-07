import assert from 'node:assert/strict';
import {
  sanitizeVoiceEvent,
  voiceBool,
  voiceResponseStyle,
  voiceTurnDetectionConfig,
} from './voice-assistant.mjs';

assert.equal(voiceBool(undefined, true), true);
assert.equal(voiceBool('1'), true);
assert.equal(voiceBool('yes'), true);
assert.equal(voiceBool('0'), false);
assert.equal(voiceBool('off'), false);

{
  const brief = voiceResponseStyle();
  assert.match(brief, /ONE short spoken sentence/);
  assert.match(brief, /twelve words/);
  assert.match(brief, /Three sentences is the hard cap/);
  assert.doesNotMatch(brief, /3-5 spoken sentences/);
}

{
  const normal = voiceResponseStyle('normal');
  assert.match(normal, /1-3 concise spoken sentences/);
}

{
  const semantic = voiceTurnDetectionConfig();
  assert.deepEqual(semantic, {
    type: 'semantic_vad',
    eagerness: 'low',
    create_response: true,
    interrupt_response: false,
  });
}

{
  const serverVad = voiceTurnDetectionConfig({ mode: 'server', interruptResponse: true });
  assert.equal(serverVad.type, 'server_vad');
  assert.equal(serverVad.interrupt_response, true);
  assert.equal(serverVad.threshold, 0.65);
  assert.equal(serverVad.silence_duration_ms, 800);
}

{
  const ev = sanitizeVoiceEvent({
    ts: 123,
    kind: 'diag',
    source: 'webrtc',
    event: 'inbound_audio_stats',
    data: {
      packetsLostDelta: 2,
      jitterMs: 31.23456,
      nested: { nope: true },
      secret: 'x'.repeat(400),
      'bad key !!!': 'kept',
    },
    ignored: 'drop',
  });
  assert.equal(ev.ts, 123);
  assert.equal(ev.kind, 'diag');
  assert.equal(ev.source, 'webrtc');
  assert.equal(ev.event, 'inbound_audio_stats');
  assert.equal(ev.data.packetsLostDelta, 2);
  assert.equal(ev.data.jitterMs, 31.235);
  assert.equal(ev.data.nested, undefined);
  assert.equal(ev.data.secret.length, 240);
  assert.equal(ev.data['badkey'], 'kept');
  assert.equal(ev.ignored, undefined);
}

{
  const ev = sanitizeVoiceEvent({ kind: 'assistant', text: ' hello '.repeat(1000), name: 'tool'.repeat(20) }, 456);
  assert.equal(ev.ts, 456);
  assert.equal(ev.kind, 'assistant');
  assert.ok(ev.text.length <= 2000);
  assert.ok(ev.name.length <= 40);
}

console.log('voice-assistant helpers ok');
