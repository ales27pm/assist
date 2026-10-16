import React from 'react';
import {
  act,
  renderAsync,
  screen,
  userEvent,
} from '@testing-library/react-native';
import { Share } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import {
  assetProbeExpectedFiles,
  assetProbeMeasurementMethods,
} from '../src/assetProbe';
import { ModelAssetProbePanel } from '../src/ModelAssetProbePanel';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    getLastModelAssetProbe: jest.fn(),
    runModelAssetProbe: jest.fn(),
    loadModel: jest.fn(),
    runModelLoadProbe: jest.fn(),
  },
}));
jest.useFakeTimers();
const native = jest.mocked(NativeAssist!);
const pending = {
  schemaVersion: 1,
  kind: 'assistModelAssetDiagnostic',
  scope: 'selected_f16_asset_identity_only_no_coreai',
  expectedModelName: 'gemma4-e2b-32k-group8-rmscomposite',
  contextCapacity: 32768,
  nativeBuild: '10',
  osVersion: 'iOS 27.2',
  attempt: {
    id: '9cde6700-1e52-4a3c-9b84-8a677eb4124a',
    startedAtUTC: '2026-10-16T17:00:00.123Z',
    processIdentifier: 21893,
    entryPoint: 'selected_f16_asset_identity_probe',
  },
  stage: 'checking_files',
  currentFileRole: 'bundle_metadata',
  files: assetProbeExpectedFiles.map(file => ({ ...file, bytesRead: 0 })),
  measurementMethods: assetProbeMeasurementMethods,
};
const completed = {
  ...pending,
  stage: 'completed',
  currentFileRole: undefined,
  storedMainHashMatches: true,
  files: pending.files.map(file => ({
    ...file,
    bytesRead: file.expectedBytes,
    sha256: file.expectedSHA256,
    matchesExpected: true,
  })),
};
const failed = {
  ...pending,
  stage: 'failed',
  errorCode: 'E_ASSET_IDENTITY_IO',
  posixErrno: 13,
};
const perform = jest.fn(async (action: () => Promise<void>) => action());
const runLabel = 'Vérifier l’asset F16';
const shareLabel = 'Partager le rapport d’identité F16';

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  native.getLastModelAssetProbe.mockReset().mockResolvedValue('null');
  native.runModelAssetProbe
    .mockReset()
    .mockResolvedValue(JSON.stringify(completed));
});

test('restores and shares a pending report without selection, engine change or retry', async () => {
  native.getLastModelAssetProbe.mockResolvedValue(
    JSON.stringify({
      ...pending,
      path: '/private/model',
    }),
  );
  const share = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
  const user = userEvent.setup();
  await renderAsync(
    <ModelAssetProbePanel
      selected={false}
      busy={false}
      modelLoaded
      perform={perform}
    />,
  );
  expect(
    await screen.findByText(
      /Dernière étape enregistrée : vérification des fichiers/,
    ),
  ).toBeOnTheScreen();
  expect(
    screen.getByText(/Essai du 2026-10-16T17:00:00.123Z/),
  ).toBeOnTheScreen();
  expect(
    screen.getByText(
      /embeddings par couche et le tokenizer ne sont pas vérifiés/,
    ),
  ).toBeOnTheScreen();
  expect(native.runModelAssetProbe).not.toHaveBeenCalled();
  expect(native.loadModel).not.toHaveBeenCalled();
  expect(native.runModelLoadProbe).not.toHaveBeenCalled();
  expect(perform).not.toHaveBeenCalled();
  await user.press(screen.getByRole('button', { name: shareLabel }));
  expect(share).toHaveBeenCalledTimes(1);
  expect(JSON.parse(share.mock.calls[0][0].message!)).toEqual(pending);
});

