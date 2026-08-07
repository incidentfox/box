import assert from 'node:assert/strict';

import {
  EVIDENCE_UPDATE_SCHEMA,
  EXTRACTOR_PROMPT_TEMPLATE,
  FACT_SCHEMA,
  RUNTIME_SCHEMA,
  VOB_PIPELINE_VERSION,
  buildVobPipeline,
  buildVobPipelineModes,
} from './vob-pipeline.mjs';

const pipeline = buildVobPipeline();

assert.equal(pipeline.version, VOB_PIPELINE_VERSION);
assert.equal(pipeline.caller.output.name, 'rise4_runtime_turn');
assert.equal(pipeline.caller.output.strict, true);
assert.deepEqual(pipeline.caller.output.schema, RUNTIME_SCHEMA);
assert.equal(pipeline.extractor.output.name, 'rise4_vob_evidence');
assert.equal(pipeline.extractor.output.strict, true);
assert.deepEqual(pipeline.extractor.output.schema, FACT_SCHEMA);
assert.equal(pipeline.extractor.promptTemplate, EXTRACTOR_PROMPT_TEMPLATE);
assert.match(pipeline.extractor.promptTemplate, /payer-side turns/);
assert.match(pipeline.extractor.promptTemplate, /\{\{requirements\}\}/);
assert.match(pipeline.extractor.promptTemplate, /\{\{transcript\}\}/);
assert.equal(pipeline.runtimeEvidence.output.name, 'rise4_runtime_evidence_updates');
assert.deepEqual(pipeline.runtimeEvidence.output.schema, EVIDENCE_UPDATE_SCHEMA);
assert.equal(pipeline.validator.prompt, null);
assert.equal(pipeline.ledger.prompt, null);
assert.ok(pipeline.ledger.closeGate.fields.includes('contradictions'));
assert.equal(JSON.stringify(pipeline).includes('patient'), false);

const modes = buildVobPipelineModes();
assert.deepEqual(Object.keys(modes), ['production_guarded', 'prompt_only']);
assert.deepEqual(modes.production_guarded.pipeline, pipeline);
assert.deepEqual(modes.production_guarded.deterministicStages, ['validator', 'ledger']);
assert.deepEqual(modes.prompt_only.deterministicStages, []);
assert.deepEqual(modes.prompt_only.removedStages, ['extractor', 'runtimeEvidence', 'validator', 'ledger']);
assert.equal(modes.prompt_only.pipeline.caller.title, 'Prompt-only VOB caller');
assert.deepEqual(Object.keys(modes.prompt_only.pipeline), ['version', 'caller']);
assert.equal(modes.prompt_only.pipeline.extractor, undefined);
assert.equal(modes.prompt_only.pipeline.caller.deterministic, false);

console.log('vob pipeline: ok');
