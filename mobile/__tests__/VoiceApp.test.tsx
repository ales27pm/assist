import React from 'react';
import {
  act,
  fireEvent,
  renderAsync,
  screen,
  userEvent,
} from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { AppStateStatus } from 'react-native';
import { AssistantScreen } from '../App';
import NativeAssist from '../specs/NativeAssist';

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    getStatus: jest.fn(),
    onProgress: jest.fn(),
    generate: jest.fn(),
    cancel: jest.fn(),
    reset: jest.fn(),
    getVoiceStatus: jest.fn(),
    getVoicePreferences: jest.fn(),
    setVoicePreferences: jest.fn(),
    onVoiceEvent: jest.fn(),
    startListening: jest.fn(),
    stopListening: jest.fn(),
    cancelVoice: jest.fn(),
    speak: jest.fn(),
    beginSpeech: jest.fn(),
    enqueueSpeech: jest.fn(),
    finishSpeech: jest.fn(),
  },
}));
const native = jest.mocked(NativeAssist!);
const engineState = JSON.stringify({ phase: 'ready', contextCapacity: 8192 });
function voiceState(phase = 'idle', extra = {}) {
  return JSON.stringify({
    available: true,
    recognitionAvailable: true,
    synthesisAvailable: true,
    locale: 'fr-CA',
    phase,
    ...extra,
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
let voiceEvent: (event: { json: string }) => void;
let progressEvent: (event: { json: string }) => void;
let lifecycleListeners: Set<(state: AppStateStatus) => void>;
let user: ReturnType<typeof userEvent.setup>;

function result(
  requestId: string,
  text = 'Bonjour de Québec.',
  finishReason = 'eos',
) {
  return JSON.stringify({
    requestId,
    text,
    generatedTokens: 4,
    promptTokens: 10,
    elapsedMs: 100,
    finishReason,
    aneExecution: 'unverified',
  });
}
function emit(update: Record<string, unknown>) {
  voiceEvent({ json: JSON.stringify(update) });
}
async function event(update: Record<string, unknown>) {
  await act(async () => emit(update));
}
async function final(sessionId: string, text: string, phase = 'idle') {
  await event({ sessionId, kind: 'transcript', phase, text, isFinal: true });
}
async function press(name: string) {
  await user.press(screen.getByRole('button', { name }));
}
async function type(text: string) {
  await user.type(screen.getByLabelText('Message'), text);
}
async function enter() {
  await press('Mode vocal');
  expect(screen.getByRole('heading', { name: 'Mode vocal' })).toBeOnTheScreen();
  return native.startListening.mock.calls.at(-1)![0];
}
async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}
async function lifecycle(state: AppStateStatus) {
  Object.defineProperty(AppState, 'currentState', { value: state });
  await act(async () => {
    for (const listener of [...lifecycleListeners]) listener(state);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-16T12:00:00Z'));
  jest.clearAllMocks();
  user = userEvent.setup();
  lifecycleListeners = new Set();
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    writable: true,
    value: 'active',
  });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
    lifecycleListeners.add(listener);
    return { remove: () => lifecycleListeners.delete(listener) };
  });
  native.getStatus.mockResolvedValue(engineState);
  native.cancel.mockResolvedValue(engineState);
  native.reset.mockResolvedValue(engineState);
  native.onProgress.mockImplementation(listener => {
    progressEvent = listener;
    return { remove: jest.fn() };
  });
  native.onVoiceEvent.mockImplementation(listener => {
    voiceEvent = listener;
    return { remove: jest.fn() };
  });
  native.getVoiceStatus.mockResolvedValue(voiceState());
  native.getVoicePreferences.mockResolvedValue('{"readResponses":true}');
  native.setVoicePreferences.mockImplementation(async enabled =>
    JSON.stringify({ readResponses: enabled }),
  );
  native.startListening.mockImplementation(async sessionId => {
    emit({ sessionId, kind: 'state', phase: 'listening' });
    return voiceState('listening');
  });
  native.stopListening.mockResolvedValue(voiceState('finishing'));
  native.cancelVoice.mockResolvedValue(voiceState());
  native.speak.mockResolvedValue(voiceState('speaking'));
  native.beginSpeech.mockImplementation(async sessionId => {
    emit({ sessionId, kind: 'state', phase: 'speaking' });
    return voiceState('speaking');
  });
  native.enqueueSpeech.mockResolvedValue(voiceState('speaking'));
  native.finishSpeech.mockResolvedValue(voiceState('speaking'));
  native.generate.mockImplementation(async json =>
    result(JSON.parse(json).requestId),
  );
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('chat exposes a separate voice mode and preserves its keyboard draft through partial speech and exit', async () => {
  await renderAsync(<AssistantScreen />);
  expect(
    screen.queryByRole('button', { name: 'Dicter' }),
  ).not.toBeOnTheScreen();
  expect(
    screen.queryByRole('switch', { name: 'Lire les réponses à voix haute' }),
  ).not.toBeOnTheScreen();
  expect(native.startListening).not.toHaveBeenCalled();
  await type('Mon brouillon au clavier.');
  const sessionId = await enter();
  expect(native.startListening).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText('Message')).not.toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: 'Envoyer' }),
  ).not.toBeOnTheScreen();
  await event({
    sessionId,
    kind: 'transcript',
    phase: 'listening',
    text: 'Je pense que…',
    isFinal: false,
  });
  expect(screen.getByText('Je pense que…')).toBeOnTheScreen();
  expect(native.generate).not.toHaveBeenCalled();
  await press('Fermer le mode vocal');
  expect(screen.getByLabelText('Message')).toHaveDisplayValue(
    'Mon brouillon au clavier.',
  );
  await final(sessionId, 'Ancien texte final.');
  expect(native.generate).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Message')).toHaveDisplayValue(
    'Mon brouillon au clavier.',
  );
});

