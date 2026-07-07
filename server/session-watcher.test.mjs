import assert from 'node:assert/strict';
import {
  WATCH_TRIGGERS,
  classifyWatchSnapshot,
  classifyWatchTransition,
  detectPrSignals,
  normalizeWatchTriggers,
  watchHash,
} from './session-watcher.mjs';

assert.deepEqual(normalizeWatchTriggers(['finished', 'bogus', 'needs_input', 'finished']), ['finished', 'needs_input']);
assert.deepEqual(normalizeWatchTriggers('pr_ready,pr_merged'), ['pr_ready', 'pr_merged']);
assert.deepEqual(normalizeWatchTriggers([]), WATCH_TRIGGERS);

{
  const before = { title: 'INC-1089', status: 'working', latestReply: 'Running tests.' };
  const after = { title: 'INC-1089', status: 'idle', latestReply: 'Done. Tests passed.' };
  const events = classifyWatchTransition(before, after, ['finished']);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'finished');
  assert.match(events[0].summary, /Finished "INC-1089"/);
}

{
  // "live" means an attached bridge exists; it is not enough to call a session finished.
  const events = classifyWatchTransition(
    { title: 'Bridge', status: 'live', latestReply: 'Idle but attached.' },
    { title: 'Bridge', status: 'idle', latestReply: 'Idle but detached.' },
    ['finished'],
  );
  assert.equal(events.length, 0);
}

{
  const events = classifyWatchTransition(
    { title: 'Ticket agent', status: 'working', latestReply: 'Investigating.' },
    { title: 'Ticket agent', status: 'needs_input', latestReply: 'Blocked: needs Jimmy to pick the remediation.' },
    ['needs_input', 'blocked'],
  );
  assert.deepEqual(events.map((e) => e.type), ['needs_input', 'blocked']);
  assert.equal(new Set(events.map((e) => e.key)).size, 2, 'different trigger keys for dedup');
}

{
  const events = classifyWatchTransition(
    { title: 'Build agent', status: 'working', latestReply: 'Starting.' },
    { title: 'Build agent', status: 'working', latestReply: 'Tests failed with Error: missing token.' },
    ['error'],
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
}

{
  const readyText = 'Opened PR https://github.com/incidentfox/box/pull/104 and it is ready for review.';
  const ready = detectPrSignals(readyText);
  assert.equal(ready.ready, true);
  assert.equal(ready.merged, false);
  assert.equal(ready.ref, 'https://github.com/incidentfox/box/pull/104');

  const events = classifyWatchTransition(
    { title: 'PR agent', status: 'working', latestReply: 'Still editing.' },
    { title: 'PR agent', status: 'idle', latestReply: readyText },
    ['finished', 'pr_ready'],
  );
  assert.deepEqual(events.map((e) => e.type), ['pr_ready', 'finished']);
  assert.equal(events[0].key, 'pr_ready:https://github.com/incidentfox/box/pull/104');
}

{
  const mergedText = 'PR https://github.com/incidentfox/box/pull/104 merged and deployed.';
  const merged = detectPrSignals(mergedText);
  assert.equal(merged.merged, true);
  assert.equal(merged.ready, false);
  const events = classifyWatchTransition(
    { title: 'PR agent', status: 'idle', latestReply: 'PR https://github.com/incidentfox/box/pull/104 ready for review.' },
    { title: 'PR agent', status: 'idle', latestReply: mergedText },
    ['pr_ready', 'pr_merged'],
  );
  assert.deepEqual(events.map((e) => e.type), ['pr_merged']);
}

{
  const a = classifyWatchSnapshot({ status: 'working', latestReply: 'same text' });
  const b = classifyWatchSnapshot({ status: 'working', latestReply: 'same text' });
  assert.equal(a.textHash, b.textHash);
  assert.equal(a.textHash, watchHash('same text'));
}

console.log('session-watcher ok');
