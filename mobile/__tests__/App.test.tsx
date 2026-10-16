import React from 'react';
import {
  act,
  fireEvent,
  renderAsync,
  screen,
  userEvent,
} from '@testing-library/react-native';
import { AssistantScreen } from '../App';
import { AppearanceProvider } from '../src/appearance';
import NativeAssist from '../specs/NativeAssist';
import { Alert, Share } from 'react-native';

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
  native.getMonitoringSnapshot.mockResolvedValue(
    JSON.stringify(monitoringReport),
  );
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
  native.reset.mockResolvedValue('{"phase":"ready","contextCapacity":8192}');
  native.unloadModel.mockImplementation(async () => {
    phase = 'idle';
    return '{}';
  });
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

afterEach(() => {
  jest.restoreAllMocks();
});

async function navigate(
  user: ReturnType<typeof userEvent.setup>,
  destination: 'Conversation' | 'Réglages' | 'Modèle' | 'Diagnostics',
) {
  if (destination === 'Conversation') {
    while (!screen.queryByRole('heading', { name: 'Assist' })) {
      await user.press(
        screen.getByRole('button', {
          name: /^(Retour à la conversation|Retour aux réglages|Retour au modèle)$/,
        }),
      );
    }
    return;
  }
  if (destination === 'Réglages') {
    if (screen.queryByRole('heading', { name: 'Réglages' })) return;
    await navigate(user, 'Conversation');
    await user.press(screen.getByRole('button', { name: 'Réglages' }));
    return;
  }
  if (destination === 'Modèle') {
    if (screen.queryByRole('heading', { name: 'Modèle' })) return;
    const contextual = screen.queryByRole('button', {
      name: 'Retour au modèle',
    });
    if (contextual) {
      await user.press(contextual);
      return;
    }
    const modelEntry = screen.queryByRole('button', {
      name: /^(Préparer mon assistant|Configurer le modèle|Modèle)$/,
    });
    if (modelEntry) {
      await user.press(modelEntry);
    } else {
      await navigate(user, 'Réglages');
      await user.press(screen.getByRole('button', { name: 'Modèle' }));
    }
    return;
  }
  if (!screen.queryByRole('heading', { name: 'Diagnostics' })) {
    await navigate(user, 'Modèle');
    await user.press(
      screen.getByRole('button', { name: 'Afficher les diagnostics' }),
    );
  }
}

async function openDisclosure(
  user: ReturnType<typeof userEvent.setup>,
  title: string,
) {
  const disclosure = screen.getByRole('button', { name: title });
  if (!disclosure.props.accessibilityState?.expanded) {
    await user.press(disclosure);
  }
}

async function openResponseSettings(user: ReturnType<typeof userEvent.setup>) {
  await navigate(user, 'Réglages');
  if (!screen.queryByLabelText('Limite de réponse · facultatif')) {
    await user.press(screen.getByRole('button', { name: 'Réponse' }));
  }
}

async function respondToClear(
  alert: jest.SpiedFunction<typeof Alert.alert>,
  label: 'Conserver' | 'Effacer et continuer',
) {
  const latest = alert.mock.calls[alert.mock.calls.length - 1];
  const button = latest?.[2]?.find(item => item.text === label);
  expect(button).toBeDefined();
  await act(async () => {
    button?.onPress?.();
  });
}

test('opens a focused conversation with model and diagnostics available through contextual controls', async () => {
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  expect(
    screen.getByRole('button', { name: 'Préparer mon assistant' }),
  ).toBeOnTheScreen();
  expect(screen.queryByRole('tab')).not.toBeOnTheScreen();
  expect(screen.getByLabelText('Message')).toHaveDisplayValue('');
  expect(screen.getByRole('button', { name: 'Envoyer' })).toBeDisabled();
  expect(screen.queryByLabelText('Limite de réponse · facultatif')).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Choisir un dossier exporté' }),
  ).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Tester le calcul natif' }),
  ).toBeNull();
  expect(native.generate).not.toHaveBeenCalled();
  await navigate(user, 'Modèle');
  expect(screen.getByRole('heading', { name: 'Modèle' })).toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: 'Choisir un dossier exporté' }),
  ).toBeNull();
  await openDisclosure(user, 'Importer un modèle');
  expect(
    screen.getByRole('button', { name: 'Choisir un dossier exporté' }),
  ).toBeEnabled();
  expect(native.loadModel).not.toHaveBeenCalled();
});

