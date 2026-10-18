import { act, renderHookAsync } from '@testing-library/react-native';
import { AppState, AppStateStatus } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { useLocalVoice } from '../src/useLocalVoice';
import { parseVoiceEvent, parseVoiceStatus } from '../src/voice';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    getVoiceStatus: jest.fn(),
    startListening: jest.fn(),
    stopListening: jest.fn(),
    cancelVoice: jest.fn(),
    speak: jest.fn(),
    beginSpeech: jest.fn(),
    enqueueSpeech: jest.fn(),
    finishSpeech: jest.fn(),
    onVoiceEvent: jest.fn(),
  },
}));

const native = jest.mocked(NativeAssist!);
let voiceEvent: (event: { json: string }) => void;
let stateChanged: (state: AppStateStatus) => void;
let removeVoiceListener: jest.Mock;
let removeAppStateListener: jest.Mock;

function status(phase = 'idle') {
  return JSON.stringify({
    available: true,
    recognitionAvailable: true,
    synthesisAvailable: true,
    locale: 'fr-CA',
    phase,
    voiceName: 'Voix de test',
  });
}

function inputDiagnostics(extra: Record<string, unknown> = {}) {
  return {
    bufferCount: 4,
    frameCount: 1920,
    sampleRate: 48_000,
    channels: 1,
    peak: 0.4,
    level: 0.2,
    measured: true,
    elapsedMs: 200,
    inputPort: 'MicrophoneBuiltIn',
    firstBufferDelayMs: 35,
    ...extra,
  };
}

function emit(event: Record<string, unknown>) {
  voiceEvent({ json: JSON.stringify(event) });
}

function transcript(sessionId: string, text: string, isFinal = false) {
  emit({
    sessionId,
    kind: 'transcript',
    phase: isFinal ? 'idle' : 'listening',
    text,
    isFinal,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    writable: true,
    value: 'active',
  });
  removeVoiceListener = jest.fn();
  removeAppStateListener = jest.fn();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
    stateChanged = listener;
    return { remove: removeAppStateListener };
  });
  native.getVoiceStatus.mockResolvedValue(status());
  native.startListening.mockResolvedValue(status('listening'));
  native.stopListening.mockResolvedValue(status('finishing'));
  native.cancelVoice.mockResolvedValue(status());
  native.speak.mockResolvedValue(status('speaking'));
  native.beginSpeech.mockResolvedValue(status('speaking'));
  native.enqueueSpeech.mockResolvedValue(status('speaking'));
  native.finishSpeech.mockResolvedValue(status('speaking'));
  native.onVoiceEvent.mockImplementation(listener => {
    voiceEvent = listener;
    return { remove: removeVoiceListener };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('queries capabilities without starting capture or playback on mount', async () => {
  const onTranscript = jest.fn();
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript, enabled: true }),
  );

  expect(native.getVoiceStatus).toHaveBeenCalledTimes(1);
  expect(native.startListening).not.toHaveBeenCalled();
  expect(native.speak).not.toHaveBeenCalled();
  expect(onTranscript).not.toHaveBeenCalled();
  expect(result.current.supported).toBe(true);
  expect(result.current.phase).toBe('idle');
  expect(result.current.captureBusy).toBe(false);
});

test('capabilities arriving after the initial hidden-screen cancellation still enable later capture', async () => {
  const capabilities = deferred<string>();
  native.getVoiceStatus.mockReturnValueOnce(capabilities.promise);
  const { result, rerenderAsync } = await renderHookAsync<
    ReturnType<typeof useLocalVoice>,
    { enabled: boolean }
  >(({ enabled }) => useLocalVoice({ onTranscript: jest.fn(), enabled }), {
    initialProps: { enabled: false },
  });
  expect(native.cancelVoice).toHaveBeenCalledTimes(1);
  expect(result.current.status).toBeNull();
  await act(async () => capabilities.resolve(status()));
  expect(result.current.status).toMatchObject({
    recognitionAvailable: true,
    synthesisAvailable: true,
    phase: 'idle',
    monitoring: false,
  });
  expect(native.startListening).not.toHaveBeenCalled();
  await rerenderAsync({ enabled: true });
  await act(async () => {
    expect(await result.current.startListening()).toBe(true);
  });
  expect(native.startListening).toHaveBeenCalledTimes(1);
});

test.each(['listening', 'requesting'])(
  'startListening reports an accepted %s capture and rejects a duplicate start',
  async phase => {
    native.startListening.mockResolvedValueOnce(status(phase));
    const { result } = await renderHookAsync(() =>
      useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
    );
    await act(async () => {
      expect(await result.current.startListening()).toBe(true);
      expect(await result.current.startListening()).toBe(false);
    });
    expect(native.startListening).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe(phase);
  },
);

test('a capture start ACK accepts a nonempty final and idle received first without reviving listening', async () => {
  const starting = deferred<string>();
  native.startListening.mockReturnValueOnce(starting.promise);
  const onTranscript = jest.fn();
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript, enabled: true }),
  );
  let accepted!: Promise<boolean>;
  await act(async () => {
    accepted = result.current.startListening();
    const sessionId = native.startListening.mock.calls[0][0];
    emit({ sessionId, kind: 'state', phase: 'listening' });
    emit({
      sessionId,
      kind: 'transcript',
      phase: 'finishing',
      text: 'Le début retenu est déjà complet.',
      isFinal: true,
    });
    emit({ sessionId, kind: 'state', phase: 'idle' });
  });
  expect(result.current.phase).toBe('idle');
  await act(async () => {
    starting.resolve(status('listening'));
    expect(await accepted).toBe(true);
  });
  expect(onTranscript).toHaveBeenCalledWith(
    'Le début retenu est déjà complet.',
  );
  expect(result.current.phase).toBe('idle');
  expect(result.current.status?.phase).toBe('idle');
  expect(result.current.captureBusy).toBe(false);
  expect(native.cancelVoice).not.toHaveBeenCalled();
});

test.each(['error', 'empty-final', 'missing-final'] as const)(
  'a capture start ACK rejects an idle completion with %s',
  async completion => {
    const starting = deferred<string>();
    native.startListening.mockReturnValueOnce(starting.promise);
    const { result } = await renderHookAsync(() =>
      useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
    );
    let accepted!: Promise<boolean>;
    await act(async () => {
      accepted = result.current.startListening();
      const sessionId = native.startListening.mock.calls[0][0];
      if (completion === 'error')
        emit({
          sessionId,
          kind: 'error',
          phase: 'finishing',
          message: 'La reconnaissance a échoué.',
        });
      if (completion !== 'missing-final')
        transcript(
          sessionId,
          completion === 'empty-final' ? '  \n ' : 'Un final après l’erreur.',
          true,
        );
      else emit({ sessionId, kind: 'state', phase: 'idle' });
      starting.resolve(status('listening'));
      expect(await accepted).toBe(false);
    });
    expect(result.current.phase).toBe('idle');
    expect(result.current.status?.phase).toBe('idle');
    if (completion === 'error')
      expect(result.current.error).toBe('La reconnaissance a échoué.');
  },
);

test.each(['cancel', 'new-capture', 'new-speech'] as const)(
  'a capture start ACK rejects a natural completion invalidated by %s',
  async replacement => {
    const starting = deferred<string>();
    native.startListening.mockReturnValueOnce(starting.promise);
    const { result } = await renderHookAsync(() =>
      useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
    );
    let accepted!: Promise<boolean>;
    await act(async () => {
      accepted = result.current.startListening();
      transcript(native.startListening.mock.calls[0][0], 'Ancien final.', true);
      if (replacement === 'cancel') await result.current.cancel();
      else if (replacement === 'new-capture')
        expect(await result.current.startListening()).toBe(true);
      else expect(await result.current.beginSpeech('new-reply')).toBe(true);
      starting.resolve(status('listening'));
      expect(await accepted).toBe(false);
    });
    expect(result.current.phase).toBe(
      replacement === 'cancel'
        ? 'idle'
        : replacement === 'new-capture'
        ? 'listening'
        : 'speaking',
    );
  },
);

