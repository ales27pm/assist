import {
  assetProbeMeasurementMethods,
  parseAssetProbeReport,
} from '../src/assetProbe';

const report = {
  schemaVersion: 1,
  kind: 'assistModelAssetDiagnostic',
  scope: 'selected_f16_asset_identity_only_no_coreai',
  expectedModelName: 'gemma4-e2b-32k-group8-rmscomposite',
  contextCapacity: 32768,
  nativeBuild: '10',
  osVersion: 'iOS 27.2',
  attempt: {
    id: '9cde6700-1e52-4a3c-9b84-8a677eb4124a',
    startedAtUTC: '2026-10-16T17:00:00.123Z',
    processIdentifier: 21893,
    entryPoint: 'selected_f16_asset_identity_probe',
  },
  stage: 'checking_files',
  currentFileRole: 'bundle_metadata',
  files: [
    [
      'bundle_metadata',
      'metadata.json',
      1091,
      '2771755c5042bc9b400ff99c320b8689b32aa2751351fa5fa137df72208fa801',
    ],
    [
      'asset_metadata',
      'gemma4-e2b-32k-group8-rmscomposite.aimodel/metadata.json',
      406,
      '68bc28f74571f1617d9b888841d33351ebdb2f72be77294c255f520957ef92db',
    ],
    [
      'stored_main_hash',
      'gemma4-e2b-32k-group8-rmscomposite.aimodel/main.hash',
      32,
      'abbf299e92e76280e6e5ce0bde11b9cabc5ad75c6a5f94d979299d07d3b2cece',
    ],
    [
      'main_bytecode',
      'gemma4-e2b-32k-group8-rmscomposite.aimodel/main.mlirb',
      1381786497,
      'bd71bc0793677c4c4789b78109426b96afa2af7fc4df332f0c88695a43967362',
    ],
  ].map(([role, relativePath, expectedBytes, expectedSHA256]) => ({
    role,
    relativePath,
    expectedBytes,
    expectedSHA256,
    bytesRead: 0,
  })),
  measurementMethods: assetProbeMeasurementMethods,
};
const completed = {
  ...report,
  stage: 'completed',
  currentFileRole: undefined,
  storedMainHashMatches: true,
  files: report.files.map(file => ({
    ...file,
    bytesRead: file.expectedBytes,
    sha256: file.expectedSHA256,
    matchesExpected: true,
  })),
};

test('restores pending markers and requires all four hashes for completion', () => {
  expect(parseAssetProbeReport('null')).toBeNull();
  expect(parseAssetProbeReport(JSON.stringify(report))).toEqual(report);
  expect(parseAssetProbeReport(JSON.stringify(completed))).toEqual(completed);
});

test.each(['E_ASSET_IDENTITY_IO', 'E_ASSET_IDENTITY_CHANGED'])(
  'preserves a partial read with safe failure %s',
  errorCode => {
    const failed = {
      ...report,
      stage: 'failed',
      errorCode,
      currentFileRole: 'main_bytecode',
      files: [
        ...completed.files.slice(0, 3),
        { ...report.files[3], bytesRead: 65536 },
      ],
    };
    expect(parseAssetProbeReport(JSON.stringify(failed))).toEqual(failed);
  },
);

test('retains actual mismatch evidence without converting it to a match', () => {
  const failed = {
    ...completed,
    stage: 'failed',
    currentFileRole: 'main_bytecode',
    errorCode: 'E_ASSET_IDENTITY_MISMATCH',
    storedMainHashMatches: false,
    files: [
      ...completed.files.slice(0, 3),
      {
        ...completed.files[3],
        sha256: '0'.repeat(64),
        matchesExpected: false,
      },
    ],
  };
  expect(parseAssetProbeReport(JSON.stringify(failed))).toEqual(failed);
});

test.each(['E_ASSET_IDENTITY_LOCAL_ONLY', 'E_ASSET_IDENTITY_MISMATCH'])(
  'accepts an early failure without inventing hashes: %s',
  errorCode => {
    const failed = { ...report, stage: 'failed', errorCode };
    expect(parseAssetProbeReport(JSON.stringify(failed))).toEqual(failed);
  },
);

test.each([
  { stage: ['checking_files'] },
  { schemaVersion: 2 },
  { kind: 'assistModelLoadDiagnostic' },
  { scope: 'generation_qualified' },
  { expectedModelName: 'gemma4-e2b-32k-group8-rms-fp32io' },
  { contextCapacity: 8192 },
  { stage: 'passed' },
  { nativeBuild: '\n10' },
  { osVersion: 'x'.repeat(161) },
  { attempt: undefined },
  { attempt: { ...report.attempt, id: 'not-a-uuid' } },
  { attempt: { ...report.attempt, startedAtUTC: '2026-02-30T00:00:00.000Z' } },
  { attempt: { ...report.attempt, processIdentifier: 1.5 } },
  { attempt: { ...report.attempt, processIdentifier: 2147483648 } },
  { attempt: { ...report.attempt, entryPoint: 'normal_load' } },
  { files: [] },
  { files: [...report.files, report.files[0]] },
  { files: [...report.files].reverse() },
  { currentFileRole: 'tokenizer' },
  { currentFileRole: undefined },
  { storedMainHashMatches: true },
  { errorCode: 'E_ASSET_IDENTITY_IO' },
  { stage: 'failed' },
  { stage: 'failed', errorCode: '/private/model' },
])('rejects malformed identity or stage evidence, case %#', change => {
  expect(() =>
    parseAssetProbeReport(JSON.stringify({ ...report, ...change })),
  ).toThrow();
});