test('switching all three appearances preserves the draft and budget without changing native model state', async () => {
  const user = userEvent.setup();
  await renderAsync(
    <AppearanceProvider>
      <AssistantScreen />
    </AppearanceProvider>,
  );
  await user.type(screen.getByLabelText('Message'), 'Une idée à conserver');
  await openResponseSettings(user);
  await user.type(
    screen.getByLabelText('Limite de réponse · facultatif'),
    '512',
  );
  expect(
    screen.getByRole('button', { name: 'Apparence' }),
  ).toHaveAccessibilityValue({
    text: 'Natif clair',
  });

  for (const label of ['Graphite', 'Bleu profond', 'Natif clair']) {
    await user.press(screen.getByRole('button', { name: 'Apparence' }));
    await user.press(screen.getByRole('radio', { name: label }));
    expect(screen.getByRole('radio', { name: label })).toBeChecked();
    await user.press(
      screen.getByRole('button', { name: 'Fermer l’apparence' }),
    );
    expect(
      screen.getByRole('button', { name: 'Apparence' }),
    ).toHaveAccessibilityValue({
      text: label,
    });
    expect(
      screen.getByLabelText('Limite de réponse · facultatif'),
    ).toHaveDisplayValue('512');
    await navigate(user, 'Conversation');
    expect(screen.getByLabelText('Message')).toHaveDisplayValue(
      'Une idée à conserver',
    );
    await navigate(user, 'Réglages');
  }

  expect(native.selectModel).not.toHaveBeenCalled();
  expect(native.loadModel).not.toHaveBeenCalled();
  expect(native.loadBundledModel).not.toHaveBeenCalled();
  expect(native.unloadModel).not.toHaveBeenCalled();
  expect(native.reset).not.toHaveBeenCalled();
  expect(native.generate).not.toHaveBeenCalled();
});

test('illustrative examples remain separate from editable drafts, generation history and shared reports', async () => {
  const share = jest.spyOn(Share, 'share').mockResolvedValue({
    action: Share.sharedAction,
    activityType: undefined,
  });
  let finish: (json: string) => void;
  native.generate.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const user = await load();
  await user.press(screen.getByRole('button', { name: 'Voir un exemple' }));
  expect(screen.getByText('Exemple · contenu illustratif')).toBeOnTheScreen();
  expect(
    screen.getByText('Aide-moi à clarifier cette idée.'),
  ).toBeOnTheScreen();
  expect(
    screen.getByText('Bien sûr. Quel résultat aimerais-tu obtenir ?'),
  ).toBeOnTheScreen();
  await user.press(screen.getByRole('button', { name: 'Plus de détails' }));
  expect(screen.getByLabelText('Message')).toHaveDisplayValue(
    'Peux-tu développer ce point : ',
  );
  expect(native.generate).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText('Message'), 'mon projet de jardin');
  const draft = 'Peux-tu développer ce point : mon projet de jardin';
  await user.press(screen.getByRole('button', { name: 'Fermer l’exemple' }));
  expect(
    screen.queryByText('Exemple · contenu illustratif'),
  ).not.toBeOnTheScreen();
  expect(screen.getByLabelText('Message')).toHaveDisplayValue(draft);
  await user.press(screen.getByRole('button', { name: 'Voir un exemple' }));
  await navigate(user, 'Modèle');
  expect(
    screen.getByRole('button', { name: 'Partager le rapport' }),
  ).toBeDisabled();
  await navigate(user, 'Conversation');
  expect(screen.getByText('Exemple · contenu illustratif')).toBeOnTheScreen();

  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Envoyer' }));
  });
  expect(native.generate).toHaveBeenCalledTimes(1);
  const request = JSON.parse(native.generate.mock.calls[0][0]);
  expect(request.messages).toEqual([{ role: 'user', content: draft }]);
  expect(
    screen.queryByText('Exemple · contenu illustratif'),
  ).not.toBeOnTheScreen();
  expect(screen.getByText(draft)).toBeOnTheScreen();
  await act(async () => {
    finish(
      JSON.stringify({
        requestId: request.requestId,
        text: 'Bonjour.',
        generatedTokens: 2,
        promptTokens: 50,
        elapsedMs: 200,
        finishReason: 'eos',
        aneExecution: 'unverified',
      }),
    );
  });
  expect(screen.getByText('Bonjour.')).toBeOnTheScreen();
  await navigate(user, 'Modèle');
  await user.press(screen.getByRole('button', { name: 'Partager le rapport' }));
  const shared = share.mock.calls[0][0].message!;
  expect(JSON.parse(shared)).toMatchObject({
    kind: 'assistQualification',
    generation: { text: 'Bonjour.', requestId: request.requestId },
  });
  expect(shared).not.toContain('Aide-moi à clarifier cette idée.');
  expect(shared).not.toContain('Bien sûr. Quel résultat aimerais-tu obtenir ?');
  await navigate(user, 'Conversation');
  await user.type(screen.getByLabelText('Message'), 'Et ensuite ?');
  await user.press(screen.getByRole('button', { name: 'Envoyer' }));
  expect(JSON.parse(native.generate.mock.calls[1][0]).messages).toEqual([
    { role: 'user', content: draft },
    { role: 'assistant', content: 'Bonjour.' },
    { role: 'user', content: 'Et ensuite ?' },
  ]);
});

