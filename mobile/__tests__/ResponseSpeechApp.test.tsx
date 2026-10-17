import React from 'react';
import {
  act,
  renderAsync,
  screen,
  userEvent,
} from '@testing-library/react-native';
import { AppState } from 'react-native';
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
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
let generation: ReturnType<typeof deferred<string>>;
let progressEvent: (event: { json: string }) => void;
let voiceEvent: (event: { json: string }) => void;
let user: ReturnType<typeof userEvent.setup>;
function state(sessionId: string, phase: string) {
  voiceEvent({ json: JSON.stringify({ sessionId, kind: 'state', phase }) });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  generation = deferred<string>();
  user = userEvent.setup();
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: 'active',
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
  native.startListening.mockImplementation(async id => {
    state(id, 'listening');
    return voiceState('listening');
  });
  native.stopListening.mockResolvedValue(voiceState('finishing'));
  native.cancelVoice.mockResolvedValue(voiceState());
  native.speak.mockResolvedValue(voiceState('speaking'));
  native.beginSpeech.mockImplementation(async id => {
    state(id, 'speaking');
    return voiceState('speaking');
  });
  native.enqueueSpeech.mockResolvedValue(voiceState('speaking'));
  native.finishSpeech.mockResolvedValue(voiceState('speaking'));
  native.generate.mockReturnValue(generation.promise);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

async function press(name: string) {
  await user.press(screen.getByRole('button', { name }));
}
async function start(read = true) {
  native.getVoicePreferences.mockResolvedValue(
    JSON.stringify({ readResponses: read }),
  );
  await renderAsync(<AssistantScreen />);
  await press('Mode vocal');
  const sessionId = native.startListening.mock.calls[0][0];
  await act(async () =>
    voiceEvent({
      json: JSON.stringify({
        sessionId,
        kind: 'transcript',
        phase: 'idle',
        text: 'Une question locale.',
        isFinal: true,
      }),
    }),
  );
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
  await act(async () => progressEvent({ json: progressJSON(requestId, text) }));
}
async function complete(requestId: string, text: string, finishReason = 'eos') {
  await act(async () =>
    generation.resolve(
      JSON.stringify({
        ...JSON.parse(progressJSON(requestId, text)),
        finishReason,
        aneExecution: 'unverified',
      }),
    ),
  );
}

test('voice mode streams ordered phrases before generation ends and flushes EOS without replay', async () => {
  const id = await start();
  await progress(id, 'Bonjour de Québec. La suite');
  expect(native.beginSpeech).toHaveBeenCalledWith(id);
  expect(native.enqueueSpeech.mock.calls).toEqual([['Bonjour de Québec.', id]]);
  expect(native.finishSpeech).not.toHaveBeenCalled();
  expect(native.startListening).toHaveBeenCalledTimes(1);
  await progress(id, 'Bonjour de Québec. La suite');
  await complete(id, 'Bonjour de Québec. La suite arrive');
  expect(native.enqueueSpeech.mock.calls).toEqual([
    ['Bonjour de Québec.', id],
    ['La suite arrive', id],
  ]);
  expect(native.finishSpeech).toHaveBeenCalledWith(id);
  expect(native.speak).not.toHaveBeenCalled();
  expect(
    screen.getByText('Bonjour de Québec. La suite arrive'),
  ).toBeOnTheScreen();
  expect(native.startListening).toHaveBeenCalledTimes(1);
  await act(async () => state(id, 'idle'));
  expect(native.startListening).toHaveBeenCalledTimes(2);
});

test('unrelated progress and progress after completion cannot append old speech', async () => {
  const id = await start();
  await progress('other-request', 'Une vieille réponse. ');
  expect(native.enqueueSpeech).not.toHaveBeenCalled();
  await complete(id, 'La bonne réponse');
  await progress(id, 'La bonne réponse. Une phrase arrivée trop tard. ');
  expect(native.enqueueSpeech.mock.calls).toEqual([['La bonne réponse', id]]);
  expect(native.finishSpeech).toHaveBeenCalledTimes(1);
});

test('playback idle received before finish acknowledgement waits for the acknowledgement and then resumes once', async () => {
  const finish = deferred<string>();
  native.finishSpeech.mockImplementationOnce(id => {
    state(id, 'idle');
    return finish.promise;
  });
  const id = await start();
  await progress(id, 'La réponse est prête. La suite');
  await complete(id, 'La réponse est prête. La suite aussi.');
  expect(native.finishSpeech).toHaveBeenCalledTimes(1);
  expect(native.startListening).toHaveBeenCalledTimes(1);
  await act(async () => finish.resolve(voiceState('idle')));
  expect(native.startListening).toHaveBeenCalledTimes(2);
  expect(screen.getByText('À ton écoute')).toBeOnTheScreen();
});

test('pause invalidates a pending speech begin and all of its queued phrases', async () => {
  const begin = deferred<string>();
  native.beginSpeech.mockReturnValueOnce(begin.promise);
  const id = await start();
  await progress(id, 'Une phrase en attente. ');
  await press('Mettre en pause');
  await act(async () => begin.resolve(voiceState('speaking')));
  await complete(id, 'Une phrase en attente.');
  expect(native.enqueueSpeech).not.toHaveBeenCalled();
  expect(native.finishSpeech).not.toHaveBeenCalled();
  expect(native.speak).not.toHaveBeenCalled();
  expect(native.startListening).toHaveBeenCalledTimes(1);
  expect(screen.getByText('En pause')).toBeOnTheScreen();
});

test('pause silences audio before generation and blocks late progress and EOS playback', async () => {
  const id = await start();
  await progress(id, 'Début autorisé. ');
  native.cancelVoice.mockClear();
  native.cancel.mockClear();
  await press('Mettre en pause');
  expect(native.cancelVoice.mock.invocationCallOrder[0]).toBeLessThan(
    native.cancel.mock.invocationCallOrder[0],
  );
  await progress(id, 'Début autorisé. Ancienne phrase tardive. ');
  await complete(id, 'Début autorisé. Ancienne phrase tardive.');
  expect(native.enqueueSpeech.mock.calls).toEqual([['Début autorisé.', id]]);
  expect(native.finishSpeech).not.toHaveBeenCalled();
  expect(native.startListening).toHaveBeenCalledTimes(1);
});

test.each(['beginSpeech', 'enqueueSpeech'] as const)(
  'a failed %s preserves local generation but stops the voice session instead of waiting for nonexistent audio',
  async command => {
    native[command].mockRejectedValueOnce(
      new Error('Lecture locale indisponible.'),
    );
    const id = await start();
    await progress(id, 'La réponse continue. Le reste');
    await complete(id, 'La réponse continue. Le reste reste lisible.');
    expect(
      screen.getByText('La réponse continue. Le reste reste lisible.'),
    ).toBeOnTheScreen();
    expect(native.finishSpeech).not.toHaveBeenCalled();
    expect(native.speak).not.toHaveBeenCalled();
    expect(native.startListening).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Mode vocal interrompu')).toBeOnTheScreen();
  },
);

test('reading disabled keeps progressive replies silent and resumes listening after completion', async () => {
  const id = await start(false);
  await progress(id, 'Une réponse silencieuse. ');
  await complete(id, 'Une réponse silencieuse. Avec une fin.');
  expect(native.beginSpeech).not.toHaveBeenCalled();
  expect(native.enqueueSpeech).not.toHaveBeenCalled();
  expect(native.finishSpeech).not.toHaveBeenCalled();
  expect(native.speak).not.toHaveBeenCalled();
  expect(native.startListening).toHaveBeenCalledTimes(2);
  expect(
    screen.getByText('Une réponse silencieuse. Avec une fin.'),
  ).toBeOnTheScreen();
});

test('an incomplete local result cancels playback without flushing an unfinished tail or retrying', async () => {
  const id = await start();
  await progress(id, 'Une première phrase. Une fin incomplète');
  native.cancelVoice.mockClear();
  await complete(id, 'Une première phrase. Une fin incomplète', 'maxTokens');
  expect(native.enqueueSpeech.mock.calls).toEqual([
    ['Une première phrase.', id],
  ]);
  expect(native.finishSpeech).not.toHaveBeenCalled();
  expect(native.cancelVoice).toHaveBeenCalled();
  expect(native.startListening).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Mode vocal interrompu')).toBeOnTheScreen();
});
