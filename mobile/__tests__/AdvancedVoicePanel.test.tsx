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
    startListening: jest.fn(),
  },
}));
const native = jest.mocked(NativeAssist!);
const empty = {
  schemaVersion: 2,
  revision: 0,
  selectedBackend: 'apple',
  selectedVariant: 'redux',
  effectiveBackend: 'apple',
  ready: false,
  resources: { pocket: false, redux: false, ultra: false, silero: false },
  voice: 'estelle',
};
const complete = {
  ...empty,
  revision: 1,
  ready: true,
  resources: { pocket: true, redux: true, ultra: true, silero: true },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
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
  expect(screen.getByText('Voix française : Estelle.')).toBeOnTheScreen();
  expect(native.setAdvancedVoiceBackend).not.toHaveBeenCalled();
});

test('explains local preparation and storage without claiming a download', async () => {
  await renderAsync(<AdvancedVoicePanel onClose={jest.fn()} />);
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
  expect(screen.getByText('Parakeet Redux : importé.')).toBeOnTheScreen();
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

test('the imported Redux pack activates Estelle without a reference or consent step', async () => {
  const redux = {
    ...complete,
    resources: { ...complete.resources, ultra: false },
  };
  native.getAdvancedVoiceState.mockResolvedValueOnce(JSON.stringify(redux));
  await renderAsync(<AdvancedVoicePanel onClose={jest.fn()} />);
  expect(screen.getByText('Voix française : Estelle.')).toBeOnTheScreen();
  expect(screen.queryByText('Ta référence vocale')).not.toBeOnTheScreen();
  expect(screen.queryByRole('checkbox')).not.toBeOnTheScreen();
  expect(
    screen.queryByLabelText('Nom de la personne autorisée'),
  ).not.toBeOnTheScreen();
  expect(
    screen.getByRole('radio', { name: 'FluidAudio · Parakeet Redux' }),
  ).toBeEnabled();
  expect(
    screen.getByRole('radio', { name: 'FluidAudio · Parakeet Ultra' }),
  ).toBeDisabled();
  await user.press(
    screen.getByRole('radio', { name: 'FluidAudio · Parakeet Redux' }),
  );
  expect(native.setAdvancedVoiceBackend).toHaveBeenCalledWith('fluid', 'redux');
  expect(screen.getByText('Configuration : FluidAudio.')).toBeOnTheScreen();
  expect(native.importAdvancedVoicePack).not.toHaveBeenCalled();
  expect(native.startListening).not.toHaveBeenCalled();
});
