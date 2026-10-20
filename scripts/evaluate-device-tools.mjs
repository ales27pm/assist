#!/usr/bin/env node
// Deterministic evaluation only: never invokes a model, executor or provider.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { runInThisContext } from 'node:vm';

const rootURL = new URL('../', import.meta.url);
const repoRequire = createRequire(new URL('../mobile/package.json', import.meta.url));
const modules = new Map();
const allowedTS = new Set(['uniqueJSON', 'deviceReferenceContext', 'nativeBundleTools']);
const compiledProductionSources = ['InferencePolicy', 'AssistAgentCalendar', 'AssistGemmaToolAdapter',
  'AssistToolContracts', 'AssistExtendedTools', 'AssistToolHost', 'AssistDeviceToolAdapter']
  .map(name => `mobile/ios/Assist/Inference/${name}.swift`);
function productionTS(name) {
  if (!allowedTS.has(name)) throw new Error('Unexpected production module');
  if (modules.has(name)) return modules.get(name);
  const ts = repoRequire('typescript');
  const source = readFileSync(new URL(`mobile/src/${name}.ts`, rootURL), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const module = { exports: {} };
  runInThisContext(`(function(exports, require, module) {${code}\n})`, { filename: `production:${name}.ts` })(
    module.exports, dependency => productionTS(dependency.replace(/^\.\//, '')), module);
  modules.set(name, module.exports);
  return module.exports;
}
const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const scalar = value => ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value);
const keys = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => [...required, ...optional].includes(key));
function readJSON(path) {
  const raw = readFileSync(path, 'utf8');
  if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error('Evaluation artifact too large');
  return productionTS('uniqueJSON').parseUniqueJSON(raw);
}
function utc(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
    !value.startsWith('0000-') && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z');
}
class MissingDialogueHistory extends Error {}
function dialogueStructure(dataset) {
  const byId = new Map(dataset.cases.map(row => [row.id, row]));
  if (byId.size !== dataset.cases.length) throw new Error('Duplicate natural dialogue case');
  const membership = new Map();
  const dialogueIds = new Set();
  for (const dialogue of dataset.dialogues ?? []) {
    if (!object(dialogue) || typeof dialogue.id !== 'string' || !Array.isArray(dialogue.turnIds) ||
        !Array.isArray(dialogue.userUtterances) || !dialogue.turnIds.length || dialogue.turnIds.length > 8 ||
        dialogue.turnIds.length !== dialogue.userUtterances.length) throw new Error('Invalid natural dialogue');
    if (dialogueIds.has(dialogue.id)) throw new Error('Duplicate natural dialogue');
    dialogueIds.add(dialogue.id);
    dialogue.turnIds.forEach((id, index) => {
      const row = byId.get(id);
      if (!row || membership.has(id) || row.prompt !== dialogue.userUtterances[index] || typeof row.prompt !== 'string') throw new Error('Dialogue utterances must match case prompts');
      membership.set(id, { dialogue, index });
      const expected = index ? { dialogueId: dialogue.id, previousCaseIds: dialogue.turnIds.slice(0, index) } : undefined;
      if (!isDeepStrictEqual(row.historyBinding, expected)) throw new Error('Dialogue history must use its actual preceding turns');
      if (row.context?.length) throw new Error('Dialogue cases must not contain fabricated assistant history');
    });
  }
  for (const row of dataset.cases) if (row.historyBinding && !membership.has(row.id)) throw new Error('Unbound dialogue history');
  if (dataset.dialogues?.length && membership.size !== dataset.cases.length) throw new Error('Unlisted natural dialogue case');
  return membership;
}
function referenceForCase(row, dataset, observations) {
  if (!row.historyBinding && !dataset.dialogues?.length) return prepareReferenceContext(row.context);
  const production = productionTS('deviceReferenceContext');
  const byId = new Map((observations?.cases ?? []).map(value => [value.id, value]));
  const current = byId.get(row.id);
  if (!current || current.userText !== row.prompt || !Number.isSafeInteger(current.referenceContextEpoch) ||
      current.referenceContextEpoch < 0 || !current.referenceContext) {
    throw new MissingDialogueHistory(`Actual admitted dialogue snapshot required before ${row.id}`);
  }
  // Use the capsule actually admitted for this turn. Reconstructing it from
  // nominal dataset prompts would resurrect goals after failure/background or
  // silently substitute an utterance that the model never received.
  const context = production.validateDeviceReferenceContext(current.referenceContext);
  const eligible = [];
  let previousEpoch = -1;
  for (const id of row.historyBinding?.previousCaseIds ?? []) {
    const prior = byId.get(id), source = dataset.cases.find(value => value.id === id);
    if (!prior || prior.completed !== true || prior.userText !== source.prompt ||
        !Number.isSafeInteger(prior.referenceContextEpoch) || prior.referenceContextEpoch < previousEpoch ||
        prior.referenceContextEpoch > current.referenceContextEpoch || typeof prior.referenceContextEligible !== 'boolean' ||
        prior.referenceContextEligible && (typeof prior.finalText !== 'string' || !prior.finalText.trim())) {
      throw new MissingDialogueHistory(`Actual completed dialogue history required before ${row.id}`);
    }
    previousEpoch = prior.referenceContextEpoch;
    // These machine dialogues use the production device host. Even a stopped
    // turn with no proposed call retires the previous unresolved goal.
    if (!prior.referenceContextEligible) eligible.length = 0;
    if (prior.referenceContextEligible && prior.referenceContextEpoch === current.referenceContextEpoch) {
      // This also applies the real privacy/size filter to the recorded texts.
      const accepted = production.appendDeviceReferenceTurn(production.emptyDeviceReferenceContext(), prior.userText, prior.finalText, true);
      if (accepted.turns.length) eligible.push(accepted.turns[0]);
    }
  }
  if (current.contextReset === true && (current.referenceContextEpoch <= previousEpoch || context.turns.length)) {
    throw new MissingDialogueHistory(`Dialogue snapshot crosses an explicit context reset before ${row.id}`);
  }
  // A snapshot may omit safe turns (opt-out/retirement), but may never add an
  // oracle answer, an uncompleted/ineligible turn or a turn from an old epoch.
  let next = 0;
  for (const turn of context.turns) {
    while (next < eligible.length && !isDeepStrictEqual(eligible[next], turn)) next += 1;
    if (next === eligible.length) throw new MissingDialogueHistory(`Dialogue snapshot contains unproven or retired history before ${row.id}`);
    next += 1;
  }
  return context;
}

function validateDataset(dataset) {
  if (dataset.schemaVersion !== 1 || !Array.isArray(dataset.cases) || !dataset.cases.length || dataset.cases.length > 1000 ||
      !keys(dataset.fixedEnvironment, ['nowUTC', 'timeZone']) || !utc(dataset.fixedEnvironment.nowUTC)) throw new Error('Invalid dataset/clock contract');
  try { new Intl.DateTimeFormat('fr', { timeZone: dataset.fixedEnvironment.timeZone }); }
  catch { throw new Error('Invalid dataset timezone'); }
  if (dataset.productionContract && dataset.productionContractRef) throw new Error('Ambiguous production contract');
  if (dataset.productionContractRef && dataset.productionContractRef !== 'device-tools-context-v1.json') throw new Error('Production contract reference is not allowlisted');
  const snapshot = dataset.productionContract ?? (dataset.productionContractRef
    ? readJSON(new URL('docs/evals/device-tools-context-v1.json', rootURL)).productionContract : null);
  if (!keys(snapshot, ['exportedBy', 'contract', 'sourceSHA256', 'provenance']) || !object(snapshot.sourceSHA256)) throw new Error('Missing compiled production contract');
  for (const [path, digest] of Object.entries(snapshot.sourceSHA256)) {
    if (!/^mobile\/ios\/Assist\/Inference\/[A-Za-z]+\.swift$/.test(path) || !/^[a-f0-9]{64}$/.test(digest) ||
        sha256(readFileSync(new URL(path, rootURL), 'utf8')) !== digest) throw new Error(`Stale production contract: ${path}`);
  }
  if (!isDeepStrictEqual(Object.keys(snapshot.sourceSHA256).sort(), [...compiledProductionSources].sort())) throw new Error('Incomplete production source provenance');
  const contract = snapshot.contract;
  if (contract.schemaVersion !== 1 || !Array.isArray(contract.tools) || contract.tools.length !== 31 ||
      !keys(contract.limits, ['maximumToolCalls', 'maximumWrites', 'maximumPublicBytes']) ||
      !Number.isSafeInteger(contract.limits.maximumToolCalls) || contract.limits.maximumToolCalls < 1 ||
      !Number.isSafeInteger(contract.limits.maximumWrites) || contract.limits.maximumWrites < 0) throw new Error('Invalid compiled production registry');
  const names = contract.tools.map(tool => tool.name);
  // Native enum names are checked independently of both dataset and snapshot.
  const swift = readFileSync(new URL('mobile/ios/Assist/Inference/AssistToolContracts.swift', rootURL), 'utf8');
  const enumBody = swift.match(/enum AssistToolName:[^{]+\{([\s\S]*?)\n\s*static var legacyCases/);
  const nativeNames = enumBody?.[1].split('\n').filter(line => /^\s*case /.test(line)).flatMap(line => line.trim().slice(5).split(',').map(value => value.trim()));
  if (!isDeepStrictEqual(names, nativeNames) || !isDeepStrictEqual(dataset.toolCatalog, names)) throw new Error('Dataset must use the actual ordered production catalog');
  for (const tool of contract.tools) {
    if (!['read', 'write', 'interactive'].includes(tool.effect) || tool.definition?.function?.name !== tool.name ||
        tool.definition?.function?.parameters?.additionalProperties !== false) throw new Error('Invalid production tool descriptor');
  }
  const validPath = path => Array.isArray(path) && path.length > 0 && path.length <= 8 && path.every(part =>
    typeof part === 'string' && !!part && part.length <= 64 && !['__proto__', 'prototype', 'constructor'].includes(part) ||
    Number.isSafeInteger(part) && part >= 0 && part < 128 ||
    keys(part, ['where']) && object(part.where) && Object.keys(part.where).length > 0 && Object.keys(part.where).length <= 8 && Object.values(part.where).every(scalar));
  const callRef = value => keys(value, ['tool', 'occurrence']) && names.includes(value.tool) && Number.isSafeInteger(value.occurrence) && value.occurrence >= 0 && value.occurrence < contract.limits.maximumToolCalls;
  const ids = new Set();
  for (const row of dataset.cases) {
    if (typeof row.id !== 'string' || !row.id || row.id.length > 128 || ids.has(row.id) || typeof row.prompt !== 'string' ||
        !['selection_only', 'scenario_requires_fixture_executor'].includes(row.evaluationMode) || !object(row.expected) ||
        !(row.expected.firstTool === null || names.includes(row.expected.firstTool))) throw new Error('Invalid or duplicate dataset case');
    ids.add(row.id);
    if (!keys(row.expected, ['firstTool'], ['firstToolAlternatives', 'argumentsSubset', 'toolSequence', 'toolSequences', 'argumentsByTool', 'clarification',
      'forbiddenClaims', 'requiredFacts', 'forbiddenTools', 'maxMutations', 'maxCommittingInteractions'])) throw new Error('Unknown oracle requirement');
    for (const key of ['forbiddenClaims', 'requiredFacts', 'forbiddenTools', 'toolSequence', 'firstToolAlternatives']) {
      if (row.expected[key] !== undefined && (!Array.isArray(row.expected[key]) || !row.expected[key].every(value => typeof value === 'string'))) throw new Error('Invalid oracle list');
    }
    if (row.expected.toolSequences !== undefined && (!Array.isArray(row.expected.toolSequences) || !row.expected.toolSequences.length ||
        row.expected.toolSequences.some(sequence => !Array.isArray(sequence) || sequence.some(name => !names.includes(name))))) throw new Error('Invalid alternative tool sequences');
    if (row.expected.toolSequence && row.expected.toolSequences) throw new Error('Ambiguous tool sequence oracle');
    for (const key of ['maxMutations', 'maxCommittingInteractions']) {
      if (row.expected[key] !== undefined && (!Number.isSafeInteger(row.expected[key]) || row.expected[key] < 0)) throw new Error('Invalid oracle budget');
    }
    if (row.scenario?.nativeOutcomes !== undefined && (!Array.isArray(row.scenario.nativeOutcomes) || !row.scenario.nativeOutcomes.length || row.scenario.nativeOutcomes.length > 8 ||
        row.scenario.nativeOutcomes.some(outcome => !keys(outcome, ['tool', 'occurrence'], ['resultSubset', 'ownerError']) ||
          !callRef({ tool: outcome.tool, occurrence: outcome.occurrence }) ||
          Object.hasOwn(outcome, 'resultSubset') === Object.hasOwn(outcome, 'ownerError') ||
          outcome.resultSubset !== undefined && !object(outcome.resultSubset) ||
          outcome.ownerError !== undefined && (!keys(outcome.ownerError, ['domain', 'code']) || typeof outcome.ownerError.domain !== 'string' ||
            !outcome.ownerError.domain || outcome.ownerError.domain.length > 128 || !Number.isSafeInteger(outcome.ownerError.code))))) throw new Error('Invalid native outcome oracle');
    if (row.scenario?.resultBindings !== undefined && (!Array.isArray(row.scenario.resultBindings) || row.scenario.resultBindings.length > 16 ||
        row.scenario.resultBindings.some(binding => !keys(binding, ['from', 'to']) ||
          !keys(binding.from, ['tool', 'occurrence', 'path']) || !validPath(binding.from.path) ||
          !callRef({ tool: binding.from.tool, occurrence: binding.from.occurrence }) ||
          !keys(binding.to, ['tool', 'occurrence', 'argument']) ||
          !callRef({ tool: binding.to.tool, occurrence: binding.to.occurrence }) ||
          !Object.hasOwn(contract.tools.find(tool => tool.name === binding.to.tool).definition.function.parameters.properties, binding.to.argument)))) throw new Error('Invalid result binding oracle');
    if (row.context !== undefined) prepareReferenceContext(row.context);
    for (const name of [...(row.expected.toolSequence ?? []), ...(row.expected.firstToolAlternatives ?? []), ...(row.expected.forbiddenTools ?? []), ...Object.keys(row.expected.argumentsByTool ?? {})]) {
      if (!names.includes(name)) throw new Error('Unknown oracle tool');
    }
    if (row.expected.argumentsSubset !== undefined && !object(row.expected.argumentsSubset)) throw new Error('Invalid argument oracle');
  }
  dialogueStructure(dataset);
  return contract;
}

export function modelInputs(dataset) {
  validateDataset(dataset);
  return dataset.cases.map(row => ({ id: row.id, environment: dataset.fixedEnvironment,
    referenceContext: referenceForCase(row, dataset, null), prompt: row.prompt }));
}
/** Human rehearsal sheet only: no assistant answer, oracle, ID or service data. */
export function rehearsalSheet(dataset) {
  if (!Array.isArray(dataset.cases) || !Array.isArray(dataset.dialogues)) throw new Error('Natural dialogue dataset required');
  dialogueStructure(dataset);
  return dataset.dialogues.map(dialogue => ({ id: dialogue.id,
    userUtterances: dialogue.userUtterances.map(text => String(text)) }));
}
export function prepareReferenceContext(messages = []) {
  if (!Array.isArray(messages) || messages.length > 128 || messages.length % 2) throw new Error('Context must contain complete user/assistant pairs');
  const production = productionTS('deviceReferenceContext');
  let context = production.emptyDeviceReferenceContext();
  for (let index = 0; index < messages.length; index += 2) {
    const user = messages[index], assistant = messages[index + 1];
    if (!keys(user, ['role', 'content']) || !keys(assistant, ['role', 'content']) || user.role !== 'user' || assistant.role !== 'assistant' ||
        typeof user.content !== 'string' || typeof assistant.content !== 'string') throw new Error('Invalid context pair');
    context = production.appendDeviceReferenceTurn(context, user.content, assistant.content, true);
  }
  return production.validateDeviceReferenceContext(context);
}
function validateObserved(observed) {
  if (!object(observed) || typeof observed.completed !== 'boolean' || !Array.isArray(observed.calls) || observed.calls.length > 64 ||
      observed.calls.some(call => !keys(call, ['name', 'arguments']) || typeof call.name !== 'string' || !object(call.arguments) ||
        !Object.values(call.arguments).every(scalar)) ||
      observed.finalText !== undefined && typeof observed.finalText !== 'string' ||
      observed.referenceContextEligible !== undefined && typeof observed.referenceContextEligible !== 'boolean' ||
      observed.contextReset !== undefined && typeof observed.contextReset !== 'boolean' ||
      observed.userText !== undefined && (typeof observed.userText !== 'string' || Buffer.byteLength(observed.userText) > 32 * 1024) ||
      observed.referenceContextEpoch !== undefined && (!Number.isSafeInteger(observed.referenceContextEpoch) || observed.referenceContextEpoch < 0)) throw new Error(`Invalid observation contract: ${observed?.id}`);
}
export function nativeEvaluationInputs(dataset, observations = null, ids = null) {
  validateDataset(dataset);
  const selected = ids ? new Set(ids) : null;
  if (selected && (selected.size !== ids.length || ids.some(id => !dataset.cases.some(row => row.id === id)))) throw new Error('Unknown or duplicate selected case');
  const byId = new Map();
  for (const observed of observations?.cases ?? []) {
    if (!dataset.cases.some(row => row.id === observed.id) || byId.has(observed.id)) throw new Error('Unknown or duplicate observation');
    validateObserved(observed); byId.set(observed.id, observed);
  }
  return dataset.cases.filter(row => selected ? selected.has(row.id) : observations ? byId.has(row.id) : true).map(row => {
    const observed = byId.get(row.id);
    if (observed) {
      validateObserved(observed);
      if (observed.userText !== undefined && observed.userText !== row.prompt) throw new Error(`Observed user input differs from scenario: ${row.id}`);
    }
    return { schemaVersion: 1, id: row.id, fixedEnvironment: dataset.fixedEnvironment,
      prompt: row.prompt, referenceContext: referenceForCase(row, dataset, observations), calls: observed?.calls ?? [] };
  });
}
function subset(actual, expected) {
  return object(actual) && Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && isDeepStrictEqual(actual[key], value));
}
function schemaValid(arguments_, schema) {
  if (!object(arguments_) || !keys(arguments_, schema.required ?? [], Object.keys(schema.properties ?? {}))) return false;
  return Object.entries(arguments_).every(([key, value]) => {
    const field = schema.properties[key];
    if (!field) return false;
    if (field.type === 'integer' && !Number.isSafeInteger(value) || field.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)) ||
        field.type === 'boolean' && typeof value !== 'boolean' || field.type === 'string' && typeof value !== 'string') return false;
    if (field.enum && !field.enum.includes(value)) return false;
    if (typeof value === 'number' && (field.minimum !== undefined && value < field.minimum || field.maximum !== undefined && value > field.maximum)) return false;
    if (typeof value === 'string' && (field.minLength !== undefined && value.length < field.minLength ||
        field.maxLength !== undefined && Buffer.byteLength(value) > field.maxLength || field.format === 'date-time' && !utc(value))) return false;
    return true;
  });
}
function reviewSubject(observed) {
  // Changing any result, user utterance or admitted capsule invalidates the
  // semantic review just as changing the final answer does.
  return { calls: observed.calls, finalText: observed.finalText ?? '',
    fixtureTrace: observed.fixtureTrace ?? null, userText: observed.userText ?? null,
    referenceContext: observed.referenceContext ?? null, referenceContextEpoch: observed.referenceContextEpoch ?? null, contextReset: observed.contextReset ?? false };
}
export function reviewCriteriaSHA256(test) { return sha256({ id: test.id, expected: test.expected, scenario: test.scenario ?? null }); }
function trustedReview(review, observed, test) {
  return object(review) && ['human', 'deterministic_fixture'].includes(review.method) && typeof review.reviewer === 'string' && !!review.reviewer.trim() &&
    review.caseId === test.id && review.criteriaSHA256 === reviewCriteriaSHA256(test) && review.subjectSHA256 === sha256(reviewSubject(observed));
}
export function reviewSubjectSHA256(observed) { return sha256(reviewSubject(observed)); }
function deepSubset(actual, expected) {
  // Empty explicitly means empty. Nonempty lists assert distinct matching rows
  // without imposing arbitrary pagination/order on otherwise valid native data.
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || !expected.length) return Array.isArray(actual) && actual.length === 0;
    const assigned = new Map();
    function match(index, seen) {
      for (let target = 0; target < actual.length; target += 1) {
        if (seen.has(target) || !deepSubset(actual[target], expected[index])) continue;
        seen.add(target);
        if (!assigned.has(target) || match(assigned.get(target), seen)) { assigned.set(target, index); return true; }
      }
      return false;
    }
    return expected.every((_, index) => match(index, new Set()));
  }
  if (object(expected)) return object(actual) && Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && deepSubset(actual[key], value));
  return isDeepStrictEqual(actual, expected);
}
function fixtureEvidence(test, observed) {
  const trace = observed.fixtureTrace;
  if (trace === undefined) return { valid: null, steps: [] };
  if (!keys(trace, ['owner', 'steps']) || trace.owner !== test.scenario?.ownerFixture || !Array.isArray(trace.steps) || trace.steps.length > observed.calls.length) return { valid: false, steps: [] };
  const steps = [];
  for (const [index, step] of trace.steps.entries()) {
    if (keys(step, ['callIndex', 'resultJSON', 'resultSHA256', 'productionResultValidated']) && step.callIndex === index &&
        typeof step.resultJSON === 'string' && Buffer.byteLength(step.resultJSON) <= 24 * 1024 &&
        step.resultSHA256 === sha256(step.resultJSON) && step.productionResultValidated === true) {
      try {
        const result = productionTS('uniqueJSON').parseUniqueJSON(step.resultJSON);
        if (!object(result) || ['cancelled', 'outcome_unknown'].includes(result.status) && Object.keys(result).length !== 1) return { valid: false, steps: [] };
        steps.push({ result });
      } catch { return { valid: false, steps: [] }; }
    } else if (keys(step, ['callIndex', 'ownerError', 'errorSHA256', 'productionErrorValidated']) && step.callIndex === index &&
        keys(step.ownerError, ['domain', 'code']) && typeof step.ownerError.domain === 'string' && step.ownerError.domain.length <= 128 &&
        Number.isSafeInteger(step.ownerError.code) && step.errorSHA256 === sha256(step.ownerError) && step.productionErrorValidated === true) {
      steps.push({ error: step.ownerError });
    } else return { valid: false, steps: [] };
  }
  return { valid: trace.steps.length === observed.calls.length && observed.completed ? true : null, steps };
}
function callIndex(calls, tool, occurrence) {
  return calls.map((call, index) => call.name === tool ? index : -1).filter(index => index >= 0)[occurrence];
}
function resultChecks(test, observed, effectiveCalls, evidence) {
  const checks = {};
  if (test.scenario?.nativeOutcomes) {
    const values = test.scenario.nativeOutcomes.map(requirement => {
      const index = callIndex(observed.calls, requirement.tool, requirement.occurrence);
      if (index === undefined) return observed.completed ? false : null;
      const step = evidence.steps[index];
      if (!step) return evidence.valid === false ? false : null;
      return requirement.ownerError ? deepSubset(step.error, requirement.ownerError) : deepSubset(step.result, requirement.resultSubset);
    });
    checks.nativeOutcomes = values.includes(false) ? false : values.includes(null) ? null : true;
  }
  if (test.scenario?.resultBindings) {
    const values = test.scenario.resultBindings.map(binding => {
      const from = callIndex(observed.calls, binding.from.tool, binding.from.occurrence);
      const to = callIndex(observed.calls, binding.to.tool, binding.to.occurrence);
      if (to === undefined) return observed.completed ? false : null;
      if (from === undefined || from >= to) return false;
      if (!evidence.steps[from]) return evidence.valid === false ? false : null;
      let value = evidence.steps[from].result;
      for (const part of binding.from.path) {
        if (object(part)) {
          if (!Array.isArray(value)) return false;
          const matches = value.filter(row => subset(row, part.where));
          if (matches.length !== 1) return false;
          value = matches[0];
        } else {
          if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return false;
          value = value[part];
        }
      }
      return scalar(value) && Object.hasOwn(effectiveCalls[to].arguments, binding.to.argument) && isDeepStrictEqual(value, effectiveCalls[to].arguments[binding.to.argument]);
    });
    checks.resultBindings = values.includes(false) ? false : values.includes(null) ? null : true;
  }
  return checks;
}