test('startListening returns false on a rejected or inactive native start and permits retry', async () => {
  native.startListening
    .mockRejectedValueOnce(new Error('Micro indisponible.'))
    .mockResolvedValueOnce(status());
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    expect(await result.current.startListening()).toBe(false);
  });
  expect(result.current.error).toBe('Micro indisponible.');
  await act(async () => {
    expect(await result.current.startListening()).toBe(false);
    expect(await result.current.startListening()).toBe(true);
  });
  expect(result.current.phase).toBe('listening');
});

test.each([
  { enabled: false, appState: 'active' },
  { enabled: true, appState: 'background' },
])(
  'startListening returns false before native capture when blocked by %j',
  async scenario => {
    Object.defineProperty(AppState, 'currentState', {
      value: scenario.appState,
    });
    const { result } = await renderHookAsync(() =>
      useLocalVoice({ onTranscript: jest.fn(), enabled: scenario.enabled }),
    );
    await act(async () => {
      expect(await result.current.startListening()).toBe(false);
    });
    expect(native.startListening).not.toHaveBeenCalled();
  },
);

test('onEvent preserves final capture identity and waits for a separate native idle event', async () => {
  const onEvent = jest.fn();
  const onTranscript = jest.fn();
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript, onEvent, enabled: true }),
  );
  await act(async () => {
    expect(await result.current.startListening()).toBe(true);
  });
  const sessionId = native.startListening.mock.calls[0][0];
  const final = {
    sessionId,
    kind: 'transcript',
    phase: 'finishing',
    text: 'Le prochain tour est vendredi.',
    isFinal: true,
  };
  const diagnostics = inputDiagnostics();
  await act(async () => {
    emit({ sessionId, kind: 'input', phase: 'listening', diagnostics });
    emit(final);
  });
  expect(onEvent.mock.calls.map(call => call[0])).toEqual([
    { sessionId, kind: 'input', phase: 'listening', diagnostics },
    final,
  ]);
  expect(onTranscript).toHaveBeenCalledWith(final.text);
  expect(result.current.phase).toBe('finishing');
  await act(async () => {
    emit({ sessionId, kind: 'state', phase: 'idle' });
  });
  expect(onEvent).toHaveBeenLastCalledWith({
    sessionId,
    kind: 'state',
    phase: 'idle',
  });
  expect(result.current.phase).toBe('idle');
});

test('a natural speech idle event releases its identity before invoking onEvent', async () => {
  let restart: Promise<boolean> | undefined;
  const onEvent = jest.fn(event => {
    if (event.kind === 'state' && event.phase === 'idle') {
      restart = result.current.startListening();
    }
  });
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), onEvent, enabled: true }),
  );
  await act(async () => {
    await result.current.beginSpeech('reply-current');
    emit({ sessionId: 'reply-current', kind: 'state', phase: 'idle' });
    expect(await restart).toBe(true);
  });
  expect(onEvent).toHaveBeenCalledWith({
    sessionId: 'reply-current',
    kind: 'state',
    phase: 'idle',
  });
  expect(result.current.phase).toBe('listening');
  expect(native.cancelVoice).not.toHaveBeenCalled();
});

test('a native interruption adopts its already-running capture once and preserves the first words', async () => {
  const onEvent = jest.fn();
  const onTranscript = jest.fn();
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript, onEvent, enabled: true }),
  );
  await act(async () => {
    await result.current.beginSpeech('reply-interrupted');
  });
  const interruption = {
    kind: 'interruption',
    sessionId: 'reply-interrupted',
    captureSessionId: 'capture-promoted',
    phase: 'listening',
  };
  await act(async () => {
    emit(interruption);
    emit(interruption);
    emit({ sessionId: 'reply-interrupted', kind: 'state', phase: 'idle' });
    transcript('reply-interrupted', 'Texte de l’ancienne lecture.', true);
    transcript('capture-promoted', 'Non, attends, le début est conservé.');
  });

  expect(onEvent.mock.calls.map(call => call[0])).toEqual([
    interruption,
    {
      sessionId: 'capture-promoted',
      kind: 'transcript',
      phase: 'listening',
      text: 'Non, attends, le début est conservé.',
      isFinal: false,
    },
  ]);
  expect(onTranscript).toHaveBeenCalledWith(
    'Non, attends, le début est conservé.',
  );
  expect(result.current.phase).toBe('listening');
  expect(result.current.captureBusy).toBe(true);
  expect(native.startListening).not.toHaveBeenCalled();
  expect(native.cancelVoice).not.toHaveBeenCalled();
  await act(async () => {
    expect(await result.current.finishListening()).toBe(true);
  });
  expect(native.stopListening).toHaveBeenCalledTimes(1);
});

test.each(
  (['begin', 'enqueue', 'finish'] as const).flatMap(command =>
    (['resolved', 'rejected'] as const).map(outcome => ({ command, outcome })),
  ),
)(
  'an interrupted $command promise that is $outcome cannot revive speech or cancel the promoted capture',
  async ({ command, outcome }) => {
    const pending = deferred<string>();
    const { result } = await renderHookAsync(() =>
      useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
    );
    let oldCommand!: Promise<boolean>;
    await act(async () => {
      if (command === 'begin') {
        native.beginSpeech.mockReturnValueOnce(pending.promise);
        oldCommand = result.current.beginSpeech('old-reply');
      } else {
        await result.current.beginSpeech('old-reply');
        if (command === 'enqueue') {
          native.enqueueSpeech.mockReturnValueOnce(pending.promise);
          oldCommand = result.current.enqueueSpeech(
            'Ancien segment.',
            'old-reply',
          );
        } else {
          native.finishSpeech.mockReturnValueOnce(pending.promise);
          oldCommand = result.current.finishSpeech('old-reply');
        }
      }
      emit({
        kind: 'interruption',
        sessionId: 'old-reply',
        captureSessionId: 'fresh-capture',
        phase: 'listening',
      });
      if (outcome === 'resolved') pending.resolve(status('speaking'));
      else pending.reject(new Error('L’ancienne lecture est terminée.'));
      expect(await oldCommand).toBe(false);
    });

    expect(result.current.phase).toBe('listening');
    expect(result.current.error).toBe('');
    expect(native.cancelVoice).not.toHaveBeenCalled();
    expect(native.startListening).not.toHaveBeenCalled();
    await act(async () => {
      expect(
        await result.current.enqueueSpeech('Ne pas reprendre.', 'old-reply'),
      ).toBe(false);
      expect(await result.current.finishSpeech('old-reply')).toBe(false);
    });
    expect(native.enqueueSpeech).toHaveBeenCalledTimes(
      command === 'enqueue' ? 1 : 0,
    );
    expect(native.finishSpeech).toHaveBeenCalledTimes(
      command === 'finish' ? 1 : 0,
    );
  },
);

