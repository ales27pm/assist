export const loadProbeFunctions = [
  'extend_1024_8',
  'extend_32768_8',
  'extend_8192_8',
  'prompt_opt_1024_64',
  'prompt_opt_32768_64',
  'prompt_opt_8192_64',
] as const;

export type LoadProbeFunction = (typeof loadProbeFunctions)[number];
type ProbeStage =
  | 'preparing_model'
  | 'loading_function'
  | 'completed'
  | 'failed';
type SampleStage =
  | 'before_prepare'
  | 'before_function_load'
  | 'after_function_load'
  | 'failed';
export type LoadProbeSample = {
  stage: SampleStage;
  elapsedMs: number;
  thermalState: string;
  lowPowerMode?: boolean;
  physicalFootprintBytes?: number;
  availableMemoryBytes?: number;
  metalCurrentAllocatedBytes?: number;
  metalMaxBufferLengthBytes?: number;
  metalRecommendedWorkingSetBytes?: number;
};
export type LoadProbeReport = {
  schemaVersion: 1 | 2;
  kind: 'assistModelLoadDiagnostic';
  scope: 'single_function_load_only_no_generation';
  aneExecution: 'unverified';
  nativeBuild: string;
  osVersion: string;
  modelName: string;
  contextCapacity: 32768;
  functionName: LoadProbeFunction;
  stage: ProbeStage;
  samples: LoadProbeSample[];
  attempt?: {
    id: string;
    startedAtUTC: string;
    processIdentifier: number;
    entryPoint: 'single_function_load_probe';
  };
  errorCode?: string;
  nativeErrors?: { domain: string; code?: number; swiftType: string }[];
  measurementMethods: Record<string, string>;
};

const byteFields = [
  'physicalFootprintBytes',
  'availableMemoryBytes',
  'metalCurrentAllocatedBytes',
  'metalMaxBufferLengthBytes',
  'metalRecommendedWorkingSetBytes',
] as const;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Diagnostic de chargement invalide.');
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.length || value.length > maximum) {
    throw new Error('Diagnostic de chargement invalide.');
  }
  return value;
}

