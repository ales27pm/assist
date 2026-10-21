import {
  debugCategories,
  debugCategoryLabels,
  debugFindingCodes,
  debugFindingLabels,
  parseDebugDiagnosticsBundle,
  parseDebugDiagnosticsStatus,
} from '../src/debugDiagnostics';

const sessionId = '11111111-1111-4111-8111-111111111111';
function event(sequence = 1) {
  return {
    sequence,
    elapsedMs: 0.25,
    traceId: 't1',
    category: 'planning',
    stage: 'roots',
    outcome: 'rejected',
    reason: 'json',
    field: 'roots',
    metrics: { durationMs: 1.25, generatedTokens: 2 },
  };
}
function status() {
  return {
    schemaVersion: 1,
    kind: 'assistDebugStatus',
    sessionId,
    revision: 0,
    mode: 'standard',
    detailExpiresAt: null,
    recordCount: 1,
    omittedRecords: 0,
    rejectedRecords: 0,
    previousSessionCount: 0,
    persistence: 'saved',
    records: [event()],
    findings: [
      {
        code: 'preparationRejected',
        severity: 'warning',
        evidence: 'observed',
        sequence: 1,
        traceId: 't1',
      },
    ],
    coverage: debugCategories.map(category => ({ category, state: 'partial' })),
    limits: {
      maxRecords: 512,
      maxSessionBytes: 262144,
      maxPreviousSessions: 2,
      detailedSeconds: 900,
    },
    privacy: { contentCaptured: false, automaticUpload: false },
  };
}
function session(id = sessionId) {
  return {
    schemaVersion: 1,
    kind: 'assistDebugSession',
    sessionId: id,
    nativeBuild: '30',
    osVersion: 'Version 27.2 (Build 24B5110a)',
    startedAt: '2026-10-20T23:00:00Z',
    capturedAt: '2026-10-20T23:01:00Z',
    records: [event()],
    omittedRecords: 0,
    rejectedRecords: 0,
  };
}
function bundle() {
  return {
    schemaVersion: 1,
    kind: 'assistDebugBundle',
    exportedAt: '2026-10-20T23:01:01Z',
    status: status(),
    current: session(),
    previous: [] as ReturnType<typeof session>[],
  };
}
function rejected(value: unknown) {
  expect(() => parseDebugDiagnosticsStatus(JSON.stringify(value))).toThrow(
    'Diagnostic avancé invalide ou incompatible.',
  );
}

test('reconstructs the closed status and bundle, preserving unknown outcomes and measured zero', () => {
  const value = status();
  expect(parseDebugDiagnosticsStatus(JSON.stringify(value))).toEqual(value);
  const output = bundle();
  output.previous = [
    session('22222222-2222-4222-8222-222222222222'),
    session('33333333-3333-4333-8333-333333333333'),
  ];
  output.status.previousSessionCount = 2;
  expect(parseDebugDiagnosticsBundle(JSON.stringify(output))).toEqual(output);
});

test('has explicit French labels for all 16 categories and every closed finding', () => {
  expect(debugCategories).toHaveLength(16);
  for (const category of debugCategories)
    expect(debugCategoryLabels[category].length).toBeGreaterThan(0);
  for (const code of debugFindingCodes)
    expect(debugFindingLabels[code].length).toBeGreaterThan(0);
});

test.each<Record<string, unknown>>([
  {
    arguments: {
      query: 'SYNTHETIC_PRIVATE',
      url: 'https://example.invalid/private',
    },
  },
  { records: [{ ...event(), payload: 'SYNTHETIC_PRIVATE' }] },
  { records: [{ ...event(), metrics: { prompt: 'SYNTHETIC_PRIVATE' } }] },
  { findings: [{ ...status().findings[0], message: 'SYNTHETIC_PRIVATE' }] },
  {
    coverage: status().coverage.map((entry, index) =>
      index ? entry : { ...entry, path: '/SYNTHETIC/PRIVATE' },
    ),
  },
  { limits: { ...status().limits, url: 'https://example.invalid' } },
  { privacy: { ...status().privacy, secret: 'SYNTHETIC_PRIVATE' } },
  { constructor: 'SYNTHETIC_PRIVATE' },
])('rejects unknown fields at every status boundary %#', extra =>
  rejected({ ...status(), ...extra }),
);

test.each([
  { mode: 'verbose' },
  { mode: 'detailed' },
  { detailExpiresAt: '2026-10-20T23:15:00Z' },
  { schemaVersion: 2 },
  { kind: 'assistRuntimeMonitoring' },
  { revision: -1 },
  { revision: 0.5 },
  { recordCount: 513 },
  { recordCount: 0 },
  { omittedRecords: Number.MAX_SAFE_INTEGER + 1 },
  { rejectedRecords: -1 },
  { previousSessionCount: 3 },
  { persistence: 'healthy' },
  { sessionId: '/SYNTHETIC/PRIVATE/PATH' },
  { sessionId: 'request-1-1' },
  { privacy: { contentCaptured: true, automaticUpload: false } },
  { limits: { ...status().limits, detailedSeconds: 901 } },
  { records: Array.from({ length: 31 }, (_, index) => event(index + 1)) },
  { findings: Array(33).fill(status().findings[0]) },
  { coverage: status().coverage.slice(1) },
  {
    coverage: status().coverage.map(() => ({
      category: 'engine',
      state: 'partial',
    })),
  },
  {
    coverage: status().coverage.map(entry => ({
      ...entry,
      state: 'qualified',
    })),
  },
])('rejects incompatible status or bounds %#', extra =>
  rejected({ ...status(), ...extra }),
);

