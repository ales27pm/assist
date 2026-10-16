import { LoadProbeReport, parseLoadProbeReport } from './loadProbe';
import { PrimitiveReport, parsePrimitiveReport } from './protocol';

export const repairTargets = {
  bundled_f16_neural_engine: {
    modelName: 'rmsnorm-f16-boundary',
    sourceAssetSHA256:
      '46932657bf6ea3e4a3e99abba91b377b1ddbfb731a8553a4d5728fc414f54c8c',
  },
  selected_f16_neural_engine: {
    modelName: 'gemma4-e2b-32k-group8-rmscomposite',
    sourceAssetSHA256:
      'bd71bc0793677c4c4789b78109426b96afa2af7fc4df332f0c88695a43967362',
  },
} as const;
export type RepairTarget = keyof typeof repairTargets;
export const specializationRepairMeasurementMethods = {
  scope:
    'One manually selected model and Neural Engine preference; no other model or compute-option cache entries are deleted',
  cache:
    'One public deleteEntry call; a returned call does not establish that an entry previously existed; a thrown call stops the repair',
  source:
    'The injected source verifier completes before invalidation; only the two fixed source identities are supported; source files are not modified',
  markers:
    'One bounded atomic private Application Support record is persisted before each risky call; a pending record is not proof of a crash and is never resumed automatically',
  attempt:
    'Fresh UUID, UTC start and process ID identify this explicit manual repair',
  elapsedMs:
    'ContinuousClock elapsed time includes observations and persistence, not isolated execution timing',
  nativeErrors:
    'At most three sanitized NSError domains, signed codes and Swift type names; descriptions and userInfo are omitted',
  completion:
    'Completed means the original diagnostic returned a JSON object; it does not assert numerical qualification, generation readiness or accelerator placement',
} as const;
const recordedErrors = [
  'E_SPECIALIZATION_REPAIR_SOURCE_FAILED',
  'E_SPECIALIZATION_REPAIR_INVALIDATION_FAILED',
  'E_SPECIALIZATION_REPAIR_QUALIFICATION_FAILED',
  'E_SPECIALIZATION_REPAIR_DIAGNOSTIC_INVALID',
  'E_SPECIALIZATION_REPAIR_CANCELLED',
] as const;
const progressStages = [
  'verifying_source',
  'invalidating_entry',
  'entry_invalidated',
  'qualifying',
  'completed',
] as const;
type ProgressStage = (typeof progressStages)[number];
export type RepairStage = ProgressStage | 'failed';
export type SpecializationRepairReport = {
  schemaVersion: 1;
  kind: 'assistSpecializationRepair';
  scope: 'single_model_neural_engine_cache_entry';
  target: RepairTarget;
  modelName: string;
  sourceAssetSHA256: string;
  computePreference: 'neural_engine_preferred';
  nativeBuild: string;
  osVersion: string;
  attempt: {
    id: string;
    startedAtUTC: string;
    processIdentifier: number;
    entryPoint: 'manual_single_entry_repair';
  };
  stage: RepairStage;
  steps: { stage: RepairStage; elapsedMs: number }[];
  errorCode?: string;
  nativeErrors?: { domain: string; code?: number; swiftType: string }[];
  measurementMethods: Record<string, string>;
};
export type RepairNumericCase = {
  variant: 'f16_boundary' | 'f32_boundary';
  mode: 'neural_engine_preferred' | 'cpu_only';
  function: string;
  passed: boolean;
  actualSHA256?: string;
  error?: string;
};
export type RepairPrimitiveReport = PrimitiveReport & {
  nativeBuild: string;
  results: RepairNumericCase[];
};
export type SpecializationRepairResult = {
  schemaVersion: 1;
  kind: 'assistSpecializationRepairResult';
  repair: SpecializationRepairReport;
  diagnostic: RepairPrimitiveReport | LoadProbeReport;
};
export type SpecializationRepairEvidence =
  | SpecializationRepairReport
  | SpecializationRepairResult;

