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
import { Share } from 'react-native';

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    getStatus: jest.fn(),
    getMonitoringSnapshot: jest.fn(),
    selectModel: jest.fn(),
    loadModel: jest.fn(),
    loadBundledModel: jest.fn(),
    unloadModel: jest.fn(),
    runNumericalProbe: jest.fn(),
    runModelLoadProbe: jest.fn(),
    getLastModelLoadProbe: jest.fn(),
    generate: jest.fn(),
    cancel: jest.fn(),
    reset: jest.fn(),
    onProgress: jest.fn(),
  },
}));
const native = jest.mocked(NativeAssist!);
const monitoringReport = {
  schemaVersion: 1,
  kind: 'assistRuntimeMonitoring',
  aneExecution: 'unverified',
  nativeBuild: '7',
  osVersion: 'test',
  measurementMethods: { memory: 'sampled physical footprint' },
  current: {
    phase: 'idle',
    sessionElapsedMs: 1000,
    thermalState: 'unknown',
    memoryPressure: 'unknown',
    lowPowerMode: false,
  },
  history: [],
  events: [],
  diagnostic: null,
};
const primitiveReport = {
  schemaVersion: 1,
  kind: 'assistPrimitiveQualification',
  scope: 'primitive_only_gemma_unqualified',
  aneExecution: 'unverified',
  summary: { cases: 24, failed: 3, nonfinite: 0, maxULP: 4 },
  results: [{ fixture: 'synthetic', passed: false }],
};
let phase: string;
let bundledModelAvailable: boolean;
beforeEach(() => {
  jest.clearAllMocks();
  phase = 'idle';
  bundledModelAvailable = false;
  native.getMonitoringSnapshot.mockResolvedValue(JSON.stringify(monitoringReport));
  native.getStatus.mockImplementation(async () =>
    JSON.stringify({
      phase,
      contextCapacity: phase === 'ready' ? 8192 : 0,
      bundledModelAvailable,
    }),
  );
  native.onProgress.mockReturnValue({ remove: jest.fn() });
  native.runNumericalProbe.mockResolvedValue(JSON.stringify(primitiveReport));
  native.getLastModelLoadProbe.mockResolvedValue('null');
  native.selectModel.mockResolvedValue(
    '{"phase":"selected","modelName":"gemma"}',
  );
  native.loadModel.mockImplementation(async () => {
    phase = 'ready';
    return '{}';
  });
  native.loadBundledModel.mockImplementation(async () => {
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

test('routes the graph diagnostic through its own native method in the full screen', async () => {
  const report = {
    schemaVersion: 1,
    kind: 'assistModelLoadDiagnostic',
    scope: 'single_function_load_only_no_generation',
    aneExecution: 'unverified',
    nativeBuild: '8',
    osVersion: 'test',
    modelName: 'gemma4-e2b-32k-group8-rms-fp32io',
    contextCapacity: 32768,
    functionName: 'extend_1024_8',
    stage: 'completed',
    samples: [
      { stage: 'before_prepare', elapsedMs: 0, thermalState: 'nominal' },
      { stage: 'before_function_load', elapsedMs: 10, thermalState: 'nominal' },
      { stage: 'after_function_load', elapsedMs: 20, thermalState: 'nominal' },
    ],
    measurementMethods: { scope: 'Synthetic native boundary for screen routing' },
  };
  native.runModelLoadProbe.mockImplementation(async () => {
    native.getLastModelLoadProbe.mockResolvedValue(JSON.stringify(report));
    return JSON.stringify(report);
  });
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  expect(screen.getByRole('button', { name: 'Tester ce graphe' })).toBeDisabled();
  await user.press(
    screen.getByRole('button', { name: 'Choisir un dossier exporté' }),
  );
  await user.press(
    await screen.findByRole('button', { name: 'Tester ce graphe', disabled: false }),
  );
  expect(await screen.findByText(/Ce graphe a été chargé/)).toBeOnTheScreen();
  expect(native.runModelLoadProbe).toHaveBeenCalledTimes(1);
  expect(native.runModelLoadProbe).toHaveBeenCalledWith('extend_1024_8');
  expect(native.loadModel).not.toHaveBeenCalled();
  expect(native.loadBundledModel).not.toHaveBeenCalled();
  expect(native.runNumericalProbe).not.toHaveBeenCalled();
  expect(native.generate).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Envoyer' })).toBeDisabled();
});

test('runs and shares a separate primitive diagnostic without enabling Gemma generation', async () => {
  const share = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  await user.press(
    screen.getByRole('button', { name: 'Tester le calcul natif' }),
  );
  expect(
    await screen.findByText(/24 contrôles · 3 échecs · 0 valeurs non finies/),
  ).toBeOnTheScreen();
  expect(native.runNumericalProbe).toHaveBeenCalledTimes(1);
  expect(native.loadModel).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Envoyer' })).toBeDisabled();
  await user.press(
    screen.getByRole('button', { name: 'Partager le diagnostic' }),
  );
  expect(JSON.parse(share.mock.calls[0][0].message!)).toEqual({
    ...primitiveReport,
    runtimeMonitoring: monitoringReport,
  });
  share.mockRestore();
});

test('requires unloading Gemma before running the primitive diagnostic', async () => {
  phase = 'ready';
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  const button = screen.getByRole('button', { name: 'Tester le calcul natif' });
  expect(button).toBeDisabled();
  await user.press(button);
  expect(native.runNumericalProbe).not.toHaveBeenCalled();
});

test('shares the original failed diagnostic when runtime monitoring is unavailable', async () => {
  native.getMonitoringSnapshot.mockRejectedValue(new Error('Sampler unavailable'));
  const share = jest.spyOn(Share, 'share').mockResolvedValue({
    action: Share.sharedAction,
    activityType: undefined,
  });
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  await user.press(screen.getByRole('button', { name: 'Tester le calcul natif' }));
  await user.press(screen.getByRole('button', { name: 'Partager le diagnostic' }));
  expect(JSON.parse(share.mock.calls[0][0].message!)).toEqual({
    ...primitiveReport,
    runtimeMonitoring: null,
  });
  share.mockRestore();
});

test('serializes the diagnostic and restores controls after a native failure', async () => {
  let fail: (error: Error) => void;
  native.runNumericalProbe.mockImplementation(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  const button = screen.getByRole('button', { name: 'Tester le calcul natif' });
  await user.press(button);
  expect(button).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Choisir un dossier exporté' }),
  ).toBeDisabled();
  await user.press(button);
  expect(native.runNumericalProbe).toHaveBeenCalledTimes(1);
  await act(async () => {
    fail(new Error('Diagnostic indisponible'));
  });
  expect(await screen.findByText('Diagnostic indisponible')).toBeOnTheScreen();
  expect(button).toBeEnabled();
  expect(
    screen.getByRole('button', { name: 'Partager le diagnostic' }),
  ).toBeDisabled();
});

test('does not claim Gemma is included when its packaged metadata is absent', async () => {
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  expect(
    await screen.findByText('Gemma n’est pas intégré à cette build.'),
  ).toBeOnTheScreen();
  const bundledButton = screen.getByRole('button', {
    name: 'Charger Gemma intégré',
  });
  expect(bundledButton).toBeDisabled();
  await user.press(bundledButton);
  expect(native.loadBundledModel).not.toHaveBeenCalled();
});

test('loads packaged Gemma without asking for a folder', async () => {
  bundledModelAvailable = true;
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  await user.press(
    await screen.findByRole('button', {
      name: 'Charger Gemma intégré',
      disabled: false,
    }),
  );
  expect(await screen.findByText(/contexte détecté : 8192/)).toBeOnTheScreen();
  expect(native.loadBundledModel).toHaveBeenCalledTimes(1);
  expect(native.loadBundledModel).toHaveBeenCalledWith();
  expect(native.selectModel).not.toHaveBeenCalled();
  expect(native.loadModel).not.toHaveBeenCalled();
  expect(
    screen.getByRole('button', { name: 'Charger Gemma intégré' }),
  ).toBeDisabled();
});

test('blocks repeated bundled loads and folder selection while loading', async () => {
  bundledModelAvailable = true;
  let finish: (json: string) => void;
  native.loadBundledModel.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  const bundledButton = await screen.findByRole('button', {
    name: 'Charger Gemma intégré',
    disabled: false,
  });
  await user.press(bundledButton);
  expect(
    await screen.findByText('Opération native en cours…'),
  ).toBeOnTheScreen();
  expect(
    screen.getByRole('button', { name: 'Charger Gemma intégré' }),
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Choisir un dossier exporté' }),
  ).toBeDisabled();
  await user.press(bundledButton);
  expect(native.loadBundledModel).toHaveBeenCalledTimes(1);
  await act(async () => {
    phase = 'ready';
    finish('{}');
  });
  expect(await screen.findByText(/contexte détecté : 8192/)).toBeOnTheScreen();
});

test('failed bundled load is retryable without enabling generation', async () => {
  bundledModelAvailable = true;
  native.loadBundledModel.mockRejectedValue(
    new Error('Gemma intégré invalide'),
  );
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  await user.press(
    await screen.findByRole('button', {
      name: 'Charger Gemma intégré',
      disabled: false,
    }),
  );
  expect(await screen.findByText('Gemma intégré invalide')).toBeOnTheScreen();
  expect(
    await screen.findByRole('button', {
      name: 'Charger Gemma intégré',
      disabled: false,
    }),
  ).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Envoyer' })).toBeDisabled();
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
  expect(native.runModelLoadProbe).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText('Message'), 'Bonjour');
  await user.press(screen.getByRole('button', { name: 'Envoyer' }));
  expect(await screen.findByText('Bonjour.')).toBeOnTheScreen();
  expect(JSON.parse(native.generate.mock.calls[0][0])).toMatchObject({
    maxTokens: null,
    temperature: 0,
    messages: [{ role: 'user', content: 'Bonjour' }],
  });
});

test('unloading clears the response from the shareable report', async () => {
  const share = jest.spyOn(Share, 'share').mockResolvedValue({
    action: Share.sharedAction,
    activityType: undefined,
  });
  native.getStatus.mockImplementation(async () =>
    JSON.stringify({
      phase,
      contextCapacity: phase === 'ready' ? 8192 : 0,
      loadElapsedMs: 100,
    }),
  );
  native.unloadModel.mockImplementationOnce(async () => {
    phase = 'idle';
    return '{}';
  });
  try {
    const user = await load();
    await user.type(screen.getByLabelText('Message'), 'Bonjour');
    await user.press(screen.getByRole('button', { name: 'Envoyer' }));
    await screen.findByText('Bonjour.');
    await user.press(screen.getByRole('button', { name: 'Décharger' }));
    expect(screen.queryByText('Bonjour.')).not.toBeOnTheScreen();
    await user.press(
      screen.getByRole('button', { name: 'Partager le rapport' }),
    );
    expect(share).toHaveBeenCalledTimes(1);
    expect(JSON.parse(share.mock.calls[0][0].message!)).toMatchObject({
      generation: null,
      engine: { loadElapsedMs: 100 },
    });
  } finally {
    share.mockRestore();
  }
});

test('an empty EOS result remains retryable without an empty assistant turn', async () => {
  native.generate.mockImplementation(async raw => {
    const request = JSON.parse(raw);
    if (
      request.messages.some((message: { content: string }) => !message.content)
    ) {
      throw new Error('Conversation invalide');
    }
    const text =
      native.generate.mock.calls.length === 1 ? '' : 'Réponse suivante';
    return JSON.stringify({
      requestId: request.requestId,
      text,
      generatedTokens: text ? 2 : 0,
      promptTokens: 50,
      elapsedMs: 200,
      finishReason: 'eos',
      aneExecution: 'unverified',
    });
  });
  const user = await load();
  await user.type(screen.getByLabelText('Message'), 'Bonjour');
  await user.press(screen.getByRole('button', { name: 'Envoyer' }));
  expect(screen.queryByText('ASSIST')).not.toBeOnTheScreen();
  expect(screen.getByLabelText('Message')).toHaveDisplayValue('Bonjour');
  await user.press(screen.getByRole('button', { name: 'Envoyer' }));
  expect(await screen.findByText('Réponse suivante')).toBeOnTheScreen();
  expect(JSON.parse(native.generate.mock.calls[1][0]).messages).toEqual([
    { role: 'user', content: 'Bonjour' },
  ]);
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
