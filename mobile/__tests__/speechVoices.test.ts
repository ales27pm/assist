import {
  blindVoiceOrder,
  parseSpeechVoiceCatalog,
  parseSpeechVoicePreviewResult,
  parseSpeechVoiceStopResult,
  VOICE_COMPARISON_SAMPLES,
} from '../src/speechVoices';
import type { SpeechVoice, SpeechVoiceCatalog } from '../src/speechVoices';

const voice = (id: string, name = id): SpeechVoice => ({
  id,
  name,
  language: 'fr-CA',
  quality: 'default',
});

function catalog(patch: Partial<SpeechVoiceCatalog> = {}): SpeechVoiceCatalog {
  return {
    schemaVersion: 1,
    locale: 'fr-CA',
    voices: [voice('one', 'Première voix'), voice('two', 'Deuxième voix')],
    selectedVoiceId: '',
    resolvedVoiceId: 'one',
    selectionMissing: false,
    ...patch,
  };
}

const parseCatalog = (value: unknown) =>
  parseSpeechVoiceCatalog(JSON.stringify(value));

test('accepts the catalog and reconstructs only its documented fields', () => {
  const value = catalog();
  const parsed = parseCatalog({
    ...value,
    unexpected: 'discarded',
    voices: value.voices.map(entry => ({ ...entry, audio: 'discarded' })),
  });
  expect(parsed).toEqual(value);
  expect(parsed).not.toBe(value);
  expect(parsed.voices).not.toBe(value.voices);
  expect(parsed.voices[0]).not.toBe(value.voices[0]);
});

test.each(['default', 'enhanced', 'premium'] as const)(
  'accepts the documented %s voice quality',
  quality => {
    const value = catalog({ voices: [{ ...voice('one'), quality }] });
    expect(parseCatalog(value)).toEqual(value);
  },
);

test('retains bounded optional native build and OS versions for reproducibility', () => {
  const value = catalog({ nativeBuild: '1.0.0 (19)', osVersion: '27.1' });
  expect(parseCatalog(value)).toEqual(value);
  expect(
    parseCatalog(
      catalog({ nativeBuild: 'b'.repeat(128), osVersion: 'v'.repeat(128) }),
    ),
  ).toEqual(
    catalog({ nativeBuild: 'b'.repeat(128), osVersion: 'v'.repeat(128) }),
  );
});

test.each([
  { nativeBuild: '' },
  { nativeBuild: ' ' },
  { nativeBuild: 'b'.repeat(129) },
  { nativeBuild: null },
  { nativeBuild: 19 },
  { osVersion: '' },
  { osVersion: ' ' },
  { osVersion: 'v'.repeat(129) },
  { osVersion: null },
  { osVersion: 27.1 },
])('rejects invalid optional native version metadata %#', patch => {
  expect(() => parseCatalog({ ...catalog(), ...patch })).toThrow();
});

test('restores explicit selection and reports a missing choice with a local fallback', () => {
  const chosen = catalog({ selectedVoiceId: 'two', resolvedVoiceId: 'two' });
  expect(parseCatalog(chosen)).toEqual(chosen);
  const removed = catalog({
    selectedVoiceId: 'removed',
    selectionMissing: true,
  });
  expect(parseCatalog(removed)).toEqual(removed);
});

test.each(['', 'removed'])(
  'accepts an empty inventory while preserving saved choice %s',
  selectedVoiceId => {
    const value = catalog({
      voices: [],
      selectedVoiceId,
      resolvedVoiceId: null,
      selectionMissing: selectedVoiceId !== '',
    });
    expect(parseCatalog(value)).toEqual(value);
  },
);

test('accepts the inventory and string limits, including distinct voices sharing a name', () => {
  const voices = Array.from({ length: 200 }, (_, index) =>
    voice(index === 0 ? 'v'.repeat(512) : `voice-${index}`, 'n'.repeat(160)),
  );
  const value = catalog({ voices, resolvedVoiceId: voices[0].id });
  expect(parseCatalog(value)).toEqual(value);
});