test('a suggestion inserts an editable draft without sending it', async () => {
  const user = await load();
  await user.press(screen.getByRole('button', { name: 'Éclaircir une idée' }));
  expect(screen.getByLabelText('Message')).toHaveDisplayValue(
    'Aide-moi à clarifier cette idée : ',
  );
  await user.type(screen.getByLabelText('Message'), 'un jardin partagé');
  expect(screen.getByLabelText('Message')).toHaveDisplayValue(
    'Aide-moi à clarifier cette idée : un jardin partagé',
  );
  expect(screen.getByRole('button', { name: 'Envoyer' })).toBeEnabled();
  expect(native.generate).not.toHaveBeenCalled();
});

test('preserves draft and response limit through settings, model, diagnostics and contextual back navigation', async () => {
  const user = await load();
  await user.type(screen.getByLabelText('Message'), 'Mon idée à conserver');
  await openResponseSettings(user);
  await user.type(
    screen.getByLabelText('Limite de réponse · facultatif'),
    '256',
  );
  await user.press(screen.getByRole('button', { name: 'Modèle' }));
  expect(
    screen.getByRole('button', { name: 'Retour aux réglages' }),
  ).toBeOnTheScreen();
  await navigate(user, 'Diagnostics');
  await user.press(screen.getByRole('button', { name: 'Retour au modèle' }));
  expect(screen.getByRole('heading', { name: 'Modèle' })).toBeOnTheScreen();
  await user.press(screen.getByRole('button', { name: 'Retour aux réglages' }));
  expect(screen.getByRole('heading', { name: 'Réglages' })).toBeOnTheScreen();
  expect(
    screen.getByLabelText('Limite de réponse · facultatif'),
  ).toHaveDisplayValue('256');
  await user.press(
    screen.getByRole('button', { name: 'Retour à la conversation' }),
  );
  expect(screen.getByLabelText('Message')).toHaveDisplayValue(
    'Mon idée à conserver',
  );
  expect(native.generate).not.toHaveBeenCalled();
  expect(native.reset).not.toHaveBeenCalled();
});

test('response settings retain an optional budget when collapsed and reopened', async () => {
  const user = await load();
  expect(screen.queryByLabelText('Limite de réponse · facultatif')).toBeNull();
  await openResponseSettings(user);
  await user.type(
    screen.getByLabelText('Limite de réponse · facultatif'),
    '128',
  );
  await user.press(screen.getByRole('button', { name: 'Réponse' }));
  expect(screen.queryByLabelText('Limite de réponse · facultatif')).toBeNull();
  await navigate(user, 'Modèle');
  await navigate(user, 'Conversation');
  await openResponseSettings(user);
  expect(
    screen.getByLabelText('Limite de réponse · facultatif'),
  ).toHaveDisplayValue('128');
  await navigate(user, 'Conversation');
  await user.type(screen.getByLabelText('Message'), 'Explique cette idée');
  await user.press(screen.getByRole('button', { name: 'Envoyer' }));
  expect(JSON.parse(native.generate.mock.calls[0][0]).maxTokens).toBe(128);
});

