import React from 'react';
import {
  act,
  renderAsync,
  screen,
  userEvent,
} from '@testing-library/react-native';
import { Share } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { SpecializationRepairPanel } from '../src/SpecializationRepairPanel';
import {
  repairTargets,
  repairMeasurementMethodsForTarget,
  specializationRepairMeasurementMethods,
} from '../src/specializationRepair';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    repairNumericalProbe: jest.fn(),
    repairModelLoadProbe: jest.fn(),
    getLastSpecializationRepair: jest.fn(),
    runNumericalProbe: jest.fn(),
    runModelLoadProbe: jest.fn(),
    loadModel: jest.fn(),
  },
}));
jest.useFakeTimers();
const native = jest.mocked(NativeAssist!);
const numericLabel = 'Réparer le calcul natif';
const gemmaLabel = 'Réparer le chargement Gemma';
const shareLabel = 'Partager le rapport de réparation';
const perform = jest.fn(async (action: () => Promise<void>) => action());
const repair = {
  schemaVersion: 1,
  kind: 'assistSpecializationRepair',
  scope: 'single_model_neural_engine_cache_entry',
  target: 'bundled_f16_neural_engine',
  ...repairTargets.bundled_f16_neural_engine,
  computePreference: 'neural_engine_preferred',
  nativeBuild: '11',
  osVersion: 'iOS 27.2',
  attempt: {
    id: '9cde6700-1e52-4a3c-9b84-8a677eb4124a',
    startedAtUTC: '2026-10-16T17:00:00.123Z',
    processIdentifier: 22290,
    entryPoint: 'manual_single_entry_repair',
  },
  stage: 'completed',
  steps: [
    'verifying_source',
    'invalidating_entry',
    'entry_invalidated',
    'qualifying',
    'completed',
  ].map((stage, elapsedMs) => ({ stage, elapsedMs })),
  measurementMethods: specializationRepairMeasurementMethods,
};
const pending = {
  ...repair,
  stage: 'invalidating_entry',
  steps: repair.steps.slice(0, 2),
};
const failed = {
  ...pending,
  stage: 'failed',
  errorCode: 'E_SPECIALIZATION_REPAIR_INVALIDATION_FAILED',
  steps: [...pending.steps, { stage: 'failed', elapsedMs: 3 }],
};
function numericWrapper(nativeErrors = 0, deviations = 0) {
  const results = ['f16_boundary', 'f32_boundary'].flatMap(variant =>
    ['neural_engine_preferred', 'cpu_only'].flatMap(mode =>
      ['256_8', '256_1', '512_8', '512_1', '1536_1', '256_35'].flatMap(shape =>
        ['weighted', 'ones'].map(weight => ({
          variant,
          mode,
          function: `rms_q8_${shape}_${weight}`,
          passed: true,
          actualSHA256: 'd'.repeat(64),
          maxULP: 0,
          rows: Array.from({ length: 8 }, (_, query) => ({ query })),
        })),
      ),
    ),
  );
  return {
    schemaVersion: 1,
    kind: 'assistSpecializationRepairResult',
    repair,
    diagnostic: {
      schemaVersion: 2,
      kind: 'assistPrimitiveQualification',
      scope: 'primitive_only_gemma_unqualified',
      aneExecution: 'unverified',
      nativeBuild: '11',
      assets: [
        {
          variant: 'f16_boundary',
          fixtureAssetSHA256: repair.sourceAssetSHA256,
          manifestSHA256: 'a'.repeat(64),
        },
        {
          variant: 'f32_boundary',
          fixtureAssetSHA256: 'b'.repeat(64),
          manifestSHA256: 'c'.repeat(64),
        },
      ],
      results: results.map((result, index) =>
        index < nativeErrors
          ? {
              ...result,
              passed: false,
              actualSHA256: undefined,
              rows: undefined,
              maxULP: undefined,
              error: 'Foundation._GenericObjCError error 0.',
            }
          : { ...result, passed: index >= nativeErrors + deviations },
      ),
      summary: {
        cases: 48,
        failed: nativeErrors + deviations,
        maxULP: 0,
        nonfinite: 0,
      },
    },
  };
}
function gemmaWrapper(
  stage: 'completed' | 'failed',
  target:
    | 'selected_f16_neural_engine'
    | 'selected_abliterated_f16_neural_engine' = 'selected_f16_neural_engine',
) {
  return {
    schemaVersion: 1,
    kind: 'assistSpecializationRepairResult',
    repair: {
      ...repair,
      target,
      ...repairTargets[target],
      measurementMethods: repairMeasurementMethodsForTarget(target),
    },
    diagnostic: {
      schemaVersion: 1,
      kind: 'assistModelLoadDiagnostic',
      scope: 'single_function_load_only_no_generation',
      aneExecution: 'unverified',
      nativeBuild: '11',
      osVersion: 'iOS 27.2',
      modelName: repairTargets[target].modelName,
      contextCapacity: 32768,
      functionName: 'extend_1024_8',
      stage,
      ...(stage === 'failed' ? { errorCode: 'E_FUNCTION_LOAD_FAILED' } : {}),
      samples: [
        { stage: 'before_prepare', elapsedMs: 0, thermalState: 'nominal' },
        {
          stage: 'before_function_load',
          elapsedMs: 1,
          thermalState: 'nominal',
        },
        {
          stage: stage === 'failed' ? 'failed' : 'after_function_load',
          elapsedMs: 2,
          thermalState: 'nominal',
        },
      ],
      measurementMethods: { cache: 'Original load report.' },
    },
  };
}
beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  native.getLastSpecializationRepair.mockReset().mockResolvedValue('null');
  native.repairNumericalProbe
    .mockReset()
    .mockResolvedValue(JSON.stringify(numericWrapper()));
  native.repairModelLoadProbe
    .mockReset()
    .mockResolvedValue(JSON.stringify(gemmaWrapper('completed')));
});

