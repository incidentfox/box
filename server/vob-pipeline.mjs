import {
  VOB_PRODUCTION_MODEL,
  VOB_PRODUCTION_PROMPT_SOURCE,
  VOB_PRODUCTION_PROMPT_VERSION,
} from './vob-production-prompt.mjs';

// This is an owner-facing, PHI-free description of the Rise4 VOB decision
// pipeline.  It intentionally describes the contracts rather than exposing
// private operator source paths or any case data.
export const VOB_PIPELINE_VERSION = 'rise4-vob-pipeline-2026-08-08.v2';

export const RUNTIME_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['speak', 'silence', 'press_digit', 'end_call'] },
    say: { type: 'string' },
    digit: { type: 'string' },
    proposed_complete: { type: 'boolean' },
    terminal_reason: { type: 'string', enum: ['none', 'closed_office', 'wrong_route', 'human_only_refusal', 'provider_only_refusal', 'failed_verification', 'code_specific_unavailable', 'disconnected'] },
  },
  required: ['action', 'say', 'digit', 'proposed_complete', 'terminal_reason'],
});

export const EVIDENCE_UPDATE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    evidence_updates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string' },
          status: { type: 'string', enum: ['confirmed', 'denied', 'not_applicable', 'unavailable', 'contradictory'] },
          value: { type: 'string' },
          evidence_quote: { type: 'string' },
          evidence_turn_index: { type: 'integer' },
          is_correction: { type: 'boolean' },
        },
        required: ['key', 'status', 'value', 'evidence_quote', 'evidence_turn_index', 'is_correction'],
      },
    },
  },
  required: ['evidence_updates'],
});

export const FACT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string' },
          status: { type: 'string', enum: ['confirmed', 'denied', 'not_applicable', 'unavailable', 'missing', 'contradictory'] },
          value: { type: 'string' },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                turn_index: { type: 'integer' },
                quote: { type: 'string' },
              },
              required: ['turn_index', 'quote'],
            },
          },
        },
        required: ['key', 'status', 'value', 'evidence'],
      },
    },
  },
  required: ['facts'],
});

export const EXTRACTOR_PROMPT_TEMPLATE = `Extract VOB facts only from the payer-side turns in this speaker-attributed transcript.
The payer side is role=user. The caller/agent side is role=agent.
For each requirement, return exactly one fact with the identical key.
Evidence must include a short verbatim answer quote from role=user and its zero-based turn index.
Never use the caller's question, assertion, readback, or supplied identifier as evidence.
For a code-specific fact, cite enough text to both name that exact code and establish the payer answer. When the caller names one exact code and the payer answers it in the next turn without repeating the number, cite both the role=agent question as referent and the role=user answer. The agent quote establishes only the code referent, never the answer.
If the caller asks about an exact list of codes and the payer says coverage cannot be determined without a diagnosis code, mark covered as unavailable for each exact code in that adjacent caller question. Do not infer valid/billable or authorization from that limitation.
Use unavailable only when the payer explicitly says the information cannot be provided. Use missing when it was not resolved. Use contradictory when payer statements conflict and the conflict was not resolved.
A name-plus-date reference is confirmed only if the payer explicitly says that is the official reference convention.
For call.live_representative, repeated automated requests for member ID, DOB, caller name, or reason for calling do not count. Confirm it only from a contextual human introduction, or from a human answering the caller's direct request for the representative's name.
Do not infer coverage, authorization, referral, network, cost share, or reference numbers.
REQUIREMENTS:
{{requirements}}
TRANSCRIPT:
{{transcript}}`;

const freeze = (value) => Object.freeze(value);

