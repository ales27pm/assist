import {
  outputBudget,
  parseProgress,
  parseResult,
  parseState,
} from '../src/protocol';
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
