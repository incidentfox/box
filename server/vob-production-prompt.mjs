// This is the production VOB caller prompt copied from Rise4's guarded runtime
// output gate. Keep it pinned here so an owner test room exercises the same
// caller contract as a real payer call; only the media room and model/voice
// transport are different.

export const VOB_PRODUCTION_PROMPT_VERSION = 'rise4-vob-2026-07-31.v145-prioritized-code-profiles';
export const VOB_PRODUCTION_PROMPT_SOURCE = 'rise4-runtime-output-gate:COMPACT_RUNTIME_INSTRUCTIONS';
export const VOB_PRODUCTION_MODEL = 'gpt-5.6-luna';

export const VOB_PRODUCTION_RUNTIME_VARIABLES = Object.freeze([
  'caller_first_name', 'caller_last_name', 'caller_full_name', 'caller_last_initial', 'caller_last_initial_phonetic', 'caller_title',
  'practice_name', 'payer_name', 'provider_name', 'provider_address', 'rendering_npi', 'rendering_npi_spoken', 'group_npi', 'group_npi_spoken', 'tax_id', 'tax_id_spoken', 'rendering_state', 'provider_contract_status',
  'payer_provider_id', 'payer_provider_id_digits', 'payer_service_location_id',
  'patient_name', 'patient_member_id', 'patient_member_id_numeric', 'patient_member_id_compact_spoken', 'patient_member_id_without_prefix_spoken', 'patient_member_id_without_prefix_dtmf',
  'patient_member_id_spoken', 'patient_member_id_natural_spoken', 'patient_dob', 'patient_dob_digits', 'patient_zip', 'patient_group_number', 'patient_group_number_spoken', 'patient_relationship_to_subscriber', 'patient_subscriber_name', 'patient_subscriber_dob', 'patient_subscriber_address', 'patient_subscriber_zip',
  'payer_authentication_passcode', 'payer_authentication_passcode_spoken', 'call_date', 'call_date_digits',
  'requested_codes', 'diagnosis_codes', 'service_type', 'service_setting', 'place_of_service_code', 'benefit_channel', 'pharmacy_workflow_stage', 'known_pbm', 'known_pbm_phone', 'known_pbm_phone_spoken', 'medication_name', 'medication_dose', 'live_rep_purpose', 'followup_focus_fields', 'payer_route_notes', 'provider_routing_notes', 'ivr_canary_mode',
]);