function invalid(): never {
  throw new Error('Rapport de réparation invalide.');
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid();
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.length || value.length > maximum) {
    return invalid();
  }
  return value;
}
function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function parseRepair(
  value: Record<string, unknown>,
): SpecializationRepairReport {
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'assistSpecializationRepair' ||
    value.scope !== 'single_model_neural_engine_cache_entry' ||
    typeof value.target !== 'string' ||
    !Object.prototype.hasOwnProperty.call(repairTargets, value.target) ||
    value.computePreference !== 'neural_engine_preferred' ||
    typeof value.stage !== 'string' ||
    ![...progressStages, 'failed'].includes(value.stage as RepairStage) ||
    !Array.isArray(value.steps) ||
    value.steps.length < 1 ||
    value.steps.length > 6
  ) {
    return invalid();
  }
  const target = value.target as RepairTarget;
  if (
    value.modelName !== repairTargets[target].modelName ||
    value.sourceAssetSHA256 !== repairTargets[target].sourceAssetSHA256
  ) {
    return invalid();
  }
  const stage = value.stage as RepairStage;
  let previousElapsed = 0;
  const rawSteps = value.steps;
  const steps = rawSteps.map((item, index) => {
    const step = record(item);
    const failedEnd = stage === 'failed' && index === rawSteps.length - 1;
    const expected = failedEnd ? 'failed' : progressStages[index];
    if (
      step.stage !== expected ||
      typeof step.elapsedMs !== 'number' ||
      !Number.isFinite(step.elapsedMs) ||
      step.elapsedMs < previousElapsed ||
      (failedEnd && index === 0)
    ) {
      return invalid();
    }
    previousElapsed = step.elapsedMs;
    return { stage: step.stage as RepairStage, elapsedMs: step.elapsedMs };
  });
  if (
    steps[steps.length - 1].stage !== stage ||
    (stage === 'failed' && steps.some(step => step.stage === 'completed')) ||
    (stage === 'failed') !== (value.errorCode != null)
  ) {
    return invalid();
  }
  const attempt = record(value.attempt);
  const id = text(attempt.id, 36);
  const startedAtUTC = text(attempt.startedAtUTC, 24);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      id,
    ) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(startedAtUTC) ||
    !Number.isFinite(Date.parse(startedAtUTC)) ||
    new Date(startedAtUTC).toISOString() !== startedAtUTC ||
    !count(attempt.processIdentifier) ||
    attempt.processIdentifier < 1 ||
    attempt.processIdentifier > 2_147_483_647 ||
    attempt.entryPoint !== 'manual_single_entry_repair'
  ) {
    return invalid();
  }
  const methods = record(value.measurementMethods);
  if (Object.keys(methods).length !== 8) {
    return invalid();
  }
  const measurementMethods: Record<string, string> = {};
  for (const [key, method] of Object.entries(methods)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key)) {
      return invalid();
    }
    measurementMethods[key] = text(method, 2048);
  }
  for (const [key, method] of Object.entries(
    specializationRepairMeasurementMethods,
  )) {
    if (measurementMethods[key] !== method) {
      return invalid();
    }
  }
  const versionText = (item: unknown) => {
    const version = text(item, 160);
    if (!/^[A-Za-z0-9._ ():-]+$/.test(version) || version.trim() !== version) {
      return invalid();
    }
    return version;
  };
  const result: SpecializationRepairReport = {
    schemaVersion: 1,
    kind: 'assistSpecializationRepair',
    scope: 'single_model_neural_engine_cache_entry',
    target,
    modelName: repairTargets[target].modelName,
    sourceAssetSHA256: repairTargets[target].sourceAssetSHA256,
    computePreference: 'neural_engine_preferred',
    nativeBuild: versionText(value.nativeBuild),
    osVersion: versionText(value.osVersion),
    attempt: {
      id,
      startedAtUTC,
      processIdentifier: attempt.processIdentifier,
      entryPoint: 'manual_single_entry_repair',
    },
    stage,
    steps,
    measurementMethods,
  };
  if (value.errorCode != null) {
    const code = text(value.errorCode, 80);
    if (!(recordedErrors as readonly string[]).includes(code)) {
      return invalid();
    }
    const failedAt = steps.length - 2;
    if (
      (code === 'E_SPECIALIZATION_REPAIR_SOURCE_FAILED' && failedAt !== 0) ||
      (code === 'E_SPECIALIZATION_REPAIR_INVALIDATION_FAILED' &&
        failedAt !== 1) ||
      ([
        'E_SPECIALIZATION_REPAIR_QUALIFICATION_FAILED',
        'E_SPECIALIZATION_REPAIR_DIAGNOSTIC_INVALID',
      ].includes(code) &&
        failedAt !== 3)
    ) {
      return invalid();
    }
    result.errorCode = code;
  }
  if (value.nativeErrors != null) {
    if (
      stage !== 'failed' ||
      !Array.isArray(value.nativeErrors) ||
      value.nativeErrors.length < 1 ||
      value.nativeErrors.length > 3
    ) {
      return invalid();
    }
    result.nativeErrors = value.nativeErrors.map(item => {
      const native = record(item);
      const domain = text(native.domain, 160);
      const swiftType = text(native.swiftType, 160);
      if (
        !/^[A-Za-z0-9._]+$/.test(domain) ||
        !/^[A-Za-z0-9._]+$/.test(swiftType)
      ) {
        return invalid();
      }
      const evidence: NonNullable<
        SpecializationRepairReport['nativeErrors']
      >[number] = { domain, swiftType };
      if (native.code != null) {
        if (
          typeof native.code !== 'number' ||
          !Number.isSafeInteger(native.code)
        ) {
          return invalid();
        }
        evidence.code = native.code;
      }
      return evidence;
    });
  }
  return result;
}