test.each(['cancelled', 'hidden', 'background'] as const)(
  'a late interruption is ignored when speech is %s',
  async lifecycle => {
    const onEvent = jest.fn();
    const onTranscript = jest.fn();
    const { result, rerenderAsync } = await renderHookAsync<
      ReturnType<typeof useLocalVoice>,
      { enabled: boolean }
    >(({ enabled }) => useLocalVoice({ onTranscript, onEvent, enabled }), {
      initialProps: { enabled: true },
    });
    await act(async () => {
      await result.current.beginSpeech('retired-reply');
    });
    if (lifecycle === 'hidden') await rerenderAsync({ enabled: false });
    else
      await act(async () => {
        if (lifecycle === 'background') stateChanged('background');
        else await result.current.cancel();
      });
    await act(async () => {
      emit({
        kind: 'interruption',
        sessionId: 'retired-reply',
        captureSessionId: 'late-capture',
        phase: 'listening',
      });
      transcript('late-capture', 'Ne pas envoyer ce texte.', true);
    });
    expect(onEvent).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('idle');
    expect(native.startListening).not.toHaveBeenCalled();
  },
);

test('speech watcher input never reaches turn detection before a native interruption', async () => {
  const onEvent = jest.fn();
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), onEvent, enabled: true }),
  );
  await act(async () => {
    await result.current.beginSpeech('watched-reply');
    emit({
      sessionId: 'watched-reply',
      kind: 'input',
      phase: 'listening',
      diagnostics: inputDiagnostics(),
    });
  });
  expect(onEvent).not.toHaveBeenCalled();
  expect(result.current.phase).toBe('speaking');
  expect(result.current.diagnostics).toBeNull();
});

test('monitoring readiness follows current speech events and resets at handoff and cancellation', async () => {
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    await result.current.beginSpeech('monitored-reply');
    emit({
      sessionId: 'monitored-reply',
      kind: 'state',
      phase: 'speaking',
      monitoring: true,
    });
  });
  expect(result.current.status).toMatchObject({
    phase: 'speaking',
    monitoring: true,
  });
  await act(async () => {
    emit({ sessionId: 'monitored-reply', kind: 'state', phase: 'speaking' });
  });
  expect(result.current.status?.monitoring).toBe(false);
  await act(async () => {
    emit({
      sessionId: 'monitored-reply',
      kind: 'state',
      phase: 'speaking',
      monitoring: true,
    });
    emit({
      kind: 'interruption',
      sessionId: 'monitored-reply',
      captureSessionId: 'monitored-capture',
      phase: 'listening',
    });
    emit({
      sessionId: 'monitored-reply',
      kind: 'state',
      phase: 'speaking',
      monitoring: true,
    });
  });
  expect(result.current.status).toMatchObject({
    phase: 'listening',
    monitoring: false,
  });
  await act(async () => {
    await result.current.cancel();
  });
  expect(result.current.status).toMatchObject({
    phase: 'idle',
    monitoring: false,
  });
});

test('a capability refresh from before speech cannot overwrite current monitoring readiness', async () => {
  const refresh = deferred<string>();
  native.getVoiceStatus.mockReturnValueOnce(refresh.promise);
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    await result.current.beginSpeech('fresh-monitored-reply');
    emit({
      sessionId: 'fresh-monitored-reply',
      kind: 'state',
      phase: 'speaking',
      monitoring: true,
    });
    refresh.resolve(status());
  });
  expect(result.current.status).toMatchObject({
    phase: 'speaking',
    monitoring: true,
  });
});

test.each([true, false])(
  'an older command ACK cannot overwrite the current monitoring=%s event',
  async monitoring => {
    const pending = deferred<string>();
    native.beginSpeech.mockReturnValueOnce(pending.promise);
    const { result } = await renderHookAsync(() =>
      useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
    );
    let beginning!: Promise<boolean>;
    await act(async () => {
      beginning = result.current.beginSpeech('rearming-reply');
      emit({
        sessionId: 'rearming-reply',
        kind: 'state',
        phase: 'speaking',
        monitoring,
      });
      pending.resolve(
        JSON.stringify({
          ...JSON.parse(status('speaking')),
          monitoring: !monitoring,
        }),
      );
      expect(await beginning).toBe(true);
    });
    expect(result.current.status).toMatchObject({
      phase: 'speaking',
      monitoring,
    });
  },
);

test('the interruption protocol requires a distinct nonempty capture identity and listening phase', () => {
  const event = {
    kind: 'interruption',
    sessionId: 'old-reply',
    captureSessionId: 'new-capture',
    phase: 'listening',
  };
  expect(parseVoiceEvent(JSON.stringify(event))).toEqual(event);
  for (const patch of [
    { captureSessionId: undefined },
    { captureSessionId: '' },
    { captureSessionId: '   ' },
    { captureSessionId: 'old-reply' },
    { phase: 'speaking' },
  ])
    expect(() =>
      parseVoiceEvent(JSON.stringify({ ...event, ...patch })),
    ).toThrow();
});

test('status and state events validate optional monitoring booleans', () => {
  for (const monitoring of [true, false]) {
    expect(
      parseVoiceStatus(
        JSON.stringify({ ...JSON.parse(status('speaking')), monitoring }),
      ),
    ).toMatchObject({ monitoring });
    expect(
      parseVoiceEvent(
        JSON.stringify({
          sessionId: 'reply',
          kind: 'state',
          phase: 'speaking',
          monitoring,
        }),
      ),
    ).toMatchObject({ monitoring });
  }
  for (const monitoring of ['true', 1, null]) {
    expect(() =>
      parseVoiceStatus(
        JSON.stringify({ ...JSON.parse(status('speaking')), monitoring }),
      ),
    ).toThrow();
    expect(() =>
      parseVoiceEvent(
        JSON.stringify({
          sessionId: 'reply',
          kind: 'state',
          phase: 'speaking',
          monitoring,
        }),
      ),
    ).toThrow();
  }
});

test('onEvent uses the latest callback without resubscribing to native events', async () => {
  const first = jest.fn();
  const latest = jest.fn();
  const { result, rerenderAsync } = await renderHookAsync<
    ReturnType<typeof useLocalVoice>,
    { callback: typeof first }
  >(
    ({ callback }) =>
      useLocalVoice({
        onTranscript: jest.fn(),
        onEvent: callback,
        enabled: true,
      }),
    {
      initialProps: { callback: first },
    },
  );
  await act(async () => {
    await result.current.startListening();
  });
  const sessionId = native.startListening.mock.calls[0][0];
  await rerenderAsync({ callback: latest });
  await act(async () => {
    transcript(sessionId, 'Une nouvelle callback.');
  });
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledTimes(1);
  expect(native.onVoiceEvent).toHaveBeenCalledTimes(1);
});

test('a pending cancellation cannot appear as natural speech completion in onEvent', async () => {
  const pending = deferred<string>();
  native.cancelVoice.mockReturnValueOnce(pending.promise);
  const onEvent = jest.fn();
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), onEvent, enabled: true }),
  );
  let cancellation: Promise<boolean>;
  await act(async () => {
    await result.current.beginSpeech('reply-cancelled');
    cancellation = result.current.cancel();
    emit({ sessionId: 'reply-cancelled', kind: 'state', phase: 'idle' });
    expect(await result.current.startListening()).toBe(false);
  });
  expect(onEvent).not.toHaveBeenCalled();
  await act(async () => {
    pending.resolve(status());
    await cancellation;
  });
  expect(result.current.phase).toBe('idle');
});

test('onEvent rejects stale or malformed events and preserves the current capture', async () => {
  const onEvent = jest.fn();
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), onEvent, enabled: true }),
  );
  await act(async () => {
    await result.current.startListening();
  });
  const sessionId = native.startListening.mock.calls[0][0];
  await act(async () => {
    transcript('older-capture', 'Ancien texte', true);
    emit({
      sessionId,
      kind: 'transcript',
      phase: 'listening',
      text: 'missing final flag',
    });
  });
  expect(onEvent).not.toHaveBeenCalled();
  expect(result.current.phase).toBe('listening');
});