test('restores and shares a pre-call marker without repairing or qualifying automatically', async () => {
  native.getLastSpecializationRepair.mockResolvedValue(JSON.stringify(pending));
  const share = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
  const user = userEvent.setup();
  await renderAsync(
    <SpecializationRepairPanel
      selected={false}
      busy={false}
      modelLoaded
      perform={perform}
    />,
  );
  expect(
    await screen.findByText(/Dernière étape enregistrée : invalidating_entry/),
  ).toBeOnTheScreen();
  expect(native.repairNumericalProbe).not.toHaveBeenCalled();
  expect(native.repairModelLoadProbe).not.toHaveBeenCalled();
  expect(perform).not.toHaveBeenCalled();
  await user.press(screen.getByRole('button', { name: shareLabel }));
  expect(JSON.parse(share.mock.calls[0][0].message!)).toEqual(pending);
});

test('numeric repair does not require a folder, Gemma does; both require idle with no resident engine', async () => {
  await renderAsync(
    <SpecializationRepairPanel
      selected={false}
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  expect(screen.getByRole('button', { name: numericLabel })).toBeEnabled();
  expect(screen.getByRole('button', { name: gemmaLabel })).toBeDisabled();
  for (const props of [
    { busy: true, modelLoaded: false },
    { busy: false, modelLoaded: true },
  ]) {
    await screen.rerenderAsync(
      <SpecializationRepairPanel selected {...props} perform={perform} />,
    );
    expect(screen.getByRole('button', { name: numericLabel })).toBeDisabled();
    expect(screen.getByRole('button', { name: gemmaLabel })).toBeDisabled();
  }
  expect(native.repairNumericalProbe).not.toHaveBeenCalled();
});

test('retains and shares the full returned qualification rather than overwriting it with the small saved record', async () => {
  const result = numericWrapper(12);
  native.repairNumericalProbe.mockResolvedValue(JSON.stringify(result));
  const share = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
  const user = userEvent.setup();
  await renderAsync(
    <SpecializationRepairPanel
      selected={false}
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  await user.press(screen.getByRole('button', { name: numericLabel }));
  expect(
    await screen.findByText(
      'Sorties mesurées : 36/48. Erreurs natives : 12. Cas en écart numérique : 0.',
    ),
  ).toBeOnTheScreen();
  expect(
    screen.getByText('Le contrôle n’a pas produit toutes les sorties natives.'),
  ).toBeOnTheScreen();
  expect(
    screen.queryByText(/Les 48 sorties natives ont été produites/),
  ).toBeNull();
  expect(native.getLastSpecializationRepair).toHaveBeenCalledTimes(1);
  expect(native.repairNumericalProbe).toHaveBeenCalledTimes(1);
  expect(native.repairNumericalProbe).toHaveBeenCalledWith();
  expect(native.runNumericalProbe).not.toHaveBeenCalled();
  expect(perform).toHaveBeenCalledTimes(1);
  await user.press(screen.getByRole('button', { name: shareLabel }));
  expect(JSON.parse(share.mock.calls[0][0].message!)).toEqual(
    JSON.parse(JSON.stringify(result)),
  );
});

test('reports all produced outputs separately from the twelve known numerical deviations', async () => {
  native.repairNumericalProbe.mockResolvedValue(
    JSON.stringify(numericWrapper(0, 12)),
  );
  const user = userEvent.setup();
  await renderAsync(
    <SpecializationRepairPanel
      selected={false}
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  await user.press(screen.getByRole('button', { name: numericLabel }));
  expect(
    await screen.findByText(
      'Sorties mesurées : 48/48. Erreurs natives : 0. Cas en écart numérique : 12.',
    ),
  ).toBeOnTheScreen();
  expect(
    screen.getByText(/Les 48 sorties natives ont été produites/),
  ).toBeOnTheScreen();
});

test.each([
  ['completed', 'selected_f16_neural_engine'],
  ['failed', 'selected_f16_neural_engine'],
  ['completed', 'selected_abliterated_f16_neural_engine'],
  ['failed', 'selected_abliterated_f16_neural_engine'],
] as const)(
  'requests the fixed Gemma function once and displays load %s separately for %s',
  async (stage, target) => {
    native.repairModelLoadProbe.mockResolvedValue(
      JSON.stringify(gemmaWrapper(stage, target)),
    );
    const user = userEvent.setup();
    await renderAsync(
      <SpecializationRepairPanel
        selected
        busy={false}
        modelLoaded={false}
        perform={perform}
      />,
    );
    await user.press(screen.getByRole('button', { name: gemmaLabel }));
    expect(
      await screen.findByText(
        stage === 'completed'
          ? 'La fonction Gemma a été chargée. La génération reste à vérifier.'
          : 'Le chargement de la fonction Gemma a retourné une erreur.',
      ),
    ).toBeOnTheScreen();
    expect(native.repairModelLoadProbe).toHaveBeenCalledTimes(1);
    expect(native.repairModelLoadProbe).toHaveBeenCalledWith('extend_1024_8');
    expect(native.runModelLoadProbe).not.toHaveBeenCalled();
    expect(native.loadModel).not.toHaveBeenCalled();
    expect(
      screen.getByText(new RegExp(repairTargets[target].modelName)),
    ).toBeOnTheScreen();
  },
);

test('restores a failed invalidation after rejection without launching any qualification', async () => {
  native.repairNumericalProbe.mockImplementation(async () => {
    native.getLastSpecializationRepair.mockResolvedValue(
      JSON.stringify(failed),
    );
    throw new Error('/private/cache secret');
  });
  const user = userEvent.setup();
  await renderAsync(
    <SpecializationRepairPanel
      selected
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  await user.press(screen.getByRole('button', { name: numericLabel }));
  expect(
    await screen.findByText(
      /Code : E_SPECIALIZATION_REPAIR_INVALIDATION_FAILED/,
    ),
  ).toBeOnTheScreen();
  expect(screen.queryByText(/private\/cache/)).toBeNull();
  expect(
    screen.queryByText(
      'La réparation n’a pas retourné de rapport exploitable.',
    ),
  ).toBeNull();
  expect(native.getLastSpecializationRepair).toHaveBeenCalledTimes(2);
  expect(native.runNumericalProbe).not.toHaveBeenCalled();
  expect(native.runModelLoadProbe).not.toHaveBeenCalled();
  expect(native.repairNumericalProbe).toHaveBeenCalledTimes(1);
});

test('ignores a restoration started before the manual action and blocks overlapping repairs', async () => {
  let restore: (value: string) => void = () => undefined;
  let finish: (value: string) => void = () => undefined;
  native.getLastSpecializationRepair.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        restore = resolve;
      }),
  );
  native.repairNumericalProbe.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const user = userEvent.setup();
  await renderAsync(
    <SpecializationRepairPanel
      selected
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  await user.press(screen.getByRole('button', { name: numericLabel }));
  expect(screen.getByRole('button', { name: gemmaLabel })).toBeDisabled();
  await user.press(screen.getByRole('button', { name: gemmaLabel }));
  expect(native.repairModelLoadProbe).not.toHaveBeenCalled();
  await act(async () => finish(JSON.stringify(numericWrapper())));
  await act(async () => restore(JSON.stringify(pending)));
  expect(
    screen.getByText(/Les 48 sorties natives ont été produites/),
  ).toBeOnTheScreen();
  expect(screen.queryByText(/Dernière étape enregistrée/)).toBeNull();
});

test('does not share malformed restored evidence or retry it', async () => {
  native.getLastSpecializationRepair.mockResolvedValue(
    JSON.stringify({ ...repair, sourceAssetSHA256: 'invalid' }),
  );
  await renderAsync(
    <SpecializationRepairPanel
      selected
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  expect(
    await screen.findByText(
      'Le rapport de réparation enregistré est indisponible.',
    ),
  ).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: shareLabel })).toBeNull();
  expect(native.repairNumericalProbe).not.toHaveBeenCalled();
});