test.each([
  { sequence: 0 },
  { sequence: 1.5 },
  { elapsedMs: -1 },
  { elapsedMs: Number.MAX_SAFE_INTEGER + 1 },
  { traceId: 't0' },
  { traceId: 't01' },
  { traceId: 't2147483648' },
  { traceId: 'request-1-1' },
  { category: 'SYNTHETIC_PRIVATE' },
  { stage: 'raw output' },
  { outcome: 'success' },
  { reason: 'SYNTHETIC_PRIVATE' },
  { field: '/SYNTHETIC/PRIVATE' },
  { metrics: { cpuPercent: -1 } },
  { metrics: { durationMs: null } },
  { metrics: { tokenIDs: [1, 2] } },
  { metrics: { durationMs: Number.MAX_SAFE_INTEGER + 1 } },
])('rejects malformed records, correlation or metrics %#', extra =>
  rejected({ ...status(), records: [{ ...event(), ...extra }] }),
);

test.each([
  { code: 'arbitrary' },
  { severity: 'healthy' },
  { evidence: 'proven' },
  { sequence: 0 },
  { traceId: 'https://example.invalid' },
])('rejects malformed finding %#', extra =>
  rejected({ ...status(), findings: [{ ...status().findings[0], ...extra }] }),
);

test('accepts detailed expiry from the native clock without making a JS wall-clock decision', () => {
  const value = {
    ...status(),
    mode: 'detailed',
    detailExpiresAt: '2020-01-01T00:00:00Z',
  };
  expect(parseDebugDiagnosticsStatus(JSON.stringify(value)).mode).toBe(
    'detailed',
  );
  rejected({ ...value, detailExpiresAt: '2026-02-30T12:00:00Z' });
});

test('rejects duplicate or reversed sequences, nonfinite JSON and unknown nested objects', () => {
  rejected({ ...status(), recordCount: 2, records: [event(), event()] });
  rejected({ ...status(), recordCount: 2, records: [event(2), event(1)] });
  const json = JSON.stringify(status()).replace('0.25', '1e999');
  expect(() => parseDebugDiagnosticsStatus(json)).toThrow();
  expect(() => parseDebugDiagnosticsStatus('null')).toThrow();
  expect(() => parseDebugDiagnosticsStatus('{')).toThrow();
});

test.each([
  (value: ReturnType<typeof bundle>) => ({
    ...value,
    url: 'https://example.invalid',
  }),
  (value: ReturnType<typeof bundle>) => ({
    ...value,
    current: { ...value.current, error: 'SYNTHETIC_PRIVATE' },
  }),
  (value: ReturnType<typeof bundle>) => ({
    ...value,
    current: { ...value.current, nativeBuild: '/private/build' },
  }),
  (value: ReturnType<typeof bundle>) => ({
    ...value,
    current: { ...value.current, osVersion: 'https://example.invalid' },
  }),
  (value: ReturnType<typeof bundle>) => ({
    ...value,
    current: { ...value.current, startedAt: '2026-02-30T00:00:00Z' },
  }),
  (value: ReturnType<typeof bundle>) => ({
    ...value,
    current: {
      ...value.current,
      sessionId: '22222222-2222-4222-8222-222222222222',
    },
  }),
  (value: ReturnType<typeof bundle>) => ({
    ...value,
    status: { ...value.status, recordCount: 2 },
  }),
  (value: ReturnType<typeof bundle>) => ({
    ...value,
    status: {
      ...value.status,
      records: [{ ...event(), outcome: 'completed' }],
    },
  }),
  (value: ReturnType<typeof bundle>) => ({ ...value, previous: [session()] }),
  (value: ReturnType<typeof bundle>) => ({
    ...value,
    status: { ...value.status, previousSessionCount: 2 },
    previous: [
      session('22222222-2222-4222-8222-222222222222'),
      session('22222222-2222-4222-8222-222222222222'),
    ],
  }),
  (value: ReturnType<typeof bundle>) => ({
    ...value,
    previous: [session(), session(), session()],
  }),
  (value: ReturnType<typeof bundle>) => ({
    ...value,
    previous: [
      { ...session('22222222-2222-4222-8222-222222222222'), arguments: {} },
    ],
  }),
])('rejects unsafe or mismatched export bundle %#', mutate => {
  expect(() =>
    parseDebugDiagnosticsBundle(JSON.stringify(mutate(bundle()))),
  ).toThrow();
});

test('reconstructs metrics in a canonical order rather than requiring JSON key order equality', () => {
  const value = bundle();
  value.current.records[0].metrics = { generatedTokens: 2, durationMs: 1.25 };
  expect(
    parseDebugDiagnosticsBundle(JSON.stringify(value)).current.records,
  ).toEqual(value.status.records);
});

test('rejects a session larger than 256 KiB even when the record count is bounded', () => {
  const value = bundle();
  const metrics = Object.fromEntries(
    [
      'durationMs',
      'inputBytes',
      'outputBytes',
      'promptTokens',
      'generatedTokens',
      'budgetTokens',
      'contextCapacity',
      'messageCount',
      'passIndex',
      'branchIndex',
      'fieldBytes',
      'limitBytes',
      'itemCount',
      'pendingOperations',
      'physicalFootprintBytes',
      'availableMemoryBytes',
      'cpuPercent',
      'signal',
      'exceptionType',
      'reportCount',
      'hangDurationMs',
    ].map(key => [key, Number.MAX_SAFE_INTEGER]),
  );
  const many = Array.from({ length: 512 }, (_, index) => ({
    ...event(index + 1),
    metrics,
  }));
  const oversized = { ...value, current: { ...value.current, records: many } };
  expect(JSON.stringify(oversized.current).length).toBeGreaterThan(262144);
  expect(() =>
    parseDebugDiagnosticsBundle(JSON.stringify(oversized)),
  ).toThrow();
});