test('requires a selected folder, no resident model and no other operation', async () => {
  const user = userEvent.setup();
  await renderAsync(
    <ModelAssetProbePanel
      selected={false}
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  expect(screen.getByRole('button', { name: runLabel })).toBeDisabled();
  await user.press(screen.getByRole('button', { name: runLabel }));
  await screen.rerenderAsync(
    <ModelAssetProbePanel
      selected
      busy={false}
      modelLoaded
      perform={perform}
    />,
  );
  expect(screen.getByRole('button', { name: runLabel })).toBeDisabled();
  await user.press(screen.getByRole('button', { name: runLabel }));
  await screen.rerenderAsync(
    <ModelAssetProbePanel
      selected
      busy
      modelLoaded={false}
      perform={perform}
    />,
  );
  expect(screen.getByRole('button', { name: runLabel })).toBeDisabled();
  await user.press(screen.getByRole('button', { name: runLabel }));
  expect(native.runModelAssetProbe).not.toHaveBeenCalled();
  expect(perform).not.toHaveBeenCalled();
});

test('runs the no-path identity action only on a manual press inside perform', async () => {
  const user = userEvent.setup();
  await renderAsync(
    <ModelAssetProbePanel
      selected
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  expect(native.runModelAssetProbe).not.toHaveBeenCalled();
  await user.press(screen.getByRole('button', { name: runLabel }));
  expect(
    await screen.findByText(
      /Les quatre fichiers correspondent à la référence F16/,
    ),
  ).toBeOnTheScreen();
  expect(
    screen.getByText('Fichiers conformes dans ce rapport : 4/4.'),
  ).toBeOnTheScreen();
  expect(native.runModelAssetProbe).toHaveBeenCalledTimes(1);
  expect(native.runModelAssetProbe).toHaveBeenCalledWith();
  expect(perform).toHaveBeenCalledTimes(1);
  expect(native.loadModel).not.toHaveBeenCalled();
  expect(native.runModelLoadProbe).not.toHaveBeenCalled();
});

test('shares a failed result and numeric errno without adding a diagnosis or retry', async () => {
  native.runModelAssetProbe.mockImplementation(async () => {
    native.getLastModelAssetProbe.mockResolvedValue(JSON.stringify(failed));
    return JSON.stringify(failed);
  });
  const share = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
  const user = userEvent.setup();
  await renderAsync(
    <ModelAssetProbePanel
      selected
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  await user.press(screen.getByRole('button', { name: runLabel }));
  expect(
    await screen.findByText(
      'La vérification n’a pas confirmé l’identité de l’asset.',
    ),
  ).toBeOnTheScreen();
  expect(screen.getByText(/Un fichier n’a pas pu être lu/)).toBeOnTheScreen();
  expect(
    screen.getByText('Erreur système enregistrée : errno 13.'),
  ).toBeOnTheScreen();
  await user.press(screen.getByRole('button', { name: shareLabel }));
  expect(JSON.parse(share.mock.calls[0][0].message!)).toEqual(failed);
  expect(native.runModelAssetProbe).toHaveBeenCalledTimes(1);
});

test('restores a saved failure after a native rejection without exposing its message', async () => {
  native.runModelAssetProbe.mockImplementation(async () => {
    native.getLastModelAssetProbe.mockResolvedValue(JSON.stringify(failed));
    throw new Error('/private/model secret');
  });
  const user = userEvent.setup();
  await renderAsync(
    <ModelAssetProbePanel
      selected
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  await user.press(screen.getByRole('button', { name: runLabel }));
  expect(
    await screen.findByText(/La vérification n’a pas confirmé/),
  ).toBeOnTheScreen();
  expect(screen.queryByText(/private\/model/)).toBeNull();
  expect(screen.getByRole('button', { name: shareLabel })).toBeEnabled();
  expect(native.runModelAssetProbe).toHaveBeenCalledTimes(1);
});

test.each([
  'not JSON',
  JSON.stringify({ ...pending, stage: 'completed' }),
  JSON.stringify({ ...pending, currentFileRole: 'tokenizer' }),
])(
  'does not display or share a malformed saved report, case %#',
  async saved => {
    native.getLastModelAssetProbe.mockResolvedValue(saved);
    await renderAsync(
      <ModelAssetProbePanel
        selected={false}
        busy={false}
        modelLoaded={false}
        perform={perform}
      />,
    );
    expect(
      await screen.findByText(
        'Le rapport d’identité enregistré est indisponible.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: shareLabel })).toBeNull();
    expect(native.runModelAssetProbe).not.toHaveBeenCalled();
  },
);

test('rejects a malformed manual result without retrying or offering it for sharing', async () => {
  native.runModelAssetProbe.mockResolvedValue(
    JSON.stringify({ ...completed, files: [] }),
  );
  const user = userEvent.setup();
  await renderAsync(
    <ModelAssetProbePanel
      selected
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  await user.press(screen.getByRole('button', { name: runLabel }));
  expect(
    await screen.findByText(
      'La vérification n’a pas retourné de rapport exploitable.',
    ),
  ).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: shareLabel })).toBeNull();
  expect(native.runModelAssetProbe).toHaveBeenCalledTimes(1);
});

test('prevents an older restoration request from replacing the manual result', async () => {
  let restore: (value: string) => void = () => undefined;
  native.getLastModelAssetProbe.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        restore = resolve;
      }),
  );
  const user = userEvent.setup();
  await renderAsync(
    <ModelAssetProbePanel
      selected
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  await user.press(screen.getByRole('button', { name: runLabel }));
  expect(
    await screen.findByText(/Les quatre fichiers correspondent/),
  ).toBeOnTheScreen();
  await act(async () => restore(JSON.stringify(pending)));
  expect(
    screen.getByText(/Les quatre fichiers correspondent/),
  ).toBeOnTheScreen();
  expect(screen.queryByText(/Dernière étape enregistrée/)).toBeNull();
});

test('hides a restored success when a folder is selected and does not restore it again', async () => {
  native.getLastModelAssetProbe.mockResolvedValue(JSON.stringify(completed));
  await renderAsync(
    <ModelAssetProbePanel
      selected={false}
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  expect(
    screen.getByText(/Les quatre fichiers correspondent/),
  ).toBeOnTheScreen();
  await screen.rerenderAsync(
    <ModelAssetProbePanel
      selected
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  expect(screen.queryByText(/Les quatre fichiers correspondent/)).toBeNull();
  expect(screen.queryByRole('button', { name: shareLabel })).toBeNull();
  expect(native.getLastModelAssetProbe).toHaveBeenCalledTimes(1);
});

test('hides the old report when another folder replaces the current selection', async () => {
  native.getLastModelAssetProbe.mockResolvedValue(JSON.stringify(completed));
  await renderAsync(
    <ModelAssetProbePanel
      selected
      selectionVersion={1}
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  expect(
    screen.getByText(/Les quatre fichiers correspondent/),
  ).toBeOnTheScreen();
  await screen.rerenderAsync(
    <ModelAssetProbePanel
      selected
      selectionVersion={2}
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  expect(screen.queryByText(/Les quatre fichiers correspondent/)).toBeNull();
  expect(screen.queryByRole('button', { name: shareLabel })).toBeNull();
});

test('ignores a restoration that finishes after the folder selection changes', async () => {
  let restore!: (value: string) => void;
  native.getLastModelAssetProbe.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        restore = resolve;
      }),
  );
  await renderAsync(
    <ModelAssetProbePanel
      selected={false}
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  await screen.rerenderAsync(
    <ModelAssetProbePanel
      selected
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  await act(async () => restore(JSON.stringify(completed)));
  expect(screen.queryByText(/Les quatre fichiers correspondent/)).toBeNull();
  expect(screen.queryByRole('button', { name: shareLabel })).toBeNull();
});

test('ignores an in-flight result and its saved fallback after the folder selection changes', async () => {
  let finish!: (value: string) => void;
  native.runModelAssetProbe.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const user = userEvent.setup();
  await renderAsync(
    <ModelAssetProbePanel
      selected
      selectionVersion={1}
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  await user.press(screen.getByRole('button', { name: runLabel }));
  await screen.rerenderAsync(
    <ModelAssetProbePanel
      selected
      selectionVersion={2}
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  native.getLastModelAssetProbe.mockResolvedValue(JSON.stringify(completed));
  await act(async () => finish(JSON.stringify(completed)));
  expect(screen.queryByText(/Les quatre fichiers correspondent/)).toBeNull();
  expect(screen.queryByRole('button', { name: shareLabel })).toBeNull();
});

test('blocks sharing during another operation and reports share failures locally', async () => {
  native.getLastModelAssetProbe.mockResolvedValue(JSON.stringify(failed));
  const share = jest
    .spyOn(Share, 'share')
    .mockRejectedValue(new Error('private share error'));
  const user = userEvent.setup();
  await renderAsync(
    <ModelAssetProbePanel
      selected
      busy
      modelLoaded={false}
      perform={perform}
    />,
  );
  const button = await screen.findByRole('button', { name: shareLabel });
  expect(button).toBeDisabled();
  await user.press(button);
  expect(share).not.toHaveBeenCalled();
  await screen.rerenderAsync(
    <ModelAssetProbePanel
      selected
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  await user.press(screen.getByRole('button', { name: shareLabel }));
  expect(
    await screen.findByText('Le partage du rapport d’identité a échoué.'),
  ).toBeOnTheScreen();
  expect(native.runModelAssetProbe).not.toHaveBeenCalled();
});
