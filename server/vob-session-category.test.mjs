import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isVobCallSession } from './vob-session-category.mjs';

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