test('closing during a pending microphone start preserves the draft and rejects its late acceptance', async () => {
  const capture = deferred<string>();
  native.startListening.mockReturnValueOnce(capture.promise);
  await renderAsync(<AssistantScreen />);
  await type('Mon brouillon reste ici.');
  const sessionId = await enter();
  await press('Fermer le mode vocal');
  await act(async () => capture.resolve(voiceState('listening')));
  await event({ sessionId, kind: 'state', phase: 'listening' });
  await final(sessionId, 'Une ancienne transcription.');
  expect(native.startListening).toHaveBeenCalledTimes(1);
  expect(native.generate).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Message')).toHaveDisplayValue(
    'Mon brouillon reste ici.',
  );
});

test('a native final automatically sends once, reads by default and waits for real playback idle before the next turn', async () => {
  await renderAsync(<AssistantScreen />);
  await type('Brouillon indépendant.');
  const captureId = await enter();
  await final(captureId, 'Salut Québec!', 'finishing');
  expect(native.generate).not.toHaveBeenCalled();
  native.cancelVoice.mockClear();
  await event({ sessionId: captureId, kind: 'state', phase: 'idle' });
  expect(native.generate).toHaveBeenCalledTimes(1);
  expect(native.cancelVoice).not.toHaveBeenCalled();
  const request = JSON.parse(native.generate.mock.calls[0][0]);
  expect(request.messages).toEqual([
    { role: 'user', content: 'Salut Québec!' },
  ]);
  expect(native.beginSpeech).toHaveBeenCalledWith(request.requestId);
  expect(native.enqueueSpeech).toHaveBeenCalledWith(
    'Bonjour de Québec.',
    request.requestId,
  );
  expect(native.finishSpeech).toHaveBeenCalledWith(request.requestId);
  expect(native.startListening).toHaveBeenCalledTimes(1);
  await final(captureId, 'Ancien final en double.');
  expect(native.generate).toHaveBeenCalledTimes(1);
  await event({ sessionId: request.requestId, kind: 'state', phase: 'idle' });
  expect(native.startListening).toHaveBeenCalledTimes(2);
  expect(screen.getByText('À ton écoute')).toBeOnTheScreen();
  await press('Fermer le mode vocal');
  expect(screen.getByLabelText('Message')).toHaveDisplayValue(
    'Brouillon indépendant.',
  );
});

