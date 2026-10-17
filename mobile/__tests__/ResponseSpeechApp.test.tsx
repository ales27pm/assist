import React from 'react';
import {
  act,
  fireEvent,
  renderAsync,
  screen,
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
const voiceState = (phase = 'idle') =>
  JSON.stringify({
    available: true,
    recognitionAvailable: true,
    synthesisAvailable: true,
    locale: 'fr-CA',
    phase,
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

let generation: ReturnType<typeof deferred<string>>;
let progressEvent: (event: { json: string }) => void;
let lifecycleListeners: Set<(state: AppStateStatus) => void>;

beforeEach(() => {
  jest.clearAllMocks();
  generation = deferred<string>();
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
  native.onVoiceEvent.mockReturnValue({ remove: jest.fn() });
  native.getVoiceStatus.mockResolvedValue(voiceState());
  native.startListening.mockResolvedValue(voiceState('listening'));
  native.stopListening.mockResolvedValue(voiceState('finishing'));
  native.cancelVoice.mockResolvedValue(voiceState());
  native.speak.mockResolvedValue(voiceState('speaking'));
  native.beginSpeech.mockResolvedValue(voiceState('speaking'));
  native.enqueueSpeech.mockResolvedValue(voiceState('speaking'));
  native.finishSpeech.mockResolvedValue(voiceState('speaking'));
  native.generate.mockReturnValue(generation.promise);
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function press(name: string) {
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name }));
  });
}

async function readAloud(value: boolean) {
  await act(async () => {
    fireEvent(
      screen.getByLabelText('Lire les réponses à voix haute'),
      'valueChange',
      value,
    );
  });
}

async function start(read = true) {
  await renderAsync(<AssistantScreen />);
  if (read) await readAloud(true);
  await act(async () => {
    fireEvent.changeText(screen.getByLabelText('Message'), 'Une question locale');
  });
  await press('Envoyer');
  expect(native.generate).toHaveBeenCalledTimes(1);
  return JSON.parse(native.generate.mock.calls[0][0]).requestId as string;
}

function progressJSON(requestId: string, text: string) {
  return JSON.stringify({
    requestId,
    text,
    generatedTokens: 10,
    promptTokens: 12,
    elapsedMs: 100,
  });
}

async function progress(requestId: string, text: string) {
  await act(async () => {
    progressEvent({ json: progressJSON(requestId, text) });
  });
}

async function complete(requestId: string, text: string, finishReason = 'eos') {
  await act(async () => {
    generation.resolve(
      JSON.stringify({
        ...JSON.parse(progressJSON(requestId, text)),
        finishReason,
        aneExecution: 'unverified',
      }),
    );
  });
}

async function lifecycle(state: AppStateStatus) {
  Object.defineProperty(AppState, 'currentState', { value: state });
  await act(async () => {
    for (const listener of [...lifecycleListeners]) listener(state);
  });
}

test('enqueues the first complete phrase before generation resolves, then flushes EOS without replay', async () => {
  const id = await start();
  await progress(id, 'Bonjour de Québec. La suite');

  // The generate promise is deliberately still unresolved at this assertion.
  expect(native.beginSpeech).toHaveBeenCalledWith(id);
  expect(native.enqueueSpeech.mock.calls).toEqual([['Bonjour de Québec.', id]]);
  expect(native.finishSpeech).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Annuler la génération' })).toBeOnTheScreen();
  await progress(id, 'Bonjour de Québec. La suite');
  await complete(id, 'Bonjour de Québec. La suite arrive');

  expect(native.enqueueSpeech.mock.calls).toEqual([
    ['Bonjour de Québec.', id],
    ['La suite arrive', id],
  ]);
  expect(native.finishSpeech).toHaveBeenCalledTimes(1);
  expect(native.finishSpeech).toHaveBeenCalledWith(id);
  expect(native.speak).not.toHaveBeenCalled();
  expect(screen.getByText('Bonjour de Québec. La suite arrive')).toBeOnTheScreen();
});

test('ignores unrelated progress identities and progress received after completion', async () => {
  const id = await start();
  await progress('another-request', 'Une vieille réponse. ');
  expect(native.enqueueSpeech).not.toHaveBeenCalled();
  await complete(id, 'La bonne réponse');
  await progress(id, 'La bonne réponse. Une phrase arrivée trop tard. ');

  expect(native.enqueueSpeech.mock.calls).toEqual([['La bonne réponse', id]]);
  expect(native.finishSpeech).toHaveBeenCalledTimes(1);
  expect(native.speak).not.toHaveBeenCalled();
});

test('disabling reading during generation stops the stream and re-enabling applies only to a later turn', async () => {
  const id = await start();
  await progress(id, 'Première phrase. La suite');
  native.cancelVoice.mockClear();
  await readAloud(false);
  expect(native.cancelVoice).toHaveBeenCalled();
  await readAloud(true);
  await progress(id, 'Première phrase. La suite ne doit pas être lue. ');
  await complete(id, 'Première phrase. La suite ne doit pas être lue.');

  expect(native.enqueueSpeech.mock.calls).toEqual([['Première phrase.', id]]);
  expect(native.finishSpeech).not.toHaveBeenCalled();
  expect(native.speak).not.toHaveBeenCalled();
  expect(screen.getByText('Première phrase. La suite ne doit pas être lue.')).toBeOnTheScreen();
});

