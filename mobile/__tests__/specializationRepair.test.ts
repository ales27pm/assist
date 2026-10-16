import {
  numericRepairCounts,
  parseSpecializationRepair,
  repairTargets,
  specializationRepairMeasurementMethods,
  RepairPrimitiveReport,
} from '../src/specializationRepair';

const repair = {
  schemaVersion: 1,
  kind: 'assistSpecializationRepair',
  scope: 'single_model_neural_engine_cache_entry',
  target: 'bundled_f16_neural_engine',
  ...repairTargets.bundled_f16_neural_engine,
  computePreference: 'neural_engine_preferred',
  nativeBuild: '11',
  osVersion: 'iOS 27.2',
  attempt: {
    id: '9cde6700-1e52-4a3c-9b84-8a677eb4124a',
    startedAtUTC: '2026-10-16T17:00:00.123Z',
    processIdentifier: 22290,
    entryPoint: 'manual_single_entry_repair',
  },
  stage: 'completed',
  steps: [
    'verifying_source',
    'invalidating_entry',
    'entry_invalidated',
    'qualifying',
    'completed',
  ].map((stage, elapsedMs) => ({ stage, elapsedMs })),
  measurementMethods: specializationRepairMeasurementMethods,
};
const numeric = {
  schemaVersion: 2,
  kind: 'assistPrimitiveQualification',
  scope: 'primitive_only_gemma_unqualified',
  aneExecution: 'unverified',
  nativeBuild: '11',
  assets: [
    {
      variant: 'f16_boundary',
      fixtureAssetSHA256:
        repairTargets.bundled_f16_neural_engine.sourceAssetSHA256,
      manifestSHA256: 'a'.repeat(64),
    },
    {
      variant: 'f32_boundary',
      fixtureAssetSHA256: 'b'.repeat(64),
      manifestSHA256: 'c'.repeat(64),
    },
  ],
  results: ['f16_boundary', 'f32_boundary'].flatMap(variant =>
    ['neural_engine_preferred', 'cpu_only'].flatMap(mode =>
      ['256_8', '256_1', '512_8', '512_1', '1536_1', '256_35'].flatMap(shape =>
        ['weighted', 'ones'].map(weight => ({
          variant,
          mode,
          function: `rms_q8_${shape}_${weight}`,
          passed: true,
          actualSHA256: 'd'.repeat(64),
          maxULP: 0,
          rows: Array.from({ length: 8 }, (_, query) => ({ query })),
        })),
      ),
    ),
  ),
  summary: { cases: 48, failed: 0, nonfinite: 0, maxULP: 0 },
  runtimeMonitoring: {
    kind: 'assistRuntimeMonitoring',
    measurementMethods: { sampling: 'original' },
  },
};
const wrapper = {
  schemaVersion: 1,
  kind: 'assistSpecializationRepairResult',
  repair,
  diagnostic: numeric,
};
function parse(value: unknown) {
  return parseSpecializationRepair(JSON.stringify(value));
}

test('restores pending and failed markers without claiming qualification', () => {
  expect(parseSpecializationRepair('null')).toBeNull();
  const pending = {
    ...repair,
    stage: 'invalidating_entry',
    steps: repair.steps.slice(0, 2),
  };
  expect(parse(pending)).toEqual(pending);
  const failed = {
    ...pending,
    stage: 'failed',
    steps: [...pending.steps, { stage: 'failed', elapsedMs: 3 }],
    errorCode: 'E_SPECIALIZATION_REPAIR_INVALIDATION_FAILED',
    nativeErrors: [
      {
        domain: 'NSCocoaErrorDomain',
        code: -1,
        swiftType: 'Foundation.NSError',
      },
    ],
  };
  expect(parse(failed)).toEqual(failed);
});

test('retains the original numerical diagnostic and monitoring without conflating native errors and deviations', () => {
  expect(parse(wrapper)).toEqual(wrapper);
  const failedNative = {
    ...numeric,
    results: numeric.results.map((result, index) =>
      index < 12
        ? {
            ...result,
            passed: false,
            error: 'Foundation._GenericObjCError error 0.',
            actualSHA256: undefined,
            rows: undefined,
            maxULP: undefined,
          }
        : result,
    ),
    summary: { ...numeric.summary, failed: 12 },
  };
  const failedWrapper = parse({ ...wrapper, diagnostic: failedNative });
  expect(failedWrapper?.kind).toBe('assistSpecializationRepairResult');
  if (failedWrapper?.kind !== 'assistSpecializationRepairResult') {
    throw new Error('Expected wrapper');
  }
  expect(
    numericRepairCounts(failedWrapper.diagnostic as RepairPrimitiveReport),
  ).toEqual({
    nativeErrors: 12,
    measured: 36,
    numericalDeviations: 0,
    allOutputsMeasured: false,
  });
  const deviations = {
    ...numeric,
    results: numeric.results.map((result, index) => ({
      ...result,
      passed: index >= 12,
    })),
    summary: { ...numeric.summary, failed: 12 },
  };
  const deviatingWrapper = parse({ ...wrapper, diagnostic: deviations });
  if (deviatingWrapper?.kind !== 'assistSpecializationRepairResult') {
    throw new Error('Expected wrapper');
  }
  expect(
    numericRepairCounts(deviatingWrapper.diagnostic as RepairPrimitiveReport),
  ).toEqual({
    nativeErrors: 0,
    measured: 48,
    numericalDeviations: 12,
    allOutputsMeasured: true,
  });
});

