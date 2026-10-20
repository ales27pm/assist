import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evaluate, gradeCase, modelInputs, nativeEvaluationInputs, rehearsalSheet } from './evaluate-device-tools.mjs';
const load = file => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
const natural = load('../docs/evals/device-tools-natural-dialogues-v1.json');
const base = load('../docs/evals/device-tools-context-v1.json');
const contract = base.productionContract.contract;
const row = id => natural.cases.find(value => value.id === id);
const observations = cases => ({ schemaVersion: 1, evidenceLayer: 'scripted', cases });
const empty = (omittedTurns = 0) => ({ schemaVersion: 1, turns: [], omittedTurns });
const completed = (id, finalText, eligible, epoch = 0) => ({ id, completed: true, calls: [], finalText,
  userText: row(id).prompt, referenceContextEligible: eligible, referenceContextEpoch: epoch });
const nextTurn = (id, preceding = [], extra = {}) => ({ id, completed: false, calls: [], userText: row(id).prompt,
  referenceContextEpoch: 0, referenceContext: { schemaVersion: 1,
    turns: preceding.filter(prior => prior.referenceContextEligible).map(prior => ({ user: prior.userText, assistant: prior.finalText })),
    omittedTurns: preceding.filter(prior => !prior.referenceContextEligible).length }, ...extra });

