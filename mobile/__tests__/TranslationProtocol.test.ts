import {
  TranslationRequest,
  parseTranslationAvailability,
  parseTranslationCancellation,
  parseTranslationResult,
  validTranslationLanguage,
  validTranslationText,
} from '../src/translationProtocol';
const request: TranslationRequest = {
  schemaVersion: 1,
  requestId: 'r1',
  action: 'translate',
  source_language: '',
  target_language: 'en',
  allow_download: false,
  text: 'Bonjour.',
};
const result = {
  schemaVersion: 1,
  requestId: 'r1',
  action: 'translate',
  sourceLanguage: 'fr',
  targetLanguage: 'en',
  sourceDetected: true,
  translatedText: 'Hello.',
  status: 'installed',
  localOnly: true,
  untrusted: true,
};
const availabilityRequest: TranslationRequest = {
  ...request,
  action: 'availability',
  source_language: '',
};
delete availabilityRequest.text;
const availability = {
  schemaVersion: 1,
  requestId: 'r1',
  action: 'availability',
  sourceLanguage: '',
  targetLanguage: 'en',
  languages: [{ identifier: 'fr', label: 'Français' }],
  status: 'not_checked',
  localOnly: true,
  untrusted: true,
};
test('accepts exact correlated local translation with detected source', () => {
  expect(
    parseTranslationResult(JSON.stringify(result), request).translatedText,
  ).toBe('Hello.');
});
test.each([
  { requestId: 'other' },
  { targetLanguage: 'es' },
  { sourceDetected: false },
  { sourceLanguage: '' },
  { translatedText: '<|tool_call>' },
  { translatedText: 'x'.repeat(8193) },
  { localOnly: false },
  { untrusted: false },
  { status: 'supported' },
  { extra: true },
])('rejects malformed/swapped result %p', change => {
  expect(() =>
    parseTranslationResult(JSON.stringify({ ...result, ...change }), request),
  ).toThrow();
});
test('explicit source must match, region normalization cannot swap provenance', () => {
  expect(() =>
    parseTranslationResult(
      JSON.stringify({ ...result, sourceDetected: false }),
      { ...request, source_language: 'en' },
    ),
  ).toThrow();
});
test('availability is dynamic and never claims an unchecked pair installed', () => {
  expect(
    parseTranslationAvailability(
      JSON.stringify(availability),
      availabilityRequest,
    ).languages[0].identifier,
  ).toBe('fr');
  expect(() =>
    parseTranslationAvailability(
      JSON.stringify({ ...availability, status: 'installed' }),
      availabilityRequest,
    ),
  ).toThrow();
});
test('rejects duplicate, excessive, malformed availability languages', () => {
  for (const languages of [
    [availability.languages[0], availability.languages[0]],
    [{ identifier: 'fr', label: '<|tool_call>' }],
    Array.from({ length: 65 }, (_, i) => ({
      identifier: `en-${i}`,
      label: 'Language',
    })),
  ])
    expect(() =>
      parseTranslationAvailability(
        JSON.stringify({ ...availability, languages }),
        availabilityRequest,
      ),
    ).toThrow();
});
test('bounds UTF8 input and rejects control characters/model markers', () => {
  expect(validTranslationText('é'.repeat(4096))).toBe(true);
  expect(validTranslationText('é'.repeat(4097))).toBe(false);
  expect(validTranslationText('text\u0000')).toBe(false);
  expect(validTranslationText('<|tool_response>')).toBe(false);
  expect(validTranslationLanguage('zh-Hant-TW')).toBe(true);
  expect(validTranslationLanguage('en_US')).toBe(false);
});
test('cancellation requires a complete exact receipt', () => {
  expect(() =>
    parseTranslationCancellation('{"schemaVersion":1,"cancelled":true}'),
  ).not.toThrow();
  expect(() =>
    parseTranslationCancellation('{"schemaVersion":1,"cancelled":false}'),
  ).toThrow();
  expect(() =>
    parseTranslationCancellation(
      '{"schemaVersion":1,"cancelled":true,"extra":1}',
    ),
  ).toThrow();
});