test.each(['hidden', 'background', 'unmounted'])(
  'onEvent does not deliver current-session events while %s',
  async lifecycle => {
    const onEvent = jest.fn();
    const { result, rerenderAsync, unmountAsync } = await renderHookAsync<
      ReturnType<typeof useLocalVoice>,
      { enabled: boolean }
    >(
      ({ enabled }) =>
        useLocalVoice({ onTranscript: jest.fn(), onEvent, enabled }),
      {
        initialProps: { enabled: true },
      },
    );
    await act(async () => {
      await result.current.startListening();
    });
    const sessionId = native.startListening.mock.calls[0][0];
    if (lifecycle === 'hidden') await rerenderAsync({ enabled: false });
    else if (lifecycle === 'unmounted') await unmountAsync();
    else await act(async () => stateChanged('background'));
    await act(async () => {
      transcript(sessionId, 'Ne pas relancer automatiquement.', true);
      emit({ sessionId, kind: 'state', phase: 'idle' });
    });
    expect(onEvent).not.toHaveBeenCalled();
  },
);

test('a retained startListening callback returns false after unmount', async () => {
  const { result, unmountAsync } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  const startListening = result.current.startListening;
  await unmountAsync();
  await act(async () => {
    expect(await startListening()).toBe(false);
  });
  expect(native.startListening).not.toHaveBeenCalled();
});

test('legacy onTranscript cancellation invalidates onEvent before delivery', async () => {
  const pending = deferred<string>();
  native.cancelVoice.mockReturnValueOnce(pending.promise);
  const onEvent = jest.fn();
  const onTranscript: jest.Mock<Promise<boolean>, []> = jest.fn(
    (): Promise<boolean> => result.current.cancel(),
  );
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript, onEvent, enabled: true }),
  );
  await act(async () => {
    await result.current.startListening();
  });
  await act(async () => {
    transcript(native.startListening.mock.calls[0][0], 'Annule ce tour.');
  });
  expect(onTranscript).toHaveBeenCalledTimes(1);
  expect(onEvent).not.toHaveBeenCalled();
  expect(result.current.phase).toBe('stopping');
  await act(async () => {
    pending.resolve(status());
    await pending.promise;
  });
  expect(result.current.phase).toBe('idle');
});

test.each([
  { bufferCount: -1 },
  { frameCount: 1.5 },
  { sampleRate: -48_000 },
  { channels: '1' },
  { peak: 1.01 },
  { level: -0.01 },
  { measured: 'yes' },
  { elapsedMs: null },
  { inputPort: 1 },
  { firstBufferDelayMs: -1 },
  { errorDomain: 1 },
  { errorCode: 1.5 },
])(
  'rejects malformed microphone diagnostics %j at either native boundary',
  extra => {
    const diagnostics = inputDiagnostics(extra);
    expect(() =>
      parseVoiceStatus(
        JSON.stringify({ ...JSON.parse(status()), diagnostics }),
      ),
    ).toThrow();
    expect(() =>
      parseVoiceEvent(
        JSON.stringify({
          sessionId: 'capture-1',
          kind: 'input',
          phase: 'listening',
          diagnostics,
        }),
      ),
    ).toThrow();
  },
);

test('input events require diagnostics and cannot claim a different phase', () => {
  expect(() =>
    parseVoiceEvent(
      JSON.stringify({
        sessionId: 'capture-1',
        kind: 'input',
        phase: 'listening',
      }),
    ),
  ).toThrow();
  expect(() =>
    parseVoiceEvent(
      JSON.stringify({
        sessionId: 'capture-1',
        kind: 'input',
        phase: 'idle',
        diagnostics: inputDiagnostics(),
      }),
    ),
  ).toThrow();
});

test('diagnostics retain only measurement fields, without transcript or audio payloads', () => {
  const parsed = parseVoiceStatus(
    JSON.stringify({
      ...JSON.parse(status()),
      diagnostics: inputDiagnostics({
        text: 'private transcript',
        audio: [1, 2, 3],
      }),
    }),
  );
  expect(parsed.diagnostics).toEqual(inputDiagnostics());
});

test.each([null, 'route', [1], Array(9).fill('route'), ['x'.repeat(401)]])(
  'rejects malformed or unbounded audio history %j at both native boundaries',
  audioDiagnostics => {
    expect(() =>
      parseVoiceStatus(
        JSON.stringify({ ...JSON.parse(status()), audioDiagnostics }),
      ),
    ).toThrow('Historique audio invalide.');
    expect(() =>
      parseVoiceEvent(
        JSON.stringify({
          sessionId: 'capture',
          kind: 'error',
          phase: 'idle',
          message: 'Session interrompue.',
          audioDiagnostics,
        }),
      ),
    ).toThrow('Historique audio invalide.');
  },
);

test('retains current audio failure details through cancellation, but clears them for a new turn', async () => {
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    await result.current.startListening();
  });
  const sessionId = native.startListening.mock.calls[0][0];
  const audioDiagnostics = ['route reason=8 engine=0 decision=stop'];
  await act(async () => {
    emit({
      sessionId,
      kind: 'error',
      phase: 'idle',
      message: 'Session interrompue.',
      audioDiagnostics,
    });
    await result.current.cancel();
  });
  expect(result.current.audioDiagnostics).toEqual(audioDiagnostics);
  await act(async () => {
    await result.current.startListening();
  });
  expect(result.current.audioDiagnostics).toEqual([]);
  await act(async () => {
    emit({
      sessionId,
      kind: 'error',
      phase: 'idle',
      message: 'Ancienne erreur.',
      audioDiagnostics,
    });
  });
  expect(result.current.audioDiagnostics).toEqual([]);
  expect(result.current.error).toBe('');
});

test('a stale capability refresh cannot overwrite newer audio failure history', async () => {
  const initial = deferred<string>();
  native.getVoiceStatus.mockReturnValueOnce(initial.promise);
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    await result.current.startListening();
  });
  const sessionId = native.startListening.mock.calls[0][0];
  const audioDiagnostics = ['route reason=2 decision=stop'];
  await act(async () => {
    emit({
      sessionId,
      kind: 'error',
      phase: 'idle',
      message: 'Session interrompue.',
      audioDiagnostics,
    });
    initial.resolve(
      JSON.stringify({ ...JSON.parse(status()), audioDiagnostics: ['older'] }),
    );
  });
  expect(result.current.audioDiagnostics).toEqual(audioDiagnostics);
});

test('reads diagnostics when a rejected start arrives before its native error event', async () => {
  const audioDiagnostics = ['route reason=8 engine=0 decision=stop'];
  native.startListening.mockRejectedValueOnce(
    new Error('Session interrompue.'),
  );
  native.getVoiceStatus
    .mockResolvedValueOnce(status())
    .mockResolvedValueOnce(
      JSON.stringify({ ...JSON.parse(status()), audioDiagnostics }),
    );
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    expect(await result.current.startListening()).toBe(false);
  });
  expect(result.current.error).toBe('Session interrompue.');
  expect(result.current.audioDiagnostics).toEqual(audioDiagnostics);
  expect(result.current.phase).toBe('idle');
  expect(native.startListening).toHaveBeenCalledTimes(1);
});

