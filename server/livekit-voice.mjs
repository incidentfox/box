import { AccessToken, AgentDispatchClient } from 'livekit-server-sdk';

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
  const dispatch = new AgentDispatchClient(config.apiUrl, config.apiKey, config.apiSecret);
  const job = await dispatch.createDispatch(room, config.agentName, {
    metadata: JSON.stringify({ vsid: String(vsid), ...metadata }),
  });
  return { url: config.url, room, identity, token: await token.toJwt(), dispatchId: job.id || '' };
}