function parseNumericDiagnostic(value: unknown): RepairPrimitiveReport {
  const diagnostic = record(value);
  const parsed = parsePrimitiveReport(JSON.stringify(diagnostic));
  if (
    parsed.schemaVersion !== 2 ||
    !Array.isArray(diagnostic.results) ||
    diagnostic.results.length !== 48
  ) {
    return invalid();
  }
  const functions = [
    '256_8',
    '256_1',
    '512_8',
    '512_1',
    '1536_1',
    '256_35',
  ].flatMap(shape =>
    ['weighted', 'ones'].map(weight => `rms_q8_${shape}_${weight}`),
  );
  const seen = new Set<string>();
  let failed = 0;
  for (const item of diagnostic.results) {
    const result = record(item);
    const key = `${result.variant}/${result.mode}/${result.function}`;
    if (
      typeof result.variant !== 'string' ||
      !['f16_boundary', 'f32_boundary'].includes(result.variant) ||
      typeof result.mode !== 'string' ||
      !['neural_engine_preferred', 'cpu_only'].includes(result.mode) ||
      typeof result.function !== 'string' ||
      !functions.includes(result.function) ||
      typeof result.passed !== 'boolean' ||
      seen.has(key)
    ) {
      return invalid();
    }
    seen.add(key);
    if (!result.passed) {
      failed += 1;
    }
    if (result.error != null) {
      text(result.error, 320);
      if (
        result.passed ||
        result.actualSHA256 != null ||
        result.rows != null ||
        result.maxULP != null
      ) {
        return invalid();
      }
    } else if (
      !hash(result.actualSHA256) ||
      !Array.isArray(result.rows) ||
      result.rows.length !== 8 ||
      !count(result.maxULP)
    ) {
      return invalid();
    }
  }
  if (failed !== parsed.summary.failed) {
    return invalid();
  }
  return parsed as RepairPrimitiveReport;
}

/** Restore only the bounded repair record; retain a returned diagnostic as its own report. */
export function parseSpecializationRepair(
  json: string,
): SpecializationRepairEvidence | null {
  if (json.length > 32_768 + 524_288 + 1024) {
    return invalid();
  }
  const decoded: unknown = JSON.parse(json);
  if (decoded === null) {
    return null;
  }
  const value = record(decoded);
  if (value.kind === 'assistSpecializationRepair') {
    if (json.length > 32_768) {
      return invalid();
    }
    return parseRepair(value);
  }
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'assistSpecializationRepairResult'
  ) {
    return invalid();
  }
  const repair = parseRepair(record(value.repair));
  if (repair.stage !== 'completed') {
    return invalid();
  }
  let diagnostic: SpecializationRepairResult['diagnostic'];
  if (repair.target === 'bundled_f16_neural_engine') {
    diagnostic = parseNumericDiagnostic(value.diagnostic);
    const raw = record(value.diagnostic);
    const assets = raw.assets as Record<string, unknown>[];
    if (
      !assets.some(
        asset =>
          asset.variant === 'f16_boundary' &&
          asset.fixtureAssetSHA256 === repair.sourceAssetSHA256,
      )
    ) {
      return invalid();
    }
  } else {
    const loaded = parseLoadProbeReport(JSON.stringify(value.diagnostic));
    if (
      !loaded ||
      loaded.modelName !== repair.modelName ||
      loaded.functionName !== 'extend_1024_8' ||
      !['completed', 'failed'].includes(loaded.stage)
    ) {
      return invalid();
    }
    diagnostic = loaded;
  }
  if (diagnostic.nativeBuild !== repair.nativeBuild) {
    return invalid();
  }
  return {
    schemaVersion: 1,
    kind: 'assistSpecializationRepairResult',
    repair,
    diagnostic,
  };
}

export function numericRepairCounts(report: RepairPrimitiveReport) {
  const nativeErrors = report.results.filter(
    result => result.error != null,
  ).length;
  const measured = report.results.filter(
    result => result.error == null && result.actualSHA256 != null,
  ).length;
  const numericalDeviations = report.results.filter(
    result =>
      result.error == null && result.actualSHA256 != null && !result.passed,
  ).length;
  return {
    nativeErrors,
    measured,
    numericalDeviations,
    allOutputsMeasured: measured === 48 && nativeErrors === 0,
  };
}
