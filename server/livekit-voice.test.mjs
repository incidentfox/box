import assert from 'node:assert/strict';
import { livekitAdapterConfig, livekitConfigured, livekitHttpUrl, livekitParticipantIdentity, livekitRoomName, voiceAdapterTransport } from './livekit-voice.mjs';

assert.equal(voiceAdapterTransport(), 'livekit');
assert.equal(voiceAdapterTransport('legacy'), 'legacy');
assert.equal(voiceAdapterTransport('anything else'), 'livekit');
assert.equal(livekitRoomName('a bad / session'), 'box-voice-abadsession');
assert.equal(livekitParticipantIdentity('hello'), 'caller-hello');
assert.equal(livekitHttpUrl('wss://example.livekit.cloud/'), 'https://example.livekit.cloud');
const config = livekitAdapterConfig({ url: 'wss://example.livekit.cloud', apiKey: 'key', apiSecret: 'secret' });
assert.equal(config.agentName, 'box-codex-voice');
assert.equal(livekitConfigured(config), true);
assert.equal(livekitConfigured({ ...config, apiSecret: '' }), false);
console.log('livekit voice helpers: ok');
