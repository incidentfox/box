// ask-answers.mjs — answer a parked AskUserQuestion (one or several questions) from the box.
//
// The phone renders the AskUserQuestion card from the JSONL tool_use, so it knows each question's
// options exactly. The live TUI shows ONE question at a time (tabs for multi-question asks): picking
// an option advances to the next question, and a multi-question ask ends on a "Ready to submit your
// answers?" review screen. We drive it step by step and re-scrape before every keypress so a
// mismatch (answered elsewhere, different question showing) stops instead of picking the wrong row.

const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
// The TUI wraps/truncates long labels at the terminal width, so compare on a shared prefix.
export function sameLabel(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  const n = Math.min(x.length, y.length, 40);
  return x.slice(0, n) === y.slice(0, n);
}

// answers: [{ index: 1-based option number, label }] in question order.
// io: { readPrompt(): parsed prompt | null, choose(index), isWaiting(), sleep(ms) }
export async function answerAskQuestions(io, answers) {
  if (!Array.isArray(answers) || !answers.length) throw new Error('No answers to send.');
  for (const [i, a] of answers.entries()) {
    const p = await io.readPrompt();
    const opt = p && p.options && p.options.find((o) => o.n === a.index);
    if (!opt || !sameLabel(opt.label, a.label)) {
      throw new Error(`Couldn't find “${a.label}” on the live question${answers.length > 1 ? ` (${i + 1} of ${answers.length})` : ''} — answer it on desktop.`);
    }
    await io.choose(a.index);
    await io.sleep(500);
  }
  // Multi-question asks stop on the review screen until "Submit answers" is chosen.
  for (let tries = 0; tries < 4; tries++) {
    if (!(await io.isWaiting())) return true;
    const p = await io.readPrompt();
    const submit = p && p.kind === 'review' && p.options.find((o) => /^submit/i.test(o.label));
    if (submit) { await io.choose(submit.n); return true; }
    if (answers.length === 1) return true; // single question: Enter already submitted
    await io.sleep(400);
  }
  return true;
}
