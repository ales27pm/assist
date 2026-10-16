import { act, renderHookAsync } from '@testing-library/react-native';
import { AppState, AppStateStatus } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { useLocalVoice } from '../src/useLocalVoice';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    getVoiceStatus: jest.fn(),
    startListening: jest.fn(),
    stopListening: jest.fn(),
    cancelVoice: jest.fn(),
    speak: jest.fn(),
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
  const promise = new Promise<T>(fulfill => {
    resolve = fulfill;
  });
  return { promise, resolve };
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
  let start: Promise<void>;
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
    await start;
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
  let start: Promise<void>;
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
  let start: Promise<void>;
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
  let start: Promise<void>;
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