test('audio observations show input activity without sending or inventing a transcript', async () => {
  await renderAsync(<AssistantScreen />);
  const sessionId = await enter();
  expect(
    screen.getByRole('progressbar', { name: 'Niveau du microphone' }),
  ).toHaveAccessibilityValue({ text: 'En attente d’audio du micro.' });
  await event({
    sessionId,
    kind: 'input',
    phase: 'listening',
    diagnostics: {
      bufferCount: 4,
      frameCount: 1920,
      sampleRate: 48_000,
      channels: 1,
      peak: 0.4,
      level: 0.2,
      measured: true,
      elapsedMs: 200,
      inputPort: 'MicrophoneBuiltIn',
    },
  });
  expect(
    screen.getByRole('progressbar', { name: 'Niveau du microphone' }),
  ).toHaveAccessibilityValue({ now: 20, text: 'Audio reçu · niveau 20 %.' });
  expect(native.generate).not.toHaveBeenCalled();
  expect(
    screen.getByText('Ton prochain message apparaîtra ici.'),
  ).toBeOnTheScreen();
});

test('automatic quiet detection waits for stop acknowledgement and the native final before sending', async () => {
  const stop = deferred<string>();
  native.stopListening.mockReturnValueOnce(stop.promise);
  await renderAsync(<AssistantScreen />);
  const sessionId = await enter();
  await event({
    sessionId,
    kind: 'transcript',
    phase: 'listening',
    text: 'Le texte partiel.',
    isFinal: false,
  });
  for (let index = 0; index <= 5; index += 1) {
    if (index) await advance(200);
    await event({
      sessionId,
      kind: 'input',
      phase: 'listening',
      diagnostics: {
        bufferCount: index + 1,
        frameCount: (index + 1) * 9600,
        sampleRate: 48_000,
        channels: 1,
        peak: 0.1,
        level: 0.005,
        measured: true,
        elapsedMs: index * 200,
        inputPort: 'MicrophoneBuiltIn',
      },
    });
  }
  expect(native.stopListening).toHaveBeenCalledTimes(1);
  expect(native.generate).not.toHaveBeenCalled();
  expect(screen.getByText('Je termine ton message')).toBeOnTheScreen();
  await final(sessionId, 'Le texte final corrigé.', 'finishing');
  await event({ sessionId, kind: 'state', phase: 'idle' });
  expect(native.generate).not.toHaveBeenCalled();
  await act(async () => stop.resolve(voiceState('idle')));
  expect(native.generate).toHaveBeenCalledTimes(1);
  expect(JSON.parse(native.generate.mock.calls[0][0]).messages).toEqual([
    { role: 'user', content: 'Le texte final corrigé.' },
  ]);
});

test('settings default reading on and allow opting out even when no local synthesis voice is installed', async () => {
  native.getVoiceStatus.mockResolvedValue(
    voiceState('idle', { synthesisAvailable: false }),
  );
  await renderAsync(<AssistantScreen />);
  await press('Réglages');
  const toggle = screen.getByRole('switch', {
    name: 'Lire les réponses à voix haute',
  });
  expect(toggle).toBeChecked();
  expect(toggle).toBeEnabled();
  await act(async () => fireEvent(toggle, 'valueChange', false));
  expect(native.setVoicePreferences).toHaveBeenCalledWith(false);
  await press('Retour à la conversation');
  const sessionId = await enter();
  await final(sessionId, 'Réponds en texte seulement.');
  expect(native.generate).toHaveBeenCalledTimes(1);
  expect(native.beginSpeech).not.toHaveBeenCalled();
  expect(native.speak).not.toHaveBeenCalled();
  expect(native.startListening).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Bonjour de Québec.')).toBeOnTheScreen();
});