test('a failed speech command stops before diagnostics and cannot cancel the next capture after a delayed read', async () => {
  const delayedDetails = deferred<string>();
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    await result.current.beginSpeech('old-reply');
  });
  native.getVoiceStatus.mockReturnValueOnce(delayedDetails.promise);
  native.enqueueSpeech.mockRejectedValueOnce(new Error('Lecture arrêtée.'));
  let failed!: Promise<boolean>;
  await act(async () => {
    failed = result.current.enqueueSpeech('Une phrase.', 'old-reply');
  });
  expect(native.cancelVoice).toHaveBeenCalledTimes(1);
  expect(native.getVoiceStatus).toHaveBeenCalledTimes(2);
  native.startListening.mockResolvedValueOnce(
    JSON.stringify({
      ...JSON.parse(status('listening')),
      audioDiagnostics: ['new-capture'],
    }),
  );
  await act(async () => {
    expect(await result.current.startListening()).toBe(true);
    delayedDetails.resolve(
      JSON.stringify({
        ...JSON.parse(status()),
        audioDiagnostics: ['old-failure'],
      }),
    );
    expect(await failed).toBe(false);
  });
  expect(native.cancelVoice).toHaveBeenCalledTimes(1);
  expect(result.current.phase).toBe('listening');
  expect(result.current.audioDiagnostics).toEqual(['new-capture']);
  expect(result.current.error).toBe('');
});

test('a cancelled start cannot deliver its old load error after delayed diagnostics', async () => {
  const details = deferred<string>();
  const onEvent = jest.fn();
  native.startListening.mockRejectedValueOnce(new Error('Ancien chargement.'));
  native.getVoiceStatus.mockResolvedValueOnce(status()).mockReturnValueOnce(details.promise);
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), onEvent, enabled: true }),
  );
  let start!: Promise<boolean>;
  await act(async () => { start = result.current.startListening(); });
  await act(async () => { await result.current.cancel(); });
  await act(async () => {
    details.resolve(JSON.stringify({ ...JSON.parse(status()), audioDiagnostics: ['old-load'] }));
    expect(await start).toBe(false);
  });
  expect(onEvent).not.toHaveBeenCalled();
  expect(result.current.audioDiagnostics).toEqual([]);
});

test('metering updates measurements without changing the draft or reviving a finished capture', async () => {
  const onTranscript = jest.fn();
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript, enabled: true }),
  );
  await act(async () => {
    await result.current.startListening();
  });
  const sessionId = native.startListening.mock.calls[0][0];
  const diagnostics = inputDiagnostics();
  await act(async () => {
    emit({ sessionId, kind: 'input', phase: 'listening', diagnostics });
  });
  expect(result.current.diagnostics).toEqual(diagnostics);
  expect(onTranscript).not.toHaveBeenCalled();
  await act(async () => {
    await result.current.finishListening();
  });
  await act(async () => {
    emit({ sessionId, kind: 'input', phase: 'listening', diagnostics });
  });
  expect(result.current.phase).toBe('finishing');
  expect(onTranscript).not.toHaveBeenCalled();
  await act(async () => {
    transcript(sessionId, 'Le texte final.', true);
  });
  expect(result.current.diagnostics).toEqual(diagnostics);
  expect(onTranscript).toHaveBeenCalledTimes(1);
});

test('cancelled and stale input events cannot overwrite measurements of the current session', async () => {
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    await result.current.startListening();
  });
  const oldSession = native.startListening.mock.calls[0][0];
  const diagnostics = inputDiagnostics();
  await act(async () => {
    emit({
      sessionId: oldSession,
      kind: 'input',
      phase: 'listening',
      diagnostics,
    });
    await result.current.cancel();
    emit({
      sessionId: oldSession,
      kind: 'input',
      phase: 'listening',
      diagnostics: inputDiagnostics({ bufferCount: 999 }),
    });
  });
  expect(result.current.diagnostics).toEqual(diagnostics);
  await act(async () => {
    await result.current.startListening();
  });
  expect(result.current.diagnostics).toBeNull();
  await act(async () => {
    emit({
      sessionId: oldSession,
      kind: 'input',
      phase: 'listening',
      diagnostics: inputDiagnostics({ bufferCount: -1 }),
    });
  });
  expect(result.current.diagnostics).toBeNull();
  expect(result.current.error).toBe('');
});

test('late command status cannot replace newer input observations', async () => {
  const pending = deferred<string>();
  native.startListening.mockReturnValueOnce(pending.promise);
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  let start: Promise<boolean>;
  await act(async () => {
    start = result.current.startListening();
    await Promise.resolve();
  });
  const sessionId = native.startListening.mock.calls[0][0];
  const diagnostics = inputDiagnostics();
  await act(async () => {
    emit({ sessionId, kind: 'input', phase: 'listening', diagnostics });
  });
  await act(async () => {
    pending.resolve(
      JSON.stringify({
        ...JSON.parse(status('listening')),
        diagnostics: inputDiagnostics({
          bufferCount: 0,
          frameCount: 0,
          elapsedMs: 0,
        }),
      }),
    );
    await start;
  });
  expect(result.current.diagnostics).toEqual(diagnostics);
});

test('terminal errors retain their final input observations after status refresh', async () => {
  native.getVoiceStatus.mockResolvedValue(
    JSON.stringify({
      ...JSON.parse(status()),
      diagnostics: inputDiagnostics({
        bufferCount: 0,
        frameCount: 0,
        elapsedMs: 0,
      }),
    }),
  );
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    await result.current.startListening();
  });
  const sessionId = native.startListening.mock.calls[0][0];
  const diagnostics = inputDiagnostics({
    errorDomain: 'SyntheticDomain',
    errorCode: -1,
  });
  await act(async () => {
    emit({
      sessionId,
      kind: 'error',
      phase: 'idle',
      message: 'La dictée s’est arrêtée.',
      diagnostics,
    });
  });
  expect(result.current.phase).toBe('idle');
  expect(result.current.diagnostics).toEqual(diagnostics);
  expect(result.current.error).toBe('La dictée s’est arrêtée.');
});

test('updates the draft only from partial and final text for the current capture', async () => {
  const onTranscript = jest.fn();
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript, enabled: true }),
  );
  await act(async () => {
    await result.current.startListening();
  });
  const sessionId = native.startListening.mock.calls[0][0];

  await act(async () => {
    transcript('unrelated-session', 'Ne pas afficher ceci.');
    transcript(sessionId, 'Salut, peux-tu');
    transcript(sessionId, 'Salut, peux-tu me rappeler ça tantôt?', true);
  });

  expect(onTranscript.mock.calls.map(call => call[0])).toEqual([
    'Salut, peux-tu',
    'Salut, peux-tu me rappeler ça tantôt?',
  ]);
  expect(result.current.phase).toBe('idle');
  expect(result.current.captureBusy).toBe(false);
});

test('finishing capture keeps the final local transcript available', async () => {
  const onTranscript = jest.fn();
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript, enabled: true }),
  );
  await act(async () => {
    await result.current.startListening();
  });
  const sessionId = native.startListening.mock.calls[0][0];

  await act(async () => {
    await result.current.finishListening();
  });
  expect(native.stopListening).toHaveBeenCalledTimes(1);
  expect(result.current.captureBusy).toBe(true);

  await act(async () => {
    transcript(sessionId, 'Vendredi matin, finalement.', true);
  });
  expect(onTranscript).toHaveBeenLastCalledWith('Vendredi matin, finalement.');
  expect(result.current.captureBusy).toBe(false);
});

test('finishListening reports a native stop rejection instead of a successful turn boundary', async () => {
  native.stopListening.mockRejectedValueOnce(
    new Error('Arrêt du micro impossible.'),
  );
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    expect(await result.current.finishListening()).toBe(false);
    await result.current.startListening();
    expect(await result.current.finishListening()).toBe(false);
  });
  expect(result.current.phase).toBe('idle');
  expect(result.current.error).toBe('Arrêt du micro impossible.');
  expect(native.cancelVoice).toHaveBeenCalledTimes(1);
});

