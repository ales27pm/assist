import React from 'react';
import { Platform, Share, View } from 'react-native';
import {
  fireEvent,
  renderAsync,
  screen,
  userEvent,
} from '@testing-library/react-native';
import { VoiceComparisonPanel } from '../src/VoiceComparisonPanel';
import { SettingsScreen } from '../src/SettingsScreen';
import { useSpeechVoiceComparison } from '../src/useSpeechVoiceComparison';
import { VOICE_COMPARISON_SAMPLES } from '../src/speechVoices';

jest.mock('../src/useSpeechVoiceComparison');
const useComparison = jest.mocked(useSpeechVoiceComparison);
const voices = [
  { id: 'voice-b', name: 'Chantal', language: 'fr-CA', quality: 'premium' },
  { id: 'voice-a', name: 'Amélie', language: 'fr-CA', quality: 'default' },
] as const;
function state() {
  const commands = {
    refresh: jest.fn().mockResolvedValue(undefined),
    play: jest.fn().mockResolvedValue(true),
    stop: jest.fn().mockResolvedValue(true),
    chooseVoice: jest.fn().mockResolvedValue(true),
  };
  const values: Omit<
    ReturnType<typeof useSpeechVoiceComparison>,
    keyof typeof commands
  > = {
    supported: true,
    catalog: {
      schemaVersion: 1,
      locale: 'fr-CA',
      voices: [...voices],
      selectedVoiceId: '',
      resolvedVoiceId: 'voice-b',
      selectionMissing: false,
    },
    candidates: [...voices],
    loading: false,
    error: '',
    playingId: null,
    saving: false,
  };
  return { ...values, ...commands };
}
let comparison = state();

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  comparison = state();
  useComparison.mockImplementation(() => comparison);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('keeps names hidden until an intentional reveal after a completed listen', async () => {
  const user = userEvent.setup();
  await renderAsync(<VoiceComparisonPanel onClose={jest.fn()} />);
  expect(screen.queryByText(/Amélie|Chantal/)).not.toBeOnTheScreen();
  expect(
    screen.getByRole('button', { name: 'Révéler les noms des voix' }),
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Partager le rapport d’écoute' }),
  ).toBeDisabled();
  await user.press(screen.getByRole('button', { name: 'Écouter Voix 1' }));
  expect(comparison.play).toHaveBeenCalledWith('voice-b', [
    'Salut! Peux-tu me rappeler d’acheter du lait tantôt, vers quatre heures et quart?',
  ]);
  expect(screen.queryByText(/Amélie|Chantal/)).not.toBeOnTheScreen();
  await user.press(
    screen.getByRole('button', { name: 'Révéler les noms des voix' }),
  );
  expect(screen.getByText('Voix 1 · Chantal · premium')).toBeOnTheScreen();
  await user.press(screen.getByRole('button', { name: 'Utiliser Voix 1' }));
  expect(comparison.chooseVoice).toHaveBeenCalledWith('voice-b');
  expect(
    screen.getByText('Choix enregistré pour les prochaines réponses vocales.'),
  ).toBeOnTheScreen();
  await user.press(
    screen.getByRole('button', { name: 'Revenir au choix automatique' }),
  );
  expect(comparison.chooseVoice).toHaveBeenLastCalledWith('');
});

test('compares identical content segmented and exports only completed trials with explicit ratings', async () => {
  const user = userEvent.setup();
  const share = jest.spyOn(Share, 'share').mockResolvedValue({
    action: Share.dismissedAction,
    activityType: undefined,
  });
  await renderAsync(<VoiceComparisonPanel onClose={jest.fn()} />);
  await user.press(
    screen.getByRole('radio', { name: 'Lecture : Segments successifs' }),
  );
  expect(
    screen.getByRole('radio', { name: 'Lecture : Segments successifs' }),
  ).toBeChecked();
  await user.press(screen.getByRole('button', { name: 'Écouter Voix 2' }));
  expect(comparison.play).toHaveBeenCalledWith(
    'voice-a',
    VOICE_COMPARISON_SAMPLES[0].segments,
  );
  await user.press(
    screen.getByRole('radio', { name: 'Accent québécois : Bon' }),
  );
  await user.press(
    screen.getByRole('radio', {
      name: 'Continuité entre les segments : Moyen',
    }),
  );
  await user.press(
    screen.getByRole('button', { name: 'Révéler les noms des voix' }),
  );
  await user.press(
    screen.getByRole('button', { name: 'Partager le rapport d’écoute' }),
  );
  const payload = JSON.parse(
    (share.mock.calls[0][0] as { message: string }).message,
  );
  expect(payload.trials).toEqual([
    {
      id: 1,
      voiceId: 'voice-a',
      label: 'Voix 2',
      sampleId: 'conversation',
      mode: 'segmented',
      listeningBlind: true,
      ratings: { accent: 3, continuity: 2 },
      ratingsBlind: { accent: true, continuity: true },
    },
  ]);
  expect(payload.offlineVerified).toBe(false);
  expect(payload.latencyMeasured).toBe(false);
  expect(payload.voices).toEqual(voices);
  expect(payload).not.toHaveProperty('audio');
  expect(payload).not.toHaveProperty('transcript');
});