test('twelve prepared dialogues cover37turns and19tools, not a31tool qualification', () => {
  assert.equal(natural.status, 'prepared_not_run_model');
  assert.equal(natural.dialogues.length, 12); assert.equal(natural.cases.length, 37);
  assert.equal(natural.coverage.targetedTools.length, 19); assert.equal(natural.coverage.full31Qualification, false);
  assert.equal(natural.executionSafety.automaticNativeExecutionAllowed, false);
  assert.equal(natural.executionSafety.physicalEffectsAllowed, false);
});
test('the rehearsal export contains only user utterances, no handles, coordinates or oracle', () => {
  const sheet = rehearsalSheet(natural);
  for (const dialogue of sheet) {
    assert.deepEqual(Object.keys(dialogue), ['id', 'userUtterances']);
    for (const text of dialogue.userUtterances) {
      assert.equal(typeof text, 'string');
      assert.equal(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i.test(text), false);
      assert.equal(/-?\d{2}\.\d{3,}/.test(text), false);
      assert.equal(natural.toolCatalog.some(name => text.includes(name)), false);
    }
  }
  assert.equal(JSON.stringify(sheet).includes('expected'), false);
  assert.equal(JSON.stringify(sheet).includes('ownerFixture'), false);
});
test('the natural dataset reuses the single production contract and missing trials remain not_run', () => {
  assert.equal(Object.hasOwn(natural, 'productionContract'), false);
  assert.equal(natural.productionContractRef, 'device-tools-context-v1.json');
  const result = evaluate(natural, observations([]));
  assert.deepEqual(result.counts, { passed: 0, failed: 0, incomplete: 0, not_run: 37 });
  const foreign = structuredClone(natural); foreign.productionContractRef = '../../private.json';
  assert.throws(() => evaluate(foreign, observations([])), /not allowlisted/);
});
test('every later turn binds only its actual preceding user/assistant outputs, without fabricated context', () => {
  for (const dialogue of natural.dialogues) dialogue.turnIds.forEach((id, index) => {
    assert.deepEqual(row(id).context, []);
    assert.equal(row(id).prompt, dialogue.userUtterances[index]);
    if (index) assert.deepEqual(row(id).historyBinding, { dialogueId: dialogue.id, previousCaseIds: dialogue.turnIds.slice(0, index) });
    else assert.equal(row(id).historyBinding, undefined);
  });
  assert.throws(() => modelInputs(natural), /Actual admitted dialogue snapshot/);
});
test('native preparation uses actual recorded previous final text, never an oracle response', () => {
  const prior = completed('dialogue03.t1', 'Les détails sont conservés pour cet atelier.', true);
  const next = nextTurn('dialogue03.t2', [prior]);
  const input = nativeEvaluationInputs(natural, observations([prior, next]), [next.id])[0];
  assert.deepEqual(input.referenceContext.turns, [{ user: row(prior.id).prompt, assistant: prior.finalText }]);
  assert.equal(input.prompt, 'Ajoute-le maintenant à mon calendrier.');
  assert.equal(Object.hasOwn(input, 'expected'), false);
});
test('missing, unfinished or unproven history cannot silently become production references', () => {
  const next = nextTurn('dialogue03.t2');
  for (const preceding of [[], [{ ...completed('dialogue03.t1', 'Détails.', true), completed: false }],
    [{ id: 'dialogue03.t1', completed: true, calls: [], finalText: 'Détails.' }]]) {
    const obs = observations([...preceding, next]);
    assert.throws(() => nativeEvaluationInputs(natural, obs, [next.id]), /Actual completed dialogue history/);
    const result = evaluate(natural, obs).cases.find(value => value.id === next.id);
    assert.equal(result.checks.dialogueHistoryPrepared, null);
    assert.notEqual(result.outcome, 'passed');
  }
});
test('recorded ineligible turns are omitted whole; manual rehearsal remains available', () => {
  const prior = completed('dialogue12.t1', 'Issue inconnue.', false);
  const next = nextTurn('dialogue12.t2', [prior]);
  const input = nativeEvaluationInputs(natural, observations([prior, next]), [next.id])[0];
  assert.deepEqual(input.referenceContext, { schemaVersion: 1, turns: [], omittedTurns: 1 });
  assert.equal(rehearsalSheet(natural).length, 12);
});
test('valid translation strategies require a real translate call in the accepted order', () => {
  const target = row('dialogue07.t1');
  const translate = { name: 'text_translate', arguments: { text: 'Bonjour. Le dossier est prêt.', source_language: 'fr', target_language: 'en', allow_download: false } };
  const availability = { name: 'translation_languages', arguments: { source_language: 'fr', target_language: 'en' } };
  for (const calls of [[translate], [availability, translate]]) {
    const result = gradeCase(target, { completed: true, calls }, contract);
    assert.equal(result.checks.firstTool, true); assert.equal(result.checks.sequence, true); assert.equal(result.checks.followupArguments, true);
  }
  assert.equal(gradeCase(target, { completed: true, calls: [availability] }, contract).checks.sequence, false);
  assert.equal(gradeCase(target, { completed: true, calls: [translate, availability] }, contract).checks.sequence, false);
});
test('alternative oracles cannot admit unknown tools or unrelated extra accesses', () => {
  const altered = structuredClone(natural); altered.cases[0].expected.firstToolAlternatives = ['unregistered_native_command'];
  assert.throws(() => evaluate(altered, observations([])), /Unknown oracle tool/);
  const target = row('dialogue07.t1');
  const result = gradeCase(target, { completed: true, calls: [{ name: 'contacts_search', arguments: { query: 'Orion', limit: 1 } }] }, contract);
  assert.equal(result.checks.firstTool, false); assert.equal(result.checks.sequence, false);
});
test('maps admits one or two resolving lookups but retains transport and selected-result provenance', () => {
  const target = row('dialogue08.t3');
  const search = { name: 'maps_search', arguments: { query: 'Hôtel de ville de Québec', limit: 2 } };
  const route = { name: 'maps_directions', arguments: { origin_latitude: 46.8, origin_longitude: -71.2, destination_latitude: 46.81, destination_longitude: -71.21, transport: 'walking' } };
  for (const calls of [[search, route], [search, search, route]]) assert.equal(gradeCase(target, { completed: true, calls }, contract).checks.sequence, true);
  assert.equal(gradeCase(target, { completed: true, calls: [route] }, contract).checks.firstTool, false);
  assert.equal(gradeCase(target, { completed: true, calls: [search, { ...route, arguments: { ...route.arguments, transport: 'automobile' } }] }, contract).checks.followupArguments, false);
  assert.equal(target.expected.requiredFacts.some(value => value.includes('coordonnées')), true);
});
test('tree-planning branches stay separate from selected native-call budgets and carry no claimed latency threshold', () => {
  const target = row('dialogue03.t2');
  const call = { name: 'calendar_create', arguments: { title: 'Atelier Orion du soir', start_iso: '2026-10-21T14:00:00Z', end_iso: '2026-10-21T14:05:00Z' } };
  const result = gradeCase(target, { completed: false, calls: [call], planningTrace: { branches: [{ calls: [call] }, { calls: [call] }, { calls: [] }], selectedBranch: 0 } }, contract);
  assert.equal(result.checks.writeProposalBudget, true);
  assert.equal(natural.comparisonAxes.latency.includes('wallStartToTerminalMs'), true);
  assert.equal(natural.comparisonAxes.latency.includes('planningModelPasses'), true);
  assert.equal(typeof natural.comparisonAxes.thresholds, 'string');
});
test('physical rehearsal does not force failures or depend on private raw HostJSON evidence', () => {
  assert.equal(natural.fixtures.notification_preview_only.physicalPolicy.includes('Annuler'), true);
  assert.equal(natural.fixtures.calendar_outcome_unknown.kind, 'fixture_owner_only');
  assert.equal(natural.fixtures.translation_unavailable.kind, 'fixture_owner_only');
  assert.equal(natural.physicalOraclePolicy.useActualDeviceClock, true);
  assert.equal(natural.dialogues.every(dialogue => !!dialogue.manualAcceptance.setup && !!dialogue.manualAcceptance.cleanup), true);
});

