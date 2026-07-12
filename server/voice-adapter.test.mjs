import assert from 'node:assert/strict';
import {
  buildVoiceAdapterPrompt, spokenAdapterText, voiceAdapterAgent,
  voiceAdapterSessionKey, voiceAdapterVAD, voiceAssistantMode,
} from './voice-adapter.mjs';

assert.equal(voiceAssistantMode(), 'adapter');
assert.equal(voiceAssistantMode('adapter'), 'adapter');
assert.equal(voiceAssistantMode('anything-else'), 'adapter');
assert.equal(voiceAdapterAgent('codex'), 'codex');
assert.equal(voiceAdapterAgent(), 'codex');
assert.equal(voiceAdapterAgent('gemini'), 'codex');
assert.equal(voiceAdapterSessionKey('2026-07-11-aa/bb'), 'voice-adapter-2026-07-11-aabb');
assert.equal(voiceAdapterSessionKey(''), '');
assert.deepEqual(voiceAdapterVAD(), { threshold: 0.004, silenceMs: 900, minSpeechMs: 350 });
assert.deepEqual(voiceAdapterVAD({ threshold: 9, silenceMs: 1, minSpeechMs: 99999 }), { threshold: 0.2, silenceMs: 350, minSpeechMs: 5000 });
assert.match(buildVoiceAdapterPrompt('check the current status', { agent: 'codex', firstTurn: true }), /persistent codex Code session/);
assert.match(buildVoiceAdapterPrompt('check the current status', { agent: 'codex', firstTurn: true }), /one final answer for each voice turn/);
assert.match(buildVoiceAdapterPrompt('next question', { firstTurn: false }), /^USER VOICE TRANSCRIPT/);
assert.match(buildVoiceAdapterPrompt('new direction', { firstTurn: false, interrupted: true }), /interrupted work already under way/);
assert.match(buildVoiceAdapterPrompt('new direction', { firstTurn: false, interrupted: true }), /background or parallel work/);
assert.equal(spokenAdapterText('One. Two.', 20), 'One. Two.');
assert.match(spokenAdapterText('word '.repeat(500), 300), /^word/);
const repeatedReply = 'The slowdown is in the Codex response path, not your microphone or transcription. The backend is taking about four seconds to produce the first text, but playback is then being delayed by roughly twenty-two more seconds, with repeated tiny playback start-and-stop cycles; that points to a voice playback or turn-streaming problem, possibly overlapping turns, rather than network speech recognition.';
assert.equal(spokenAdapterText(repeatedReply, 360), 'The slowdown is in the Codex response path, not your microphone or transcription.');
const noSentence = 'word '.repeat(100) + 'unfinished';
assert.ok(spokenAdapterText(noSentence, 360).endsWith('word…'), 'progress must stop at the last complete word');
console.log('voice-adapter helpers ok');
