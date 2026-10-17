import { VoiceTurnPolicy } from '../src/voiceTurnPolicy';

function input(policy: VoiceTurnPolicy, nowMs: number, level = 0.005) {
  policy.input({ frameCount: nowMs + 1, measured: true, level }, nowMs);
}

function quiet(policy: VoiceTurnPolicy, from: number, until: number) {
  for (let at = from; at <= until; at += 200) input(policy, at);
}

test('a normal turn needs stable text and a sustained observed quiet interval', () => {
  const policy = new VoiceTurnPolicy();
  policy.reset(0);
  input(policy, 100, 0.1);
  policy.transcript('Rappelle-moi ça demain.', 200);
  quiet(policy, 400, 1200);
  expect(policy.decision(1299)).toBe('wait');
  expect(policy.decision(1300)).toBe('finish');
});

test('a new partial transcript restarts text stability during a quiet pause', () => {
  const policy = new VoiceTurnPolicy();
  policy.reset(0);
  policy.transcript('Rappelle-moi ça', 200);
  quiet(policy, 400, 1000);
  policy.transcript('Rappelle-moi ça vendredi matin.', 1100);
  quiet(policy, 1200, 1800);
  expect(policy.decision(1999)).toBe('wait');
  expect(policy.decision(2000)).toBe('finish');
});

test('recent sound prevents finishing even when the text has stopped changing', () => {
  const policy = new VoiceTurnPolicy();
  policy.reset(0);
  policy.transcript('Je continue.', 100);
  for (let at = 200; at <= 6000; at += 200) {
    input(policy, at, 0.1);
    expect(policy.decision(at)).toBe('wait');
  }
  quiet(policy, 6200, 7000);
  expect(policy.decision(7099)).toBe('wait');
  expect(policy.decision(7100)).toBe('finish');
});

test.each([
  ['Euh…', 1800],
  ['Attends deux secondes…', 1800],
  ['Je pense que', 2200],
  ['Demain, mais', 2200],
  ['Après ça, pis', 2200],
])('extends the pause for an unfinished fragment: %s', (text, pauseMs) => {
  const policy = new VoiceTurnPolicy();
  policy.reset(0);
  policy.transcript(text, 200);
  const finishAt = 400 + Number(pauseMs);
  quiet(policy, 400, finishAt - 100);
  expect(policy.decision(finishAt - 1)).toBe('wait');
  expect(policy.decision(finishAt)).toBe('finish');
});

test('a completed sentence with an earlier filler retains the normal pause', () => {
  const policy = new VoiceTurnPolicy();
  policy.reset(0);
  policy.transcript('Euh, mets le rappel à deux heures.', 200);
  quiet(policy, 400, 1200);
  expect(policy.decision(1300)).toBe('finish');
});

test('repeated equivalent partial text does not keep extending a finished turn', () => {
  const policy = new VoiceTurnPolicy();
  policy.reset(0);
  policy.transcript('Bonjour Québec.', 200);
  quiet(policy, 400, 800);
  policy.transcript('  Bonjour   Québec.  ', 900);
  quiet(policy, 1000, 1200);
  expect(policy.decision(1300)).toBe('finish');
});

test('no microphone observations and no transcript end as no-speech, never finish', () => {
  const policy = new VoiceTurnPolicy();
  expect(policy.decision(60_000)).toBe('wait');
  policy.reset(0);
  policy.transcript('   ', 100);
  expect(policy.decision(14_999)).toBe('wait');
  expect(policy.decision(15_000)).toBe('no-speech');
});

test('a recent noise peak delays the no-speech timeout without creating a transcript', () => {
  const policy = new VoiceTurnPolicy();
  policy.reset(0);
  input(policy, 14_900, 0.2);
  expect(policy.decision(15_000)).toBe('wait');
  expect(policy.decision(15_799)).toBe('wait');
  expect(policy.decision(15_800)).toBe('no-speech');
});

test.each(['absent', 'unmeasured', 'no-frames'] as const)(
  'missing usable input (%s) uses a conservative text-only fallback',
  kind => {
    const policy = new VoiceTurnPolicy();
    policy.reset(0);
    policy.transcript('Bonjour.', 100);
    if (kind !== 'absent') {
      policy.input(
        {
          frameCount: kind === 'no-frames' ? 0 : 100,
          measured: kind === 'no-frames',
          level: 1,
        },
        200,
      );
    }
    expect(policy.decision(2299)).toBe('wait');
    expect(policy.decision(2300)).toBe('finish');
  },
);

test('stale aggregate frames cannot refresh sound or advance the accepted clock', () => {
  const policy = new VoiceTurnPolicy();
  policy.reset(0);
  policy.transcript('Bonjour.', 200);
  input(policy, 400);
  policy.input({ frameCount: 401, measured: true, level: 1 }, 12_000);
  quiet(policy, 600, 1200);
  expect(policy.decision(1300)).toBe('finish');
});

test('backward timestamps and invalid levels cannot change a current turn', () => {
  const policy = new VoiceTurnPolicy();
  policy.reset(1000);
  policy.transcript('Bonjour.', 1100);
  input(policy, 1200, 0.1);
  expect(policy.decision(1300)).toBe('wait');
  policy.transcript('Attends…', 1000);
  policy.input({ frameCount: 1401, measured: true, level: 0 }, 1250);
  policy.input({ frameCount: 9999, measured: true, level: Number.NaN }, 50_000);
  quiet(policy, 1400, 2200);
  expect(policy.decision(Number.POSITIVE_INFINITY)).toBe('wait');
  expect(policy.decision(2299)).toBe('wait');
  expect(policy.decision(2300)).toBe('finish');
});

test('reset clears earlier text, frame counters and silence history for the next capture', () => {
  const policy = new VoiceTurnPolicy();
  policy.reset(0);
  policy.transcript('Ancienne réponse.', 100);
  input(policy, 1000, 0.1);
  policy.reset(2000);
  policy.input({ frameCount: 1, measured: true, level: 0.1 }, 2100);
  expect(policy.decision(16_999)).toBe('wait');
  expect(policy.decision(17_000)).toBe('no-speech');
  policy.reset(Number.NaN);
  expect(policy.decision(100_000)).toBe('wait');
});