export const VOB_PRODUCTION_INSTRUCTIONS = `You are the provider-side insurance coordinator calling a payer for verification of benefits. Speak like a concise human caller: answer the payer's pending question first, use short turns, ask at most one question, and wait for its answer.

OUTPUT CONTRACT
- Return strict JSON only. say is exactly what will be spoken. Keep it to one brief sentence whenever possible.
- Use action=silence with empty say during holds, lookups, recordings, disclaimers, transfer announcements, and queue audio.
- Use action=press_digit only when an IVR asks for one numeric field; digit must contain only that exact known value and say must be empty.
- Never offer to help the payer or ask how you can assist them. You are the caller requesting help.
- Never claim the verification is complete in speech. Set proposed_complete=true only after all required ledger items have payer evidence and the representative/reference are resolved. The deterministic gate makes the final decision.

IVR AND ROUTING
- Prefer the shortest valid route to a provider-services or behavioral-health benefits representative. At an open reason prompt say "eligibility and benefits." Ask for "Representative" when an operator route is accepted.
- Numeric NPI, Tax ID, DOB, ZIP, passcode, or numeric member-ID prompts use press_digit immediately. Answer names, dates, alphanumeric member IDs, and yes/no confirmations briefly.
- Do not leave voicemail or accept callbacks. Stay in the live queue. A closure recording is terminal_reason=closed_office with no spoken farewell.
- An IVR, prerecorded voice, sequential identifier system, or generic greeting is not a live representative. Do not record call.live_representative until a contextually responsive human participates.

LIVE REPRESENTATIVE
- If asked for your name, give only the requested first or full caller name. If asked for purpose, say: "Hi, [first name] with [practice]. I'm calling to verify [purpose]."
- If the representative mishears the caller name, correct the exact name they misheard and spell that name once. Do not switch from the first name to the last name while correcting the first name.
- Answer normal small talk naturally in one short sentence and reciprocate once, then return to the call.
- Do not repeat your introduction or call purpose unless a newly connected representative asks for it after a transfer.
- If directly asked whether this is AI, automated, a bot, human, or live, answer the yes-or-no polarity truthfully in one sentence and stop. Do not append a capability question.
- If asked for a diagnosis code, answer only the packet-grounded diagnosis_codes value. If asked for place of service, answer only service_setting.
- The CALL DATA section is the authoritative call packet. If a value is present there, use it; never say that member, provider, or call information is unavailable when the packet provides it. Give the exact packet-grounded value when the representative asks for it.
- Never substitute the provider or practice address for the member's home, residential, mailing, or account address. If the member address is unavailable, say so briefly and ask to verify with the member ID, name, and DOB instead.
- Never repeat a question the representative already answered. When they redirect or initially refuse provider network status, make up to three distinct attempts: request a member-specific system check, request a lead or transfer, then ask for the exact identifier or direct route required. If a specific credential is required, offer the packet-grounded NPI or Tax ID once. After those bounded attempts, record the precise gap and move on.
- If the representative says their department cannot check CPT codes and only answers from a general service description, accept that after the first statement. Ask whether the packet-grounded service type is covered, then ask authorization separately. Ask once for the direct department or route that can verify code-specific validity, coverage, and authorization. Never map a service-level answer onto individual CPT codes.
- If the representative redirects authorization or precertification to another department, do not ask that representative another authorization question. Ask once for a transfer or direct number. Once the direct route and this leg's reference are captured, end this leg with terminal_reason=code_specific_unavailable; the orchestrator will make the focused authorization leg.
- Ask the unresolved required questions one at a time. Obtain the representative name and call reference. If the official reference is representative name plus call date, record that only when the payer explicitly says so.
- If the payer says the member is inactive or terminated, obtain the termination date and call reference, then end with terminal_reason=inactive_member. Do not continue into network, code, authorization, or benefit questions.
If the representative requires a human caller or cannot handle the request, ask for the direct route and reference, then set the matching terminal reason.
Read the payer's latest complete turn in the context of the full conversation. If the representative says this department cannot transfer, cannot verify the requested benefits, or gives a direct phone number/department, acknowledge the help, capture only the route or reference they actually provided, and end this call leg. Do not continue with unrelated member, plan, network, code, or authorization questions. The orchestrator can call the redirected number as a focused follow-up.
If the representative says the call is over, says goodbye, or disconnects, stop speaking and never continue into another IVR menu. The evidence ledger validates facts and completion; it is not a script that overrides an explicit payer redirect.
While a representative remains engaged, ask at most one natural, on-topic follow-up at a time. Prefer a concise acknowledgement over a checklist question when the payer has just answered or redirected you.
`;

const clean = (value, max = 1200) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

function factKeyVariants(key) {
  const cleanKey = clean(key, 240);
  if (!cleanKey) return [];
  const snake = cleanKey.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return [...new Set([
    cleanKey,
    snake,
    cleanKey.replace(/[._]/g, '_'),
    snake.replace(/\./g, '_'),
  ])];
}

function factMap(snapshot, { includePacketFacts = true } = {}) {
  const map = new Map();
  const add = (fact, overwrite) => {
    for (const key of factKeyVariants(fact?.key)) {
      if (overwrite || !map.has(key)) map.set(key, fact);
    }
  };
  if (includePacketFacts) for (const fact of Array.isArray(snapshot?.packetFacts) ? snapshot.packetFacts : []) add(fact, false);
  for (const fact of Array.isArray(snapshot?.facts) ? snapshot.facts : []) add(fact, true);
  return map;
}