export function buildVobPipeline() {
  return freeze({
    version: VOB_PIPELINE_VERSION,
    // The call is no longer the first thing that happens. An X12 270 eligibility
    // request goes to the payer's own system first, and whatever it answers is
    // dropped from the question list before anyone dials.
    eligibility: freeze({
      kind: 'deterministic',
      title: 'Payer eligibility check (X12 270/271)',
      source: 'rise4-eligibility-step:runEligibilityStep',
      prompt: null,
      rules: freeze([
        'Send a 270 to the payer before the call and read the 271 into a benefits ledger.',
        'A failed or skipped check changes nothing: the call proceeds with the full question list.',
        'Only fields the payer answered are dropped from what the call has to ask.',
        'Facts obtained here are payer-verified and outrank nothing the representative later corrects.',
      ]),
      explanation: 'Deterministic EDI, no model. This is why a case can already show confirmed benefits before its first call connects.',
    }),
    caller: freeze({
      kind: 'llm',
      title: 'Live caller decision',
      source: 'rise4-runtime-output-gate:proposeRuntimeTurn',
      controlModel: VOB_PRODUCTION_MODEL,
      mediaModel: 'google/gemma-4-31b-it',
      mediaContract: 'Deepgram Flux transcription + Cartesia Sonic 3.5 speech',
      output: freeze({ format: 'json_schema', name: 'rise4_runtime_turn', strict: true, schema: RUNTIME_SCHEMA }),
      promptRef: freeze({ version: VOB_PRODUCTION_PROMPT_VERSION, source: VOB_PRODUCTION_PROMPT_SOURCE }),
      explanation: 'The control model proposes a small call-control envelope. Only say is spoken; action, digit, and completion fields are control data.',
    }),
    extractor: freeze({
      kind: 'llm',
      title: 'Transcript evidence extractor',
      source: 'rise4-transcript-evidence:extractTranscriptEvidence',
      model: VOB_PRODUCTION_MODEL,
      output: freeze({ format: 'json_schema', name: 'rise4_vob_evidence', strict: true, schema: FACT_SCHEMA }),
      promptTemplate: EXTRACTOR_PROMPT_TEMPLATE,
      explanation: 'After turns arrive, this stage proposes one fact per requested ledger key and must cite a payer-side quote plus its turn index.',
    }),
    runtimeEvidence: freeze({
      kind: 'llm',
      title: 'Turn evidence updates',
      source: 'rise4-runtime-output-gate:extractRuntimeEvidence',
      model: VOB_PRODUCTION_MODEL,
      output: freeze({ format: 'json_schema', name: 'rise4_runtime_evidence_updates', strict: true, schema: EVIDENCE_UPDATE_SCHEMA }),
      explanation: 'An optional bounded extraction pass can attach evidence to the current turn; it cannot bypass the deterministic evidence checks.',
    }),
    validator: freeze({
      kind: 'deterministic',
      title: 'Runtime output validator',
      source: 'rise4-runtime-output-gate:applyRuntimeOutputGate',
      prompt: null,
      rules: freeze([
        'Normalize the model envelope and allow only speak, silence, press_digit, or end_call.',
        'Speak only the say field; press_digit uses digit and never speaks it.',
        'Enforce one concise question at a time and suppress unsafe or malformed output.',
        'Block premature completion, invalid terminal reasons, and hangups while a representative is still engaged.',
        'Apply IVR/hold/human-phase transitions and merge only validated evidence updates.',
      ]),
      explanation: 'There is no validator prompt. This is a deterministic postprocessor that can override an LLM proposal before it reaches LiveKit.',
    }),
    merge: freeze({
      kind: 'deterministic',
      title: 'Evidence merge across sources',
      source: 'rise4-transcript-evidence:mergeEligibilityEvidence',
      prompt: null,
      rules: freeze([
        'Union, never replace: eligibility facts fill only keys the call left missing or contradictory.',
        'The representative always wins. A payer-side answer overrides the earlier EDI value for the same key.',
        'Answered keys drop off the follow-up list so a later attempt does not re-ask them.',
        'Knowledge accumulates across attempts; a later empty result cannot erase an earlier answer.',
      ]),
      explanation: 'What the case knows is the union of every source, recomputed after each attempt.',
    }),
    ledger: freeze({
      kind: 'deterministic',
      title: 'Evidence ledger + close gate',
      source: 'rise4-transcript-evidence + rise4-vob-close-gate',
      prompt: null,
      statuses: freeze(['confirmed', 'denied', 'not_applicable', 'unavailable', 'missing', 'contradictory']),
      rules: freeze([
        'Start every requested field as missing/pending and keep requirements conditional on the benefit channel and call route.',
        'Accept a value only when payer-side evidence supports the exact key; retain quote, turn index, and corrections.',
        'Never infer coverage, network, authorization, referral, cost share, or a code result from a generic answer.',
        'Keep contradictions visible until a later payer statement resolves them.',
        'Ask the next unresolved required question; complete only when the close gate allows it.',
      ]),
      closeGate: freeze({
        source: 'rise4-vob-close-gate:evaluateCloseGate',
        modes: freeze(['continue', 'complete', 'terminal_partial']),
        fields: freeze(['reached_human', 'rep_name', 'reference_status', 'provider_and_plan', 'network_and_status', 'code_results', 'benefits', 'authorization', 'conditional_channel_fields', 'contradictions']),
      }),
      explanation: 'There is no ledger prompt. The ledger is deterministic state: payer evidence moves fields between statuses, and the close gate decides continue, complete, or terminal partial.',
    }),
  });
}

// The guarded pipeline remains the production default. Prompt-only is an
// intentionally small experimentation lane: it runs the same caller prompt
// in LiveKit, but leaves post-call extraction, validation, evidence, and
// completion decisions out of the loop so an owner can iterate quickly.
export function buildVobPipelineModes() {
  const guarded = buildVobPipeline();
  return {
    production_guarded: {
      id: 'production_guarded',
      label: 'Production guarded',
      description: 'Production caller with deterministic evidence validation, ledger updates, and the close gate.',
      deterministicStages: ['validator', 'ledger'],
      pipeline: guarded,
    },
    prompt_only: {
      id: 'prompt_only',
      label: 'Prompt-only iteration',
      description: 'One production caller prompt in a test lane; no extractor, validator, ledger update, or close gate.',
      deterministicStages: [],
      removedStages: ['extractor', 'runtimeEvidence', 'validator', 'ledger'],
      pipeline: {
        version: 'rise4-vob-prompt-only-2026-08-07.v1',
        caller: {
          id: 'caller',
          title: 'Prompt-only VOB caller',
          kind: 'livekit_llm',
          deterministic: false,
          explanation: 'The same production caller prompt runs as a single LiveKit conversation; no deterministic postprocessor runs.',
        },
      },
    },
  };
}