test('nominal scenario prompts never replace the actually recorded historical utterance', () => {
  const prior = { ...completed('dialogue03.t1', 'D’accord.', true), userText: 'Salut.' };
  const next = nextTurn('dialogue03.t2', [prior]);
  assert.throws(() => nativeEvaluationInputs(natural, observations([prior, next]), [next.id]), /Actual completed dialogue history/);
  const currentMismatch = nextTurn('dialogue03.t2', [], { userText: 'Bonjour.' });
  assert.throws(() => nativeEvaluationInputs(natural, observations([currentMismatch]), [currentMismatch.id]), /differs from scenario/);
});
test('actual admitted context is used and reset epochs cannot resurrect an earlier workshop', () => {
  const prior = completed('dialogue03.t1', 'Les détails de l’atelier sont reçus.', true, 4);
  const next = nextTurn('dialogue03.t2', [], { referenceContextEpoch: 5, contextReset: true, referenceContext: empty(1) });
  const input = nativeEvaluationInputs(natural, observations([prior, next]), [next.id])[0];
  assert.deepEqual(input.referenceContext, empty(1));
  next.referenceContext = { schemaVersion: 1, turns: [{ user: prior.userText, assistant: prior.finalText }], omittedTurns: 0 };
  assert.throws(() => nativeEvaluationInputs(natural, observations([prior, next]), [next.id]), /reset|retired history/);
  next.referenceContextEpoch = 4;
  assert.throws(() => nativeEvaluationInputs(natural, observations([prior, next]), [next.id]), /reset/);
});
test('an ineligible tool turn retires earlier eligible goals even when the epoch is unchanged', () => {
  const first = completed('dialogue03.t1', 'Détails de l’atelier reçus.', true);
  const rejected = { ...completed('dialogue03.t2', 'Action annulée.', false), calls: [{ name: 'calendar_create', arguments: row('dialogue03.t2').expected.argumentsSubset }] };
  const next = nextTurn('dialogue03.t3', [first], { referenceContext: empty(2) });
  assert.deepEqual(nativeEvaluationInputs(natural, observations([first, rejected, next]), [next.id])[0].referenceContext, empty(2));
  next.referenceContext = { schemaVersion: 1, turns: [{ user: first.userText, assistant: first.finalText }], omittedTurns: 1 };
  assert.throws(() => nativeEvaluationInputs(natural, observations([first, rejected, next]), [next.id]), /retired history/);
});
test('a capsule cannot import an oracle answer or an unrelated assistant final', () => {
  const prior = completed('dialogue03.t1', 'Détails reçus.', true);
  const next = nextTurn('dialogue03.t2', [prior]);
  next.referenceContext.turns[0].assistant = 'L’événement a été créé.';
  assert.throws(() => nativeEvaluationInputs(natural, observations([prior, next]), [next.id]), /unproven/);
  delete next.referenceContext;
  assert.throws(() => nativeEvaluationInputs(natural, observations([prior, next]), [next.id]), /Actual admitted dialogue snapshot/);
});
test('natural target binding selects the unique named result rather than a pagination position', () => {
  const target = row('dialogue06.t3');
  const desired = 'B7C4B011-0AD2-4D80-9FD7-190011000001';
  const other = 'B7C4B011-0AD2-4D80-9FD7-190011000002';
  const resultJSON = JSON.stringify({ result_status: 'succeeded', items: [
    { title: 'Un autre minuteur', alarm_id: other },
    { title: 'Infusion Orion du soir', alarm_id: desired, uncertain: false },
  ] });
  const step = { callIndex: 0, resultJSON, resultSHA256: createHash('sha256').update(resultJSON).digest('hex'), productionResultValidated: true };
  const observed = { completed: false, calls: [{ name: 'alarm_list', arguments: {} }, { name: 'alarm_stop', arguments: { alarm_id: desired } }],
    fixtureTrace: { owner: target.scenario.ownerFixture, steps: [step] } };
  assert.equal(gradeCase(target, observed, contract).checks.resultBindings, true);
  observed.calls[1].arguments.alarm_id = other;
  assert.equal(gradeCase(target, observed, contract).checks.resultBindings, false);
});