test.each([
  { role: 'tokenizer' },
  { relativePath: '/private/model' },
  { relativePath: '../metadata.json' },
  { expectedBytes: 1092 },
  { expectedSHA256: '0'.repeat(64) },
  { bytesRead: -1 },
  { bytesRead: 0.5 },
  { bytesRead: 1091 + 65537 },
  { sha256: '0'.repeat(64) },
  { matchesExpected: true },
  { sha256: 'invalid', matchesExpected: false },
  { sha256: '0'.repeat(64), matchesExpected: true },
  { sha256: '0'.repeat(64), matchesExpected: false, bytesRead: 0 },
  {
    sha256: report.files[0].expectedSHA256,
    matchesExpected: true,
    bytesRead: 0,
  },
])('rejects misleading file measurements, case %#', change => {
  expect(() =>
    parseAssetProbeReport(
      JSON.stringify({
        ...report,
        files: [{ ...report.files[0], ...change }, ...report.files.slice(1)],
      }),
    ),
  ).toThrow();
});

test.each([
  { currentFileRole: 'main_bytecode' },
  { storedMainHashMatches: undefined },
  { storedMainHashMatches: false },
  { errorCode: 'E_ASSET_IDENTITY_MISMATCH' },
  { files: report.files },
  {
    files: [
      { ...completed.files[0], matchesExpected: false },
      ...completed.files.slice(1),
    ],
  },
])('rejects unsupported completion claims, case %#', change => {
  expect(() =>
    parseAssetProbeReport(JSON.stringify({ ...completed, ...change })),
  ).toThrow();
});

test('strips unknown fields before sharing and bounds the entire input', () => {
  expect(
    parseAssetProbeReport(
      JSON.stringify({
        ...completed,
        path: '/private/model',
        prompt: 'private text',
        attempt: { ...report.attempt, deviceID: 'private device' },
        files: completed.files.map(file => ({
          ...file,
          fileContents: 'private',
        })),
        measurementMethods: {
          ...assetProbeMeasurementMethods,
          unknown: 'private context',
        },
      }),
    ),
  ).toEqual(completed);
  expect(() => parseAssetProbeReport(' '.repeat(32769))).toThrow(/volumineux/);
  expect(() =>
    parseAssetProbeReport(
      JSON.stringify({
        ...report,
        unknown: 'é'.repeat(16000),
      }),
    ),
  ).toThrow(/volumineux/);
  expect(() =>
    parseAssetProbeReport(
      JSON.stringify({
        ...report,
        measurementMethods: {
          ...assetProbeMeasurementMethods,
          unverified: undefined,
        },
      }),
    ),
  ).toThrow();
  expect(() =>
    parseAssetProbeReport(
      JSON.stringify({
        ...report,
        measurementMethods: {
          ...assetProbeMeasurementMethods,
          scope: 'Generation validated',
        },
      }),
    ),
  ).toThrow();
});

test('preserves only bounded recorded POSIX numbers for IO and changed failures', () => {
  for (const errorCode of ['E_ASSET_IDENTITY_IO', 'E_ASSET_IDENTITY_CHANGED']) {
    const failed = { ...report, stage: 'failed', errorCode, posixErrno: 13 };
    expect(parseAssetProbeReport(JSON.stringify(failed))).toEqual(failed);
  }
  for (const posixErrno of [0, -1, 1.5, 4096, '13', null]) {
    expect(() =>
      parseAssetProbeReport(
        JSON.stringify({
          ...report,
          stage: 'failed',
          errorCode: 'E_ASSET_IDENTITY_IO',
          posixErrno,
        }),
      ),
    ).toThrow();
  }
  expect(() =>
    parseAssetProbeReport(
      JSON.stringify({
        ...report,
        stage: 'failed',
        errorCode: 'E_ASSET_IDENTITY_MISMATCH',
        posixErrno: 13,
      }),
    ),
  ).toThrow();
  expect(() =>
    parseAssetProbeReport(
      JSON.stringify({
        ...completed,
        posixErrno: 13,
      }),
    ),
  ).toThrow();
});

test('rejects skipped or future file observations in a pending marker', () => {
  expect(() =>
    parseAssetProbeReport(
      JSON.stringify({
        ...report,
        currentFileRole: 'main_bytecode',
      }),
    ),
  ).toThrow();
  expect(() =>
    parseAssetProbeReport(
      JSON.stringify({
        ...report,
        files: [
          report.files[0],
          { ...report.files[1], bytesRead: 1 },
          ...report.files.slice(2),
        ],
      }),
    ),
  ).toThrow();
  expect(() =>
    parseAssetProbeReport(
      JSON.stringify({
        ...completed,
        stage: 'checking_files',
        currentFileRole: 'main_bytecode',
      }),
    ),
  ).toThrow();
});