export function gradeCase(test, observed, contract, nativeRow = null) {
  if (!observed) return { id: test.id, scope: test.evaluationMode, outcome: 'not_run', checks: {} };
  validateObserved(observed);
  const expected = test.expected, calls = observed.calls;
  const effectiveCalls = calls.map((call, index) => nativeRow?.calls[index]?.accepted === true && object(nativeRow.calls[index].normalizedArguments)
    ? { ...call, arguments: nativeRow.calls[index].normalizedArguments } : call);
  const tools = new Map(contract.tools.map(tool => [tool.name, tool]));
  const checks = {
    knownTools: calls.every(call => tools.has(call.name)),
    schemaArguments: calls.every(call => tools.has(call.name) && schemaValid(call.arguments, tools.get(call.name).definition.function.parameters)),
    nativeArguments: calls.length ? nativeRow ? nativeRow.calls.every(row => row.accepted === true) : null : true,
    firstTool: [expected.firstTool, ...(expected.firstToolAlternatives ?? [])].includes(calls[0]?.name ?? null),
    callBudget: calls.length <= contract.limits.maximumToolCalls,
    writeProposalBudget: calls.filter(call => tools.get(call.name)?.effect === 'write').length <= contract.limits.maximumWrites,
  };
  if (test.evaluationMode === 'selection_only') checks.singlePlanningDecision = calls.length <= 1;
  if (expected.argumentsSubset) checks.arguments = subset(effectiveCalls[0]?.arguments, expected.argumentsSubset);
  const sequences = expected.toolSequences ?? (expected.toolSequence ? [expected.toolSequence] : null);
  if (sequences) {
    const prefixValid = sequences.some(sequence => calls.length <= sequence.length && calls.every((call, index) => call.name === sequence[index]));
    checks.sequence = !prefixValid ? false : observed.completed ? sequences.some(sequence => isDeepStrictEqual(calls.map(call => call.name), sequence)) : null;
  }
  if (expected.argumentsByTool) {
    // An observed wrong argument is already a failure even if interrupted.
    // Only a required follow-up that has not happened yet remains unknown.
    const values = Object.entries(expected.argumentsByTool).map(([name, args]) => {
      const matching = effectiveCalls.filter(call => call.name === name);
      return matching.length ? matching.every(call => subset(call.arguments, args)) : observed.completed ? false : null;
    });
    checks.followupArguments = values.includes(false) ? false : values.includes(null) ? null : true;
  }
  if (expected.forbiddenTools) checks.forbiddenTools = calls.every(call => !expected.forbiddenTools.includes(call.name));
  if (expected.maxMutations !== undefined) checks.mutationProposals = calls.filter(call => tools.get(call.name)?.effect === 'write').length <= expected.maxMutations;
  if (expected.maxCommittingInteractions !== undefined) checks.committingInteractiveProposals = calls.filter(call => productionTS('nativeBundleTools').interactiveMayCommit(call.name)).length <= expected.maxCommittingInteractions;
  if (test.context?.length) checks.contextPrepared = nativeRow ? true : null;
  if (test.historyBinding) checks.dialogueHistoryPrepared = nativeRow ? true : null;
  if (test.category === 'natural_dialogue') checks.dialogueInputPrepared = nativeRow ? true : null;
  if (!calls.length) checks.nonemptyAnswer = typeof observed.finalText === 'string' && !!observed.finalText.trim() ? true : null;
  const review = trustedReview(observed.review, observed, test) ? observed.review : {};
  if (typeof expected.clarification === 'boolean') checks.clarification = typeof review.clarification === 'boolean' ? review.clarification === expected.clarification : null;
  for (const [requirement, key] of [[Boolean(expected.forbiddenClaims?.length), 'forbiddenClaimsAbsent'], [Boolean(expected.requiredFacts?.length), 'requiredFactsPresent']]) {
    if (requirement) checks[key] = typeof review[key] === 'boolean' ? review[key] : null;
  }
  if (test.evaluationMode === 'scenario_requires_fixture_executor') {
    const evidence = fixtureEvidence(test, observed);
    checks.fixtureScenario = evidence.valid;
    Object.assign(checks, resultChecks(test, observed, effectiveCalls, evidence));
    if (test.scenario?.requiresProductionContextFilter && !test.scenario.ownerFixture) checks.fixtureScenario = nativeRow ? true : null;
  }
  checks.completed = observed.completed ? true : null;
  const values = Object.values(checks);
  return { id: test.id, scope: test.evaluationMode, outcome: values.includes(false) ? 'failed' : values.includes(null) ? 'incomplete' : 'passed', checks };
}

