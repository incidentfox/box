import assert from 'node:assert/strict';
import { sttEngineOrder, stripNonSpeechTags } from './stt-engine.mjs';

const both = { eleven: true, deepgram: true };

// Default: Scribe leads, Deepgram is the fallback — the whole point of the change.
assert.deepEqual(sttEngineOrder(undefined, both), ['eleven', 'deepgram']);
assert.deepEqual(sttEngineOrder('eleven', both), ['eleven', 'deepgram']);
// STT_ENGINE=deepgram reverts to the old behaviour without a code change.
assert.deepEqual(sttEngineOrder('deepgram', both), ['deepgram', 'eleven']);
// An unknown value must not disable STT — fall back to the default order.
assert.deepEqual(sttEngineOrder('whisper', both), ['eleven', 'deepgram']);

// A self-hoster with one key still works, whichever key it is, and whatever they asked for.
assert.deepEqual(sttEngineOrder('eleven', { deepgram: true }), ['deepgram']);
assert.deepEqual(sttEngineOrder('deepgram', { eleven: true }), ['eleven']);
assert.deepEqual(sttEngineOrder('eleven', {}), []);

// Whole-transcript tags are the production symptom: 10 rows of the voice log are nothing
// but one of these, and they were pasted into the prompt box as if dictated.
for (const tag of ['[pause]', '[silence]', '[inhales]', '[background noise]', '[LAUGHTER]', ' [pause] ']) {
  assert.equal(stripNonSpeechTags(tag), '', `bare ${tag} should strip to empty`);
}
// Empty output matters beyond tidiness: transcribeBuffer treats empty as "engine failed"
// and falls through to the next one, which is the behaviour we want on a silent clip.
assert.equal(stripNonSpeechTags(''), '');
assert.equal(stripNonSpeechTags(null), '');

// Mid-transcript tags are removed without welding the surrounding words together.
assert.equal(stripNonSpeechTags('Hello [pause] world'), 'Hello world');
assert.equal(stripNonSpeechTags('Send it [background noise] to Carisk.'), 'Send it to Carisk.');

// Real speech is never touched — including Mandarin, which is what this change exists for.
assert.equal(stripNonSpeechTags('但是这个玩意儿它可以说中文。'), '但是这个玩意儿它可以说中文。');
assert.equal(stripNonSpeechTags('It should be on the W-9.'), 'It should be on the W-9.');
// Brackets that are not a known non-speech tag are left alone — this is a closed list.
assert.equal(stripNonSpeechTags('Check [INC-1215] please'), 'Check [INC-1215] please');

console.log('stt-engine ok');