/** A saved pre-call marker is evidence of the last stage, not a crash detector. */
export function parseLoadProbeReport(json: string): LoadProbeReport | null {
  if (json.length > 32_768) {
    throw new Error('Diagnostic de chargement trop volumineux.');
  }
  const decoded: unknown = JSON.parse(json);
  if (decoded === null) {
    return null;
  }
  const value = record(decoded);
  const expectedLastStage: Record<ProbeStage, SampleStage> = {
    preparing_model: 'before_prepare',
    loading_function: 'before_function_load',
    completed: 'after_function_load',
    failed: 'failed',
  };
  if (
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    value.kind !== 'assistModelLoadDiagnostic' ||
    value.scope !== 'single_function_load_only_no_generation' ||
    value.aneExecution !== 'unverified' ||
    value.contextCapacity !== 32768 ||
    !loadProbeFunctions.includes(value.functionName as LoadProbeFunction) ||
    typeof value.stage !== 'string' ||
    !Object.prototype.hasOwnProperty.call(expectedLastStage, value.stage) ||
    !Array.isArray(value.samples) ||
    value.samples.length < 1 ||
    value.samples.length > 4
  ) {
    throw new Error('Diagnostic de chargement invalide.');
  }
  let previousElapsed = 0;
  const samples = value.samples.map(item => {
    const sample = record(item);
    if (
      ![
        'before_prepare',
        'before_function_load',
        'after_function_load',
        'failed',
      ].includes(String(sample.stage)) ||
      typeof sample.elapsedMs !== 'number' ||
      !Number.isFinite(sample.elapsedMs) ||
      sample.elapsedMs < previousElapsed
    ) {
      throw new Error('Mesure de chargement invalide.');
    }
    previousElapsed = sample.elapsedMs;
    const result: LoadProbeSample = {
      stage: sample.stage as SampleStage,
      elapsedMs: sample.elapsedMs,
      thermalState: text(sample.thermalState, 32),
    };
    if (
      !['nominal', 'fair', 'serious', 'critical', 'unknown'].includes(
        result.thermalState,
      )
    ) {
      throw new Error('État thermique invalide.');
    }
    for (const field of byteFields) {
      const amount = sample[field];
      if (amount != null) {
        if (
          typeof amount !== 'number' ||
          !Number.isSafeInteger(amount) ||
          amount < 0
        ) {
          throw new Error('Mesure mémoire invalide.');
        }
        result[field] = amount;
      }
    }
    if (sample.lowPowerMode != null) {
      if (typeof sample.lowPowerMode !== 'boolean') {
        throw new Error('Mesure de chargement invalide.');
      }
      result.lowPowerMode = sample.lowPowerMode;
    }
    return result;
  });
  const stage = value.stage as ProbeStage;
  if (samples[samples.length - 1].stage !== expectedLastStage[stage]) {
    throw new Error('Étapes de chargement incohérentes.');
  }
  const sequences: Record<ProbeStage, SampleStage[][]> = {
    preparing_model: [['before_prepare']],
    loading_function: [['before_prepare', 'before_function_load']],
    completed: [
      ['before_prepare', 'before_function_load', 'after_function_load'],
    ],
    failed: [
      ['before_prepare', 'failed'],
      ['before_prepare', 'before_function_load', 'failed'],
    ],
  };
  if (
    !sequences[stage].some(
      sequence =>
        sequence.length === samples.length &&
        sequence.every((step, index) => step === samples[index].stage),
    )
  ) {
    throw new Error('Étapes de chargement incohérentes.');
  }
  const methods = record(value.measurementMethods);
  if (Object.keys(methods).length < 1 || Object.keys(methods).length > 16) {
    throw new Error('Méthodes de mesure invalides.');
  }
  const measurementMethods: Record<string, string> = {};
  for (const [key, method] of Object.entries(methods)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key)) {
      throw new Error('Méthodes de mesure invalides.');
    }
    measurementMethods[key] = text(method, 2048);
  }
  const modelName = text(value.modelName, 160);
  if (!/^[A-Za-z0-9._ -]+$/.test(modelName)) {
    throw new Error('Identité du modèle invalide.');
  }
  const result: LoadProbeReport = {
    schemaVersion: value.schemaVersion,
    kind: 'assistModelLoadDiagnostic',
    scope: 'single_function_load_only_no_generation',
    aneExecution: 'unverified',
    nativeBuild: text(value.nativeBuild, 32),
    osVersion: text(value.osVersion, 160),
    modelName,
    contextCapacity: 32768,
    functionName: value.functionName as LoadProbeFunction,
    stage,
    samples,
    measurementMethods,
  };
  if ((stage === 'failed') !== (value.errorCode != null)) {
    throw new Error('Résultat de chargement incohérent.');
  }
  if (value.errorCode != null) {
    const code = text(value.errorCode, 64);
    if (
      ![
        'E_MODEL_PREPARATION_FAILED',
        'E_FUNCTION_LOAD_FAILED',
        'E_FUNCTION_NOT_FOUND',
      ].includes(code)
    ) {
      throw new Error('Code de diagnostic invalide.');
    }
    result.errorCode = code;
  }
  if (value.schemaVersion === 1) {
    if (value.attempt != null || value.nativeErrors != null) {
      throw new Error('Version du diagnostic incohérente.');
    }
    return result;
  }
  const attempt = record(value.attempt);
  const id = text(attempt.id, 36);
  const startedAtUTC = text(attempt.startedAtUTC, 24);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(startedAtUTC) ||
    !Number.isFinite(Date.parse(startedAtUTC)) ||
    new Date(startedAtUTC).toISOString() !== startedAtUTC ||
    typeof attempt.processIdentifier !== 'number' ||
    !Number.isInteger(attempt.processIdentifier) ||
    attempt.processIdentifier <= 0 ||
    attempt.processIdentifier > 2_147_483_647 ||
    attempt.entryPoint !== 'single_function_load_probe'
  ) {
    throw new Error('Identité de l’essai invalide.');
  }
  result.attempt = {
    id,
    startedAtUTC,
    processIdentifier: attempt.processIdentifier,
    entryPoint: 'single_function_load_probe',
  };
  const threw = [
    'E_MODEL_PREPARATION_FAILED',
    'E_FUNCTION_LOAD_FAILED',
  ].includes(result.errorCode ?? '');
  if (threw !== (value.nativeErrors != null)) {
    throw new Error('Erreur native incohérente.');
  }
  if (value.nativeErrors != null) {
    if (
      !Array.isArray(value.nativeErrors) ||
      value.nativeErrors.length < 1 ||
      value.nativeErrors.length > 3
    ) {
      throw new Error('Erreur native invalide.');
    }
    result.nativeErrors = value.nativeErrors.map(item => {
      const native = record(item);
      const domain = text(native.domain, 160);
      const swiftType = text(native.swiftType, 160);
      if (
        !/^[A-Za-z0-9._]+$/.test(domain) ||
        !/^[A-Za-z0-9._]+$/.test(swiftType)
      ) {
        throw new Error('Identifiant d’erreur native invalide.');
      }
      const evidence: NonNullable<LoadProbeReport['nativeErrors']>[number] = {
        domain,
        swiftType,
      };
      if (native.code != null) {
        if (typeof native.code !== 'number' || !Number.isSafeInteger(native.code)) {
          throw new Error('Code d’erreur native invalide.');
        }
        evidence.code = native.code;
      }
      return evidence;
    });
  }
  return result;
}