test('finishListening succeeds when final text and native idle arrive before the stop ACK', async () => {
  const pending = deferred<string>();
  native.stopListening.mockReturnValueOnce(pending.promise);
  const onTranscript = jest.fn();
  const onEvent = jest.fn();
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript, onEvent, enabled: true }),
  );
  await act(async () => {
    await result.current.startListening();
  });
  const sessionId = native.startListening.mock.calls[0][0];
  let finish: Promise<boolean>;
  await act(async () => {
    finish = result.current.finishListening();
    emit({
      sessionId,
      kind: 'transcript',
      phase: 'finishing',
      text: 'La phrase finale complète.',
      isFinal: true,
    });
    emit({ sessionId, kind: 'state', phase: 'idle' });
  });
  expect(result.current.phase).toBe('idle');
  await act(async () => {
    pending.resolve(status('finishing'));
    expect(await finish).toBe(true);
  });
  expect(result.current.phase).toBe('idle');
  expect(onTranscript).toHaveBeenCalledWith('La phrase finale complète.');
  expect(onEvent.mock.calls.map(call => call[0].kind)).toEqual([
    'transcript',
    'state',
  ]);
  expect(native.cancelVoice).not.toHaveBeenCalled();
});

test('finishListening rejects a stop ACK invalidated by cancellation', async () => {
  const pending = deferred<string>();
  native.stopListening.mockReturnValueOnce(pending.promise);
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  let finish: Promise<boolean>;
  await act(async () => {
    await result.current.startListening();
    finish = result.current.finishListening();
    await result.current.cancel();
  });
  await act(async () => {
    pending.resolve(status('finishing'));
    expect(await finish).toBe(false);
  });
  expect(result.current.phase).toBe('idle');
});

test('cancellation rejects late transcripts, state changes, and errors', async () => {
  const onTranscript = jest.fn();
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript, enabled: true }),
  );
  await act(async () => {
    await result.current.startListening();
  });
  const sessionId = native.startListening.mock.calls[0][0];
  await act(async () => {
    await result.current.cancel();
    transcript(sessionId, 'Ancienne phrase', true);
    emit({ sessionId, kind: 'state', phase: 'listening' });
    emit({
      sessionId,
      kind: 'error',
      phase: 'idle',
      message: 'Erreur de la session annulée',
    });
  });

  expect(native.cancelVoice).toHaveBeenCalled();
  expect(onTranscript).not.toHaveBeenCalled();
  expect(result.current.phase).toBe('idle');
  expect(result.current.captureBusy).toBe(false);
  expect(result.current.error).toBe('');
});

test('a pending native start cannot revive capture after cancellation', async () => {
  const pending = deferred<string>();
  native.startListening.mockReturnValueOnce(pending.promise);
  const onTranscript = jest.fn();
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript, enabled: true }),
  );
  let start: Promise<boolean>;
  await act(async () => {
    start = result.current.startListening();
    await Promise.resolve();
  });
  const sessionId = native.startListening.mock.calls[0][0];

  await act(async () => {
    await result.current.cancel();
  });
  await act(async () => {
    pending.resolve(status('listening'));
    expect(await start).toBe(false);
    transcript(sessionId, 'Trop tard.', true);
  });

  expect(onTranscript).not.toHaveBeenCalled();
  expect(result.current.phase).toBe('idle');
  expect(result.current.captureBusy).toBe(false);
});

test('an inactive privacy prompt preserves the pending first-time authorization', async () => {
  const pending = deferred<string>();
  native.startListening.mockReturnValueOnce(pending.promise);
  const onTranscript = jest.fn();
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript, enabled: true }),
  );
  let start: Promise<boolean>;
  await act(async () => {
    start = result.current.startListening();
    await Promise.resolve();
  });
  const sessionId = native.startListening.mock.calls[0][0];
  await act(async () => {
    emit({ sessionId, kind: 'state', phase: 'requesting' });
  });
  expect(result.current.phase).toBe('requesting');

  await act(async () => {
    stateChanged('inactive');
    await Promise.resolve();
  });
  expect(native.cancelVoice).not.toHaveBeenCalled();
  expect(result.current.phase).toBe('requesting');
  expect(result.current.captureBusy).toBe(true);

  await act(async () => {
    stateChanged('active');
    pending.resolve(status('listening'));
    await start;
  });
  expect(result.current.phase).toBe('listening');
  expect(native.startListening).toHaveBeenCalledTimes(1);
  expect(native.cancelVoice).not.toHaveBeenCalled();
  await act(async () => {
    transcript(sessionId, 'Le micro fonctionne après mon autorisation.', true);
  });
  expect(onTranscript).toHaveBeenCalledWith(
    'Le micro fonctionne après mon autorisation.',
  );
});

test('a privacy prompt arriving before the next render preserves authorization', async () => {
  const pending = deferred<string>();
  native.startListening.mockReturnValueOnce(pending.promise);
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  let start: Promise<boolean>;
  await act(async () => {
    start = result.current.startListening();
    const sessionId = native.startListening.mock.calls[0][0];
    emit({ sessionId, kind: 'state', phase: 'requesting' });
    stateChanged('inactive');
    await Promise.resolve();
  });
  expect(native.cancelVoice).not.toHaveBeenCalled();

  await act(async () => {
    stateChanged('active');
    pending.resolve(status('listening'));
    await start;
  });
  expect(result.current.phase).toBe('listening');
});

test('actual backgrounding cancels pending authorization and rejects its late start', async () => {
  const pending = deferred<string>();
  native.startListening.mockReturnValueOnce(pending.promise);
  const onTranscript = jest.fn();
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript, enabled: true }),
  );
  let start: Promise<boolean>;
  await act(async () => {
    start = result.current.startListening();
    await Promise.resolve();
  });
  const sessionId = native.startListening.mock.calls[0][0];
  expect(result.current.phase).toBe('requesting');
  await act(async () => {
    stateChanged('inactive');
    stateChanged('background');
    await Promise.resolve();
  });
  expect(native.cancelVoice).toHaveBeenCalledTimes(1);
  expect(result.current.phase).toBe('idle');

  await act(async () => {
    stateChanged('active');
    pending.resolve(status('listening'));
    await start;
    transcript(sessionId, 'Ancienne demande d’autorisation.', true);
  });
  expect(onTranscript).not.toHaveBeenCalled();
  expect(result.current.phase).toBe('idle');
  expect(result.current.captureBusy).toBe(false);
});

test('leaving the conversation cancels capture and invalidates its callbacks', async () => {
  const onTranscript = jest.fn();
  const { result, rerenderAsync } = await renderHookAsync<
    ReturnType<typeof useLocalVoice>,
    { enabled: boolean }
  >(({ enabled }) => useLocalVoice({ onTranscript, enabled }), {
    initialProps: { enabled: true },
  });
  await act(async () => {
    await result.current.startListening();
  });
  const sessionId = native.startListening.mock.calls[0][0];
  await rerenderAsync({ enabled: false });

  await act(async () => {
    transcript(sessionId, 'Ne pas modifier une autre page.', true);
  });

  expect(native.cancelVoice).toHaveBeenCalled();
  expect(onTranscript).not.toHaveBeenCalled();
  expect(result.current.phase).toBe('idle');
  await act(async () => {
    await result.current.startListening();
    await result.current.speak('Ne pas lire depuis un autre écran.', 'hidden');
  });
  expect(native.startListening).toHaveBeenCalledTimes(1);
  expect(native.speak).not.toHaveBeenCalled();
});

