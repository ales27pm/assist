import {
  outputBudget,
  parseProgress,
  parseResult,
  parsePrimitiveReport,
  parseState,
} from '../src/protocol';

test('primitive report preserves failures and extra evidence without qualifying Gemma', () => {
  const report = {
    schemaVersion: 1,
    kind: 'assistPrimitiveQualification',
    scope: 'primitive_only_gemma_unqualified',
    aneExecution: 'unverified',
    summary: { cases: 24, failed: 2, nonfinite: 1, maxULP: 7 },
    results: [{ error: 'One controlled native failure' }],
  };
  expect(parsePrimitiveReport(JSON.stringify(report))).toEqual(report);
  for (const invalid of [
    { ...report, aneExecution: 'verified' },
    { ...report, scope: 'gemma_qualified' },
    { ...report, summary: { ...report.summary, cases: 0 } },
    { ...report, summary: { ...report.summary, failed: 25 } },
    { ...report, summary: { ...report.summary, maxULP: -1 } },
  ]) {
    expect(() => parsePrimitiveReport(JSON.stringify(invalid))).toThrow();
  }
});
test('comparison report preserves both asset identities and the failing baseline', () => {
  const assets = ['f16_boundary', 'f32_boundary'].map((variant, index) => ({
    variant,
    fixtureAssetSHA256: String(index + 1).repeat(64),
    manifestSHA256: String(index + 3).repeat(64),
  }));
  const report = {
    schemaVersion: 2,
    kind: 'assistPrimitiveQualification',
    scope: 'primitive_only_gemma_unqualified',
    aneExecution: 'unverified',
    assets,
    summary: { cases: 48, failed: 12, nonfinite: 0, maxULP: 12 },
    results: [{ variant: 'f16_boundary', passed: false, maxULP: 12 }],
  };
  expect(parsePrimitiveReport(JSON.stringify(report))).toEqual(report);
  for (const invalid of [
    { ...report, assets: undefined },
    { ...report, assets: [assets[0], assets[0]] },
    { ...report, assets: [assets[0], { ...assets[1], variant: 'unknown' }] },
    { ...report, assets: [assets[0], { ...assets[1], fixtureAssetSHA256: 'bad' }] },
    { ...report, summary: { ...report.summary, cases: 24 } },
    { ...report, summary: { ...report.summary, failed: 49 } },
  ]) {
    expect(() => parsePrimitiveReport(JSON.stringify(invalid))).toThrow();
  }
});
test('no artificial output cap', () => {
  expect(outputBudget('')).toBeNull();
  expect(outputBudget(' ')).toBeNull();
  expect(outputBudget('1024')).toBe(1024);
  expect(outputBudget('32768')).toBe(32768);
});
test.each(['0', '-1', 'NaN', '1.2', '1e3', 'Infinity', '9007199254740992'])(
  'rejects invalid budget %s',
  value => {
    expect(() => outputBudget(value)).toThrow();
  },
);
test('preserves detected capacity rather than replacing it with 32K target', () => {
  expect(
    parseState('{"phase":"ready","contextCapacity":8192}').contextCapacity,
  ).toBe(8192);
});
test('accepts native bundled-model availability without inferring it for older states', () => {
  expect(
    parseState(
      '{"phase":"idle","contextCapacity":0,"bundledModelAvailable":true}',
    ).bundledModelAvailable,
  ).toBe(true);
  expect(
    parseState(
      '{"phase":"idle","contextCapacity":0,"bundledModelAvailable":false}',
    ).bundledModelAvailable,
  ).toBe(false);
  expect(
    parseState('{"phase":"idle","contextCapacity":0}').bundledModelAvailable,
  ).toBeUndefined();
});
test.each([
  'null',
  '[]',
  '{"phase":"ready","contextCapacity":"32768"}',
  '{"phase":"bogus","contextCapacity":0}',
  '{"phase":"idle","contextCapacity":0,"bundledModelAvailable":"true"}',
  '{"phase":"idle","contextCapacity":0,"bundledModelAvailable":null}',
])('rejects malformed state %s', json => {
  expect(() => parseState(json)).toThrow();
});
test('rejects fabricated ANE proof', () => {
  const result = {
    requestId: 'r',
    text: 'Bonjour',
    generatedTokens: 1,
    promptTokens: 10,
    elapsedMs: 100,
    finishReason: 'eos',
    aneExecution: 'verified',
  };
  expect(() => parseResult(JSON.stringify(result))).toThrow();
  expect(
    parseResult(JSON.stringify({ ...result, aneExecution: 'unverified' })).text,
  ).toBe('Bonjour');
});
test('rejects negative metrics', () => {
  expect(() =>
    parseProgress(
      '{"requestId":"r","text":"x","generatedTokens":-1,"promptTokens":1,"elapsedMs":1}',
    ),
  ).toThrow();
});