test('supports older builds with unavailable repair methods', async () => {
  const original = NativeAssist!.repairNumericalProbe;
  Object.defineProperty(NativeAssist, 'repairNumericalProbe', {
    value: undefined,
    configurable: true,
  });
  try {
    await renderAsync(
      <SpecializationRepairPanel
        selected
        busy={false}
        modelLoaded={false}
        perform={perform}
      />,
    );
    expect(
      screen.getByText('Disponible dans une nouvelle build iOS.'),
    ).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: numericLabel })).toBeDisabled();
    expect(screen.getByRole('button', { name: gemmaLabel })).toBeDisabled();
    expect(native.getLastSpecializationRepair).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(NativeAssist, 'repairNumericalProbe', {
      value: original,
      configurable: true,
    });
  }
});

test('finishes an outstanding restoration after unmount without running a repair', async () => {
  let restore: (value: string) => void = () => undefined;
  native.getLastSpecializationRepair.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        restore = resolve;
      }),
  );
  const view = await renderAsync(
    <SpecializationRepairPanel
      selected
      busy={false}
      modelLoaded={false}
      perform={perform}
    />,
  );
  await view.unmountAsync();
  await act(async () => restore(JSON.stringify(pending)));
  expect(native.repairNumericalProbe).not.toHaveBeenCalled();
  expect(native.repairModelLoadProbe).not.toHaveBeenCalled();
});
