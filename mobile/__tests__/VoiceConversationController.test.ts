import { VoiceConversationController } from '../src/VoiceConversationController';
import type { VoicePhase } from '../src/voice';

type Reply = { text: string; spoken: boolean };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flush() {
  // All collaborators are controlled promises; no wall clock or native work.
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function fixture() {
  let time = 0;
  const generation = deferred<Reply>();
  const finishAck = deferred<void>();
  const commands = {
    startCapture: jest.fn(async (_isCurrent: () => boolean) => true),
    finishCapture: jest.fn(() => finishAck.promise),
    cancel: jest.fn(async () => {}),
    cancelResponse: jest.fn(async () => {}),
    generate: jest.fn(
      (_text: string, _isCurrent: () => boolean) => generation.promise,
    ),
    changed: jest.fn(),
    now: () => time,
  };
  const controller = new VoiceConversationController(commands);
  return {
    controller,
    commands,
    generation,
    finishAck,
    at: (now: number) => {
      time = now;
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

function handoff(test: Fixture, oldId = 'reply-1', newId = 'interruption-1') {
  test.controller.event({
    kind: 'interruption', phase: 'listening',
    sessionId: oldId, captureSessionId: newId,
  });
}

function transcript(
  test: Fixture,
  text: string,
  isFinal = false,
  phase: VoicePhase = isFinal ? 'idle' : 'listening',
  sessionId = 'capture-1',
) {
  test.controller.event({
    sessionId,
    kind: 'transcript',
    text,
    isFinal,
    phase,
  });
}

function state(test: Fixture, sessionId: string, phase: VoicePhase) {
  test.controller.event({ sessionId, kind: 'state', phase });
}

function requestAutomaticFinish(test: Fixture) {
  test.at(100);
  transcript(test, 'Rappelle-moi ça demain.');
  for (let now = 200; now <= 1000; now += 200) {
    test.at(now);
    test.controller.event({
      sessionId: 'capture-1',
      kind: 'input',
      phase: 'listening',
      diagnostics: {
        frameCount: now * 48,
        bufferCount: now / 200,
        sampleRate: 48_000,
        channels: 1,
        peak: 0.1,
        level: 0.005,
        measured: true,
        elapsedMs: now,
        inputPort: 'MicrophoneBuiltIn',
      },
    });
  }
  test.at(1100);
  test.controller.tick();
}

test('automatic end-of-turn requests stop once and waits for native final, idle and stop acknowledgement', async () => {
  const test = fixture();
  await test.controller.start();
  requestAutomaticFinish(test);
  test.controller.tick();
  test.controller.tick();
  expect(test.controller.snapshot().phase).toBe('finishing');
  expect(test.commands.finishCapture).toHaveBeenCalledTimes(1);
  await flush();
  expect(test.commands.generate).not.toHaveBeenCalled();

  transcript(test, 'Rappelle-moi ça vendredi.', true, 'finishing');
  await flush();
  expect(test.commands.generate).not.toHaveBeenCalled();
  state(test, 'capture-1', 'idle');
  await flush();
  expect(test.commands.generate).not.toHaveBeenCalled();
  test.finishAck.resolve();
  await flush();
  expect(test.commands.generate).toHaveBeenCalledTimes(1);
  expect(test.commands.generate).toHaveBeenCalledWith(
    'Rappelle-moi ça vendredi.',
    expect.any(Function),
  );
});

test('a stop acknowledgement and idle without final text still cannot send a partial transcript', async () => {
  const test = fixture();
  await test.controller.start();
  requestAutomaticFinish(test);
  test.finishAck.resolve();
  state(test, 'capture-1', 'idle');
  await flush();
  expect(test.commands.generate).not.toHaveBeenCalled();
  transcript(test, 'Le résultat final.', true);
  await flush();
  expect(test.commands.generate).toHaveBeenCalledWith(
    'Le résultat final.',
    expect.any(Function),
  );
});

test('a natural native final submits exactly once without requesting a redundant stop', async () => {
  const test = fixture();
  await test.controller.start();
  transcript(test, 'Bonjour Québec.', true);
  transcript(test, 'Bonjour Québec.', true);
  state(test, 'capture-1', 'idle');
  test.controller.tick();
  await flush();
  expect(test.commands.generate).toHaveBeenCalledTimes(1);
  expect(test.commands.finishCapture).not.toHaveBeenCalled();
  expect(test.controller.snapshot().phase).toBe('thinking');
});

test('a spoken response cannot reopen capture until generation and actual native playback have both ended', async () => {
  const test = fixture();
  await test.controller.start();
  transcript(test, 'Bonjour.', true);
  await flush();
  state(test, 'reply-1', 'speaking');
  test.generation.resolve({ text: 'Salut!', spoken: true });
  await flush();
  expect(test.commands.startCapture).toHaveBeenCalledTimes(1);
  expect(test.controller.snapshot().phase).toBe('speaking');
  state(test, 'reply-1', 'idle');
  await flush();
  expect(test.commands.startCapture).toHaveBeenCalledTimes(2);
  expect(test.controller.snapshot().phase).toBe('listening');
});

test('an early playback idle waits for the still-pending generation promise', async () => {
  const test = fixture();
  await test.controller.start();
  transcript(test, 'Bonjour.', true);
  await flush();
  state(test, 'reply-1', 'speaking');
  state(test, 'reply-1', 'idle');
  await flush();
  expect(test.commands.startCapture).toHaveBeenCalledTimes(1);
  test.generation.resolve({ text: 'Réponse terminée.', spoken: true });
  await flush();
  expect(test.commands.startCapture).toHaveBeenCalledTimes(2);
});

test('reading disabled returns to listening after generation without waiting for nonexistent playback', async () => {
  const test = fixture();
  await test.controller.start();
  transcript(test, 'Réponds sans lire.', true);
  await flush();
  expect(test.commands.startCapture).toHaveBeenCalledTimes(1);
  test.generation.resolve({ text: 'Réponse au texte.', spoken: false });
  await flush();
  expect(test.commands.startCapture).toHaveBeenCalledTimes(2);
  expect(test.controller.snapshot().phase).toBe('listening');
  expect(test.controller.snapshot().reply).toBe('Réponse au texte.');
});

test('pausing or leaving during a pending capture rejects its late completion and events', async () => {
  const test = fixture();
  const capture = deferred<boolean>();
  test.commands.startCapture.mockReturnValueOnce(capture.promise);
  const starting = test.controller.start();
  await flush();
  expect(test.commands.startCapture).toHaveBeenCalledTimes(1);
  const wasCurrent = test.commands.startCapture.mock.calls[0][0];
  expect(wasCurrent()).toBe(true);
  await test.controller.pause();
  expect(wasCurrent()).toBe(false);
  state(test, 'capture-1', 'listening');
  transcript(test, 'Ne pas envoyer.', true);
  capture.resolve(true);
  await starting;
  await flush();
  expect(test.controller.isActive()).toBe(false);
  expect(test.controller.snapshot().phase).toBe('paused');
  expect(test.commands.generate).not.toHaveBeenCalled();
  expect(test.commands.startCapture).toHaveBeenCalledTimes(1);
});

test.each(['cancel-first', 'generation-first'] as const)(
  'interrupt opens a fresh turn only after old work settles (%s)',
  async order => {
    const test = fixture();
    await test.controller.start();
    transcript(test, 'Ancienne question.', true);
    await flush();
    const wasCurrent = test.commands.generate.mock.calls[0][1];
    const cancellation = deferred<void>();
    test.commands.cancel.mockReturnValueOnce(cancellation.promise);
    const interrupting = test.controller.interrupt();
    expect(wasCurrent()).toBe(false);
    await flush();
    expect(test.commands.startCapture).toHaveBeenCalledTimes(1);
    if (order === 'cancel-first') cancellation.resolve();
    else test.generation.resolve({ text: 'Réponse périmée.', spoken: false });
    await flush();
    expect(test.commands.startCapture).toHaveBeenCalledTimes(1);
    if (order === 'cancel-first')
      test.generation.resolve({ text: 'Réponse périmée.', spoken: false });
    else cancellation.resolve();
    await interrupting;
    expect(test.commands.startCapture).toHaveBeenCalledTimes(2);
    expect(test.controller.snapshot().phase).toBe('listening');
    expect(test.controller.snapshot().reply).not.toBe('Réponse périmée.');
  },
);

test('pausing a pending generation invalidates its reply and prevents automatic listening', async () => {
  const test = fixture();
  await test.controller.start();
  transcript(test, 'Ancienne question.', true);
  await flush();
  const wasCurrent = test.commands.generate.mock.calls[0][1];
  const pausing = test.controller.pause();
  expect(wasCurrent()).toBe(false);
  state(test, 'reply-1', 'speaking');
  state(test, 'reply-1', 'idle');
  test.controller.progress('Ancien texte en cours.');
  test.generation.resolve({ text: 'Ancienne réponse.', spoken: false });
  await pausing;
  await flush();
  expect(test.controller.snapshot().phase).toBe('paused');
  expect(test.controller.snapshot().reply).toBe('');
  expect(test.commands.startCapture).toHaveBeenCalledTimes(1);
});

test('a retired capture cannot submit again after the next turn has opened', async () => {
  const test = fixture();
  await test.controller.start();
  transcript(test, 'Première question.', true);
  await flush();
  test.generation.resolve({ text: 'Première réponse.', spoken: false });
  await flush();
  expect(test.commands.startCapture).toHaveBeenCalledTimes(2);
  transcript(test, 'Ancien final livré tard.', true, 'idle', 'capture-1');
  await flush();
  expect(test.commands.generate).toHaveBeenCalledTimes(1);
  expect(test.controller.snapshot().phase).toBe('listening');
  expect(test.controller.snapshot().transcript).toBe('');
});

test('retired speech events cannot drain the reply of a newer turn', async () => {
  const test = fixture();
  const nextGeneration = deferred<Reply>();
  test.commands.generate
    .mockReturnValueOnce(test.generation.promise)
    .mockReturnValueOnce(nextGeneration.promise);
  await test.controller.start();
  transcript(test, 'Première question.', true);
  await flush();
  state(test, 'reply-1', 'speaking');
  const interrupting = test.controller.interrupt();
  test.generation.resolve({ text: 'Ancienne réponse.', spoken: true });
  await interrupting;
  transcript(test, 'Nouvelle question.', true, 'idle', 'capture-2');
  await flush();
  state(test, 'reply-1', 'speaking');
  state(test, 'reply-2', 'speaking');
  nextGeneration.resolve({ text: 'Nouvelle réponse.', spoken: true });
  await flush();
  state(test, 'reply-1', 'idle');
  await flush();
  expect(test.commands.startCapture).toHaveBeenCalledTimes(2);
  expect(test.controller.snapshot().phase).toBe('speaking');
  state(test, 'reply-2', 'idle');
  await flush();
  expect(test.commands.startCapture).toHaveBeenCalledTimes(3);
});

test.each(['native-error', 'no-speech'] as const)(
  '%s pauses the session without retrying capture',
  async cause => {
    const test = fixture();
    await test.controller.start();
    if (cause === 'native-error') {
      test.controller.event({
        sessionId: 'capture-1',
        kind: 'error',
        phase: 'idle',
        message: 'Micro indisponible.',
      });
    } else {
      test.at(15_000);
      test.controller.tick();
    }
    await flush();
    expect(test.controller.isActive()).toBe(false);
    expect(test.controller.snapshot().phase).toBe('error');
    expect(test.controller.snapshot().error).not.toBe('');
    for (let index = 0; index < 5; index += 1) test.controller.tick();
    transcript(test, 'Résultat tardif.', true);
    await flush();
    expect(test.commands.generate).not.toHaveBeenCalled();
    expect(test.commands.startCapture).toHaveBeenCalledTimes(1);
    expect(test.commands.cancel).toHaveBeenCalledTimes(2);
  },
);

test('an empty native final never generates a message', async () => {
  const test = fixture();
  await test.controller.start();
  transcript(test, '  \n ', true);
  await flush();
  expect(test.commands.generate).not.toHaveBeenCalled();
  expect(test.controller.isActive()).toBe(false);
  expect(test.controller.snapshot().phase).toBe('error');
});

test('pausing keeps running text in voice state without treating it as a completed message', async () => {
  const test = fixture();
  await test.controller.start();
  transcript(test, 'Je pense que…');
  await test.controller.pause();
  expect(test.controller.snapshot().transcript).toBe('Je pense que…');
  expect(test.commands.generate).not.toHaveBeenCalled();
  await test.controller.start();
  expect(test.controller.snapshot().transcript).toBe('');
  transcript(test, 'Le nouveau message final.', true, 'idle', 'capture-2');
  await flush();
  expect(test.commands.generate).toHaveBeenCalledWith(
    'Le nouveau message final.',
    expect.any(Function),
  );
});

test('pause and immediate resume share cancellation and wait for its acknowledgement', async () => {
  const test = fixture();
  await test.controller.start();
  const acknowledgement = deferred<void>();
  test.commands.cancel.mockReturnValueOnce(acknowledgement.promise);
  const pausing = test.controller.pause();
  expect(test.controller.snapshot().phase).toBe('stopping');
  const resuming = test.controller.start();
  await flush();
  expect(test.commands.cancel).toHaveBeenCalledTimes(2);
  expect(test.commands.startCapture).toHaveBeenCalledTimes(1);
  acknowledgement.resolve();
  await Promise.all([pausing, resuming]);
  expect(test.commands.startCapture).toHaveBeenCalledTimes(2);
  expect(test.controller.snapshot().phase).toBe('listening');
});

test('a failed cancellation never claims a completed pause or reopens the microphone', async () => {
  const test = fixture();
  await test.controller.start();
  test.commands.cancel.mockRejectedValueOnce(new Error('Audio stop failed'));
  await test.controller.pause();
  await flush();
  expect(test.controller.isActive()).toBe(false);
  expect(test.controller.snapshot().phase).toBe('error');
  expect(test.controller.snapshot().error).toContain('n’a pas été confirmé');
  expect(test.commands.startCapture).toHaveBeenCalledTimes(1);
});

test.each(['cancel-first', 'generation-first'] as const)(
  'spoken interruption preserves its final and waits for both old tasks: %s',
  async order => {
    const test = fixture();
    const cancellation = deferred<void>();
    const second = deferred<Reply>();
    test.commands.cancelResponse.mockReturnValueOnce(cancellation.promise);
    test.commands.generate.mockReturnValueOnce(test.generation.promise).mockReturnValueOnce(second.promise);
    await test.controller.start();
    transcript(test, 'Première question.', true);
    await flush();
    test.controller.expectSpeech('reply-1');
    state(test, 'reply-1', 'speaking');
    const initialCancels = test.commands.cancel.mock.calls.length;
    const wasCurrent = test.commands.generate.mock.calls[0][1];
    handoff(test);
    expect(wasCurrent()).toBe(false);
    expect(test.controller.snapshot().phase).toBe('listening');
    expect(test.commands.cancelResponse).toHaveBeenCalledTimes(1);
    expect(test.commands.cancel).toHaveBeenCalledTimes(initialCancels);
    expect(test.commands.startCapture).toHaveBeenCalledTimes(1);
    transcript(test, 'Non, attends, plutôt vendredi.', true, 'idle', 'interruption-1');
    state(test, 'reply-1', 'idle');
    transcript(test, 'Ancien texte.', true);
    handoff(test);
    await flush();
    expect(test.commands.generate).toHaveBeenCalledTimes(1);
    if (order === 'cancel-first') cancellation.resolve();
    else test.generation.resolve({ text: 'Ancienne réponse.', spoken: true });
    await flush();
    expect(test.commands.generate).toHaveBeenCalledTimes(1);
    if (order === 'cancel-first') test.generation.resolve({ text: 'Ancienne réponse.', spoken: true });
    else cancellation.resolve();
    await flush();
    expect(test.commands.generate).toHaveBeenCalledTimes(2);
    expect(test.commands.generate.mock.calls[1][0]).toBe('Non, attends, plutôt vendredi.');
    expect(test.commands.startCapture).toHaveBeenCalledTimes(1);
    expect(test.commands.cancelResponse).toHaveBeenCalledTimes(1);
    second.resolve({ text: 'D’accord.', spoken: false });
    await flush();
    expect(test.commands.startCapture).toHaveBeenCalledTimes(2);
  },
);

test('a single promoted partial contributes to end-of-turn after reset', async () => {
  const test = fixture();
  await test.controller.start();
  transcript(test, 'Question.', true);
  await flush();
  test.controller.expectSpeech('reply-1');
  state(test, 'reply-1', 'speaking');
  handoff(test);
  test.at(100);
  transcript(test, 'Non, plutôt vendredi.', false, 'listening', 'interruption-1');
  test.at(2400);
  test.controller.tick();
  expect(test.commands.finishCapture).toHaveBeenCalledTimes(1);
  expect(test.controller.snapshot().transcript).toBe('Non, plutôt vendredi.');
});

test('failed model cancellation after handoff stops the promoted microphone', async () => {
  const test = fixture();
  const cancellation = deferred<void>();
  cancellation.promise.catch(() => undefined);
  test.commands.cancelResponse.mockReturnValueOnce(cancellation.promise);
  await test.controller.start();
  transcript(test, 'Question.', true);
  await flush();
  test.controller.expectSpeech('reply-1');
  state(test, 'reply-1', 'speaking');
  const initialCancels = test.commands.cancel.mock.calls.length;
  handoff(test);
  cancellation.reject(new Error('cancel failed'));
  await flush();
  expect(test.controller.snapshot().phase).toBe('error');
  expect(test.controller.isActive()).toBe(false);
  expect(test.commands.cancel).toHaveBeenCalledTimes(initialCancels + 1);
  transcript(test, 'Ne pas envoyer.', true, 'idle', 'interruption-1');
  test.generation.resolve({ text: 'Ancien.', spoken: true });
  await flush();
  expect(test.commands.generate).toHaveBeenCalledTimes(1);
});

test('pause wins over a late native handoff while the old model settles', async () => {
  const test = fixture();
  await test.controller.start();
  transcript(test, 'Question.', true);
  await flush();
  test.controller.expectSpeech('reply-1');
  state(test, 'reply-1', 'speaking');
  const stopping = test.controller.pause();
  handoff(test);
  transcript(test, 'Ne pas envoyer.', true, 'idle', 'interruption-1');
  test.generation.resolve({ text: 'Ancien.', spoken: true });
  await stopping;
  expect(test.commands.cancelResponse).not.toHaveBeenCalled();
  expect(test.controller.snapshot().phase).toBe('paused');
  expect(test.commands.generate).toHaveBeenCalledTimes(1);
});
