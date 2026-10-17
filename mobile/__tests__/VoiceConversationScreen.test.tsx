import React from 'react';
import { View } from 'react-native';
import {
  fireEvent,
  renderAsync,
  screen,
  userEvent,
} from '@testing-library/react-native';
import {
  VoiceConversationScreen,
  VoiceConversationScreenProps,
} from '../src/VoiceConversationScreen';
import { SettingsScreen } from '../src/SettingsScreen';
import type { VoiceInputDiagnostics } from '../src/voice';

function props(
  extra: Partial<VoiceConversationScreenProps> = {},
): VoiceConversationScreenProps {
  return {
    phase: 'listening',
    transcript: '',
    reply: '',
    readResponses: true,
    onPause: jest.fn(),
    onResume: jest.fn(),
    onInterrupt: jest.fn(),
    onClose: jest.fn(),
    onSettings: jest.fn(),
    ...extra,
  };
}

function diagnostics(
  extra: Partial<VoiceInputDiagnostics> = {},
): VoiceInputDiagnostics {
  return {
    bufferCount: 4,
    frameCount: 1920,
    sampleRate: 48_000,
    channels: 1,
    peak: 0.6,
    level: 0.2,
    measured: true,
    elapsedMs: 200,
    inputPort: 'MicrophoneBuiltIn',
    ...extra,
  };
}

function settings(
  extra: Partial<React.ComponentProps<typeof SettingsScreen>> = {},
) {
  return (
    <SettingsScreen
      modelStatus="Prêt"
      budget=""
      budgetError=""
      busy={false}
      responseOpen={false}
      onToggleResponse={jest.fn()}
      onBudgetChange={jest.fn()}
      onModel={jest.fn()}
      onAppearance={jest.fn()}
      appearanceRef={React.createRef<React.ComponentRef<typeof View>>()}
      {...extra}
    />
  );
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

test('presents a dedicated automatic voice surface without a composer or inline reading preference', async () => {
  const state = props();
  await renderAsync(<VoiceConversationScreen {...state} />);

  expect(screen.getByRole('heading', { name: 'Mode vocal' })).toBeOnTheScreen();
  expect(screen.getByText('On reste sur cet appareil.')).toBeOnTheScreen();
  expect(screen.getByLabelText(/^À ton écoute\./)).toHaveAccessibleName(
    'À ton écoute. Parle, puis laisse une pause pour terminer ton tour.',
  );
  expect(screen.queryByRole('switch')).not.toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: /Envoyer|Dicter/ }),
  ).not.toBeOnTheScreen();
  expect(screen.queryByLabelText('Message')).not.toBeOnTheScreen();
  for (const action of [
    state.onPause,
    state.onResume,
    state.onInterrupt,
    state.onClose,
    state.onSettings,
  ]) {
    expect(action).not.toHaveBeenCalled();
  }
});

test.each([
  ['starting', 'Préparation du mode vocal'],
  ['listening', 'À ton écoute'],
  ['finishing', 'Je termine ton message'],
  ['thinking', 'Je prépare la réponse'],
  ['speaking', 'Réponse vocale'],
  ['paused', 'En pause'],
  ['error', 'Mode vocal interrompu'],
] as const)(
  'keeps close and settings available in the %s state',
  async (phase, title) => {
    const user = userEvent.setup();
    const state = props({ phase });
    await renderAsync(<VoiceConversationScreen {...state} />);

    expect(screen.getByText(title)).toBeOnTheScreen();
    await user.press(
      screen.getByRole('button', { name: 'Réglages du mode vocal' }),
    );
    await user.press(
      screen.getByRole('button', { name: 'Fermer le mode vocal' }),
    );
    expect(state.onSettings).toHaveBeenCalledTimes(1);
    expect(state.onClose).toHaveBeenCalledTimes(1);
    expect(state.onInterrupt).not.toHaveBeenCalled();
  },
);

test.each([
  'starting',
  'listening',
  'finishing',
  'thinking',
  'speaking',
] as const)(
  'offers explicit pause during %s without resuming implicitly',
  async phase => {
    const user = userEvent.setup();
    const state = props({ phase });
    await renderAsync(<VoiceConversationScreen {...state} />);
    await user.press(screen.getByRole('button', { name: 'Mettre en pause' }));
    expect(state.onPause).toHaveBeenCalledTimes(1);
    expect(state.onResume).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Reprendre' }),
    ).not.toBeOnTheScreen();
  },
);

test.each(['paused', 'error'] as const)(
  'requires explicit resume from %s',
  async phase => {
    const user = userEvent.setup();
    const state = props({ phase });
    await renderAsync(<VoiceConversationScreen {...state} />);
    expect(state.onResume).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Mettre en pause' }),
    ).not.toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Reprendre' }));
    expect(state.onResume).toHaveBeenCalledTimes(1);
    expect(state.onPause).not.toHaveBeenCalled();
  },
);