test.each([
  ['0', 'Le budget doit être un entier positif.'],
  ['1.5', 'Entre un entier positif, ou laisse vide.'],
])(
  'invalid response budget %s blocks generation and offers recovery without losing the draft',
  async (invalidBudget, message) => {
    const user = await load();
    await user.type(screen.getByLabelText('Message'), 'Mon idée à développer');
    await openResponseSettings(user);
    await user.type(
      screen.getByLabelText('Limite de réponse · facultatif'),
      invalidBudget,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    await user.press(screen.getByRole('button', { name: 'Réponse' }));
    expect(
      screen.queryByLabelText('Limite de réponse · facultatif'),
    ).toBeNull();
    await navigate(user, 'Conversation');
    const send = screen.getByRole('button', { name: 'Envoyer' });
    expect(send).toBeDisabled();
    await user.press(send);
    expect(native.generate).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message')).toHaveDisplayValue(
      'Mon idée à développer',
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Limite invalide. Corrige-la dans Réglages.',
    );
    await user.press(
      screen.getByRole('button', { name: 'Corriger la limite de réponse' }),
    );
    expect(screen.getByRole('heading', { name: 'Réglages' })).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Réponse', expanded: true }),
    ).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Limite de réponse · facultatif'),
    ).toHaveDisplayValue(invalidBudget);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    await user.clear(screen.getByLabelText('Limite de réponse · facultatif'));
    await user.type(
      screen.getByLabelText('Limite de réponse · facultatif'),
      '256',
    );
    expect(screen.queryByRole('alert')).not.toBeOnTheScreen();
    await navigate(user, 'Conversation');
    expect(
      screen.queryByRole('button', { name: 'Corriger la limite de réponse' }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Envoyer' })).toBeEnabled();
    await user.press(screen.getByRole('button', { name: 'Envoyer' }));
    expect(await screen.findByText('Bonjour.')).toBeOnTheScreen();
    expect(native.generate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(native.generate.mock.calls[0][0])).toMatchObject({
      maxTokens: 256,
      messages: [{ role: 'user', content: 'Mon idée à développer' }],
    });
  },
);

test('new conversation can be cancelled and clears content only after native reset succeeds', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  let finishReset: (json: string) => void;
  native.reset.mockImplementation(
    () =>
      new Promise(resolve => {
        finishReset = resolve;
      }),
  );
  const user = await load();
  await user.type(screen.getByLabelText('Message'), 'Bonjour');
  await user.press(screen.getByRole('button', { name: 'Envoyer' }));
  await screen.findByText('Bonjour.');
  await user.type(screen.getByLabelText('Message'), 'Mon prochain message');
  await user.press(
    screen.getByRole('button', { name: 'Nouvelle conversation' }),
  );
  expect(alert).toHaveBeenCalledWith(
    'Nouvelle conversation ?',
    expect.any(String),
    expect.any(Array),
  );
  expect(native.reset).not.toHaveBeenCalled();
  await respondToClear(alert, 'Conserver');
  expect(native.reset).not.toHaveBeenCalled();
  expect(screen.getByText('Bonjour.')).toBeOnTheScreen();
  expect(screen.getByLabelText('Message')).toHaveDisplayValue(
    'Mon prochain message',
  );
  await user.press(
    screen.getByRole('button', { name: 'Nouvelle conversation' }),
  );
  await respondToClear(alert, 'Effacer et continuer');
  expect(native.reset).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Bonjour.')).toBeOnTheScreen();
  expect(screen.getByLabelText('Message')).toHaveDisplayValue(
    'Mon prochain message',
  );
  await act(async () => {
    finishReset('{"phase":"ready","contextCapacity":8192}');
  });
  expect(screen.queryByText('Bonjour.')).not.toBeOnTheScreen();
  expect(screen.getByLabelText('Message')).toHaveDisplayValue('');
  await navigate(user, 'Modèle');
  expect(
    screen.getByRole('button', { name: 'Partager le rapport' }),
  ).toBeDisabled();
});

test('a failed native reset preserves the draft, conversation and original generation report', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const share = jest.spyOn(Share, 'share').mockResolvedValue({
    action: Share.sharedAction,
    activityType: undefined,
  });
  native.reset.mockRejectedValue(new Error('Réinitialisation indisponible'));
  const user = await load();
  await user.type(screen.getByLabelText('Message'), 'Bonjour');
  await user.press(screen.getByRole('button', { name: 'Envoyer' }));
  await screen.findByText('Bonjour.');
  await user.type(screen.getByLabelText('Message'), 'Brouillon conservé');
  await user.press(
    screen.getByRole('button', { name: 'Nouvelle conversation' }),
  );
  await respondToClear(alert, 'Effacer et continuer');
  expect(native.reset).toHaveBeenCalledTimes(1);
  expect(
    await screen.findByText('Réinitialisation indisponible'),
  ).toBeOnTheScreen();
  expect(screen.getByText('Bonjour.')).toBeOnTheScreen();
  expect(screen.getByLabelText('Message')).toHaveDisplayValue(
    'Brouillon conservé',
  );
  await navigate(user, 'Modèle');
  await user.press(screen.getByRole('button', { name: 'Partager le rapport' }));
  expect(share).toHaveBeenCalledTimes(1);
  expect(JSON.parse(share.mock.calls[0][0].message!)).toMatchObject({
    generation: { text: 'Bonjour.', finishReason: 'eos' },
  });
});