test('a stopped device turn with zero proposals still retires the prior goal', () => {
  const first = completed('dialogue03.t1', 'Détails de l’atelier reçus.', true);
  const stopped = completed('dialogue03.t2', 'La demande a été arrêtée avant proposition.', false);
  const next = nextTurn('dialogue03.t3', [], { referenceContext: empty(2) });
  assert.deepEqual(nativeEvaluationInputs(natural, observations([first, stopped, next]), [next.id])[0].referenceContext, empty(2));
  next.referenceContext = { schemaVersion: 1, turns: [{ user: first.userText, assistant: first.finalText }], omittedTurns: 1 };
  assert.throws(() => nativeEvaluationInputs(natural, observations([first, stopped, next]), [next.id]), /retired history/);
});
test('even the first natural turn requires the actual admitted user text and capsule', () => {
  const first = { id: 'dialogue01.t1', completed: true, calls: [], finalText: 'Bonjour.' };
  assert.throws(() => nativeEvaluationInputs(natural, observations([first]), [first.id]), /Actual admitted dialogue snapshot/);
  const result = evaluate(natural, observations([first])).cases.find(value => value.id === first.id);
  assert.equal(result.checks.dialogueInputPrepared, null); assert.equal(result.outcome, 'incomplete');
  const actual = nextTurn(first.id, [], { ...first, referenceContextEligible: true });
  assert.equal(nativeEvaluationInputs(natural, observations([actual]), [actual.id])[0].prompt, row(actual.id).prompt);
});

