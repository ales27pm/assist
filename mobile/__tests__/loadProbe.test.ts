import { loadProbeFunctions, parseLoadProbeReport } from '../src/loadProbe';

const report = {
  schemaVersion: 1,
  kind: 'assistModelLoadDiagnostic',
  scope: 'single_function_load_only_no_generation',
  aneExecution: 'unverified',
  nativeBuild: '8',
  osVersion: 'iOS 27.2',
  modelName: 'gemma4-e2b-32k-group8-rms-fp32io',
  contextCapacity: 32768,
  functionName: 'extend_1024_8',
  stage: 'loading_function',
  samples: [
    { stage: 'before_prepare', elapsedMs: 0, thermalState: 'nominal' },
    {
      stage: 'before_function_load',
      elapsedMs: 50,
      thermalState: 'nominal',
      availableMemoryBytes: 1024,
    },
  ],
  measurementMethods: { cacheState: 'Not measured; existing cache untouched.' },
};

test('accepts an incomplete persisted marker without upgrading it to completion', () => {
  expect(parseLoadProbeReport(JSON.stringify(report))).toEqual(report);
  expect(parseLoadProbeReport('null')).toBeNull();
});

test('accepts a saved native error with its bounded code and matching stages', () => {
  const failure = {
    ...report,
    stage: 'failed',
    errorCode: 'E_FUNCTION_LOAD_FAILED',
    samples: [
      ...report.samples,
      { stage: 'failed', elapsedMs: 80, thermalState: 'nominal' },
    ],
  };
  expect(parseLoadProbeReport(JSON.stringify(failure))).toEqual(failure);
});

test.each(loadProbeFunctions)(
  'allows only the specified full-bundle function: %s',
  functionName => {
    expect(
      parseLoadProbeReport(JSON.stringify({ ...report, functionName }))
        ?.functionName,
    ).toBe(functionName);
  },
);

test.each([
  { contextCapacity: 8192 },
  { functionName: '../other-model' },
  { functionName: 'extend_32768_64' },
  { scope: 'generation_qualified' },
  { aneExecution: 'verified' },
  { stage: 'completed' },
  { samples: [report.samples[1]] },
  {
    stage: 'failed',
    samples: [
      report.samples[0],
      { stage: 'failed', elapsedMs: 1, thermalState: 'nominal' },
    ],
  },
  {
    samples: [{ ...report.samples[0], thermalState: 'hot' }, report.samples[1]],
  },
  { modelName: '/private/model' },
  { samples: [] },
  { samples: Array(5).fill(report.samples[0]) },
  {
    samples: [
      { stage: 'before_function_load', elapsedMs: -1, thermalState: 'nominal' },
    ],
  },
  {
    samples: [
      {
        stage: 'before_function_load',
        elapsedMs: null,
        thermalState: 'nominal',
      },
    ],
  },
  {
    samples: [
      {
        stage: 'before_function_load',
        elapsedMs: 1,
        thermalState: 'nominal',
        availableMemoryBytes: 1.5,
      },
    ],
  },
  { samples: [report.samples[1], { ...report.samples[1], elapsedMs: 0 }] },
  { errorCode: '/private/error' },
])('rejects malformed or misleading loading evidence %j', change => {
  expect(() =>
    parseLoadProbeReport(JSON.stringify({ ...report, ...change })),
  ).toThrow();
});

test('removes undeclared fields before sharing and bounds the input', () => {
  const parsed = parseLoadProbeReport(
    JSON.stringify({ ...report, path: '/private/model', prompt: 'private' }),
  );
  expect(parsed).toEqual(report);
  expect(() => parseLoadProbeReport(' '.repeat(32769))).toThrow(/volumineux/);
});