test('unload confirmation preserves a cancelled draft and clears it after acceptance', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const user = await load();
  await user.type(screen.getByLabelText('Message'), 'Une idée non envoyée');
  await navigate(user, 'Modèle');
  await user.press(screen.getByRole('button', { name: 'Décharger' }));
  expect(native.unloadModel).not.toHaveBeenCalled();
  await respondToClear(alert, 'Conserver');
  await navigate(user, 'Conversation');
  expect(screen.getByLabelText('Message')).toHaveDisplayValue(
    'Une idée non envoyée',
  );
  await navigate(user, 'Modèle');
  await user.press(screen.getByRole('button', { name: 'Décharger' }));
  await respondToClear(alert, 'Effacer et continuer');
  expect(native.unloadModel).toHaveBeenCalledTimes(1);
  await navigate(user, 'Conversation');
  expect(screen.getByLabelText('Message')).toHaveDisplayValue('');
  expect(screen.getByRole('button', { name: 'Envoyer' })).toBeDisabled();
});

test('advanced diagnostics mount only when opened and never start a native operation automatically', async () => {
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  expect(native.getLastModelLoadProbe).not.toHaveBeenCalled();
  expect(native.getMonitoringSnapshot).not.toHaveBeenCalled();
  await navigate(user, 'Modèle');
  expect(native.getLastModelLoadProbe).not.toHaveBeenCalled();
  expect(native.getMonitoringSnapshot).not.toHaveBeenCalled();
  await navigate(user, 'Diagnostics');
  expect(screen.queryByRole('button', { name: 'Tester ce graphe' })).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Tester le calcul natif' }),
  ).toBeNull();
  expect(native.getLastModelLoadProbe).not.toHaveBeenCalled();
  expect(native.runModelLoadProbe).not.toHaveBeenCalled();
  expect(native.runNumericalProbe).not.toHaveBeenCalled();
  await openDisclosure(user, 'Vérifier le chargement');
  expect(
    await screen.findByRole('button', { name: 'Tester ce graphe' }),
  ).toBeDisabled();
  expect(native.getLastModelLoadProbe).toHaveBeenCalledTimes(1);
  expect(native.runModelLoadProbe).not.toHaveBeenCalled();
  await user.press(
    screen.getByRole('button', { name: 'Vérifier le chargement' }),
  );
  expect(screen.queryByRole('button', { name: 'Tester ce graphe' })).toBeNull();
  await openDisclosure(user, 'Vérifier le chargement');
  expect(
    screen.getByRole('button', { name: 'Tester ce graphe' }),
  ).toBeDisabled();
  expect(native.getLastModelLoadProbe).toHaveBeenCalledTimes(1);
  await openDisclosure(user, 'Calcul natif');
  expect(
    screen.getByRole('button', { name: 'Tester le calcul natif' }),
  ).toBeEnabled();
  expect(native.runNumericalProbe).not.toHaveBeenCalled();
  expect(native.loadModel).not.toHaveBeenCalled();
  expect(native.loadBundledModel).not.toHaveBeenCalled();
  expect(native.generate).not.toHaveBeenCalled();
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
    measurementMethods: {
      scope: 'Synthetic native boundary for screen routing',
    },
  };
  native.runModelLoadProbe.mockImplementation(async () => {
    native.getLastModelLoadProbe.mockResolvedValue(JSON.stringify(report));
    return JSON.stringify(report);
  });
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  await navigate(user, 'Diagnostics');
  await openDisclosure(user, 'Vérifier le chargement');
  expect(
    screen.getByRole('button', { name: 'Tester ce graphe' }),
  ).toBeDisabled();
  await navigate(user, 'Modèle');
  await openDisclosure(user, 'Importer un modèle');
  await user.press(
    screen.getByRole('button', { name: 'Choisir un dossier exporté' }),
  );
  await navigate(user, 'Diagnostics');
  await openDisclosure(user, 'Vérifier le chargement');
  await user.press(
    await screen.findByRole('button', {
      name: 'Tester ce graphe',
      disabled: false,
    }),
  );
  expect(await screen.findByText(/Ce graphe a été chargé/)).toBeOnTheScreen();
  expect(native.runModelLoadProbe).toHaveBeenCalledTimes(1);
  expect(native.runModelLoadProbe).toHaveBeenCalledWith('extend_1024_8');
  expect(native.loadModel).not.toHaveBeenCalled();
  expect(native.loadBundledModel).not.toHaveBeenCalled();
  expect(native.runNumericalProbe).not.toHaveBeenCalled();
  expect(native.generate).not.toHaveBeenCalled();
  const savedReportReads = native.getLastModelLoadProbe.mock.calls.length;
  await navigate(user, 'Conversation');
  expect(screen.getByRole('button', { name: 'Envoyer' })).toBeDisabled();
  await navigate(user, 'Diagnostics');
  await openDisclosure(user, 'Vérifier le chargement');
  expect(screen.getByText(/Ce graphe a été chargé/)).toBeOnTheScreen();
  expect(native.getLastModelLoadProbe).toHaveBeenCalledTimes(savedReportReads);
  expect(native.runModelLoadProbe).toHaveBeenCalledTimes(1);
});

