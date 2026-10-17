import React from 'react';
import { AppState } from 'react-native';
import {
  act,
  renderAsync,
  screen,
  userEvent,
} from '@testing-library/react-native';
import NativeAssist from '../specs/NativeAssist';
import { AdvancedVoicePanel } from '../src/AdvancedVoicePanel';
import { SettingsScreen } from '../src/SettingsScreen';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    getAdvancedVoiceState: jest.fn(),
    importAdvancedVoicePack: jest.fn(),
    setAdvancedVoiceBackend: jest.fn(),
    importAdvancedVoiceReference: jest.fn(),
    removeAdvancedVoiceReference: jest.fn(),
    startListening: jest.fn(),
  },
}));
const native = jest.mocked(NativeAssist!);
const empty = {
  schemaVersion: 1,
  revision: 0,
  selectedBackend: 'apple',
  selectedVariant: 'redux',
  effectiveBackend: 'apple',
  ready: false,
  resources: { pocket: false, redux: false, ultra: false, silero: false },
  reference: { ready: false },
};
const complete = {
  ...empty,
  revision: 1,
  ready: true,
  resources: { pocket: true, redux: true, ultra: true, silero: true },
  reference: { ready: true, speakerName: 'Camille' },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
const consentLabel =
  'Je confirme l’autorisation de cloner et reproduire cette voix localement';
let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  jest.useFakeTimers();
  jest.resetAllMocks();
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: 'active',
  });
  jest
    .spyOn(AppState, 'addEventListener')
    .mockReturnValue({ remove: jest.fn() });
  user = userEvent.setup();
  native.getAdvancedVoiceState.mockResolvedValue(JSON.stringify(empty));
  native.importAdvancedVoicePack.mockResolvedValue(JSON.stringify(complete));
  native.importAdvancedVoiceReference.mockResolvedValue(
    JSON.stringify(complete),
  );
  native.removeAdvancedVoiceReference.mockResolvedValue(
    JSON.stringify({ ...empty, revision: 2 }),
  );
  native.setAdvancedVoiceBackend.mockImplementation(async (backend, variant) =>
    JSON.stringify({
      ...complete,
      revision: 2,
      selectedBackend: backend,
      selectedVariant: variant,
      effectiveBackend: backend,
    }),
  );
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('settings opens resource management only after the explicit advanced voice action', async () => {
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
      appearanceRef={{ current: null }}
    />,
  );
  expect(native.getAdvancedVoiceState).not.toHaveBeenCalled();
  await user.press(screen.getByRole('button', { name: 'Voix locale avancée' }));
  expect(
    screen.getByRole('heading', { name: 'Voix locale avancée' }),
  ).toBeOnTheScreen();
  expect(native.getAdvancedVoiceState).toHaveBeenCalledTimes(1);
  expect(native.startListening).not.toHaveBeenCalled();
  expect(native.importAdvancedVoicePack).not.toHaveBeenCalled();
  await user.press(screen.getByRole('button', { name: 'Retour aux réglages' }));
  expect(screen.getByRole('heading', { name: 'Réglages' })).toBeOnTheScreen();
});

test('shows the actual Apple fallback and keeps unavailable Fluid variants disabled', async () => {
  await renderAsync(<AdvancedVoicePanel onClose={jest.fn()} />);
  expect(screen.getByText('Configuration : Voix Apple.')).toBeOnTheScreen();
  expect(screen.getByRole('radio', { name: 'Voix Apple' })).toBeChecked();
  expect(
    screen.getByRole('radio', { name: 'FluidAudio · Parakeet Redux' }),
  ).toBeDisabled();
  expect(
    screen.getByRole('radio', { name: 'FluidAudio · Parakeet Ultra' }),
  ).toBeDisabled();
  expect(
    screen.getByText(
      'Aucune référence importée. Les voix Apple restent disponibles.',
    ),
  ).toBeOnTheScreen();
  expect(native.setAdvancedVoiceBackend).not.toHaveBeenCalled();
});

test('requires an explicit speaker and unchecked-by-default consent before opening the import pickers', async () => {
  await renderAsync(<AdvancedVoicePanel onClose={jest.fn()} />);
  const importButton = () =>
    screen.getByRole('button', {
      name: 'Importer la référence et son consentement',
    });
  expect(
    screen.getByRole('checkbox', { name: consentLabel }),
  ).not.toBeChecked();
  expect(importButton()).toBeDisabled();
  await user.type(
    screen.getByLabelText('Nom de la personne autorisée'),
    'Camille',
  );
  expect(importButton()).toBeDisabled();
  await user.press(screen.getByRole('checkbox', { name: consentLabel }));
  expect(importButton()).toBeEnabled();
  expect(native.importAdvancedVoiceReference).not.toHaveBeenCalled();
  await user.press(importButton());
  expect(native.importAdvancedVoiceReference).toHaveBeenCalledWith(
    JSON.stringify({ speakerName: 'Camille', consentConfirmed: true }),
  );
  expect(screen.getByText('Référence prête · Camille.')).toBeOnTheScreen();
  expect(native.startListening).not.toHaveBeenCalled();
});

