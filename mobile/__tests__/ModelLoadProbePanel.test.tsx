import React from 'react';
import { renderAsync, screen, userEvent } from '@testing-library/react-native';
import { Share } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { ModelLoadProbePanel } from '../src/ModelLoadProbePanel';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: { getLastModelLoadProbe: jest.fn(), runModelLoadProbe: jest.fn() },
}));
jest.useFakeTimers();
const native = jest.mocked(NativeAssist!);
const saved = {
  schemaVersion: 1,
  kind: 'assistModelLoadDiagnostic',
  scope: 'single_function_load_only_no_generation',
  aneExecution: 'unverified',
  nativeBuild: '8',
  osVersion: 'iOS 27.2',
  modelName: 'gemma4-e2b-32k-group8-rms-fp32io',
  contextCapacity: 32768,
  functionName: 'extend_1024_8',
  stage: 'loading_function',
  samples: [
    { stage: 'before_prepare', elapsedMs: 0, thermalState: 'nominal' },
    { stage: 'before_function_load', elapsedMs: 50, thermalState: 'nominal' },
  ],
  measurementMethods: { cacheState: 'Unmeasured; unchanged' },
};
const perform = async (action: () => Promise<void>) => action();
beforeEach(() => {
  jest.clearAllMocks();
  native.getLastModelLoadProbe.mockResolvedValue('null');
});