test('runs and shares a separate primitive diagnostic without enabling Gemma generation', async () => {
  const share = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  await navigate(user, 'Diagnostics');
  await openDisclosure(user, 'Calcul natif');
  await user.press(
    screen.getByRole('button', { name: 'Tester le calcul natif' }),
  );
  expect(
    await screen.findByText(/24 contrôles · 3 échecs · 0 valeurs non finies/),
  ).toBeOnTheScreen();
  expect(native.runNumericalProbe).toHaveBeenCalledTimes(1);
  expect(native.loadModel).not.toHaveBeenCalled();
  await navigate(user, 'Conversation');
  expect(screen.getByRole('button', { name: 'Envoyer' })).toBeDisabled();
  await navigate(user, 'Diagnostics');
  await openDisclosure(user, 'Calcul natif');
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
  await navigate(user, 'Diagnostics');
  await openDisclosure(user, 'Calcul natif');
  const button = screen.getByRole('button', { name: 'Tester le calcul natif' });
  expect(button).toBeDisabled();
  await user.press(button);
  expect(native.runNumericalProbe).not.toHaveBeenCalled();
});

test('shares the original failed diagnostic when runtime monitoring is unavailable', async () => {
  native.getMonitoringSnapshot.mockRejectedValue(
    new Error('Sampler unavailable'),
  );
  const share = jest.spyOn(Share, 'share').mockResolvedValue({
    action: Share.sharedAction,
    activityType: undefined,
  });
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  await navigate(user, 'Diagnostics');
  await openDisclosure(user, 'Calcul natif');
  await user.press(
    screen.getByRole('button', { name: 'Tester le calcul natif' }),
  );
  await user.press(
    screen.getByRole('button', { name: 'Partager le diagnostic' }),
  );
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
  await navigate(user, 'Diagnostics');
  await openDisclosure(user, 'Calcul natif');
  const button = screen.getByRole('button', { name: 'Tester le calcul natif' });
  await user.press(button);
  expect(button).toBeDisabled();
  await user.press(button);
  expect(native.runNumericalProbe).toHaveBeenCalledTimes(1);
  const back = screen.getByRole('button', { name: 'Retour au modèle' });
  expect(back).toBeDisabled();
  await user.press(back);
  expect(
    screen.getByRole('heading', { name: 'Diagnostics' }),
  ).toBeOnTheScreen();
  expect(
    screen.getByRole('button', { name: 'Gérer le modèle' }),
  ).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Calcul natif' })).toBeDisabled();
  expect(
    screen.queryByRole('button', { name: 'Choisir un dossier exporté' }),
  ).toBeNull();
  expect(native.selectModel).not.toHaveBeenCalled();
  expect(native.runNumericalProbe).toHaveBeenCalledTimes(1);
  await act(async () => {
    fail(new Error('Diagnostic indisponible'));
  });
  expect(await screen.findByText('Diagnostic indisponible')).toBeOnTheScreen();
  expect(
    screen.getByRole('button', { name: 'Retour au modèle' }),
  ).toBeEnabled();
  expect(
    screen.getByRole('button', { name: 'Tester le calcul natif' }),
  ).toBeEnabled();
  expect(
    screen.getByRole('button', { name: 'Partager le diagnostic' }),
  ).toBeDisabled();
});

