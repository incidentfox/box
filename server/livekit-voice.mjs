import { AccessToken, RoomConfiguration } from 'livekit-server-sdk';

export function voiceAdapterTransport(value = 'livekit') {
  return String(value || 'livekit').trim().toLowerCase() === 'legacy' ? 'legacy' : 'livekit';
}

export function livekitRoomName(vsid) {
  const safe = String(vsid || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  return safe ? `box-voice-${safe}` : '';
}

export function livekitParticipantIdentity(vsid) {
  const room = livekitRoomName(vsid);
  return room ? `caller-${room.slice('box-voice-'.length)}` : '';
}

export function livekitHttpUrl(url) {
  const raw = String(url || '').trim().replace(/\/$/, '');
  if (!raw) return '';
  return raw.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
}

export function livekitAdapterConfig({ url, apiKey, apiSecret, agentName = 'box-codex-voice', transport = 'livekit' } = {}) {
  return {
    transport: voiceAdapterTransport(transport),
    url: String(url || '').trim().replace(/\/$/, ''),
    apiUrl: livekitHttpUrl(url),
    apiKey: String(apiKey || '').trim(),
    apiSecret: String(apiSecret || '').trim(),
    agentName: String(agentName || 'box-codex-voice').trim() || 'box-codex-voice',
  };
}

export function livekitConfigured(config) {
  return !!(config && config.transport === 'livekit' && config.url && config.apiUrl && config.apiKey && config.apiSecret && config.agentName);
}

export function livekitRoomOptions({ config, vsid, metadata = {} } = {}) {
  const room = livekitRoomName(vsid);
  if (!room) throw new Error('invalid voice session id');
  return {
    name: room,
    emptyTimeout: 30,
    departureTimeout: 30,
    maxParticipants: 2,
    metadata: JSON.stringify({ source: 'box-voice', vsid: String(vsid) }),
    agents: [{ agentName: config.agentName, metadata: JSON.stringify({ vsid: String(vsid), ...metadata }) }],
  };
}

export async function createLivekitVoiceJoin({ config, vsid, metadata = {} } = {}) {
  if (!livekitConfigured(config)) throw new Error('LiveKit voice runtime is not configured');
  const room = livekitRoomName(vsid);
  const identity = livekitParticipantIdentity(vsid);
  if (!room || !identity) throw new Error('invalid voice session id');
  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity,
    name: 'Box voice caller',
    ttl: '20m',
    metadata: JSON.stringify({ vsid: String(vsid), source: 'box-voice' }),
  });
  token.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
  // Put room creation and the named-agent dispatch in the join token. LiveKit applies
  // this configuration atomically when the caller creates the room. The previous path
  // made a separate RoomService request and waited for it before returning
  // the token, adding 1-2.5 seconds to every call even though the browser still had to
  // perform its own WebRTC connection afterward.
  //
  // This project contains unrelated deployments, so keep the explicit named dispatch
  // and two-participant limit instead of relying on automatic agent dispatch.
  token.roomConfig = new RoomConfiguration(livekitRoomOptions({ config, vsid, metadata }));
  return { url: config.url, room, identity, token: await token.toJwt(), roomSid: '' };
}
