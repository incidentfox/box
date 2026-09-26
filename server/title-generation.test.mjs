import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Keep title policy directly testable without booting the Box server or calling a model.
const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function isPlaceholderTitle(');
const end = source.indexOf('async function aiTitleFromPrompt(');
assert.ok(start >= 0 && end > start, 'title helpers are present in the server');
const context = {};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);
const combineStart = source.indexOf('function combineQueued(');
const combineEnd = source.indexOf('function codexUserQidPersisted(');
assert.ok(combineStart >= 0 && combineEnd > combineStart, 'queue combiner is present in the server');
vm.runInContext(source.slice(combineStart, combineEnd), context);

const scheduledPrompt = 'You are running an automated daily task. Task: Reconcile overnight claim failures and flag action items.';
assert.equal(context.fallbackTitleFromPrompt(scheduledPrompt), 'Reconcile Overnight Claim Failures Flag');
assert.equal(context.fallbackTitleFromPrompt('You are running an automated daily task.'), 'Scheduled Task');
assert.equal(context.fallbackTitleFromPrompt('Please investigate the duplicate history entries.'), 'Investigate Duplicate History Entries');

const generated = context.titleForAgentEnqueue('', scheduledPrompt);
assert.equal(generated.title, 'Reconcile Overnight Claim Failures Flag');
assert.equal(generated.generated, true);
const callerSupplied = context.titleForAgentEnqueue('Nightly reconciliation', scheduledPrompt);
assert.equal(callerSupplied.title, 'Nightly reconciliation');
assert.equal(callerSupplied.generated, false);

const generatedCodexTitle = context.codexOpeningTitle({ title: generated.title, titleGenerated: true }, scheduledPrompt, true);
assert.equal(generatedCodexTitle.explicitTitle, '');
assert.equal(generatedCodexTitle.initialTitle, 'Reconcile Overnight Claim Failures Flag');
const explicitCodexTitle = context.codexOpeningTitle({ title: 'A deliberate name' }, scheduledPrompt, true);
assert.equal(explicitCodexTitle.explicitTitle, 'A deliberate name');
assert.equal(explicitCodexTitle.initialTitle, 'A deliberate name');

const batchedGeneratedTitle = context.combineQueued([
  { qid: 'first', text: scheduledPrompt, mode: 'normal', agent: 'codex', title: generated.title, titleGenerated: true },
  { qid: 'second', text: 'and notify the reviewer', mode: 'normal', agent: 'codex' },
]);
assert.equal(batchedGeneratedTitle.title, generated.title);
assert.equal(batchedGeneratedTitle.titleGenerated, true);

console.log('title generation tests passed');
