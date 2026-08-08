import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// The console's summarising logic is pure, so it is exercised directly rather
// than through a DOM. Same approach as app-markdown.test.mjs.
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const start = app.indexOf('const VOB_FIELD_LABELS = {');
const end = app.indexOf('function vobRenderSnapshot(vob) {', start);
assert.ok(start >= 0 && end > start, 'locate the VOB console summarisers');

const context = { vobKnownAnswers: null, vobOutstanding: null, vobFieldLabel: null };
vm.runInNewContext(`${app.slice(start, end)}`, context);
const plain = (value) => JSON.parse(JSON.stringify(value));
const { vobKnownAnswers, vobOutstanding, vobFieldLabel } = context;

test('payer-verified benefits appear as answers even when no call has produced a fact', () => {
  const rows = plain(vobKnownAnswers({
    eligibility: { verified: ['Coverage: active', 'Out-of-pocket maximum: $7,200'] },
    facts: [],
  }));
  assert.deepEqual(rows.map((row) => [row.label, row.value, row.source]), [
    ['Coverage', 'active', 'payer record'],
    ['Out-of-pocket maximum', '$7,200', 'payer record'],
  ]);
});

test('a representative answer overrides the eligibility value for the same field', () => {
  // This is the precedence the operator's evidence merge applies. The console
  // showing the stale EDI number next to a rep correction would be a lie about
  // what we would tell the customer.
  const rows = plain(vobKnownAnswers({
    eligibility: { verified: ['Copay: $30'] },
    facts: [{ key: 'benefit.copay', status: 'confirmed', value: '$45' }],
  }));
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].value, rows[0].source], ['$45', 'call']);
});

test('unconfirmed facts are never shown as answers', () => {
  const rows = plain(vobKnownAnswers({
    facts: [
      { key: 'rep.name', status: 'missing', value: null },
      { key: 'plan.status', status: 'unavailable', value: '' },
      { key: 'benefit.coinsurance', status: 'confirmed', value: '20%' },
    ],
  }));
  assert.deepEqual(rows.map((row) => row.label), ['Coinsurance']);
});

test('the outstanding list excludes answered fields and marks payer refusals', () => {
  const vob = {
    eligibility: { verified: ['Coverage: active'] },
    facts: [{ key: 'benefit.copay', status: 'confirmed', value: '$45' }],
    ledger: [{
      fields: [
        { key: 'benefit.copay', status: 'confirmed' },
        { key: 'plan.status', status: 'confirmed' },
        { key: 'auth.required', status: 'missing' },
        { key: 'claims.address', status: 'unavailable' },
        { key: 'rep.name', status: 'not_applicable' },
      ],
    }],
  };
  assert.deepEqual(plain(vobOutstanding(vob)).map((row) => [row.label, row.status]), [
    ['Auth required', 'missing'],
    ['Claims mailing address', 'unavailable'],
  ]);
});

test('ledger keys render as readable labels', () => {
  assert.equal(vobFieldLabel('benefit.individual_deductible_total'), 'Deductible');
  assert.equal(vobFieldLabel('rep.name'), 'Representative name');
  assert.equal(vobFieldLabel('auth.required'), 'Auth required');
  assert.equal(vobFieldLabel(''), '');
});

test('the observability page describes one pipeline, not a test-lane menu', () => {
  // Rendering prompt-only beside production made every case look as though two
  // pipelines had run against it. The lane is a choice inside the test modal.
  const markup = app.slice(app.indexOf('function vobPipelineMarkup(pipeline, pipelineModes) {'), start);
  assert.ok(!/removedStages/.test(markup), 'the observability pipeline must not render the prompt-only lane');
  assert.ok(/current\.eligibility/.test(markup), 'the eligibility stage must be described');
});