test('backgrounding the app cancels voice without accepting late text', async () => {
  const onTranscript = jest.fn();
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript, enabled: true }),
  );
  await act(async () => {
    await result.current.startListening();
  });
  const sessionId = native.startListening.mock.calls[0][0];
  await act(async () => {
    stateChanged('background');
    await Promise.resolve();
    transcript(sessionId, 'Ne pas conserver ce résultat.', true);
  });

  expect(native.cancelVoice).toHaveBeenCalled();
  expect(onTranscript).not.toHaveBeenCalled();
  expect(result.current.phase).toBe('idle');
  expect(result.current.captureBusy).toBe(false);
});

test('playback after cancellation rejects old capture and playback events', async () => {
  const onTranscript = jest.fn();
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript, enabled: true }),
  );
  await act(async () => {
    await result.current.startListening();
  });
  const captureId = native.startListening.mock.calls[0][0];
  await act(async () => {
    await result.current.cancel();
  });
  await act(async () => {
    await result.current.speak('Bonjour, comment ça va?', 'response-1');
    transcript(captureId, 'Écho du haut-parleur.', true);
  });

  expect(native.speak).toHaveBeenCalledWith(
    'Bonjour, comment ça va?',
    'response-1',
  );
  expect(onTranscript).not.toHaveBeenCalled();
  expect(result.current.phase).toBe('speaking');

  await act(async () => {
    await result.current.cancel();
    emit({ sessionId: 'response-1', kind: 'state', phase: 'speaking' });
  });
  expect(result.current.phase).toBe('idle');
});

test('a pending native playback cannot revive after leaving the conversation', async () => {
  const pending = deferred<string>();
  native.speak.mockReturnValueOnce(pending.promise);
  const { result, rerenderAsync } = await renderHookAsync<
    ReturnType<typeof useLocalVoice>,
    { enabled: boolean }
  >(({ enabled }) => useLocalVoice({ onTranscript: jest.fn(), enabled }), {
    initialProps: { enabled: true },
  });
  let playback: Promise<void>;
  await act(async () => {
    playback = result.current.speak(
      'Réponse qui arrive trop tard.',
      'response-1',
    );
    await Promise.resolve();
  });
  await rerenderAsync({ enabled: false });
  await act(async () => {
    pending.resolve(status('speaking'));
    await playback;
    emit({ sessionId: 'response-1', kind: 'state', phase: 'speaking' });
  });

  expect(native.cancelVoice).toHaveBeenCalled();
  expect(result.current.phase).toBe('idle');
});

test('empty responses never start native playback', async () => {
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    await result.current.speak('  \n ', 'empty-response');
  });
  expect(native.speak).not.toHaveBeenCalled();
  expect(result.current.phase).toBe('idle');
});

test('progressive speech opens one identity and returns idle only after its own completion', async () => {
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  expect(result.current.streamingSupported).toBe(true);
  expect(native.beginSpeech).not.toHaveBeenCalled();
  await act(async () => {
    expect(await result.current.beginSpeech('reply-1')).toBe(true);
    expect(
      await result.current.enqueueSpeech('Bonjour de Québec.', 'reply-1'),
    ).toBe(true);
    expect(await result.current.finishSpeech('reply-1')).toBe(true);
  });
  expect(native.beginSpeech).toHaveBeenCalledWith('reply-1');
  expect(native.enqueueSpeech).toHaveBeenCalledWith(
    'Bonjour de Québec.',
    'reply-1',
  );
  expect(native.finishSpeech).toHaveBeenCalledWith('reply-1');
  expect(result.current.phase).toBe('speaking');
  await act(async () => {
    emit({ sessionId: 'other-reply', kind: 'state', phase: 'idle' });
  });
  expect(result.current.phase).toBe('speaking');
  await act(async () => {
    emit({ sessionId: 'reply-1', kind: 'state', phase: 'idle' });
  });
  expect(result.current.phase).toBe('idle');
});

test('progressive speech cannot queue or finish an old response after cancellation', async () => {
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    await result.current.beginSpeech('reply-1');
    await result.current.cancel();
    expect(
      await result.current.enqueueSpeech('Réponse périmée.', 'reply-1'),
    ).toBe(false);
    expect(await result.current.finishSpeech('reply-1')).toBe(false);
  });
  expect(native.enqueueSpeech).not.toHaveBeenCalled();
  expect(native.finishSpeech).not.toHaveBeenCalled();
  expect(result.current.phase).toBe('idle');
});

test('an immediately drained progressive finish releases capture without cancelling it', async () => {
  native.finishSpeech.mockResolvedValueOnce(status());
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    await result.current.beginSpeech('reply-1');
    expect(await result.current.finishSpeech('reply-1')).toBe(true);
  });
  expect(result.current.phase).toBe('idle');
  await act(async () => {
    await result.current.startListening();
  });
  expect(result.current.phase).toBe('listening');
  expect(native.cancelVoice).not.toHaveBeenCalled();
});

test('a natural speech idle before the finish ACK succeeds without reviving playback', async () => {
  const pending = deferred<string>();
  native.finishSpeech.mockReturnValueOnce(pending.promise);
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  let finish: Promise<boolean>;
  await act(async () => {
    await result.current.beginSpeech('reply-drained');
    finish = result.current.finishSpeech('reply-drained');
    emit({ sessionId: 'reply-drained', kind: 'state', phase: 'idle' });
  });
  expect(result.current.phase).toBe('idle');
  await act(async () => {
    pending.resolve(status('speaking'));
    expect(await finish).toBe(true);
  });
  expect(result.current.phase).toBe('idle');
  expect(result.current.error).toBe('');
  expect(native.cancelVoice).not.toHaveBeenCalled();
});

test.each(['error', 'cancel', 'new-capture'])(
  'a finish ACK cannot accept a speech completion invalidated by %s',
  async invalidation => {
    const pending = deferred<string>();
    native.finishSpeech.mockReturnValueOnce(pending.promise);
    const { result } = await renderHookAsync(() =>
      useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
    );
    let finish: Promise<boolean>;
    await act(async () => {
      await result.current.beginSpeech('reply-ending');
      finish = result.current.finishSpeech('reply-ending');
      if (invalidation === 'error') {
        emit({
          sessionId: 'reply-ending',
          kind: 'error',
          phase: 'speaking',
          message: 'La lecture a été interrompue.',
        });
      } else if (invalidation === 'cancel') {
        await result.current.cancel();
      }
      emit({ sessionId: 'reply-ending', kind: 'state', phase: 'idle' });
      if (invalidation === 'new-capture') {
        expect(await result.current.startListening()).toBe(true);
      }
    });
    await act(async () => {
      pending.resolve(status('speaking'));
      expect(await finish).toBe(false);
    });
    expect(result.current.phase).toBe(
      invalidation === 'new-capture' ? 'listening' : 'idle',
    );
    expect(result.current.error).toBe(
      invalidation === 'error' ? 'La lecture a été interrompue.' : '',
    );
  },
);

test('a failed speech session rejects its finish ACK even before native idle', async () => {
  const pending = deferred<string>();
  native.finishSpeech.mockReturnValueOnce(pending.promise);
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  let finish: Promise<boolean>;
  await act(async () => {
    await result.current.beginSpeech('reply-error');
    finish = result.current.finishSpeech('reply-error');
    emit({
      sessionId: 'reply-error',
      kind: 'error',
      phase: 'speaking',
      message: 'Erreur avant idle.',
    });
  });
  await act(async () => {
    pending.resolve(status('idle'));
    expect(await finish).toBe(false);
  });
  expect(result.current.error).toBe('Erreur avant idle.');
});