test.each([
  ['schema', { schemaVersion: 2 }],
  ['locale', { locale: 'fr-FR' }],
  ['inventory', { voices: {} }],
  [
    'too many voices',
    { voices: Array.from({ length: 201 }, (_, i) => voice(`${i}`)) },
  ],
  ['duplicate identifiers', { voices: [voice('one'), voice('one')] }],
  ['empty identifier', { voices: [voice('')] }],
  ['blank identifier', { voices: [voice('   ')] }],
  ['long identifier', { voices: [voice('v'.repeat(513))] }],
  ['empty name', { voices: [voice('one', '')] }],
  ['long name', { voices: [voice('one', 'n'.repeat(161))] }],
  ['foreign voice', { voices: [{ ...voice('one'), language: 'fr-FR' }] }],
  [
    'noncanonical language',
    { voices: [{ ...voice('one'), language: 'fr_CA' }] },
  ],
  ['unknown quality', { voices: [{ ...voice('one'), quality: 'studio' }] }],
  ['invalid voice', { voices: [null] }],
  ['selected identifier type', { selectedVoiceId: null }],
  ['long selected identifier', { selectedVoiceId: 'v'.repeat(513) }],
  ['missing flag type', { selectionMissing: 'false' }],
  ['unknown resolved identifier', { resolvedVoiceId: 'absent' }],
  ['missing resolved voice', { resolvedVoiceId: null }],
  [
    'wrong selected resolution',
    { selectedVoiceId: 'two', resolvedVoiceId: 'one' },
  ],
  [
    'missing selected flag',
    { selectedVoiceId: 'absent', selectionMissing: false },
  ],
  ['false missing flag', { selectedVoiceId: 'one', selectionMissing: true }],
] as const)('rejects an invalid %s', (_label, patch) => {
  expect(() => parseCatalog({ ...catalog(), ...patch })).toThrow();
});

test.each(['null', '[]', 'true', '{}', 'not json'])(
  'rejects missing or malformed native input',
  json => expect(() => parseSpeechVoiceCatalog(json)).toThrow(),
);

test('bounds an otherwise valid catalog payload before retaining oversized extra data', () => {
  expect(() =>
    parseCatalog({ ...catalog(), ignored: 'x'.repeat(1_000_001) }),
  ).toThrow();
});

test.each(['completed', 'cancelled'] as const)(
  'accepts a terminal %s result without retaining extra data',
  outcome => {
    const result = { sessionId: 'preview-1', outcome };
    expect(
      parseSpeechVoicePreviewResult(
        JSON.stringify({ ...result, text: 'ignored' }),
      ),
    ).toEqual(result);
  },
);

test.each([
  { sessionId: '', outcome: 'completed' },
  { sessionId: ' ', outcome: 'completed' },
  { sessionId: 's'.repeat(513), outcome: 'completed' },
  { sessionId: 'preview-1', outcome: 'scheduled' },
  { sessionId: 'preview-1' },
  { outcome: 'cancelled' },
  null,
  [],
])('rejects malformed or nonterminal preview result %#', result => {
  expect(() => parseSpeechVoicePreviewResult(JSON.stringify(result))).toThrow();
});

test('accepts the preview session identifier limit and bounds its bridge payload', () => {
  const result = { sessionId: 's'.repeat(512), outcome: 'completed' };
  expect(parseSpeechVoicePreviewResult(JSON.stringify(result))).toEqual(result);
  expect(() =>
    parseSpeechVoicePreviewResult(
      JSON.stringify({ ...result, ignored: 'x'.repeat(4096) }),
    ),
  ).toThrow();
});

test.each([true, false])(
  'accepts a targeted stop ACK with stopped=%s',
  stopped => {
    const result = { sessionId: 'preview-1', stopped };
    expect(
      parseSpeechVoiceStopResult(
        JSON.stringify({ ...result, text: 'ignored' }),
      ),
    ).toEqual(result);
  },
);

test.each([
  { sessionId: '', stopped: true },
  { sessionId: ' ', stopped: false },
  { sessionId: 's'.repeat(513), stopped: true },
  { sessionId: 'preview-1', stopped: 'false' },
  { sessionId: 'preview-1', stopped: 1 },
  { sessionId: 'preview-1', outcome: 'cancelled' },
  { stopped: true },
  null,
  [],
])('rejects an invalid targeted stop ACK %#', result => {
  expect(() => parseSpeechVoiceStopResult(JSON.stringify(result))).toThrow();
});