export function evaluate(dataset, observations, nativeReport = null) {
  const contract = validateDataset(dataset);
  if (observations.schemaVersion !== 1 || !['scripted', 'model_output', 'physical_device'].includes(observations.evidenceLayer) || !Array.isArray(observations.cases)) throw new Error('Invalid evaluation contract');
  const expectedIds = new Set(dataset.cases.map(row => row.id)), byId = new Map();
  for (const observed of observations.cases) {
    if (!object(observed) || !expectedIds.has(observed.id) || byId.has(observed.id)) throw new Error('Unknown or duplicate observation');
    validateObserved(observed); byId.set(observed.id, observed);
  }
  const native = new Map();
  let inputs;
  try { inputs = nativeEvaluationInputs(dataset, observations); }
  catch (error) { if (error instanceof MissingDialogueHistory && !nativeReport) inputs = null; else throw error; }
  if (nativeReport) {
    if (nativeReport.schemaVersion !== 1 || !isDeepStrictEqual(nativeReport.contract, contract) || !Array.isArray(nativeReport.cases) || nativeReport.cases.length !== inputs.length) throw new Error('Mismatched compiled native validation contract');
    for (const row of nativeReport.cases) {
      const input = inputs.find(input => input.id === row.id);
      let actual;
      try { actual = productionTS('uniqueJSON').parseUniqueJSON(row.inputJSON); } catch { throw new Error('Invalid native input provenance'); }
      if (!input || native.has(row.id) || row.inputAccepted !== true || !isDeepStrictEqual(actual, input) ||
          !Array.isArray(row.calls) || row.calls.length !== input.calls.length ||
          row.calls.some((call, index) => !object(call) || typeof call.accepted !== 'boolean' || call.accepted === true &&
            (!object(call.normalizedArguments) || !schemaValid(call.normalizedArguments,
              contract.tools.find(tool => tool.name === input.calls[index].name)?.definition.function.parameters ?? {}))) ||
          !Array.isArray(row.messages) || !isDeepStrictEqual(row.tools, contract.tools.map(tool => tool.definition))) throw new Error('Native validation does not match the observed inputs');
      native.set(row.id, row);
    }
  }
  const provenance = observations.provenance;
  const modelTraceProvenance = observations.evidenceLayer === 'scripted' ? 'scripted_only' :
    object(provenance) && ['runId', 'modelIdentity', 'runtime', 'sourceRevision'].every(key => typeof provenance[key] === 'string' && provenance[key].trim()) &&
      provenance.templateSHA256 === contract.canonicalTemplateSHA256 ? 'declared_not_independently_authenticated' : 'missing_or_incomplete';
  const cases = dataset.cases.map(row => {
    const result = gradeCase(row, byId.get(row.id), contract, native.get(row.id));
    if (byId.has(row.id) && observations.evidenceLayer !== 'scripted') {
      result.checks.traceProvenance = modelTraceProvenance === 'missing_or_incomplete' ? null : true;
      if (result.outcome === 'passed' && result.checks.traceProvenance === null) result.outcome = 'incomplete';
    }
    return result;
  });
  const counts = Object.fromEntries(['passed', 'failed', 'incomplete', 'not_run'].map(key => [key, cases.filter(row => row.outcome === key).length]));
  return { schemaVersion: 1, evidenceLayer: observations.evidenceLayer, qualification: 'not_established_by_this_grader',
    provenance: { datasetSHA256: sha256(dataset), observationsSHA256: sha256(observations), nativeInputSHA256: inputs ? sha256(inputs) : null,
      productionContractSHA256: sha256(contract), nativeValidation: nativeReport ? 'matched_native_report_artifact_origin_not_authenticated' : 'not_supplied', modelTraceProvenance,
      contextPreparation: { typescriptVersion: repoRequire('typescript/package.json').version,
        sourceSHA256: Object.fromEntries(['deviceReferenceContext', 'uniqueJSON'].map(name => [
          `mobile/src/${name}.ts`, sha256(readFileSync(new URL(`mobile/src/${name}.ts`, rootURL), 'utf8'))])) } },
    counts, cases,
    limits: ['Scripted observations do not measure Gemma tool selection.',
      'Model output and validated arguments do not prove consent, native execution, cancellation or external state.',
      'Matching hashes bind artifacts together but do not authenticate their author or prove runtime provenance.',
      'Fixture results require bounded structured content and declared production validation; opaque hashes/booleans alone do not prove the expected outcome.',
      'Natural histories use actual admitted capsules and recorded utterances from completed eligible turns of the same epoch, never nominal historical prompts.',
      'Qualitative claims require an explicit independent review; missing cases remain not_run.',
      'Proposal budgets are separate from native submission/effect budgets; interactive commits remain a separate axis.'] };
}