test('does not count an interrupted preview as a completed listening trial', async () => {
  comparison.play.mockResolvedValue(false);
  const user = userEvent.setup();
  await renderAsync(<VoiceComparisonPanel onClose={jest.fn()} />);
  await user.press(screen.getByRole('button', { name: 'Écouter Voix 1' }));
  expect(
    screen.getByRole('button', { name: 'Révéler les noms des voix' }),
  ).toBeDisabled();
  expect(screen.queryByText('Ton avis · Voix 1')).not.toBeOnTheScreen();
});

test('distinguishes blind listening from ratings entered after the names are revealed', async () => {
  const user = userEvent.setup();
  const share = jest.spyOn(Share, 'share').mockResolvedValue({
    action: Share.dismissedAction,
    activityType: undefined,
  });
  await renderAsync(<VoiceComparisonPanel onClose={jest.fn()} />);
  await user.press(screen.getByRole('button', { name: 'Écouter Voix 1' }));
  await user.press(
    screen.getByRole('radio', { name: 'Accent québécois : Bon' }),
  );
  await user.press(
    screen.getByRole('button', { name: 'Révéler les noms des voix' }),
  );
  await user.press(
    screen.getByRole('radio', { name: 'Intelligibilité : Bon' }),
  );
  await user.press(
    screen.getByRole('radio', { name: 'Accent québécois : Moyen' }),
  );
  await user.press(
    screen.getByRole('button', { name: 'Partager le rapport d’écoute' }),
  );
  const payload = JSON.parse(
    (share.mock.calls[0][0] as { message: string }).message,
  );
  expect(payload.trials[0]).toMatchObject({
    listeningBlind: true,
    ratings: { accent: 2, clarity: 3 },
    ratingsBlind: { accent: false, clarity: false },
  });
});

test('keeps stop and close available during playback while locking the comparison parameters', async () => {
  comparison = { ...comparison, playingId: 'voice-b' };
  const onClose = jest.fn();
  comparison.stop.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const user = userEvent.setup();
  await renderAsync(<VoiceComparisonPanel onClose={onClose} />);
  expect(screen.getByRole('button', { name: 'Écouter Voix 1' })).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Actualiser les voix' }),
  ).toBeDisabled();
  expect(
    screen.getByRole('radio', { name: 'Lecture : Phrase entière' }),
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Arrêter l’aperçu' }),
  ).toBeEnabled();
  await user.press(
    screen.getByRole('button', { name: 'Fermer le comparatif' }),
  );
  expect(onClose).not.toHaveBeenCalled();
  await user.press(
    screen.getByRole('button', { name: 'Fermer le comparatif' }),
  );
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('explains an empty catalog and offers a refresh without requesting an audio preview', async () => {
  comparison = {
    ...comparison,
    candidates: [],
    catalog: { ...comparison.catalog!, voices: [], resolvedVoiceId: null },
  };
  const user = userEvent.setup();
  await renderAsync(<VoiceComparisonPanel onClose={jest.fn()} />);
  expect(
    screen.getByText(/Aucune voix Apple fr-CA disponible/),
  ).toBeOnTheScreen();
  await user.press(screen.getByRole('button', { name: 'Actualiser les voix' }));
  expect(comparison.refresh).toHaveBeenCalledTimes(1);
  expect(comparison.play).not.toHaveBeenCalled();
});

test('older builds remain readable and closable without pretending the comparison is supported', async () => {
  comparison = {
    ...comparison,
    supported: false,
    catalog: null,
    candidates: [],
  };
  const user = userEvent.setup();
  const onClose = jest.fn();
  await renderAsync(<VoiceComparisonPanel onClose={onClose} />);
  expect(screen.getByRole('alert')).toHaveTextContent(
    /nécessite une version iOS/,
  );
  expect(
    screen.queryByRole('button', { name: 'Actualiser les voix' }),
  ).not.toBeOnTheScreen();
  await user.press(
    screen.getByRole('button', { name: 'Fermer le comparatif' }),
  );
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('settings opens the comparison without starting playback and returns after a confirmed stop', async () => {
  const user = userEvent.setup();
  await renderAsync(
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
    />,
  );
  await user.press(screen.getByRole('button', { name: 'Voix de l’assistant' }));
  expect(
    screen.getByRole('heading', { name: 'Comparer les voix fr-CA' }),
  ).toBeOnTheScreen();
  expect(comparison.play).not.toHaveBeenCalled();
  await user.press(
    screen.getByRole('button', { name: 'Fermer le comparatif' }),
  );
  expect(
    screen.getByRole('button', { name: 'Voix de l’assistant' }),
  ).toBeOnTheScreen();
});

test('web radio keyboard selection changes the sample without triggering playback', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  await renderAsync(<VoiceComparisonPanel onClose={jest.fn()} />);
  const first = screen.getByRole('radio', {
    name: 'Phrase d’essai : Conversation et heure',
  });
  const preventDefault = jest.fn();
  fireEvent(first, 'keyDown', {
    nativeEvent: { key: 'ArrowDown' },
    preventDefault,
  });
  expect(preventDefault).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole('radio', { name: 'Phrase d’essai : Noms québécois' }),
  ).toBeChecked();
  expect(comparison.play).not.toHaveBeenCalled();
});
