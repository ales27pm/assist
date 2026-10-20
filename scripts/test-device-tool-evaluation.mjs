import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gradeCase, modelInputs, evaluate, nativeEvaluationInputs, prepareReferenceContext, reviewSubjectSHA256, reviewCriteriaSHA256 } from './evaluate-device-tools.mjs';

const dataset = JSON.parse(readFileSync(new URL('../docs/evals/device-tools-context-v1.json', import.meta.url), 'utf8'));
const contract = dataset.productionContract.contract;
const selected = id => structuredClone(dataset.cases.find(row => row.id === id));
const observation = (row, extra = {}) => ({ id: row.id, completed: true,
  calls: row.expected.firstTool ? [{ name: row.expected.firstTool, arguments: row.expected.argumentsSubset ?? {} }] : [], ...extra });
const corpus = rows => ({ ...dataset, cases: rows });
const observations = cases => ({ schemaVersion: 1, evidenceLayer: 'scripted', cases });
// Scripted artifact for grader regression only, never a native/model observation.
const scriptedNativeReport = (data, obs) => ({ schemaVersion: 1, contract, cases: nativeEvaluationInputs(data, obs).map(input => ({
  id: input.id, inputJSON: JSON.stringify(input), inputAccepted: true,
  calls: input.calls.map(call => ({ accepted: true, normalizedArguments: call.arguments })),
  messages: [{ role: 'system', content: 'Scripted grader regression, not a model prompt proof.' }],
  tools: contract.tools.map(tool => tool.definition),
})) });
const reviewed = observed => ({ method: 'human', reviewer: 'scripted-regression-fixture-only',
  caseId: observed.id, criteriaSHA256: reviewCriteriaSHA256(selected(observed.id)), subjectSHA256: reviewSubjectSHA256(observed), clarification: true,
  forbiddenClaimsAbsent: true, requiredFactsPresent: true });