test('offers interruption only while preparing or speaking a response', async () => {
  const user = userEvent.setup();
  const state = props({ phase: 'thinking' });
  const { rerenderAsync } = await renderAsync(
    <VoiceConversationScreen {...state} />,
  );
  await user.press(screen.getByRole('button', { name: 'Interrompre' }));
  await rerenderAsync(<VoiceConversationScreen {...state} phase="speaking" />);
  await user.press(screen.getByRole('button', { name: 'Interrompre' }));
  expect(state.onInterrupt).toHaveBeenCalledTimes(2);
  await rerenderAsync(<VoiceConversationScreen {...state} phase="listening" />);
  expect(
    screen.queryByRole('button', { name: 'Interrompre' }),
  ).not.toBeOnTheScreen();
});

test.each(['thinking', 'speaking'] as const)(
  'only promises acoustic interruption in %s after native monitoring is ready',
  async phase => {
    const user = userEvent.setup();
    const state = props({ phase, diagnostics: diagnostics() });
    const { rerenderAsync } = await renderAsync(
      <VoiceConversationScreen {...state} />,
    );
    expect(
      screen.getByText('Touche Interrompre pour reprendre la parole.'),
    ).toBeOnTheScreen();
    expect(
      screen.queryByText('Micro actif pendant la réponse.'),
    ).not.toBeOnTheScreen();
    expect(screen.queryByLabelText(/Parle pour m’interrompre/)).not.toBeOnTheScreen();

    await rerenderAsync(
      <VoiceConversationScreen {...state} bargeInReady />,
    );
    expect(screen.getByText('Micro actif pendant la réponse.')).toBeOnTheScreen();
    expect(
      screen.getByText('Parle pour m’interrompre, ou touche Interrompre.'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText(/Micro actif pendant la réponse/)).toHaveProp(
      'accessibilityLiveRegion',
      'polite',
    );
    // The native monitor supplies readiness, not microphone metering snapshots.
    expect(screen.queryByRole('progressbar')).not.toBeOnTheScreen();
    await user.press(screen.getByRole('button', { name: 'Interrompre' }));
    expect(state.onInterrupt).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('switch')).not.toBeOnTheScreen();

    await rerenderAsync(
      <VoiceConversationScreen {...state} bargeInReady={false} />,
    );
    expect(
      screen.queryByText('Micro actif pendant la réponse.'),
    ).not.toBeOnTheScreen();
    expect(screen.queryByLabelText(/Parle pour m’interrompre/)).not.toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Interrompre' })).toBeEnabled();
  },
);

test.each([
  'starting',
  'listening',
  'finishing',
  'stopping',
  'paused',
  'error',
] as const)(
  'ignores stale response monitoring readiness in %s',
  async phase => {
    await renderAsync(
      <VoiceConversationScreen {...props({ phase, bargeInReady: true })} />,
    );
    expect(
      screen.queryByText('Micro actif pendant la réponse.'),
    ).not.toBeOnTheScreen();
    expect(screen.queryByLabelText(/Parle pour m’interrompre/)).not.toBeOnTheScreen();
    expect(
      screen.queryByRole('button', { name: 'Interrompre' }),
    ).not.toBeOnTheScreen();
    if (phase !== 'listening')
      expect(screen.queryByRole('progressbar')).not.toBeOnTheScreen();
  },
);

test('the microphone meter exposes measured input only during listening', async () => {
  const state = props();
  const { rerenderAsync } = await renderAsync(
    <VoiceConversationScreen {...state} />,
  );
  expect(
    screen.getByRole('progressbar', { name: 'Niveau du microphone' }),
  ).toHaveAccessibilityValue({
    text: 'En attente d’audio du micro.',
  });
  await rerenderAsync(
    <VoiceConversationScreen
      {...state}
      diagnostics={diagnostics({ measured: false })}
    />,
  );
  expect(
    screen.getByRole('progressbar', { name: 'Niveau du microphone' }),
  ).toHaveAccessibilityValue({
    text: 'Audio reçu · niveau indisponible.',
  });
  await rerenderAsync(
    <VoiceConversationScreen
      {...state}
      diagnostics={diagnostics({ level: 0.75 })}
    />,
  );
  expect(
    screen.getByRole('progressbar', { name: 'Niveau du microphone' }),
  ).toHaveAccessibilityValue({
    min: 0,
    max: 100,
    now: 75,
    text: 'Audio reçu · niveau 75 %.',
  });
  expect(screen.getByLabelText(/^À ton écoute\./)).toHaveAccessibleName(
    'À ton écoute. Parle, puis laisse une pause pour terminer ton tour.',
  );
  await rerenderAsync(
    <VoiceConversationScreen
      {...state}
      phase="speaking"
      diagnostics={diagnostics()}
    />,
  );
  expect(
    screen.queryByRole('progressbar', { name: 'Niveau du microphone' }),
  ).not.toBeOnTheScreen();
});

