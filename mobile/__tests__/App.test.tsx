import React from 'react';
import {
  act,
  fireEventAsync,
  renderAsync,
  screen,
  userEvent,
} from '@testing-library/react-native';
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
    selectModel: jest.fn(),
    loadModel: jest.fn(),
    unloadModel: jest.fn(),
    generate: jest.fn(),
    cancel: jest.fn(),
    reset: jest.fn(),
    onProgress: jest.fn(),
  },
}));
const native = jest.mocked(NativeAssist!);
let phase: string;
beforeEach(() => {
  jest.clearAllMocks();
  phase = 'idle';
  native.getStatus.mockImplementation(async () =>
    JSON.stringify({ phase, contextCapacity: phase === 'ready' ? 8192 : 0 }),
  );
  native.onProgress.mockReturnValue({ remove: jest.fn() });
  native.selectModel.mockResolvedValue(
    '{"phase":"selected","modelName":"gemma"}',
  );
  native.loadModel.mockImplementation(async () => {
    phase = 'ready';
    return '{}';
  });
  native.cancel.mockResolvedValue('{"phase":"ready","contextCapacity":8192}');
  native.generate.mockImplementation(async raw => {
    const request = JSON.parse(raw);
    return JSON.stringify({
      requestId: request.requestId,
      text: 'Bonjour.',
      generatedTokens: 2,
      promptTokens: 50,
      elapsedMs: 200,
      finishReason: 'eos',
      aneExecution: 'unverified',
    });
  });
});

test('late cancellation acknowledgement restores ready state', async () => {
  let finish: (json: string) => void;
  let acknowledge: (json: string) => void;
  let requestId = '';
  native.generate.mockImplementation(raw => {
    requestId = JSON.parse(raw).requestId;
    return new Promise(resolve => {
      finish = resolve;
    });
  });
  native.cancel.mockImplementation(() => {
    phase = 'cancelling';
    finish(
      JSON.stringify({
        requestId,
        text: 'Arrêt',
        generatedTokens: 1,
        promptTokens: 20,
        elapsedMs: 100,
        finishReason: 'cancelled',
        aneExecution: 'unverified',
      }),
    );
    return new Promise(resolve => {
      acknowledge = resolve;
    });
  });
  const user = await load();
  await user.type(screen.getByLabelText('Message'), 'Bonjour');
  await fireEventAsync.press(screen.getByRole('button', { name: 'Envoyer' }));
  await fireEventAsync.press(
    await screen.findByRole('button', {
      name: 'Annuler la génération',
      disabled: false,
    }),
  );
  await screen.findByText(/État : cancelling/);
  // External native promise completion, not a user interaction or wrapped render.
  await act(async () => {
    phase = 'ready';
    acknowledge('{"phase":"ready","contextCapacity":8192}');
  });
  expect(
    await screen.findByRole('button', { name: 'Envoyer', disabled: false }),
  ).toBeEnabled();
});

async function load() {
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  await user.press(
    screen.getByRole('button', { name: 'Choisir un dossier exporté' }),
  );
  await user.press(
    await screen.findByRole('button', {
      name: 'Charger le modèle',
      disabled: false,
    }),
  );
  await screen.findByText(/contexte détecté : 8192/);
  return user;
}

test('requires local model load, then sends remaining-context budget', async () => {
  const user = await load();
  await user.type(screen.getByLabelText('Message'), 'Bonjour');
  await user.press(screen.getByRole('button', { name: 'Envoyer' }));
  expect(await screen.findByText('Bonjour.')).toBeOnTheScreen();
  expect(JSON.parse(native.generate.mock.calls[0][0])).toMatchObject({
    maxTokens: null,
    temperature: 0,
    messages: [{ role: 'user', content: 'Bonjour' }],
  });
});

test('forwards budgets above 32 unchanged', async () => {
  const user = await load();
  await user.type(screen.getByLabelText('Budget de sortie'), '2048');
  await user.type(screen.getByLabelText('Message'), 'Explique');
  await user.press(screen.getByRole('button', { name: 'Envoyer' }));
  await screen.findByText('Bonjour.');
  expect(JSON.parse(native.generate.mock.calls[0][0]).maxTokens).toBe(2048);
});

test('failed load leaves model retryable and generation unavailable', async () => {
  native.loadModel.mockRejectedValue(new Error('Mémoire insuffisante'));
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  await user.press(
    screen.getByRole('button', { name: 'Choisir un dossier exporté' }),
  );
  await user.press(
    await screen.findByRole('button', {
      name: 'Charger le modèle',
      disabled: false,
    }),
  );
  expect(await screen.findByText('Mémoire insuffisante')).toBeOnTheScreen();
  expect(
    await screen.findByRole('button', {
      name: 'Charger le modèle',
      disabled: false,
    }),
  ).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Envoyer' })).toBeDisabled();
});

test('cancel preserves partial output, without committing a completed turn', async () => {
  let finish: ((value: string) => void) | undefined;
  let requestId = '';
  native.generate.mockImplementation(raw => {
    requestId = JSON.parse(raw).requestId;
    return new Promise(resolve => {
      finish = resolve;
    });
  });
  native.cancel.mockImplementation(async () => {
    finish!(
      JSON.stringify({
        requestId,
        text: 'Préfixe conservé',
        generatedTokens: 3,
        promptTokens: 50,
        elapsedMs: 500,
        finishReason: 'cancelled',
        aneExecution: 'unverified',
      }),
    );
    return '{"phase":"ready","contextCapacity":8192}';
  });
  const user = await load();
  await user.type(screen.getByLabelText('Message'), 'Une longue réponse');
  await fireEventAsync.press(screen.getByRole('button', { name: 'Envoyer' }));
  await user.press(
    await screen.findByRole('button', {
      name: 'Annuler la génération',
      disabled: false,
    }),
  );
  expect(await screen.findByText('Préfixe conservé')).toBeOnTheScreen();
  expect(screen.getByLabelText('Message')).toHaveDisplayValue(
    'Une longue réponse',
  );
  expect(screen.queryByText('ASSIST')).not.toBeOnTheScreen();
});
