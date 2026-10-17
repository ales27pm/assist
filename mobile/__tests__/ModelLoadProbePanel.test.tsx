import React from 'react';
import {
  act,
  fireEvent,
  renderAsync,
  screen,
  userEvent,
} from '@testing-library/react-native';
import { Platform, Share } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { ModelLoadProbePanel } from '../src/ModelLoadProbePanel';
import { loadProbeFunctions } from '../src/loadProbe';

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
afterEach(() => jest.restoreAllMocks());

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
  for (const option of screen.getAllByRole('radio')) {
    expect(option).toBeDisabled();
  }
  expect(native.runModelLoadProbe).not.toHaveBeenCalled();
});

test('offers six directly selectable functions and only changes the selection', async () => {
  const user = userEvent.setup();
  await renderAsync(
    <ModelLoadProbePanel
      selected
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  expect(screen.getAllByRole('radio')).toHaveLength(6);
  expect(screen.getByLabelText('Fonction à tester')).toHaveProp(
    'accessibilityRole',
    'radiogroup',
  );
  for (const functionName of loadProbeFunctions) {
    expect(screen.getByRole('radio', { name: functionName })).toHaveStyle({
      minHeight: 44,
    });
  }
  expect(
    screen.getByRole('radio', { name: loadProbeFunctions[0], checked: true }),
  ).toBeOnTheScreen();
  await user.press(screen.getByRole('radio', { name: loadProbeFunctions[5] }));
  expect(
    screen.getByRole('radio', { name: loadProbeFunctions[5], checked: true }),
  ).toBeOnTheScreen();
  expect(screen.getAllByRole('radio', { checked: true })).toHaveLength(1);
  await user.press(screen.getByRole('radio', { name: loadProbeFunctions[0] }));
  expect(
    screen.getByRole('radio', { name: loadProbeFunctions[0], checked: true }),
  ).toBeOnTheScreen();
  expect(native.runModelLoadProbe).not.toHaveBeenCalled();
  expect(
    screen.queryByRole('button', { name: 'Fonction suivante' }),
  ).toBeNull();
});

test('supports a single web tab stop and guarded arrow, Home and End selection without probing', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  await renderAsync(
    <ModelLoadProbePanel
      selected
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  expect(
    screen.getAllByRole('radio').map(option => option.props.tabIndex),
  ).toEqual([0, -1, -1, -1, -1, -1]);

  for (const [key, expectedIndex] of [
    ['ArrowRight', 1],
    ['ArrowDown', 2],
    ['End', 5],
    ['ArrowRight', 0],
    ['ArrowLeft', 5],
    ['ArrowUp', 4],
    ['Home', 0],
  ] as const) {
    const event = {
      nativeEvent: { key },
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    };
    await act(async () => {
      fireEvent(screen.getByRole('radio', { checked: true }), 'keyDown', event);
    });
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole('radio', {
        name: loadProbeFunctions[expectedIndex],
        checked: true,
      }),
    ).toHaveProp('tabIndex', 0);
    expect(
      screen
        .getAllByRole('radio')
        .filter(option => option.props.tabIndex === 0),
    ).toHaveLength(1);
  }
  for (const modifier of [
    'altKey',
    'ctrlKey',
    'metaKey',
    'shiftKey',
    'isComposing',
  ]) {
    const event = {
      nativeEvent: { key: 'ArrowDown', [modifier]: true },
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    };
    await act(async () => {
      fireEvent(screen.getByRole('radio', { checked: true }), 'keyDown', event);
    });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(
      screen.getByRole('radio', { name: loadProbeFunctions[0], checked: true }),
    ).toBeOnTheScreen();
  }
  await screen.rerenderAsync(
    <ModelLoadProbePanel selected busy modelLoaded={false} perform={perform} />,
  );
  const event = {
    nativeEvent: { key: 'End' },
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
  };
  await act(async () => {
    fireEvent(screen.getByRole('radio', { checked: true }), 'keyDown', event);
  });
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(
    screen.getByRole('radio', { name: loadProbeFunctions[0], checked: true }),
  ).toHaveProp('tabIndex', -1);
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
  await user.press(screen.getByRole('radio', { name: 'extend_32768_8' }));
  expect(native.runModelLoadProbe).not.toHaveBeenCalled();
  await user.press(screen.getByRole('button', { name: 'Tester ce graphe' }));
  expect(await screen.findByText(/Ce graphe a été chargé/)).toBeOnTheScreen();
  expect(native.runModelLoadProbe).toHaveBeenCalledTimes(1);
  expect(native.runModelLoadProbe).toHaveBeenCalledWith('extend_32768_8');
  expect(
    screen.getByRole('radio', { name: 'extend_32768_8', checked: true }),
  ).toBeOnTheScreen();
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