test('changing the speaker invalidates the previous consent confirmation', async () => {
  await renderAsync(<AdvancedVoicePanel onClose={jest.fn()} />);
  const name = screen.getByLabelText('Nom de la personne autorisée');
  await user.type(name, 'Camille');
  await user.press(screen.getByRole('checkbox', { name: consentLabel }));
  await user.type(name, ' B');
  expect(
    screen.getByRole('checkbox', { name: consentLabel }),
  ).not.toBeChecked();
  expect(
    screen.getByRole('button', {
      name: 'Importer la référence et son consentement',
    }),
  ).toBeDisabled();
});

test('explains local preparation, storage and supported consent inputs without claiming a download', async () => {
  await renderAsync(<AdvancedVoicePanel onClose={jest.fn()} />);
  expect(screen.getByText(/WAV de 3 à 30 secondes/)).toBeOnTheScreen();
  expect(
    screen.getByText(/PDF, texte ou JSON \(5 Mo maximum\)/),
  ).toBeOnTheScreen();
  await user.press(screen.getByRole('button', { name: 'Préparer le pack' }));
  expect(screen.getByText(/1,25 Go avec Redux/)).toBeOnTheScreen();
  expect(screen.getByText(/copie et vérifie les modèles/)).toBeOnTheScreen();
  expect(native.importAdvancedVoicePack).not.toHaveBeenCalled();
});

test('an in-flight import disables actions and close until the native acknowledgement', async () => {
  const importing = deferred<string>();
  native.importAdvancedVoicePack.mockReturnValueOnce(importing.promise);
  const close = jest.fn();
  await renderAsync(<AdvancedVoicePanel onClose={close} />);
  await user.press(
    screen.getByRole('button', { name: 'Importer un pack de modèles' }),
  );
  expect(
    screen.getByRole('button', { name: 'Retour aux réglages' }),
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Actualiser les ressources' }),
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Importer un pack de modèles' }),
  ).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent(
    /Importation et vérification/,
  );
  await user.press(screen.getByRole('button', { name: 'Retour aux réglages' }));
  expect(close).not.toHaveBeenCalled();
  await act(async () => importing.resolve(JSON.stringify(complete)));
  expect(screen.getByText('Parakeet Redux : prêt.')).toBeOnTheScreen();
  expect(
    screen.getByRole('button', { name: 'Retour aux réglages' }),
  ).toBeEnabled();
});

test('backend activation waits for native acknowledgement and a failed activation preserves Apple', async () => {
  native.getAdvancedVoiceState.mockResolvedValueOnce(JSON.stringify(complete));
  native.setAdvancedVoiceBackend.mockRejectedValueOnce(
    new Error('Chargement local impossible.'),
  );
  await renderAsync(<AdvancedVoicePanel onClose={jest.fn()} />);
  await user.press(
    screen.getByRole('radio', { name: 'FluidAudio · Parakeet Redux' }),
  );
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Chargement local impossible.',
  );
  expect(screen.getByRole('radio', { name: 'Voix Apple' })).toBeChecked();
  expect(screen.getByText('Configuration : Voix Apple.')).toBeOnTheScreen();
  await user.press(
    screen.getByRole('radio', { name: 'FluidAudio · Parakeet Ultra' }),
  );
  expect(
    screen.getByRole('radio', { name: 'FluidAudio · Parakeet Ultra' }),
  ).toBeChecked();
  expect(screen.getByText('Configuration : FluidAudio.')).toBeOnTheScreen();
  expect(
    screen.getByText(/chargés à l’ouverture du mode vocal/),
  ).toBeOnTheScreen();
});

test('reference removal is explicit and reflects the native Apple fallback', async () => {
  native.getAdvancedVoiceState.mockResolvedValueOnce(JSON.stringify(complete));
  await renderAsync(<AdvancedVoicePanel onClose={jest.fn()} />);
  expect(native.removeAdvancedVoiceReference).not.toHaveBeenCalled();
  await user.press(
    screen.getByRole('button', {
      name: 'Supprimer la référence et son consentement',
    }),
  );
  expect(native.removeAdvancedVoiceReference).toHaveBeenCalledTimes(1);
  expect(
    screen.getByText(
      'Aucune référence importée. Les voix Apple restent disponibles.',
    ),
  ).toBeOnTheScreen();
  expect(
    screen.queryByRole('button', {
      name: 'Supprimer la référence et son consentement',
    }),
  ).not.toBeOnTheScreen();
});
