import React from 'react';
import {
  act,
  fireEvent,
  renderAsync,
  screen,
} from '@testing-library/react-native';
import { AssistantScreen } from '../App';
import NativeAssist from '../specs/NativeAssist';
import { AppState } from 'react-native';

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
  },
}));
const native = jest.mocked(NativeAssist!);
const engineState = JSON.stringify({ phase: 'ready', contextCapacity: 8192 });
const voiceState = (phase = 'idle', recognitionAvailable = true) =>
  JSON.stringify({
    available: recognitionAvailable,
    recognitionAvailable,
    synthesisAvailable: true,
    locale: 'fr-CA',
    phase,
    ...(!recognitionAvailable && {
      reason: 'Reconnaissance locale fr-CA indisponible.',
    }),
  });
let voiceEvent: (event: { json: string }) => void;
function result(requestId: string, finishReason = 'eos') {
  return JSON.stringify({
    requestId,
    text: 'Bonjour de Québec.',
    generatedTokens: 4,
    promptTokens: 10,
    elapsedMs: 100,
    finishReason,
    aneExecution: 'unverified',
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: 'active',
  });
  native.getStatus.mockResolvedValue(engineState);
  native.cancel.mockResolvedValue(engineState);
  native.reset.mockResolvedValue(engineState);
  native.onProgress.mockReturnValue({ remove: jest.fn() });
  native.onVoiceEvent.mockImplementation(listener => {
    voiceEvent = listener;
    return { remove: jest.fn() };
  });
  native.getVoiceStatus.mockResolvedValue(voiceState());
  native.startListening.mockResolvedValue(voiceState('listening'));
  native.stopListening.mockResolvedValue(voiceState('finishing'));
  native.cancelVoice.mockResolvedValue(voiceState());
  native.speak.mockResolvedValue(voiceState('speaking'));
  native.generate.mockImplementation(async json =>
    result(JSON.parse(json).requestId),
  );
});

async function press(name: string) {
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name }));
  });
}
async function type(text: string) {
  await act(async () => {
    fireEvent.changeText(screen.getByLabelText('Message'), text);
  });
}
async function readAloud(value = true) {
  await act(async () => {
    fireEvent(
      screen.getByLabelText('Lire les réponses à voix haute'),
      'valueChange',
      value,
    );
  });
}

test('dictation preserves the draft, requires explicit Send, and reads only after opt-in', async () => {
  await renderAsync(<AssistantScreen />);
  expect(native.startListening).not.toHaveBeenCalled();
  await type('Note :');
  await press('Dicter');
  const sessionId = native.startListening.mock.calls[0][0];
  await act(async () =>
    voiceEvent({
      json: JSON.stringify({
        sessionId,
        kind: 'transcript',
        phase: 'listening',
        text: 'Salut',
        isFinal: false,
      }),
    }),
  );
  expect(screen.getByLabelText('Message')).toHaveDisplayValue('Note :\nSalut');
  expect(screen.getByRole('button', { name: 'Envoyer' })).toBeDisabled();
  expect(native.generate).not.toHaveBeenCalled();
  await press('Terminer la dictée');
  await act(async () =>
    voiceEvent({
      json: JSON.stringify({
        sessionId,
        kind: 'transcript',
        phase: 'idle',
        text: 'Salut Québec!',
        isFinal: true,
      }),
    }),
  );
  expect(screen.getByLabelText('Message')).toHaveDisplayValue(
    'Note :\nSalut Québec!',
  );
  await type('Salut Québec, corrigé.');
  await readAloud();
  await press('Envoyer');
  const request = JSON.parse(native.generate.mock.calls[0][0]);
  expect(request.messages).toEqual([
    { role: 'user', content: 'Salut Québec, corrigé.' },
  ]);
  expect(native.speak).toHaveBeenCalledWith(
    'Bonjour de Québec.',
    request.requestId,
  );
  await press('Arrêter la lecture');
  expect(native.cancelVoice).toHaveBeenCalled();
});

test('text-only and incomplete replies are never spoken', async () => {
  await renderAsync(<AssistantScreen />);
  await type('Bonjour');
  await press('Envoyer');
  expect(native.speak).not.toHaveBeenCalled();
  await readAloud();
  native.generate.mockImplementation(async json =>
    result(JSON.parse(json).requestId, 'length'),
  );
  await type('Encore');
  await press('Envoyer');
  expect(native.speak).not.toHaveBeenCalled();
});

test('turning reading off during generation discards any pending speech', async () => {
  let finish!: (json: string) => void;
  native.generate.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  await renderAsync(<AssistantScreen />);
  await readAloud();
  await type('Bonjour');
  await press('Envoyer');
  const { requestId } = JSON.parse(native.generate.mock.calls[0][0]);
  await readAloud(false);
  await act(async () => finish(result(requestId)));
  expect(native.speak).not.toHaveBeenCalled();
});

test('turning reading off while Send awaits audio cancellation cannot re-arm speech', async () => {
  let releaseAudio!: (json: string) => void;
  native.cancelVoice.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        releaseAudio = resolve;
      }),
  );
  await renderAsync(<AssistantScreen />);
  await readAloud();
  await type('Bonjour');
  await press('Envoyer');
  expect(native.generate).not.toHaveBeenCalled();
  await readAloud(false);
  await readAloud(true); // Opting back in applies to a later turn, not this one.
  await act(async () => releaseAudio(voiceState()));
  expect(native.generate).toHaveBeenCalledTimes(1);
  expect(native.speak).not.toHaveBeenCalled();
});

test('cancel silences voice before the LLM and rejects late completed speech', async () => {
  let finish!: (json: string) => void;
  native.generate.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  await renderAsync(<AssistantScreen />);
  await readAloud();
  await type('Bonjour');
  await press('Envoyer');
  native.cancelVoice.mockClear();
  const { requestId } = JSON.parse(native.generate.mock.calls[0][0]);
  await press('Annuler la génération');
  expect(native.cancelVoice.mock.invocationCallOrder[0]).toBeLessThan(
    native.cancel.mock.invocationCallOrder[0],
  );
  await act(async () => finish(result(requestId)));
  expect(native.speak).not.toHaveBeenCalled();
});

test('unavailable local recognition keeps keyboard use without starting capture', async () => {
  native.getVoiceStatus.mockResolvedValue(voiceState('idle', false));
  await renderAsync(<AssistantScreen />);
  expect(screen.getByRole('button', { name: 'Dicter' })).toBeDisabled();
  expect(
    screen.getByText('Reconnaissance locale fr-CA indisponible.'),
  ).toBeOnTheScreen();
  await type('Au clavier');
  await press('Envoyer');
  expect(native.generate).toHaveBeenCalledTimes(1);
  expect(native.startListening).not.toHaveBeenCalled();
});

test('reset during a pending dictation start cannot reopen the microphone', async () => {
  let releaseAudio!: (json: string) => void;
  native.cancelVoice.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        releaseAudio = resolve;
      }),
  );
  await renderAsync(<AssistantScreen />);
  await press('Dicter');
  expect(native.startListening).not.toHaveBeenCalled();
  await press('Nouvelle conversation');
  await act(async () => releaseAudio(voiceState()));
  expect(native.reset).toHaveBeenCalledTimes(1);
  expect(native.startListening).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Message')).toHaveDisplayValue('');
});
