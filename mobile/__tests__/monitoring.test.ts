import { parseMonitoringSnapshot } from '../src/monitoring';

const sample = {
  phase: 'loading',
  sessionElapsedMs: 1000,
  thermalState: 'unknown',
  memoryPressure: 'unknown',
  lowPowerMode: false,
};

function report(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: 'assistRuntimeMonitoring',
    aneExecution: 'unverified',
    nativeBuild: '7',
    osVersion: 'iOS 27.2',
    measurementMethods: { memory: 'sampled physical footprint' },
    current: sample,
    history: [],
    events: [],
    diagnostic: null,
    ...extra,
  };
}

test('keeps unknown metrics unknown and accepts multicore process CPU', () => {
  const value = report({
    current: { ...sample, cpuPercent: 256.5, physicalFootprintBytes: null },
  });
  expect(parseMonitoringSnapshot(JSON.stringify(value))).toEqual(value);
});

test('retains additional native evidence and failed diagnostic counts for sharing', () => {
  const value = report({
    diagnostic: { completed: 48, total: 48, failed: 12 },
    generations: [
      {
        promptTokens: 32,
        generatedTokens: 11,
        generationElapsedMs: 700,
        finishReason: 'eos',
      },
    ],
    measurementMethods: { memory: 'sampled', decode: 'token intervals' },
    sourceRevision: 'measured-native-revision',
  });
  expect(parseMonitoringSnapshot(JSON.stringify(value))).toEqual(value);
});

test.each([
  { aneExecution: 'verified' },
  { current: { ...sample, phase: 'invented' } },
  { current: { ...sample, generatedTokens: -1 } },
  { current: { ...sample, generatedTokens: 1.5 } },
  { current: { ...sample, cpuPercent: -1 } },
  { current: { ...sample, ttftMs: 'unknown' } },
  { current: { ...sample, memoryPressure: 'low' } },
  { current: { ...sample, lowPowerMode: null } },
  { history: Array(61).fill(sample) },
  { events: Array(201).fill({}) },
  { generations: Array(101).fill({}) },
  { diagnostic: { completed: 10, total: 48, failed: 11 } },
  { diagnostic: { completed: 49, total: 48, failed: 0 } },
  { diagnostic: { completed: 1.5, total: 48, failed: 0 } },
  {
    events: [
      {
        sequence: 1,
        elapsedMs: 1,
        code: 'LOAD',
        severity: 'ok',
        phase: 'loading',
      },
    ],
  },
  { generations: [{ generatedTokens: -1 }] },
  { measurementMethods: { memory: 4 } },
])('rejects malformed native monitoring data %#', extra => {
  expect(() => parseMonitoringSnapshot(JSON.stringify(report(extra)))).toThrow(
    'Suivi natif invalide.',
  );
});

test('rejects nonfinite values before rendering or sharing', () => {
  const json = JSON.stringify(report()).replace(
    '"sessionElapsedMs":1000',
    '"sessionElapsedMs":1e999',
  );
  expect(() => parseMonitoringSnapshot(json)).toThrow('Suivi natif invalide.');
});

test.each(['prompt', 'text', 'messages', 'content', 'modelPath'])(
  'rejects inference content or paths in monitoring evidence: %s',
  key => {
    expect(() =>
      parseMonitoringSnapshot(
        JSON.stringify(report({ unexpectedEvidence: { [key]: 'private' } })),
      ),
    ).toThrow('Suivi natif invalide.');
  },
);