function main(args) {
  const dataset = readJSON(args[1]);
  if (args[0] === '--rehearsal-sheet' && args.length === 2) {
    process.stdout.write(rehearsalSheet(dataset).map(row => `${row.id}\n${row.userUtterances.map((text, index) => `${index + 1}. ${text}`).join('\n')}`).join('\n\n') + '\n'); return;
  }
  if (args[0] === '--export-inputs' && args.length === 2) {
    process.stdout.write(modelInputs(dataset).map(row => JSON.stringify(row)).join('\n') + '\n'); return;
  }
  if (args[0] === '--native-inputs' && [2, 3].includes(args.length)) {
    const observations = args[2] ? readJSON(args[2]) : null;
    // Also validate foreign/duplicate IDs before exporting an observation subset.
    if (observations) evaluate(dataset, observations);
    process.stdout.write(nativeEvaluationInputs(dataset, observations).map(row => JSON.stringify(row)).join('\n') + '\n'); return;
  }
  if (args[0] !== '--grade' || ![4, 5].includes(args.length)) throw new Error('Usage: --export-inputs DATASET | --native-inputs DATASET [OBSERVATIONS] | --grade DATASET OBSERVATIONS OUTPUT [NATIVE_REPORT]');
  const report = evaluate(dataset, readJSON(args[2]), args[4] ? readJSON(args[4]) : null);
  writeFileSync(args[3], JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ evidenceLayer: report.evidenceLayer, counts: report.counts, qualification: report.qualification }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