const extension = load('../docs/evals/device-tools-natural-dialogues-extension-v1.json');
const extendedRow = id => extension.cases.find(value => value.id === id);
const fixtureStep = (callIndex, result) => {
  const resultJSON = JSON.stringify(result);
  return { callIndex, resultJSON, resultSHA256: createHash('sha256').update(resultJSON).digest('hex'), productionResultValidated: true };
};
test('a separate fourteen-turn extension prepares the twelve missing tools while preserving the original12/37', () => {
  assert.equal(natural.dialogues.length, 12); assert.equal(natural.cases.length, 37);
  assert.equal(extension.dialogues.length, 4); assert.equal(extension.cases.length, 14);
  assert.equal(extension.status, 'prepared_not_run_model'); assert.equal(extension.productionContractRef, natural.productionContractRef);
  assert.equal(Object.hasOwn(extension, 'productionContract'), false);
  const targeted = [...new Set(extension.cases.flatMap(value => value.toolCoverage))].sort();
  const missing = contract.tools.map(tool => tool.name).filter(name => !natural.coverage.targetedTools.includes(name)).sort();
  assert.equal(missing.length, 12);
  assert.deepEqual(extension.coverage.newToolsRelativeToBase, missing);
  assert.deepEqual(extension.coverage.targetedTools, targeted);
  const union = [...new Set([...natural.coverage.targetedTools, ...targeted])].sort();
  assert.deepEqual(union, contract.tools.map(tool => tool.name).sort());
  assert.equal(extension.coverage.full31Qualification, false);
  assert.equal(new Set([...natural.cases, ...extension.cases].map(value => value.id)).size, 51);
});
test('extension rehearsal has only natural user utterances and no embedded handle, coordinate or oracle', () => {
  const sheet = rehearsalSheet(extension);
  assert.equal(sheet.length, 4); assert.equal(sheet.flatMap(dialogue => dialogue.userUtterances).length, 14);
  for (const dialogue of sheet) for (const text of dialogue.userUtterances) {
    assert.equal(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i.test(text), false);
    assert.equal(/-?\d{2}\.\d{3,}/.test(text), false);
    assert.equal(extension.toolCatalog.some(name => text.includes(name)), false);
  }
  assert.equal(JSON.stringify(sheet).includes('ownerFixture'), false);
  assert.equal(JSON.stringify(sheet).includes('expected'), false);
  assert.deepEqual(evaluate(extension, observations([])).counts, { passed: 0, failed: 0, incomplete: 0, not_run: 14 });
});
test('extension preparation uses the same admitted-capsule pipeline without forwarding new fixture data', () => {
  const first = extendedRow('dialogue13.t1');
  const actual = { id: first.id, userText: first.prompt, completed: false, calls: [], referenceContextEpoch: 0, referenceContext: empty() };
  const input = nativeEvaluationInputs(extension, observations([actual]), [first.id])[0];
  assert.deepEqual(input.referenceContext, empty()); assert.equal(input.prompt, first.prompt);
  assert.deepEqual(Object.keys(input), ['schemaVersion', 'id', 'fixedEnvironment', 'prompt', 'referenceContext', 'calls']);
  assert.equal(JSON.stringify(input).includes('biometrics_available_orion'), false);
  assert.equal(JSON.stringify(input).includes('qa@example.invalid'), false);
});
test('scan-to-index links the actual new inboxID in the same turn and remains inside one write', () => {
  const target = extendedRow('dialogue14.t2');
  const selectedID = 'a7c4b011-0ad2-4d80-9fd7-190011000003';
  const calls = [{ name: 'document_scan', arguments: { max_pages: 2 } }, { name: 'document_index', arguments: {
    inbox_id: selectedID, title: 'Carnet de démonstration Orion', expiration_days: 1,
  } }];
  const observed = { completed: false, calls, fixtureTrace: { owner: target.scenario.ownerFixture,
    steps: [fixtureStep(0, { inboxId: selectedID, result_status: 'scanned', action: 'scan', pageCount: 2, method: 'vision_ocr', documentState: 'text' })] } };
  const result = gradeCase(target, observed, contract);
  assert.equal(result.checks.resultBindings, true); assert.equal(result.checks.writeProposalBudget, true);
  assert.equal(result.checks.mutationProposals, true); assert.equal(result.checks.committingInteractiveProposals, true);
  observed.calls[1].arguments.inbox_id = 'a7c4b011-0ad2-4d80-9fd7-190011000004';
  assert.equal(gradeCase(target, observed, contract).checks.resultBindings, false);
  for (const id of ['dialogue14.t3', 'dialogue14.t4']) {
    const row = extendedRow(id);
    assert.equal(row.expected.firstTool, 'document_search');
    assert.equal(row.scenario.resultBindings[0].from.tool, 'document_search');
    assert.equal(row.scenario.resultBindings[0].from.path[1].where.title, 'Carnet de démonstration Orion');
    assert.equal(JSON.stringify(row.expected).includes('inbox_id'), false);
  }
});
test('contact-to-compose uses the current unique email result and cannot reuse a wrong recipient', () => {
  const target = extendedRow('dialogue15.t3');
  const compose = { name: 'message_compose', arguments: { channel: 'email', recipients: 'qa@example.invalid', subject: 'Essai Orion', body: 'Bonjour, ceci est un brouillon de démonstration.' } };
  const observed = { completed: false, calls: [{ name: 'contacts_search', arguments: { query: 'Camille Démo Orion', limit: 5 } }, compose],
    fixtureTrace: { owner: target.scenario.ownerFixture, steps: [fixtureStep(0, { contacts: [{ given_name: 'Camille', family_name: 'Démo Orion', emails: [{ value: 'qa@example.invalid', label: 'test' }] }] })] } };
  const result = gradeCase(target, observed, contract);
  assert.equal(result.checks.resultBindings, true); assert.equal(result.checks.followupArguments, true);
  assert.equal(result.checks.requiredFactsPresent, null); // Uniqueness/consent/meaning still require review.
  observed.calls[1].arguments.recipients = 'other@example.invalid';
  assert.equal(gradeCase(target, observed, contract).checks.resultBindings, false);
  assert.deepEqual(target.scenario.nativeOutcomes.find(value => value.tool === 'message_compose').resultSubset, { status: 'cancelled' });
  for (const id of ['dialogue15.t2', 'dialogue15.t3']) assert.equal(Object.hasOwn(extendedRow(id).expected, 'argumentsSubset'), false);
});
test('ambiguous contact and unsupported settings admit valid clarification/explanation without forcing a tool', () => {
  for (const id of ['dialogue15.t1', 'dialogue16.t1']) {
    const target = extendedRow(id);
    const noTool = gradeCase(target, { completed: true, calls: [], finalText: 'Une explication ou précision adaptée.' }, contract);
    assert.equal(noTool.checks.firstTool, true); assert.equal(noTool.checks.sequence, true);
    const permitted = target.expected.firstToolAlternatives[0];
    const arguments_ = permitted === 'native_boundary' ? { feature: 'systemSettings' } : { query: 'Camille', limit: 3 };
    const lookup = gradeCase(target, { completed: true, calls: [{ name: permitted, arguments: arguments_ }] }, contract);
    assert.equal(lookup.checks.firstTool, true); assert.equal(lookup.checks.sequence, true);
    const wrong = gradeCase(target, { completed: false, calls: [{ name: 'message_compose', arguments: { channel: 'email', recipients: 'qa@example.invalid', subject: '', body: 'Bonjour.' } }] }, contract);
    assert.equal(wrong.checks.forbiddenTools, false); assert.equal(wrong.outcome, 'failed');
  }
  assert.deepEqual(extension.coverage.optionalToolBranches, ['native_boundary']);
  assert.equal(extension.coverage.meaning.includes('non exercé'), true);
});
test('extension safety requires user touch and bounded cleanup, never automatic native tests or sends', () => {
  assert.equal(extension.executionSafety.automaticNativeExecutionAllowed, false);
  assert.equal(extension.executionSafety.physicalEffectsAllowed, false);
  assert.equal(extension.fixtures.contact_and_compose_cancel_orion.policy.includes('Ne jamais cliquer Envoyer'), true);
  assert.equal(extension.fixtures.paper_orion_extension.indexPolicy.includes('même tour'), true);
  assert.equal(extension.fixtures.location_once_orion.physicalPolicy.includes('rapport public'), true);
  assert.equal(extension.dialogues.every(dialogue => !!dialogue.manualAcceptance.setup && !!dialogue.manualAcceptance.cleanup && !!dialogue.manualAcceptance.unavailablePolicy), true);
});