test('disabling reading while begin is pending invalidates its queued phrases', async () => {
  const begin = deferred<string>();
  native.beginSpeech.mockReturnValueOnce(begin.promise);
  const id = await start();
  await progress(id, 'Une phrase en attente. ');
  await readAloud(false);
  await act(async () => begin.resolve(voiceState('speaking')));
  await complete(id, 'Une phrase en attente.');

  expect(native.enqueueSpeech).not.toHaveBeenCalled();
  expect(native.finishSpeech).not.toHaveBeenCalled();
  expect(native.speak).not.toHaveBeenCalled();
  expect(screen.getByText('Une phrase en attente.')).toBeOnTheScreen();
});

test('generation cancellation silences audio first and blocks late progress and late EOS speech', async () => {
  const id = await start();
  await progress(id, 'Début autorisé. ');
  native.cancelVoice.mockClear();
  native.cancel.mockClear();
  await press('Annuler la génération');
  expect(native.cancelVoice.mock.invocationCallOrder[0]).toBeLessThan(
    native.cancel.mock.invocationCallOrder[0],
  );
  await progress(id, 'Début autorisé. Ancienne phrase tardive. ');
  await complete(id, 'Début autorisé. Ancienne phrase tardive.');
  await progress(id, 'Début autorisé. Ancienne phrase tardive. Encore. ');

  expect(native.enqueueSpeech.mock.calls).toEqual([['Début autorisé.', id]]);
  expect(native.finishSpeech).not.toHaveBeenCalled();
  expect(native.speak).not.toHaveBeenCalled();
});

test('leaving the conversation and returning does not re-arm its in-progress speech', async () => {
  const id = await start();
  await progress(id, 'Début autorisé. ');
  native.cancelVoice.mockClear();
  await press('Réglages');
  expect(native.cancelVoice).toHaveBeenCalled();
  await progress(id, 'Début autorisé. Ancienne phrase tardive. ');
  await press('Retour à la conversation');
  await complete(id, 'Début autorisé. Ancienne phrase tardive.');
  await progress(id, 'Début autorisé. Ancienne phrase tardive. Encore. ');

  expect(native.enqueueSpeech.mock.calls).toEqual([['Début autorisé.', id]]);
  expect(native.finishSpeech).not.toHaveBeenCalled();
  expect(native.speak).not.toHaveBeenCalled();
});

test('background cancellation survives foreground return and late generation results', async () => {
  const id = await start();
  await progress(id, 'Début autorisé. ');
  native.cancelVoice.mockClear();
  await lifecycle('background');
  expect(native.cancelVoice).toHaveBeenCalled();
  expect(native.cancel).toHaveBeenCalled();
  await progress(id, 'Début autorisé. Ancienne phrase tardive. ');
  await lifecycle('active');
  await complete(id, 'Début autorisé. Ancienne phrase tardive.');
  await progress(id, 'Début autorisé. Ancienne phrase tardive. Encore. ');

  expect(native.enqueueSpeech.mock.calls).toEqual([['Début autorisé.', id]]);
  expect(native.finishSpeech).not.toHaveBeenCalled();
  expect(native.speak).not.toHaveBeenCalled();
});

test.each(['beginSpeech', 'enqueueSpeech'] as const)(
  'a failed %s leaves local generation and its completed text available',
  async command => {
    native[command].mockRejectedValueOnce(new Error('Lecture locale indisponible'));
    const id = await start();
    await progress(id, 'La réponse continue. Le reste');
    await progress(id, 'La réponse continue. Le reste reste lisible. ');
    await complete(id, 'La réponse continue. Le reste reste lisible.');

    expect(native.cancel).not.toHaveBeenCalled();
    expect(screen.getByText('La réponse continue. Le reste reste lisible.')).toBeOnTheScreen();
    expect(screen.getByLabelText('Message')).toHaveDisplayValue('');
    expect(native.finishSpeech).not.toHaveBeenCalled();
    expect(native.speak).not.toHaveBeenCalled();
    expect(native.enqueueSpeech).toHaveBeenCalledTimes(command === 'beginSpeech' ? 0 : 1);
    expect(native.cancelVoice.mock.calls.length).toBeGreaterThan(1);
  },
);

test('does not start any response speech when reading is disabled', async () => {
  const id = await start(false);
  await progress(id, 'Une réponse silencieuse. ');
  await complete(id, 'Une réponse silencieuse. Avec une fin.');

  expect(native.beginSpeech).not.toHaveBeenCalled();
  expect(native.enqueueSpeech).not.toHaveBeenCalled();
  expect(native.finishSpeech).not.toHaveBeenCalled();
  expect(native.speak).not.toHaveBeenCalled();
  expect(screen.getByText('Une réponse silencieuse. Avec une fin.')).toBeOnTheScreen();
});

test('an incomplete LLM result stops speech instead of flushing an unfinished tail', async () => {
  const id = await start();
  await progress(id, 'Une première phrase. Une fin incomplète');
  native.cancelVoice.mockClear();
  await complete(id, 'Une première phrase. Une fin incomplète', 'maxTokens');

  expect(native.enqueueSpeech.mock.calls).toEqual([['Une première phrase.', id]]);
  expect(native.finishSpeech).not.toHaveBeenCalled();
  expect(native.cancelVoice).toHaveBeenCalled();
  expect(native.speak).not.toHaveBeenCalled();
});