test('preserves complete long messages, explicit controls and a reading-off explanation', async () => {
  const transcript = 'Un long message québécois. '.repeat(60);
  const reply = 'Une réponse locale complète. '.repeat(100);
  await renderAsync(
    <VoiceConversationScreen
      {...props({ transcript, reply, readResponses: false })}
    />,
  );

  expect(
    screen.getByRole('heading', { name: 'Ton message' }),
  ).toBeOnTheScreen();
  expect(
    screen.getByRole('heading', { name: 'Réponse de l’assistant' }),
  ).toBeOnTheScreen();
  expect(screen.getByText(transcript, { normalizer: text => text })).toHaveProp(
    'selectable',
    true,
  );
  expect(screen.getByText(reply, { normalizer: text => text })).toHaveProp(
    'selectable',
    true,
  );
  expect(
    screen.getByText(
      'Lecture automatique désactivée · les réponses restent visibles.',
    ),
  ).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Mettre en pause' })).toBeEnabled();
  expect(
    screen.getByRole('button', { name: 'Fermer le mode vocal' }),
  ).toBeEnabled();
});

test.each(['listening', 'paused'] as const)(
  'identifies an interrupted reply during %s until the next response',
  async phase => {
    const reply = 'Le début de la réponse précédente…';
    const state = props({ phase, reply, replyInterrupted: true });
    const { rerenderAsync } = await renderAsync(
      <VoiceConversationScreen {...state} />,
    );
    expect(
      screen.getByRole('heading', { name: 'Réponse interrompue' }),
    ).toBeOnTheScreen();
    expect(screen.getByText(reply)).toHaveProp('selectable', true);
    expect(
      screen.queryByRole('heading', { name: 'Réponse de l’assistant' }),
    ).not.toBeOnTheScreen();

    await rerenderAsync(
      <VoiceConversationScreen
        {...state}
        phase="speaking"
        reply="La nouvelle réponse."
        replyInterrupted={false}
      />,
    );
    expect(
      screen.getByRole('heading', { name: 'Réponse de l’assistant' }),
    ).toBeOnTheScreen();
    expect(
      screen.queryByRole('heading', { name: 'Réponse interrompue' }),
    ).not.toBeOnTheScreen();
  },
);

test('exposes a useful error while retaining explicit recovery and exit', async () => {
  const message = 'Aucune voix locale disponible sur cet appareil.';
  await renderAsync(
    <VoiceConversationScreen {...props({ phase: 'error', error: message })} />,
  );
  expect(screen.getByRole('alert')).toHaveTextContent(message);
  expect(screen.getByRole('button', { name: 'Reprendre' })).toBeEnabled();
  expect(
    screen.getByRole('button', { name: 'Fermer le mode vocal' }),
  ).toBeEnabled();
});

test('settings defaults reading on and lets the caller control opting out', async () => {
  const onReadResponsesChange = jest.fn();
  const { rerenderAsync } = await renderAsync(
    settings({ onReadResponsesChange }),
  );
  const toggle = screen.getByRole('switch', {
    name: 'Lire les réponses à voix haute',
  });
  expect(toggle).toBeChecked();
  expect(toggle).toBeEnabled();
  // RNTL 13 userEvent has no Switch valueChange action.
  fireEvent(toggle, 'valueChange', false);
  expect(onReadResponsesChange).toHaveBeenCalledWith(false);
  await rerenderAsync(
    settings({ readResponses: false, onReadResponsesChange }),
  );
  expect(
    screen.getByRole('switch', { name: 'Lire les réponses à voix haute' }),
  ).not.toBeChecked();
});

test('settings keeps the reading opt-out usable when no local voice is available', async () => {
  const onReadResponsesChange = jest.fn();
  await renderAsync(settings({ voiceAvailable: false, onReadResponsesChange }));
  const toggle = screen.getByRole('switch', {
    name: 'Lire les réponses à voix haute',
  });
  expect(toggle).toBeEnabled();
  expect(toggle).toBeChecked();
  fireEvent(toggle, 'valueChange', false);
  expect(onReadResponsesChange).toHaveBeenCalledWith(false);
  expect(screen.getByText(/Voix locale indisponible/)).toBeOnTheScreen();
});