test('does not claim Gemma is included when its packaged metadata is absent', async () => {
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  await navigate(user, 'Modèle');
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
  await navigate(user, 'Modèle');
  await user.press(
    await screen.findByRole('button', {
      name: 'Charger Gemma intégré',
      disabled: false,
    }),
  );
  expect(await screen.findByText(/contexte détecté : 8192/i)).toBeOnTheScreen();
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
  await navigate(user, 'Modèle');
  await openDisclosure(user, 'Importer un modèle');
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
  expect(await screen.findByText(/contexte détecté : 8192/i)).toBeOnTheScreen();
});

test('failed bundled load is retryable without enabling generation', async () => {
  bundledModelAvailable = true;
  native.loadBundledModel.mockRejectedValue(
    new Error('Gemma intégré invalide'),
  );
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  await navigate(user, 'Modèle');
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
  await navigate(user, 'Conversation');
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
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Envoyer' }));
  });
  await screen.findByRole('button', {
    name: 'Annuler la génération',
    disabled: false,
  });
  await act(async () => {
    fireEvent.press(
      screen.getByRole('button', { name: 'Annuler la génération' }),
    );
  });
  await navigate(user, 'Modèle');
  await screen.findByText(/État : Annulation/);
  // External native promise completion, not a user interaction or wrapped render.
  await act(async () => {
    phase = 'ready';
    acknowledge('{"phase":"ready","contextCapacity":8192}');
  });
  await navigate(user, 'Conversation');
  expect(
    await screen.findByRole('button', { name: 'Envoyer', disabled: false }),
  ).toBeEnabled();
});

async function load() {
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  await navigate(user, 'Modèle');
  await openDisclosure(user, 'Importer un modèle');
  await user.press(
    screen.getByRole('button', { name: 'Choisir un dossier exporté' }),
  );
  await user.press(
    await screen.findByRole('button', {
      name: 'Charger le modèle',
      disabled: false,
    }),
  );
  await screen.findByText(/contexte détecté : 8192/i);
  await navigate(user, 'Conversation');
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
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
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
    await navigate(user, 'Modèle');
    await user.press(screen.getByRole('button', { name: 'Décharger' }));
    expect(native.unloadModel).not.toHaveBeenCalled();
    await respondToClear(alert, 'Effacer et continuer');
    expect(native.unloadModel).toHaveBeenCalledTimes(1);
    await navigate(user, 'Conversation');
    expect(screen.queryByText('Bonjour.')).not.toBeOnTheScreen();
    await navigate(user, 'Modèle');
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

test.each(['', ' \n\t '])(
  'a blank EOS result %j remains retryable without an empty assistant turn',
  async firstText => {
    native.generate.mockImplementation(async raw => {
      const request = JSON.parse(raw);
      if (
        request.messages.some(
          (message: { content: string }) => !message.content.trim(),
        )
      ) {
        throw new Error('Conversation invalide');
      }
      const text =
        native.generate.mock.calls.length === 1
          ? firstText
          : 'Réponse suivante';
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
  },
);

test('forwards budgets above 32 unchanged', async () => {
  const user = await load();
  await openResponseSettings(user);
  await user.type(
    screen.getByLabelText('Limite de réponse · facultatif'),
    '2048',
  );
  await navigate(user, 'Conversation');
  await user.type(screen.getByLabelText('Message'), 'Explique');
  await user.press(screen.getByRole('button', { name: 'Envoyer' }));
  await screen.findByText('Bonjour.');
  expect(JSON.parse(native.generate.mock.calls[0][0]).maxTokens).toBe(2048);
});

test('failed load leaves model retryable and generation unavailable', async () => {
  native.loadModel.mockRejectedValue(new Error('Mémoire insuffisante'));
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  await navigate(user, 'Modèle');
  await openDisclosure(user, 'Importer un modèle');
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
  await navigate(user, 'Conversation');
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
  await act(async () => {
    fireEvent.press(screen.getByRole('button', { name: 'Envoyer' }));
  });
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
