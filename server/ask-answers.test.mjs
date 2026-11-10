import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerAskQuestions, sameLabel } from './ask-answers.mjs';

// A fake TUI: one question per screen, then a review screen, then done.
function fakeTui(questions) {
  let step = 0; const chosen = [];
  const io = {
    readPrompt: async () => step < questions.length
      ? { kind: 'question', options: questions[step].map((label, k) => ({ n: k + 1, label })) }
      : step === questions.length && questions.length > 1
        ? { kind: 'review', options: [{ n: 1, label: 'Submit answers' }, { n: 2, label: 'Cancel' }] }
        : null,
    choose: async (n) => { chosen.push(n); step++; },
    isWaiting: async () => step < questions.length + (questions.length > 1 ? 1 : 0),
    sleep: async () => {},
  };
  return { io, chosen };
}

test('multi-question ask answers each tab then submits the review screen', async () => {
  const { io, chosen } = fakeTui([['Fix date + Send Duplicate now', 'Wait'], ['Single date 12/11/2025 (Recommended)', 'Keep CT']]);
  await answerAskQuestions(io, [{ index: 1, label: 'Fix date + Send Duplicate now' }, { index: 1, label: 'Single date 12/11/2025 (Recommended)' }]);
  assert.deepEqual(chosen, [1, 1, 1]);
});
test('single question picks the option and stops', async () => {
  const { io, chosen } = fakeTui([['A', 'B', 'C']]);
  await answerAskQuestions(io, [{ index: 3, label: 'C' }]);
  assert.deepEqual(chosen, [3]);
});
test('a mismatched live screen refuses instead of picking the wrong row', async () => {
  const { io, chosen } = fakeTui([['Something else', 'B']]);
  await assert.rejects(answerAskQuestions(io, [{ index: 1, label: 'A' }]), /answer it on desktop/);
  assert.deepEqual(chosen, []);
});
test('labels match across TUI wrapping/truncation', () => {
  assert.ok(sameLabel('Single date 12/11/2025 (Recommended)', 'Single  date 12/11/2025 (Recom'));
  assert.ok(!sameLabel('Keep CT', 'Single date'));
});