test('retains a returned Gemma load failure separately from repair completion', () => {
  const result = {
    ...wrapper,
    repair: {
      ...repair,
      target: 'selected_f16_neural_engine',
      ...repairTargets.selected_f16_neural_engine,
    },
    diagnostic: {
      schemaVersion: 1,
      kind: 'assistModelLoadDiagnostic',
      scope: 'single_function_load_only_no_generation',
      aneExecution: 'unverified',
      nativeBuild: '11',
      osVersion: 'iOS 27.2',
      modelName: repairTargets.selected_f16_neural_engine.modelName,
      contextCapacity: 32768,
      functionName: 'extend_1024_8',
      stage: 'failed',
      errorCode: 'E_FUNCTION_LOAD_FAILED',
      samples: [
        { stage: 'before_prepare', elapsedMs: 0, thermalState: 'nominal' },
        {
          stage: 'before_function_load',
          elapsedMs: 1,
          thermalState: 'nominal',
        },
        { stage: 'failed', elapsedMs: 2, thermalState: 'nominal' },
      ],
      measurementMethods: { cache: 'Original single function diagnostic.' },
    },
  };
  expect(parse(result)).toEqual(result);
  expect(() =>
    parse({
      ...result,
      diagnostic: { ...result.diagnostic, functionName: 'extend_8192_8' },
    }),
  ).toThrow();
});

test.each([
  { ...repair, target: ['bundled_f16_neural_engine'] },
  { ...repair, sourceAssetSHA256: '0'.repeat(64) },
  { ...repair, modelName: 'another-model' },
  { ...repair, computePreference: 'cpu_only' },
  { ...repair, stage: ['completed'] },
  { ...repair, steps: [...repair.steps, { stage: 'completed', elapsedMs: 8 }] },
  {
    ...repair,
    steps: repair.steps.map((step, index) => ({
      ...step,
      elapsedMs: index === 3 ? -1 : index,
    })),
  },
  {
    ...repair,
    stage: 'failed',
    errorCode: 'E_SPECIALIZATION_REPAIR_SOURCE_FAILED',
  },
  { ...repair, errorCode: 'E_SPECIALIZATION_REPAIR_SOURCE_FAILED' },
  {
    ...repair,
    attempt: { ...repair.attempt, startedAtUTC: '2026-02-31T17:00:00.123Z' },
  },
  {
    ...repair,
    nativeErrors: [{ domain: '/private/file', swiftType: 'NSError' }],
  },
])(
  'rejects malformed or mismatched repair identity and transitions %#',
  value => {
    expect(() => parse(value)).toThrow();
  },
);

test.each([
  { ...wrapper, repair: { ...repair, nativeBuild: '12' } },
  {
    ...wrapper,
    repair: { ...repair, stage: 'qualifying', steps: repair.steps.slice(0, 4) },
  },
  { ...wrapper, diagnostic: { ...numeric, results: numeric.results.slice(1) } },
  {
    ...wrapper,
    diagnostic: {
      ...numeric,
      results: [numeric.results[0], ...numeric.results.slice(0, -1)],
    },
  },
  {
    ...wrapper,
    diagnostic: {
      ...numeric,
      results: numeric.results.map((result, index) =>
        index === 0 ? { ...result, variant: ['f16_boundary'] } : result,
      ),
    },
  },
  {
    ...wrapper,
    diagnostic: {
      ...numeric,
      results: numeric.results.map((result, index) =>
        index === 0 ? { ...result, error: 'error' } : result,
      ),
    },
  },
  {
    ...wrapper,
    diagnostic: { ...numeric, summary: { ...numeric.summary, failed: 1 } },
  },
])('rejects inconsistent follow-up qualifications %#', value => {
  expect(() => parse(value)).toThrow();
});

test('strips unknown fields from the small persisted repair record', () => {
  expect(
    parse({
      ...repair,
      privatePath: '/private/source',
      attempt: { ...repair.attempt, path: '/private/attempt' },
    }),
  ).toEqual(repair);
});