test('historical 0/0-to-1/1 error fails argument accuracy independently of selection', () => {
  const row = selected('exact.weather-zero-zero');
  const obs = observation(row); obs.calls[0].arguments = { ...obs.calls[0].arguments, hourly_count: 1, daily_count: 1 };
  const result = gradeCase(row, obs, contract);
  assert.equal(result.checks.firstTool, true); assert.equal(result.checks.arguments, false); assert.equal(result.outcome, 'failed');
});
test('model inputs exclude oracle, production metadata and synthetic service receipts', () => {
  const data = corpus([selected('exact.weather-zero-zero')]);
  data.fixtures = { secretOracle: 'DO NOT SEND' };
  const inputs = modelInputs(data);
  assert.deepEqual(Object.keys(inputs[0]), ['id', 'environment', 'referenceContext', 'prompt']);
  assert.equal(JSON.stringify(inputs).includes('hourly_count'), false);
  assert.equal(JSON.stringify(inputs).includes('DO NOT SEND'), false);
  assert.equal(JSON.stringify(inputs).includes('productionContract'), false);
});
test('missing inference is not interpreted as a correct no-tool answer', () => {
  const result = evaluate(corpus([selected('exact.weather-zero-zero')]), observations([]));
  assert.deepEqual(result.counts, { passed: 0, failed: 0, incomplete: 0, not_run: 1 });
  assert.equal(result.qualification, 'not_established_by_this_grader');
});
test('a self-asserted context flag cannot establish actual production preparation', () => {
  const row = selected('context.selected-document-reference');
  const obs = observation(row, { finalText: 'Quel document ?', referenceContextPrepared: true }); obs.review = reviewed(obs);
  assert.equal(gradeCase(row, obs, contract).checks.contextPrepared, null);
  assert.equal(gradeCase(row, obs, contract).outcome, 'incomplete');
});
test('missing arguments cannot pass because the oracle only checks a subset', () => {
  const row = selected('natural.timer-ten-minutes'); row.expected.argumentsSubset = { duration_seconds: 600 };
  const obs = observation(row);
  const result = gradeCase(row, obs, contract);
  assert.equal(result.checks.arguments, true); assert.equal(result.checks.schemaArguments, false); assert.equal(result.outcome, 'failed');
});
test('an extra model field is rejected against the production closed schema', () => {
  const row = selected('natural.timer-ten-minutes'), obs = observation(row);
  obs.calls[0].arguments = { ...obs.calls[0].arguments, arbitrary_permission: true };
  assert.equal(gradeCase(row, obs, contract).outcome, 'failed');
});
test('production types, enum and numeric bounds are enforced independently of expected fields', () => {
  const row = selected('exact.weather-zero-zero'); row.expected.argumentsSubset = {};
  for (const invalid of [{ hourly_count: true }, { daily_count: 6 }, { latitude: 91 }, { unit: 'kelvin' }, { hourly_count: 1.5 }]) {
    const obs = observation(selected('exact.weather-zero-zero'));
    obs.calls[0].arguments = { ...obs.calls[0].arguments, ...invalid };
    assert.equal(gradeCase(row, obs, contract).checks.schemaArguments, false);
  }
});
test('two writes fail the global production budget even when no maxMutations oracle is present', () => {
  const row = selected('natural.timer-ten-minutes'), obs = observation(row); obs.calls.push(structuredClone(obs.calls[0]));
  assert.equal(Object.hasOwn(row.expected, 'maxMutations'), false);
  assert.equal(gradeCase(row, obs, contract).checks.writeProposalBudget, false);
  assert.equal(gradeCase(row, obs, contract).outcome, 'failed');
});
test('selection-only cannot hide extra reads behind a correct first tool', () => {
  const row = selected('natural.biometry-type'), obs = observation(row); obs.calls.push({ name: 'device_capabilities', arguments: {} });
  assert.equal(gradeCase(row, obs, contract).checks.singlePlanningDecision, false);
});
test('schema-valid calls remain incomplete without the actual native semantic validator', () => {
  const row = selected('natural.timer-ten-minutes');
  const result = gradeCase(row, observation(row), contract);
  assert.equal(result.checks.schemaArguments, true); assert.equal(result.checks.nativeArguments, null); assert.equal(result.outcome, 'incomplete');
});
test('a native semantic rejection is not concealed by JSON schema validity', () => {
  const row = selected('natural.timer-ten-minutes');
  const result = gradeCase(row, observation(row), contract, { calls: [{ accepted: false }] });
  assert.equal(result.checks.nativeArguments, false); assert.equal(result.outcome, 'failed');
});
test('wrong then correct follow-up cannot hide the earlier wrong target', () => {
  const row = selected('natural.timer-stop'), obs = observation(row);
  obs.calls.push({ name: 'alarm_stop', arguments: { alarm_id: '00000000-0000-0000-0000-000000000000' } },
    { name: 'alarm_stop', arguments: row.expected.argumentsByTool.alarm_stop });
  assert.equal(gradeCase(row, obs, contract).checks.followupArguments, false);
});
test('a list-first workflow is not fully scored from only the planning pass', () => {
  const row = selected('natural.timer-stop'), result = gradeCase(row, observation(row, { completed: false }), contract);
  assert.equal(result.outcome, 'incomplete'); assert.equal(result.checks.sequence, null); assert.equal(result.checks.fixtureScenario, null);
});
test('fixtureExecutorVerified alone is not a recorded fixture trajectory', () => {
  const row = selected('documents.preview-does-not-read'), obs = observation(row, { fixtureExecutorVerified: true });
  obs.review = reviewed(obs);
  assert.equal(gradeCase(row, obs, contract, { calls: [{ accepted: true }] }).checks.fixtureScenario, null);
});
test('review flags without provenance do not establish semantics', () => {
  const row = selected('ambiguous.weather-place'), obs = observation(row, { finalText: 'Il fait beau.', review: { clarification: true } });
  assert.equal(gradeCase(row, obs, contract).checks.clarification, null);
  obs.review = reviewed(obs); obs.finalText = 'Le texte a changé.';
  assert.equal(gradeCase(row, obs, contract).checks.clarification, null);
});
test('a no-tool oracle saying no clarification also requires that distinction to be reviewed', () => {
  const row = selected('no-tool.explain-ocr'), obs = observation(row, { finalText: 'Quelle image voulez-vous lire ?' });
  obs.review = reviewed(obs);
  assert.equal(gradeCase(row, obs, contract).checks.clarification, false);
});
test('an empty completed no-tool observation remains incomplete', () => {
  const row = selected('no-tool.explain-ocr'), obs = observation(row); obs.review = { ...reviewed(obs), clarification: false };
  assert.equal(gradeCase(row, obs, contract).checks.nonemptyAnswer, null);
  assert.equal(gradeCase(row, obs, contract).outcome, 'incomplete');
});
test('duplicate or foreign observations cannot inflate the aggregate score', () => {
  const row = selected('exact.weather-zero-zero'), data = corpus([row]), obs = observation(row);
  assert.throws(() => evaluate(data, observations([obs, obs])), /duplicate/);
  assert.throws(() => evaluate(data, observations([{ ...obs, id: 'foreign' }])), /Unknown/);
});
test('a 31-name synthetic catalog is not the actual production catalog', () => {
  const data = corpus([selected('exact.weather-zero-zero')]); data.toolCatalog = Array.from({ length: 31 }, (_, i) => `tool_${i}`);
  assert.throws(() => evaluate(data, observations([])), /actual ordered production catalog/);
});
test('source drift invalidates a cached production contract rather than silently scoring stale schemas', () => {
  const data = structuredClone(corpus([selected('exact.weather-zero-zero')]));
  data.productionContract.sourceSHA256['mobile/ios/Assist/Inference/AssistExtendedTools.swift'] = '0'.repeat(64);
  assert.throws(() => evaluate(data, observations([])), /Stale production contract/);
});
test('substituting another production file cannot omit a required compiled source', () => {
  const data = structuredClone(corpus([selected('exact.weather-zero-zero')]));
  const fingerprints = data.productionContract.sourceSHA256;
  delete fingerprints['mobile/ios/Assist/Inference/AssistDeviceToolAdapter.swift'];
  fingerprints['mobile/ios/Assist/Inference/AssistDeviceToolRun.swift'] = createHash('sha256').update(
    readFileSync(new URL('../mobile/ios/Assist/Inference/AssistDeviceToolRun.swift', import.meta.url))).digest('hex');
  assert.throws(() => evaluate(data, observations([])), /Incomplete production source provenance/);
});
test('native report must match all exact input calls and fixed clock', () => {
  const row = selected('exact.weather-zero-zero'), data = corpus([row]), obs = observations([observation(row)]);
  const native = scriptedNativeReport(data, obs);
  assert.equal(evaluate(data, obs, native).counts.passed, 1);
  const changed = structuredClone(native);
  const input = JSON.parse(changed.cases[0].inputJSON); input.fixedEnvironment.nowUTC = '2030-01-16T15:00:00Z';
  changed.cases[0].inputJSON = JSON.stringify(input);
  assert.throws(() => evaluate(data, obs, changed), /does not match/);
  changed.cases[0].inputJSON = native.cases[0].inputJSON; changed.cases[0].calls = [];
  assert.throws(() => evaluate(data, obs, changed), /does not match/);
  changed.cases[0].calls = [{ accepted: true }];
  assert.throws(() => evaluate(data, obs, changed), /does not match/);
});
test('native report rejects duplicate decoded keys rather than accepting ambiguous provenance', () => {
  const row = selected('exact.weather-zero-zero'), data = corpus([row]), obs = observations([observation(row)]);
  const native = scriptedNativeReport(data, obs);
  native.cases[0].inputJSON = native.cases[0].inputJSON.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
  assert.throws(() => evaluate(data, obs, native), /Invalid native input provenance/);
});
test('real production context filtering drops private handles and retains whole safe pairs', () => {
  const context = prepareReferenceContext([
    { role: 'user', content: 'Le document a7c4b011-0ad2-4d80-9fd7-190011000001.' }, { role: 'assistant', content: 'Document choisi.' },
    { role: 'user', content: 'Je préfère Celsius.' }, { role: 'assistant', content: 'Celsius pour la suite.' },
  ]);
  assert.equal(context.omittedTurns, 1); assert.deepEqual(context.turns, [{ user: 'Je préfère Celsius.', assistant: 'Celsius pour la suite.' }]);
});
test('real production context enforces UTF8 and combined limits without truncating text', () => {
  const messages = Array.from({ length: 4 }, (_, i) => [{ role: 'user', content: `Question ${i}` }, { role: 'assistant', content: `Réponse ${i}` }]).flat();
  const context = prepareReferenceContext(messages); assert.equal(context.turns.length, 3); assert.equal(context.omittedTurns, 1);
  const large = prepareReferenceContext([{ role: 'user', content: 'é'.repeat(1025) }, { role: 'assistant', content: 'Trop long.' }]);
  assert.equal(large.turns.length, 0); assert.equal(large.omittedTurns, 1);
  assert.throws(() => prepareReferenceContext([{ role: 'user', content: 'Incomplet.' }]), /complete/);
});
test('native preparation exports actual filtered context, no expected fields or fixture payload', () => {
  const data = corpus([selected('context.selected-document-reference')]);
  const inputs = nativeEvaluationInputs(data);
  assert.equal(inputs[0].referenceContext.turns.length, 0); assert.equal(inputs[0].referenceContext.omittedTurns, 1);
  assert.equal(Object.hasOwn(inputs[0], 'expected'), false); assert.equal(Object.hasOwn(inputs[0], 'fixtures'), false);
  const exported = modelInputs(data);
  assert.equal(exported[0].referenceContext.turns.length, 0);
  assert.equal(JSON.stringify(exported).includes('a7c4b011-0ad2-4d80-9fd7-190011000001'), false);
});
test('prepared benchmark covers the real 31 tools and never claims model execution', () => {
  assert.equal(dataset.status, 'prepared_not_run_model'); assert.equal(dataset.cases.length, 59);
  assert.equal(new Set(dataset.cases.map(row => row.id)).size, dataset.cases.length);
  assert.deepEqual([...new Set(dataset.cases.flatMap(row => row.toolCoverage))].sort(), [...dataset.toolCatalog].sort());
  const missing = evaluate(dataset, observations([])); assert.equal(missing.counts.not_run, dataset.cases.length);
  for (const input of modelInputs(dataset)) for (const key of ['expected', 'fixtures', 'provenance', 'productionContract']) assert.equal(Object.hasOwn(input, key), false);
});
test('new natural translation prompt does not hint at a native engine', () => {
  const row = selected('natural.translation-unhinted');
  assert.equal(row.prompt, 'Traduis en anglais : « Bonjour. Le résultat du test est quarante-deux. »');
  assert.equal(row.expected.firstTool, 'text_translate');
});