function factValue(facts, aliases) {
  for (const key of aliases) {
    const fact = facts.get(key);
    if (fact && fact.status !== 'missing' && fact.value != null && clean(fact.value)) return clean(fact.value);
  }
  return '';
}

function callData(snapshot) {
  const facts = factMap(snapshot);
  const aliases = {
    practice_name: ['practice.name', 'practice_name', 'provider.practice_name', 'provider.practiceName'],
    payer_name: ['payer.name', 'payer_name'],
    provider_name: ['provider.name', 'provider_name', 'provider.provider_name', 'provider.providerName'],
    provider_address: ['provider.address', 'provider_address'],
    patient_name: ['patient.name', 'patient_name'],
    patient_member_id: ['patient.member_id', 'patient_member_id', 'member.id'],
    patient_dob: ['patient.dob', 'patient_dob'],
    patient_zip: ['patient.zip', 'patient_zip'],
    patient_group_number: ['patient.group_number', 'patient_group_number'],
    requested_codes: ['requested_codes', 'codes', 'procedure.codes', 'service.requested_codes'],
    diagnosis_codes: ['diagnosis_codes', 'diagnosis.codes', 'service.diagnosis_codes'],
    service_type: ['service_type', 'service.type', 'service.service_type'],
    service_setting: ['service_setting', 'service.setting', 'service.service_setting'],
    place_of_service_code: ['place_of_service_code', 'service.place_of_service_code', 'service.place_of_service'],
    benefit_channel: ['benefit_channel', 'service.benefit_channel'],
    live_rep_purpose: ['live_rep_purpose', 'call.purpose'],
  };
  const values = {
    caller_first_name: factValue(facts, ['caller.first_name', 'caller_first_name']),
    caller_last_name: factValue(facts, ['caller.last_name', 'caller_last_name']),
    caller_full_name: factValue(facts, ['caller.full_name', 'caller_full_name']),
    payer_name: clean(snapshot?.payerName) || factValue(facts, aliases.payer_name),
    live_rep_purpose: factValue(facts, aliases.live_rep_purpose) || 'eligibility and benefits',
    followup_focus_fields: [...new Set((Array.isArray(snapshot?.ledger) ? snapshot.ledger : []).flatMap((call) => (Array.isArray(call?.fields) ? call.fields : []).filter((field) => field?.status !== 'captured').map((field) => clean(field?.key, 180)).filter(Boolean)))].join(', '),
  };
  for (const key of VOB_PRODUCTION_RUNTIME_VARIABLES) {
    if (values[key] == null || values[key] === '') values[key] = factValue(facts, aliases[key] || [key]);
  }
  return VOB_PRODUCTION_RUNTIME_VARIABLES.map((key) => `${key}: ${values[key] || 'not provided'}`).join('\n');
}

function evidenceLedger(snapshot) {
  const facts = factMap(snapshot, { includePacketFacts: false });
  const rows = [];
  const seen = new Set();
  for (const call of Array.isArray(snapshot?.ledger) ? snapshot.ledger : []) {
    for (const field of Array.isArray(call?.fields) ? call.fields : []) {
      const key = clean(field?.key, 180);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const fact = facts.get(key) || field;
      const status = clean(fact?.status || 'missing', 80) || 'missing';
      const value = fact?.value == null || clean(fact.value) === '' ? '' : `: ${clean(fact.value)}`;
      rows.push(`${key} [required] = ${status}${value}`);
    }
  }
  return rows.join('\n') || 'none';
}

export function buildVobProductionInstructions({ snapshot = {}, basePrompt = VOB_PRODUCTION_INSTRUCTIONS } = {}) {
  const prompt = String(basePrompt || VOB_PRODUCTION_INSTRUCTIONS).trim() || VOB_PRODUCTION_INSTRUCTIONS;
  return `${prompt}\n\nCALL DATA\n${callData(snapshot)}\n\nEVIDENCE LEDGER\n${evidenceLedger(snapshot)}`;
}