test('a pending progressive begin cannot revive speech after cancellation', async () => {
  const pending = deferred<string>();
  native.beginSpeech.mockReturnValueOnce(pending.promise);
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  let begin: Promise<boolean>;
  await act(async () => {
    begin = result.current.beginSpeech('reply-1');
    await Promise.resolve();
  });
  await act(async () => {
    await result.current.cancel();
  });
  await act(async () => {
    await result.current.startListening();
  });
  await act(async () => {
    pending.resolve(status('speaking'));
    expect(await begin).toBe(false);
    emit({ sessionId: 'reply-1', kind: 'state', phase: 'speaking' });
  });
  expect(result.current.phase).toBe('listening');
});

test('a late progressive finish rejection cannot cancel a newer dictation', async () => {
  let reject!: (error: Error) => void;
  native.finishSpeech.mockReturnValueOnce(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    await result.current.beginSpeech('reply-1');
  });
  let finish: Promise<boolean>;
  await act(async () => {
    finish = result.current.finishSpeech('reply-1');
    await Promise.resolve();
  });
  await act(async () => {
    await result.current.cancel();
  });
  await act(async () => {
    await result.current.startListening();
  });
  native.cancelVoice.mockClear();
  await act(async () => {
    reject(new Error('Old queued response failed.'));
    expect(await finish).toBe(false);
  });
  expect(result.current.phase).toBe('listening');
  expect(result.current.error).toBe('');
  expect(native.cancelVoice).not.toHaveBeenCalled();
});

test('a current progressive queue error is visible and stops only that response', async () => {
  native.enqueueSpeech.mockRejectedValueOnce(
    new Error('Lecture vocale indisponible.'),
  );
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    await result.current.beginSpeech('reply-1');
    expect(await result.current.enqueueSpeech('Bonjour.', 'reply-1')).toBe(
      false,
    );
  });
  expect(result.current.error).toBe('Lecture vocale indisponible.');
  expect(result.current.phase).toBe('idle');
  expect(native.cancelVoice).toHaveBeenCalled();
});

test('a missing progressive API preserves the legacy speech fallback', async () => {
  const original = NativeAssist!.beginSpeech;
  Object.defineProperty(NativeAssist, 'beginSpeech', {
    configurable: true,
    value: undefined,
  });
  try {
    const { result } = await renderHookAsync(() =>
      useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
    );
    expect(result.current.supported).toBe(true);
    expect(result.current.streamingSupported).toBe(false);
    await act(async () => {
      expect(await result.current.beginSpeech('reply-1')).toBe(false);
      await result.current.speak('Réponse complète.', 'legacy-1');
    });
    expect(native.speak).toHaveBeenCalledWith('Réponse complète.', 'legacy-1');
  } finally {
    Object.defineProperty(NativeAssist, 'beginSpeech', {
      configurable: true,
      value: original,
    });
  }
});

test('a second capture request cannot overlap the active microphone session', async () => {
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    await result.current.startListening();
    await result.current.startListening();
  });

  expect(native.startListening).toHaveBeenCalledTimes(1);
  expect(result.current.phase).toBe('listening');
});

test('background state blocks new capture and playback until the app is active', async () => {
  Object.defineProperty(AppState, 'currentState', { value: 'background' });
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    await result.current.startListening();
    await result.current.speak('Ne pas lire en arrière-plan.', 'background');
  });
  expect(native.startListening).not.toHaveBeenCalled();
  expect(native.speak).not.toHaveBeenCalled();

  await act(async () => {
    stateChanged('active');
    await Promise.resolve();
    await result.current.startListening();
  });
  expect(native.startListening).toHaveBeenCalledTimes(1);
});

test('native permission or recognition errors are shown without leaving capture busy', async () => {
  native.startListening.mockRejectedValueOnce(
    new Error('Reconnaissance locale non disponible.'),
  );
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    await result.current.startListening();
  });

  expect(result.current.error).toContain(
    'Reconnaissance locale non disponible.',
  );
  expect(result.current.phase).toBe('idle');
  expect(result.current.captureBusy).toBe(false);
  expect(native.speak).not.toHaveBeenCalled();
});

test('unmount removes listeners and stops the active native session', async () => {
  const onTranscript = jest.fn();
  const { result, unmountAsync } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript, enabled: true }),
  );
  await act(async () => {
    await result.current.startListening();
  });
  const sessionId = native.startListening.mock.calls[0][0];
  await unmountAsync();
  await act(async () => {
    transcript(sessionId, 'Ne pas réanimer le composant.', true);
  });

  expect(removeVoiceListener).toHaveBeenCalled();
  expect(removeAppStateListener).toHaveBeenCalled();
  expect(native.cancelVoice).toHaveBeenCalled();
  expect(onTranscript).not.toHaveBeenCalled();
});

test('response preparation preserves models only after final capture text and native idle at the same epoch', async () => {
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    await result.current.startListening();
  });
  const sessionId = native.startListening.mock.calls[0][0];
  await act(async () => {
    emit({
      sessionId,
      kind: 'transcript',
      phase: 'finishing',
      text: 'Question finale.',
      isFinal: true,
    });
    emit({ sessionId, kind: 'state', phase: 'idle' });
  });
  native.cancelVoice.mockClear();
  await act(async () => {
    expect(await result.current.prepareResponse()).toBe(true);
  });
  expect(native.cancelVoice).not.toHaveBeenCalled();
  expect(result.current.phase).toBe('idle');
});

test.each(['partial', 'error', 'cancelled', 'new-capture'] as const)(
  'response preparation still cancels audio after %s instead of trusting old completion',
  async scenario => {
    const { result } = await renderHookAsync(() =>
      useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
    );
    await act(async () => {
      await result.current.startListening();
    });
    const sessionId = native.startListening.mock.calls[0][0];
    await act(async () => {
      emit({
        sessionId,
        kind: 'transcript',
        phase: 'finishing',
        text: 'Texte.',
        isFinal: scenario !== 'partial',
      });
      if (scenario === 'error')
        emit({
          sessionId,
          kind: 'error',
          phase: 'finishing',
          message: 'Erreur de capture.',
        });
      emit({ sessionId, kind: 'state', phase: 'idle' });
      if (scenario === 'cancelled') await result.current.cancel();
      if (scenario === 'new-capture') await result.current.startListening();
    });
    native.cancelVoice.mockClear();
    await act(async () => {
      expect(await result.current.prepareResponse()).toBe(true);
    });
    expect(native.cancelVoice).toHaveBeenCalledTimes(1);
  },
);

test('response preparation joins an in-flight stop and never acknowledges it before native', async () => {
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    await result.current.startListening();
  });
  const pending = deferred<string>();
  native.cancelVoice.mockReturnValueOnce(pending.promise);
  let stop!: Promise<boolean>;
  let preparing!: Promise<boolean>;
  let completed = false;
  await act(async () => {
    stop = result.current.cancel();
    preparing = result.current.prepareResponse().then(value => {
      completed = true;
      return value;
    });
  });
  expect(completed).toBe(false);
  expect(result.current.phase).toBe('stopping');
  expect(native.cancelVoice).toHaveBeenCalledTimes(1);
  await act(async () => {
    pending.resolve(status());
    expect(await stop).toBe(true);
    expect(await preparing).toBe(true);
  });
});

test('a natural speech idle cannot stand in for completed capture when input may still be retained', async () => {
  const { result } = await renderHookAsync(() =>
    useLocalVoice({ onTranscript: jest.fn(), enabled: true }),
  );
  await act(async () => {
    await result.current.beginSpeech('reply-retaining-microphone');
    emit({
      sessionId: 'reply-retaining-microphone',
      kind: 'state',
      phase: 'idle',
    });
  });
  native.cancelVoice.mockClear();
  await act(async () => {
    expect(await result.current.prepareResponse()).toBe(true);
  });
  expect(native.cancelVoice).toHaveBeenCalledTimes(1);
});