test('only real native normalization can remove a whitespace-only argument mismatch', () => {
  const row = selected('natural.contacts-name'), obs = observation(row);
  obs.calls[0].arguments = { ...obs.calls[0].arguments, query: '  Camille Éval Orion  ' };
  assert.equal(gradeCase(row, obs, contract).checks.arguments, false);
  const result = gradeCase(row, obs, contract, { calls: [{ accepted: true, normalizedArguments: row.expected.argumentsSubset }] });
  assert.equal(result.checks.arguments, true);
});
test('model-output provenance is required before counting an otherwise matching case passed', () => {
  const row = selected('exact.weather-zero-zero'), data = corpus([row]), obs = { ...observations([observation(row)]), evidenceLayer: 'model_output' };
  const native = scriptedNativeReport(data, obs);
  assert.equal(evaluate(data, obs, native).counts.incomplete, 1);
  obs.provenance = { runId: 'synthetic-test-only', modelIdentity: 'synthetic-test-model', runtime: 'scripted-fixture',
    sourceRevision: 'synthetic-test-source', templateSHA256: contract.canonicalTemplateSHA256 };
  assert.equal(evaluate(data, obs, native).provenance.modelTraceProvenance, 'declared_not_independently_authenticated');
});
test('misspelled oracle fields and malformed context cannot silently disappear from scoring', () => {
  const data = corpus([selected('natural.contacts-name')]);
  data.cases[0].expected.forbiddenTool = ['calendar_create'];
  assert.throws(() => evaluate(data, observations([])), /Unknown oracle requirement/);
  delete data.cases[0].expected.forbiddenTool;
  data.cases[0].context = [{ role: 'user', content: 'Salut', expected: 'oracle leak' }, { role: 'assistant', content: 'Salut' }];
  assert.throws(() => modelInputs(data), /Invalid context pair/);
});

