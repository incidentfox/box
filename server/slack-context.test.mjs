import assert from 'node:assert/strict';
import { slackConfigured, slackRecent, slackSearch, renderSlackContext, slackEventForMessage } from './slack-context.mjs';

function json(body) {
  return { ok: true, status: 200, json: async () => body };
}

function fakeFetch(url) {
  const u = new URL(String(url));
  const method = u.pathname.split('/').pop();
  if (method === 'conversations.list') {
    return json({
      ok: true,
      channels: [
        { id: 'COPS', name: 'ops', updated: 30 },
        { id: 'COLD', name: 'old', updated: 1 },
      ],
      response_metadata: { next_cursor: '' },
    });
  }
  if (method === 'conversations.info') {
    return json({ ok: true, channel: { id: u.searchParams.get('channel'), name: 'direct' } });
  }
  if (method === 'conversations.history') {
    assert.equal(u.searchParams.get('channel'), 'COPS');
    return json({
      ok: true,
      messages: [
        { ts: '1780000000.000100', user: 'U1', text: 'Ping <#COPS|ops> from <@U2> &amp; <https://example.com|link>' },
        { ts: '1780000001.000200', username: 'bot', text: 'Latest update' },
      ],
    });
  }
  if (method === 'search.messages') {
    assert.equal(u.searchParams.get('query'), 'invoice');
    return json({
      ok: true,
      messages: {
        matches: [
          { ts: '1780000002.000300', user: 'U3', text: 'invoice approved', channel: { id: 'COPS', name: 'ops' }, permalink: 'https://slack.test/archives/COPS/p178' },
        ],
      },
    });
  }
  return json({ ok: false, error: 'unknown_method' });
}

const cfg = (k, d = '') => ({
  SLACK_USER_TOKEN: 'xoxp-test',
  SLACK_CHANNELS: '#ops',
  SLACK_CONTEXT_MAX_MESSAGES: '5',
}[k] || d);

assert.equal(slackConfigured(cfg), true);
assert.equal(slackConfigured(() => ''), false);

const recent = await slackRecent({ cfg, fetchImpl: fakeFetch });
assert.equal(recent.configured, true);
assert.deepEqual(recent.channels, [{ id: 'COPS', name: '#ops' }]);
assert.equal(recent.messages.length, 2);
assert.equal(recent.messages[1].text, 'Ping #ops from @U2 & link (https://example.com)');

const rendered = await renderSlackContext({ cfg, fetchImpl: fakeFetch });
assert.match(rendered, /Recent Slack messages:/);
assert.match(rendered, /Latest update/);

const search = await slackSearch({ query: 'invoice', cfg, fetchImpl: fakeFetch });
assert.equal(search.matches.length, 1);
assert.equal(search.matches[0].permalink, 'https://slack.test/archives/COPS/p178');
assert.deepEqual(slackEventForMessage(search.matches[0]), {
  type: 'slack',
  ts: '2026-05-28T20:26:42.000Z',
  title: '#ops U3',
  summary: 'invoice approved',
  url: 'https://slack.test/archives/COPS/p178',
});

const missing = await slackRecent({ cfg: () => '' });
assert.equal(missing.configured, false);

console.log('slack-context tests passed');
