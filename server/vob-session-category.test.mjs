import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isVobCallSession, mainPageSessionRank } from './vob-session-category.mjs';

test('classifies an explicit VOB category', () => {
  assert.equal(isVobCallSession({ category: 'vob' }), true);
  assert.equal(isVobCallSession({ sessionCategory: 'vob-call' }), true);
});

test('classifies live VOB operator and remediation directories', () => {
  assert.equal(isVobCallSession({ cwd: '/home/factory/.factory/rise4-vob/production/operators/request-1' }), true);
  assert.equal(isVobCallSession({ cwd: '/home/factory/.factory/rise4-vob/production/remediation/call-1/attempt-2' }), true);
});

test('uses the VOB operator title as a compatibility fallback', () => {
  assert.equal(isVobCallSession({ title: 'VOB operator • Aetna', cwd: '/home/factory/development' }), true);
  assert.equal(isVobCallSession({ title: 'VOB remediation • Aetna • attempt 2' }), true);
});

test('does not classify ordinary live sessions or unrelated VOB work', () => {
  assert.equal(isVobCallSession({ title: 'Recovery Orchestrator', cwd: '/home/factory/development' }), false);
  assert.equal(isVobCallSession({ title: 'Review VOB reporting', cwd: '/home/factory/development/repos/mindbill' }), false);
  assert.equal(isVobCallSession({ cwd: '/home/factory/.factory/rise4-vob/campaigns/20260731' }), false);
});

test('orders the main page as Favorites, VOB calls, Live, then recent', () => {
  const sessions = [
    { id: 'recent', category: 'main', mtime: 40 },
    { id: 'live', category: 'main', pinned: true, mtime: 30 },
    { id: 'vob', category: 'vob', pinned: true, mtime: 20 },
    { id: 'favorite', category: 'main', favorite: true, mtime: 10 },
  ];
  sessions.sort((a, b) => mainPageSessionRank(a) - mainPageSessionRank(b) || b.mtime - a.mtime);
  assert.deepEqual(sessions.map((session) => session.id), ['favorite', 'vob', 'live', 'recent']);
  assert.equal(mainPageSessionRank({ category: 'vob', favorite: true, pinned: true }), 1);
});