const rawStep = (callIndex, resultJSON) => ({ callIndex, resultJSON,
  resultSHA256: createHash('sha256').update(resultJSON).digest('hex'), productionResultValidated: true });
const resultStep = (callIndex, value) => rawStep(callIndex, JSON.stringify(value));

test('an interrupted impossible tool prefix or already wrong target fails immediately', () => {
  const row = selected('natural.timer-stop');
  for (const followup of [
    { name: 'document_read', arguments: { inbox_id: 'a7c4b011-0ad2-4d80-9fd7-190011000001' } },
    { name: 'alarm_stop', arguments: { alarm_id: '00000000-0000-0000-0000-000000000000' } },
  ]) {
    const result = gradeCase(row, { completed: false, calls: [{ name: 'alarm_list', arguments: {} }, followup] }, contract);
    assert.equal(result.outcome, 'failed');
    assert.equal(followup.name === 'alarm_stop' ? result.checks.followupArguments : result.checks.sequence, false);
  }
  const future = gradeCase(row, { completed: false, calls: [{ name: 'alarm_list', arguments: {} }] }, contract);
  assert.equal(future.checks.sequence, null); assert.equal(future.checks.followupArguments, null);
});
test('a success receipt cannot pass an explicit cancellation scenario', () => {
  const row = selected('cancel.photo-selector');
  const obs = observation(row, { finalText: 'Le texte reconnu est BONJOUR.', fixtureTrace: { owner: row.scenario.ownerFixture,
    steps: [resultStep(0, { selected: true, ocr_status: 'text', ocr_text: 'BONJOUR' })] } });
  obs.review = reviewed(obs);
  const native = { calls: [{ accepted: true, normalizedArguments: {} }] };
  const wrong = gradeCase(row, obs, contract, native);
  assert.equal(wrong.checks.fixtureScenario, true); assert.equal(wrong.checks.nativeOutcomes, false); assert.equal(wrong.outcome, 'failed');
  obs.fixtureTrace.steps = [resultStep(0, { status: 'cancelled' })];
  // The receipt changed, so the previous semantic review cannot transfer.
  assert.equal(gradeCase(row, obs, contract, native).checks.forbiddenClaimsAbsent, null);
  obs.finalText = 'L’action a été annulée. Aucun nouvel essai automatique.'; obs.review = reviewed(obs);
  assert.equal(gradeCase(row, obs, contract, native).outcome, 'passed');
});
test('opaque, modified, duplicate-key or oversized native results cannot prove a fixture outcome', () => {
  const row = selected('cancel.photo-selector');
  const examples = [
    { callIndex: 0, resultSHA256: '1'.repeat(64), productionResultValidated: true },
    { ...resultStep(0, { status: 'cancelled' }), resultJSON: '{"status":"success"}' },
    rawStep(0, '{"status":"success","status":"cancelled"}'),
    resultStep(0, { status: 'cancelled', ocr_text: 'An impossible extra native field' }),
    rawStep(0, JSON.stringify({ status: 'cancelled', text: 'x'.repeat(24 * 1024) })),
  ];
  for (const step of examples) {
    const result = gradeCase(row, observation(row, { fixtureTrace: { owner: row.scenario.ownerFixture, steps: [step] } }), contract);
    assert.equal(result.checks.fixtureScenario, false); assert.equal(result.outcome, 'failed');
  }
  assert.equal(gradeCase(row, observation(row), contract).checks.nativeOutcomes, null);
});
test('unknown and unavailable branches require their actual native outcome, never a success label', () => {
  const unknown = selected('recovery.unknown-calendar-effect');
  const obs = observation(unknown, { fixtureTrace: { owner: unknown.scenario.ownerFixture,
    steps: [resultStep(0, { created: true, destination: 'calendar' })] } });
  assert.equal(gradeCase(unknown, obs, contract).checks.nativeOutcomes, false);
  obs.fixtureTrace.steps = [resultStep(0, { status: 'outcome_unknown' })];
  assert.equal(gradeCase(unknown, obs, contract).checks.nativeOutcomes, true);
  const unavailable = selected('fidelity.translation-unavailable');
  const failure = { domain: 'AssistTranslation', code: 6 };
  const canonical = JSON.stringify({ code: failure.code, domain: failure.domain });
  const step = { callIndex: 0, ownerError: failure,
    errorSHA256: createHash('sha256').update(canonical).digest('hex'), productionErrorValidated: true };
  const failed = observation(unavailable, { fixtureTrace: { owner: unavailable.scenario.ownerFixture, steps: [step] } });
  assert.equal(gradeCase(unavailable, failed, contract).checks.nativeOutcomes, true);
  failed.fixtureTrace.steps = [resultStep(0, { result_status: 'installed', translatedText: 'Hello.' })];
  assert.equal(gradeCase(unavailable, failed, contract).checks.nativeOutcomes, false);
});
test('a follow-up target must match the actual authorized result, not merely the fixed oracle', () => {
  const row = selected('documents.search-then-read');
  const expectedID = row.expected.argumentsByTool.document_read.inbox_id;
  const returnedID = 'a7c4b011-0ad2-4d80-9fd7-190011000002';
  const obs = observation(row, { completed: false, calls: [
    { name: 'document_search', arguments: row.expected.argumentsSubset },
    { name: 'document_read', arguments: { inbox_id: expectedID } },
  ], fixtureTrace: { owner: row.scenario.ownerFixture, steps: [resultStep(0, { results: [{ inboxId: returnedID }] })] } });
  const result = gradeCase(row, obs, contract);
  assert.equal(result.checks.followupArguments, true); assert.equal(result.checks.resultBindings, false);
  assert.equal(result.outcome, 'failed');
});

test('a semantic review cannot transfer to different oracle criteria or case identity', () => {
  const row = selected('no-tool.explain-ocr'), obs = observation(row, { finalText: 'OCR reconnaît le texte imprimé dans une image.' });
  obs.review = { ...reviewed(obs), clarification: false };
  assert.equal(gradeCase(row, obs, contract).checks.clarification, true);
  row.expected.requiredFacts = ['A newly required fact that was never reviewed.'];
  assert.equal(gradeCase(row, obs, contract).checks.requiredFactsPresent, null);
  const different = selected('no-tool.explain-ocr'); different.id = 'another-case-same-transcript';
  assert.equal(gradeCase(different, obs, contract).checks.clarification, null);
});