test('text chat remains manual and never reads automatically even with the reading preference on', async () => {
  await renderAsync(<AssistantScreen />);
  await type('Au clavier.');
  await press('Envoyer');
  expect(native.generate).toHaveBeenCalledTimes(1);
  expect(native.startListening).not.toHaveBeenCalled();
  expect(native.beginSpeech).not.toHaveBeenCalled();
  expect(native.speak).not.toHaveBeenCalled();
});

test('declining permission pauses voice mode without automatic retries or sending', async () => {
  native.startListening.mockRejectedValueOnce(
    new Error('Permission micro refusée.'),
  );
  await renderAsync(<AssistantScreen />);
  await press('Mode vocal');
  expect(screen.getByText('Mode vocal interrompu')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Reprendre' })).toBeEnabled();
  await advance(20_000);
  expect(native.startListening).toHaveBeenCalledTimes(1);
  expect(native.generate).not.toHaveBeenCalled();
});

test('a model load failure exposes details even before microphone capture starts', async () => {
  const message = 'Impossible de charger PocketTTS français.';
  const details = 'load stage=pocket cause=com.apple.CoreML:1';
  native.startListening.mockRejectedValueOnce(new Error(message));
  native.getVoiceStatus.mockResolvedValue(
    voiceState('idle', {
      audioDiagnostics: [details],
    }),
  );
  await renderAsync(<AssistantScreen />);
  await press('Mode vocal');
  expect(screen.getByText('Mode vocal interrompu')).toBeOnTheScreen();
  expect(screen.getByText(message)).toBeOnTheScreen();
  await press('Détails audio');
  expect(screen.getByText(details)).toHaveProp('selectable', true);
  await advance(20_000);
  expect(native.startListening).toHaveBeenCalledTimes(1);
  expect(native.generate).not.toHaveBeenCalled();
  expect(native.beginSpeech).not.toHaveBeenCalled();
});

test.each(['inactive', 'background'] as const)(
  'a native error survives %s and return, then explicit resume waits for stop ACK',
  async state => {
    const stopped = deferred<string>();
    const reason =
      'La session audio a été interrompue. Reprends pour réessayer.';
    const audioDiagnostics = ['route reason=2 decision=stop'];
    await renderAsync(<AssistantScreen />);
    const retiredId = await enter();
    native.cancelVoice.mockReturnValueOnce(stopped.promise);
    await event({
      sessionId: retiredId,
      kind: 'error',
      phase: 'listening',
      message: reason,
      audioDiagnostics,
    });
    expect(screen.getByText('Mode vocal interrompu')).toBeOnTheScreen();
    await lifecycle(state);
    await lifecycle('active');
    await advance(2_000);

    expect(screen.getByText('Mode vocal interrompu')).toBeOnTheScreen();
    expect(screen.getByText(reason)).toBeOnTheScreen();
    expect(screen.queryByText('En pause')).not.toBeOnTheScreen();
    expect(native.startListening).toHaveBeenCalledTimes(1);
    expect(native.generate).not.toHaveBeenCalled();
    expect(native.beginSpeech).not.toHaveBeenCalled();
    await press('Détails audio');
    expect(screen.getByText(audioDiagnostics[0])).toBeOnTheScreen();

    await press('Reprendre');
    expect(native.startListening).toHaveBeenCalledTimes(1);
    await act(async () => stopped.resolve(voiceState()));
    expect(native.startListening).toHaveBeenCalledTimes(2);
    expect(screen.getByText('À ton écoute')).toBeOnTheScreen();
    expect(screen.queryByText(reason)).not.toBeOnTheScreen();
    expect(
      screen.queryByRole('button', { name: 'Détails audio' }),
    ).not.toBeOnTheScreen();
    await event({
      sessionId: retiredId,
      kind: 'error',
      phase: 'idle',
      message: 'Ancienne erreur retardée.',
    });
    await final(retiredId, 'Ancienne transcription retardée.');
    expect(screen.getByText('À ton écoute')).toBeOnTheScreen();
    expect(
      screen.queryByText('Ancienne erreur retardée.'),
    ).not.toBeOnTheScreen();
    expect(native.startListening).toHaveBeenCalledTimes(2);
    expect(native.generate).not.toHaveBeenCalled();
  },
);

test.each(['manual', 'background'] as const)(
  'a late native error after %s pause never replaces the paused state or adds an alert',
  async pause => {
    const stopped = deferred<string>();
    await renderAsync(<AssistantScreen />);
    const retiredId = await enter();
    native.cancelVoice.mockReturnValueOnce(stopped.promise);
    if (pause === 'manual') await press('Mettre en pause');
    else await lifecycle('background');
    await event({
      sessionId: retiredId,
      kind: 'error',
      phase: 'idle',
      message: 'Erreur de l’ancienne session.',
    });
    await final(retiredId, 'Ancien texte après la pause.');
    await act(async () => stopped.resolve(voiceState()));
    if (pause === 'background') await lifecycle('active');

    expect(screen.getByText('En pause')).toBeOnTheScreen();
    expect(screen.queryByRole('alert')).not.toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Reprendre' })).toBeEnabled();
    expect(native.startListening).toHaveBeenCalledTimes(1);
    expect(native.generate).not.toHaveBeenCalled();
  },
);

test.each(['no-audio', 'empty-final'] as const)(
  '%s never auto-sends and requires explicit resume',
  async kind => {
    await renderAsync(<AssistantScreen />);
    const sessionId = await enter();
    if (kind === 'no-audio') await advance(15_100);
    else await final(sessionId, '  \n ');
    expect(screen.getByText('Mode vocal interrompu')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Reprendre' })).toBeEnabled();
    expect(native.generate).not.toHaveBeenCalled();
    expect(native.startListening).toHaveBeenCalledTimes(1);
  },
);

test.each(['pause', 'close', 'settings', 'background'] as const)(
  '%s cancels audio before local generation and rejects late results',
  async action => {
    const generation = deferred<string>();
    native.generate.mockReturnValueOnce(generation.promise);
    await renderAsync(<AssistantScreen />);
    const captureId = await enter();
    await final(captureId, 'Une question locale.');
    const { requestId } = JSON.parse(native.generate.mock.calls[0][0]);
    await act(async () =>
      progressEvent({
        json: JSON.stringify({
          requestId,
          text: 'Début autorisé. La suite',
          generatedTokens: 4,
          promptTokens: 10,
          elapsedMs: 100,
        }),
      }),
    );
    native.cancelVoice.mockClear();
    native.cancel.mockClear();
    if (action === 'background') await lifecycle('background');
    else
      await press(
        {
          pause: 'Mettre en pause',
          close: 'Fermer le mode vocal',
          settings: 'Réglages du mode vocal',
        }[action],
      );
    expect(native.cancelVoice.mock.invocationCallOrder[0]).toBeLessThan(
      native.cancel.mock.invocationCallOrder[0],
    );
    await final(captureId, 'Ancienne question tardive.');
    await act(async () =>
      generation.resolve(
        result(requestId, 'Début autorisé. Ancienne réponse.'),
      ),
    );
    if (action === 'background') await lifecycle('active');
    expect(native.generate).toHaveBeenCalledTimes(1);
    expect(native.startListening).toHaveBeenCalledTimes(1);
    expect(native.enqueueSpeech.mock.calls).toEqual([
      ['Début autorisé.', requestId],
    ]);
    expect(native.finishSpeech).not.toHaveBeenCalled();
  },
);

test('interrupt waits for old generation to settle before opening a fresh capture', async () => {
  const generation = deferred<string>();
  native.generate.mockReturnValueOnce(generation.promise);
  await renderAsync(<AssistantScreen />);
  const oldCapture = await enter();
  await final(oldCapture, 'Ancienne question.');
  const { requestId } = JSON.parse(native.generate.mock.calls[0][0]);
  native.cancelVoice.mockClear();
  native.cancel.mockClear();
  await press('Interrompre');
  expect(native.cancelVoice.mock.invocationCallOrder[0]).toBeLessThan(
    native.cancel.mock.invocationCallOrder[0],
  );
  expect(native.startListening).toHaveBeenCalledTimes(1);
  await act(async () =>
    generation.resolve(result(requestId, 'Ancienne réponse.')),
  );
  expect(native.startListening).toHaveBeenCalledTimes(2);
  await final(oldCapture, 'Ancien résultat retardé.');
  expect(native.generate).toHaveBeenCalledTimes(1);
});

test('returning from voice settings stays paused until an explicit resume', async () => {
  await renderAsync(<AssistantScreen />);
  await enter();
  await press('Réglages du mode vocal');
  const toggle = screen.getByRole('switch', {
    name: 'Lire les réponses à voix haute',
  });
  await act(async () => fireEvent(toggle, 'valueChange', false));
  await press('Retour au mode vocal');
  expect(screen.getByText('En pause')).toBeOnTheScreen();
  expect(native.startListening).toHaveBeenCalledTimes(1);
  await press('Reprendre');
  expect(native.startListening).toHaveBeenCalledTimes(2);
  expect(screen.getByText('À ton écoute')).toBeOnTheScreen();
});

test.each(['close', 'settings'] as const)(
  '%s keeps the voice error visible when native audio cancellation fails',
  async action => {
    await renderAsync(<AssistantScreen />);
    const sessionId = await enter();
    native.cancelVoice.mockRejectedValueOnce(
      new Error('Le micro ne confirme pas son arrêt.'),
    );
    await press(
      action === 'close'
        ? 'Fermer le mode vocal'
        : 'Réglages du mode vocal',
    );

    expect(
      screen.getByRole('heading', { name: 'Mode vocal' }),
    ).toBeOnTheScreen();
    expect(screen.getByText('Mode vocal interrompu')).toBeOnTheScreen();
    expect(
      screen.getByText(
        'L’arrêt de la voix n’a pas été confirmé. Ferme le mode vocal puis réessaie.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByLabelText('Message')).not.toBeOnTheScreen();
    expect(
      screen.queryByRole('heading', { name: 'Réglages' }),
    ).not.toBeOnTheScreen();
    await final(sessionId, 'Ancienne transcription après l’échec.');
    await advance(2_000);
    expect(native.generate).not.toHaveBeenCalled();
    expect(native.startListening).toHaveBeenCalledTimes(1);
  },
);

test.each(['close', 'settings'] as const)(
  '%s waits for the native audio stop acknowledgement before leaving voice mode',
  async action => {
    const stopped = deferred<string>();
    await renderAsync(<AssistantScreen />);
    const sessionId = await enter();
    native.cancelVoice.mockReturnValueOnce(stopped.promise);
    await press(
      action === 'close'
        ? 'Fermer le mode vocal'
        : 'Réglages du mode vocal',
    );

    expect(screen.getByText('Arrêt en cours')).toBeOnTheScreen();
    expect(
      screen.getByRole('heading', { name: 'Mode vocal' }),
    ).toBeOnTheScreen();
    expect(screen.queryByLabelText('Message')).not.toBeOnTheScreen();
    expect(
      screen.queryByRole('heading', { name: 'Réglages' }),
    ).not.toBeOnTheScreen();
    await final(sessionId, 'Ancienne transcription pendant l’arrêt.');
    expect(native.generate).not.toHaveBeenCalled();

    await act(async () => stopped.resolve(voiceState()));
    expect(
      screen.queryByRole('heading', { name: 'Mode vocal' }),
    ).not.toBeOnTheScreen();
    if (action === 'close')
      expect(screen.getByLabelText('Message')).toBeOnTheScreen();
    else
      expect(
        screen.getByRole('heading', { name: 'Réglages' }),
      ).toBeOnTheScreen();
    expect(native.startListening).toHaveBeenCalledTimes(1);
  },
);

test.each(['cancel-first', 'generation-first'] as const)(
  'spoken barge-in preserves the first words, old user intent and draft: %s',
  async order => {
    const first = deferred<string>();
    const cancellation = deferred<string>();
    const second = deferred<string>();
    native.generate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await renderAsync(<AssistantScreen />);
    await type('Brouillon clavier conservé.');
    const captureId = await enter();
    await final(captureId, 'Planifie le rendez-vous demain.');
    const firstId = JSON.parse(native.generate.mock.calls[0][0]).requestId;
    await event({ sessionId: firstId, kind: 'state', phase: 'speaking', monitoring: true });
    expect(screen.getByText('Micro actif pendant la réponse.')).toBeOnTheScreen();
    await act(async () => progressEvent({ json: JSON.stringify({ requestId: firstId, text: 'D’accord. Je prépare le rendez-vous.', generatedTokens: 8, promptTokens: 10, elapsedMs: 200 }) }));
    native.cancel.mockReturnValueOnce(cancellation.promise);
    native.cancelVoice.mockClear();
    await event({ kind: 'interruption', sessionId: firstId, captureSessionId: 'promoted-1', phase: 'listening' });
    expect(native.cancel).toHaveBeenCalled();
    expect(native.cancelVoice).not.toHaveBeenCalled();
    expect(native.startListening).toHaveBeenCalledTimes(1);
    await event({ sessionId: 'promoted-1', kind: 'transcript', phase: 'listening', text: 'Non, plutôt', isFinal: false });
    expect(screen.getByText('Non, plutôt')).toBeOnTheScreen();
    await final('promoted-1', 'Non, plutôt vendredi.');
    await event({ sessionId: firstId, kind: 'state', phase: 'idle' });
    if (order === 'cancel-first') await act(async () => cancellation.resolve(engineState));
    else await act(async () => first.resolve(result(firstId, 'Ancienne réponse.', 'cancelled')));
    expect(native.generate).toHaveBeenCalledTimes(1);
    if (order === 'cancel-first') await act(async () => first.resolve(result(firstId, 'Ancienne réponse.', 'cancelled')));
    else await act(async () => cancellation.resolve(engineState));
    expect(native.generate).toHaveBeenCalledTimes(2);
    const request = JSON.parse(native.generate.mock.calls[1][0]);
    expect(request.messages).toEqual([{ role: 'user', content: 'Planifie le rendez-vous demain.\n\nNon, plutôt vendredi.' }]);
    expect(native.startListening).toHaveBeenCalledTimes(1);
    await act(async () => second.resolve(result(request.requestId, 'Vendredi, d’accord.')));
    await event({ sessionId: request.requestId, kind: 'state', phase: 'idle' });
    await press('Fermer le mode vocal');
    expect(screen.getByLabelText('Message')).toHaveDisplayValue('Brouillon clavier conservé.');
  },
);

test('a stale enqueue acknowledgement after spoken barge-in cannot cancel the promoted capture', async () => {
  const first = deferred<string>();
  const queued = deferred<string>();
  native.generate.mockReturnValueOnce(first.promise);
  native.enqueueSpeech.mockReturnValueOnce(queued.promise);
  await renderAsync(<AssistantScreen />);
  const captureId = await enter();
  await final(captureId, 'Première question.');
  const firstId = JSON.parse(native.generate.mock.calls[0][0]).requestId;
  await act(async () => progressEvent({ json: JSON.stringify({ requestId: firstId, text: 'Première phrase. La suite.', generatedTokens: 8, promptTokens: 10, elapsedMs: 200 }) }));
  expect(native.enqueueSpeech).toHaveBeenCalled();
  native.cancelVoice.mockClear();
  await event({ kind: 'interruption', sessionId: firstId, captureSessionId: 'promoted-2', phase: 'listening' });
  await act(async () => queued.resolve(voiceState('speaking')));
  await event({ sessionId: 'promoted-2', kind: 'transcript', phase: 'listening', text: 'Non, attends.', isFinal: false });
  expect(native.cancelVoice).not.toHaveBeenCalled();
  expect(screen.getByText('Non, attends.')).toBeOnTheScreen();
  await act(async () => first.resolve(result(firstId, 'Ancien.', 'cancelled')));
  await press('Fermer le mode vocal');
});

test('closing after a spoken interruption shows the interrupted user once and no stale running answer', async () => {
  const first = deferred<string>();
  native.generate.mockReturnValueOnce(first.promise);
  await renderAsync(<AssistantScreen />);
  const captureId = await enter();
  await final(captureId, 'Question interrompue.');
  const firstId = JSON.parse(native.generate.mock.calls[0][0]).requestId;
  await act(async () => progressEvent({ json: JSON.stringify({ requestId: firstId, text: 'Ancienne réponse partielle.', generatedTokens: 8, promptTokens: 10, elapsedMs: 200 }) }));
  await event({ kind: 'interruption', sessionId: firstId, captureSessionId: 'promoted-close', phase: 'listening' });
  await act(async () => first.resolve(result(firstId, 'Ancienne réponse partielle.', 'cancelled')));
  await press('Fermer le mode vocal');
  expect(screen.getAllByText('Question interrompue.')).toHaveLength(1);
  expect(screen.queryByText('Ancienne réponse partielle.')).not.toBeOnTheScreen();
  expect(screen.queryByText('EN COURS')).not.toBeOnTheScreen();
});

test('natural playback completion requests the next capture without destroying retained native recognition', async () => {
  const first = deferred<string>();
  native.generate.mockReturnValueOnce(first.promise);
  await renderAsync(<AssistantScreen />);
  const captureId = await enter();
  await final(captureId, 'Question.');
  const firstId = JSON.parse(native.generate.mock.calls[0][0]).requestId;
  await act(async () => first.resolve(result(firstId, 'Réponse terminée.')));
  native.cancelVoice.mockClear();
  await event({ sessionId: firstId, kind: 'state', phase: 'idle' });
  expect(native.startListening).toHaveBeenCalledTimes(2);
  expect(native.cancelVoice).not.toHaveBeenCalled();
  await press('Fermer le mode vocal');
});

test('retained native recognition may finish before start acknowledgement without losing the next turn', async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  native.generate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await renderAsync(<AssistantScreen />);
  const captureId = await enter();
  await final(captureId, 'Question initiale.');
  const firstId = JSON.parse(native.generate.mock.calls[0][0]).requestId;
  await act(async () => first.resolve(result(firstId, 'Première réponse.')));
  native.startListening.mockImplementationOnce(async id => {
    emit({ sessionId: id, kind: 'state', phase: 'listening' });
    emit({ sessionId: id, kind: 'transcript', phase: 'listening', text: 'Je commençais juste à parler.', isFinal: true });
    emit({ sessionId: id, kind: 'state', phase: 'idle' });
    return voiceState('idle');
  });
  await event({ sessionId: firstId, kind: 'state', phase: 'idle' });
  expect(native.startListening).toHaveBeenCalledTimes(2);
  expect(native.generate).toHaveBeenCalledTimes(2);
  const request = JSON.parse(native.generate.mock.calls[1][0]);
  expect(request.messages.at(-1).content).toBe('Je commençais juste à parler.');
  expect(screen.queryByText('Le micro n’a pas pu démarrer. Vérifie ses autorisations, puis reprends.')).not.toBeOnTheScreen();
  await act(async () => second.resolve(result(request.requestId, 'Je t’écoute.')));
  await event({ sessionId: request.requestId, kind: 'state', phase: 'idle' });
  await press('Fermer le mode vocal');
});