test('bounds targeted stop payloads and accepts their session identifier limit', () => {
  const result = { sessionId: 's'.repeat(512), stopped: false };
  expect(parseSpeechVoiceStopResult(JSON.stringify(result))).toEqual(result);
  expect(() =>
    parseSpeechVoiceStopResult(
      JSON.stringify({ ...result, ignored: 'x'.repeat(4096) }),
    ),
  ).toThrow();
  expect(() => parseSpeechVoiceStopResult('not json')).toThrow();
});

test('keeps all five test phrases identical in whole and segmented listening', () => {
  expect(VOICE_COMPARISON_SAMPLES).toHaveLength(5);
  expect(new Set(VOICE_COMPARISON_SAMPLES.map(sample => sample.id)).size).toBe(
    5,
  );
  for (const sample of VOICE_COMPARISON_SAMPLES) {
    expect(sample.id.trim()).not.toBe('');
    expect(sample.label.trim()).not.toBe('');
    expect(sample.text.length).toBeLessThanOrEqual(2400);
    expect(sample.segments.length).toBeGreaterThan(1);
    expect(sample.segments.length).toBeLessThanOrEqual(8);
    expect(sample.segments.every(segment => !!segment.trim())).toBe(true);
    expect(sample.segments.join('')).toBe(sample.text);
  }
  const corpus = VOICE_COMPARISON_SAMPLES.map(sample => sample.text).join(' ');
  for (const phrase of [
    'tantôt',
    'René-Lévesque',
    'Sainte-Foy',
    'UQAM',
    'vingt piasses',
    'Core ML',
    'Wi-Fi',
    'retry',
    'Euh…',
    'attends',
  ])
    expect(corpus).toContain(phrase);
});

test('returns a fresh bijection without mutating the inventory or voice objects', () => {
  const voices = Object.freeze(
    Array.from({ length: 200 }, (_, i) => Object.freeze(voice(`${i}`))),
  );
  for (const random of [() => 0, () => 0.3, () => 1 - Number.EPSILON]) {
    const ordered = blindVoiceOrder(voices, random);
    expect(ordered).not.toBe(voices);
    expect(ordered).toHaveLength(voices.length);
    expect(new Set(ordered).size).toBe(voices.length);
    expect(new Set(ordered)).toEqual(new Set(voices));
    expect(voices.map(entry => entry.id)).toEqual(
      Array.from({ length: 200 }, (_, i) => `${i}`),
    );
  }
});

test('replays a stable mapping with the same injected random sequence', () => {
  const voices = [voice('one'), voice('two'), voice('three'), voice('four')];
  const sequence = () => {
    let position = 0;
    const values = [0.2, 0.8, 0.4];
    return () => values[position++];
  };
  expect(blindVoiceOrder(voices, sequence())).toEqual(
    blindVoiceOrder(voices, sequence()),
  );
});

test('gives all six permutations of three voices equal weight across equally likely random intervals', () => {
  const voices = [voice('one'), voice('two'), voice('three')];
  const outcomes: string[] = [];
  for (const first of [1 / 6, 1 / 2, 5 / 6]) {
    for (const second of [1 / 4, 3 / 4]) {
      const draws = [first, second];
      let position = 0;
      outcomes.push(
        blindVoiceOrder(voices, () => draws[position++])
          .map(entry => entry.id)
          .join(','),
      );
    }
  }
  expect(new Set(outcomes)).toEqual(
    new Set([
      'one,two,three',
      'one,three,two',
      'two,one,three',
      'two,three,one',
      'three,one,two',
      'three,two,one',
    ]),
  );
});

test.each([NaN, Infinity, -0.1, 1, 2])(
  'rejects an invalid random sample %s',
  value => {
    const voices = [voice('one'), voice('two')];
    expect(() => blindVoiceOrder(voices, () => value)).toThrow();
    expect(voices.map(entry => entry.id)).toEqual(['one', 'two']);
  },
);

test('handles empty and single-voice inventories without drawing a random value', () => {
  const random = jest.fn(() => {
    throw new Error('Unneeded random draw');
  });
  expect(blindVoiceOrder([], random)).toEqual([]);
  const one = [voice('one')];
  expect(blindVoiceOrder(one, random)).toEqual(one);
  expect(random).not.toHaveBeenCalled();
});