test('restores and shares the last pre-call marker without automatically retrying', async () => {
  native.getLastModelLoadProbe.mockResolvedValue(JSON.stringify(saved));
  const share = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
  const user = userEvent.setup();
  await renderAsync(
    <ModelLoadProbePanel
      selected={false}
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  expect(
    await screen.findByText(/Dernière étape enregistrée : loading_function/),
  ).toBeOnTheScreen();
  expect(native.runModelLoadProbe).not.toHaveBeenCalled();
  await user.press(
    screen.getByRole('button', {
      name: 'Partager le diagnostic de chargement',
    }),
  );
  expect(JSON.parse(share.mock.calls[0][0].message!)).toEqual(saved);
  share.mockRestore();
});

test('requires a selected folder, no resident engine and no other operation', async () => {
  await renderAsync(
    <ModelLoadProbePanel
      selected={false}
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  expect(
    screen.getByRole('button', { name: 'Tester ce graphe' }),
  ).toBeDisabled();
  await screen.rerenderAsync(
    <ModelLoadProbePanel selected busy={false} modelLoaded perform={perform} />,
  );
  expect(
    screen.getByRole('button', { name: 'Tester ce graphe' }),
  ).toBeDisabled();
  await screen.rerenderAsync(
    <ModelLoadProbePanel selected busy modelLoaded={false} perform={perform} />,
  );
  expect(
    screen.getByRole('button', { name: 'Tester ce graphe' }),
  ).toBeDisabled();
  expect(native.runModelLoadProbe).not.toHaveBeenCalled();
});

test('loads only the user-selected function and does not advance or retry it', async () => {
  native.runModelLoadProbe.mockImplementation(async functionName => {
    const result = {
      ...saved,
      functionName,
      stage: 'completed',
      samples: [
        ...saved.samples,
        {
          stage: 'after_function_load',
          elapsedMs: 80,
          thermalState: 'nominal',
        },
      ],
    };
    native.getLastModelLoadProbe.mockResolvedValue(JSON.stringify(result));
    return JSON.stringify(result);
  });
  const user = userEvent.setup();
  await renderAsync(
    <ModelLoadProbePanel
      selected
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  await user.press(screen.getByRole('button', { name: 'Fonction suivante' }));
  await user.press(screen.getByRole('button', { name: 'Tester ce graphe' }));
  expect(await screen.findByText(/Ce graphe a été chargé/)).toBeOnTheScreen();
  expect(native.runModelLoadProbe).toHaveBeenCalledTimes(1);
  expect(native.runModelLoadProbe).toHaveBeenCalledWith('extend_32768_8');
  expect(screen.getByText('extend_32768_8')).toBeOnTheScreen();
});

test('shows a saved native loading error as an error result without retrying', async () => {
  const failure = {
    ...saved,
    stage: 'failed',
    errorCode: 'E_FUNCTION_LOAD_FAILED',
    samples: [
      ...saved.samples,
      { stage: 'failed', elapsedMs: 80, thermalState: 'nominal' },
    ],
  };
  native.runModelLoadProbe.mockImplementation(async () => {
    native.getLastModelLoadProbe.mockResolvedValue(JSON.stringify(failure));
    return JSON.stringify(failure);
  });
  const user = userEvent.setup();
  await renderAsync(
    <ModelLoadProbePanel
      selected
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  await user.press(screen.getByRole('button', { name: 'Tester ce graphe' }));
  expect(
    await screen.findByText('Le diagnostic a retourné une erreur.'),
  ).toBeOnTheScreen();
  expect(native.runModelLoadProbe).toHaveBeenCalledTimes(1);
});

test('restores and shares the model, attempt identity and bounded native causes', async () => {
  const failure = {
    ...saved,
    schemaVersion: 2,
    nativeBuild: '9',
    stage: 'failed',
    errorCode: 'E_FUNCTION_LOAD_FAILED',
    attempt: {
      id: '9cde6700-1e52-4a3c-9b84-8a677eb4124a',
      startedAtUTC: '2026-10-16T13:00:00.123Z',
      processIdentifier: 20501,
      entryPoint: 'single_function_load_probe',
    },
    nativeErrors: [
      {
        domain: 'NSCocoaErrorDomain',
        code: 260,
        swiftType: 'Foundation.NSError',
      },
      {
        domain: 'NSPOSIXErrorDomain',
        code: 2,
        swiftType: 'Foundation.NSError',
      },
    ],
    samples: [
      ...saved.samples,
      { stage: 'failed', elapsedMs: 80, thermalState: 'nominal' },
    ],
  };
  native.getLastModelLoadProbe.mockResolvedValue(JSON.stringify(failure));
  const share = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
  const user = userEvent.setup();
  await renderAsync(
    <ModelLoadProbePanel
      selected={false}
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  expect(
    await screen.findByText(/Modèle : gemma4-e2b-32k-group8-rms-fp32io/),
  ).toBeOnTheScreen();
  expect(
    screen.getByText(/Essai du 2026-10-16T13:00:00.123Z/),
  ).toBeOnTheScreen();
  expect(
    screen.getByText('NSCocoaErrorDomain (260) → NSPOSIXErrorDomain (2)'),
  ).toBeOnTheScreen();
  await user.press(
    screen.getByRole('button', {
      name: 'Partager le diagnostic de chargement',
    }),
  );
  expect(JSON.parse(share.mock.calls[0][0].message!)).toEqual(failure);
  expect(native.runModelLoadProbe).not.toHaveBeenCalled();
  share.mockRestore();
});

test('shares prepared-library observations without presenting a load marker as success', async () => {
  const observed = {
    ...saved,
    schemaVersion: 3,
    attempt: {
      id: '9cde6700-1e52-4a3c-9b84-8a677eb4124a',
      startedAtUTC: '2026-10-16T13:00:00.123Z',
      processIdentifier: 20501,
      entryPoint: 'single_function_load_probe',
    },
    preparedLibrary: {
      functionCount: 1,
      functionNamesPrefix: ['load_embeddings'],
      functionNamesTruncated: false,
      matchesSourceSummary: false,
      selectedDescriptorPresent: false,
    },
  };
  native.getLastModelLoadProbe.mockResolvedValue(JSON.stringify(observed));
  const share = jest.spyOn(Share, 'share').mockResolvedValue({
    action: Share.sharedAction,
    activityType: undefined,
  });
  const user = userEvent.setup();
  await renderAsync(
    <ModelLoadProbePanel
      selected={false}
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  expect(
    await screen.findByText(/Liste conforme à la source : non/),
  ).toBeOnTheScreen();
  expect(
    screen.getByText(/Descripteur de la fonction choisie : absent/),
  ).toBeOnTheScreen();
  expect(screen.queryByText(/Ce graphe a été chargé/)).toBeNull();
  await user.press(
    screen.getByRole('button', {
      name: 'Partager le diagnostic de chargement',
    }),
  );
  expect(JSON.parse(share.mock.calls[0][0].message!)).toEqual(observed);
  expect(native.runModelLoadProbe).not.toHaveBeenCalled();
  share.mockRestore();
});
