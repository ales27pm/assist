import React from 'react';
import { renderAsync, screen, userEvent } from '@testing-library/react-native';
import { Share } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { DiagnosticsWorkspace } from '../src/DiagnosticsWorkspace';
import {
  repairTargets,
  specializationRepairMeasurementMethods,
} from '../src/specializationRepair';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    repairNumericalProbe: jest.fn(),
    repairModelLoadProbe: jest.fn(),
    getLastSpecializationRepair: jest.fn(),
  },
}));
jest.useFakeTimers();

const native = jest.mocked(NativeAssist!);
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

// Native protocol fixtures verify report retention; they are not device results.
const qualification = {
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
    results: ['f16_boundary', 'f32_boundary'].flatMap(variant =>
      ['neural_engine_preferred', 'cpu_only'].flatMap(mode =>
        ['256_8', '256_1', '512_8', '512_1', '1536_1', '256_35'].flatMap(
          shape =>
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
    ),
    summary: { cases: 48, failed: 0, maxULP: 0, nonfinite: 0 },
  },
};

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

test('keeps the full repair qualification available to share after collapsing and reopening its section', async () => {
  native.getLastSpecializationRepair.mockResolvedValue(JSON.stringify(repair));
  native.repairNumericalProbe.mockResolvedValue(JSON.stringify(qualification));
  const share = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
  const perform = jest.fn(async (action: () => Promise<void>) => action());
  const user = userEvent.setup();

  await renderAsync(
    <DiagnosticsWorkspace
      selected={false}
      selectionVersion={0}
      busy={false}
      ready={false}
      active
      perform={perform}
      onModel={jest.fn()}
    >
      {null}
    </DiagnosticsWorkspace>,
  );

  expect(native.getLastSpecializationRepair).not.toHaveBeenCalled();
  expect(native.repairNumericalProbe).not.toHaveBeenCalled();
  const section = screen.getByRole('button', {
    name: 'Réparer la spécialisation',
  });
  await user.press(section);
  expect(native.getLastSpecializationRepair).toHaveBeenCalledTimes(1);

  await user.press(
    screen.getByRole('button', { name: 'Réparer le calcul natif' }),
  );
  const measured =
    'Sorties mesurées : 48/48. Erreurs natives : 0. Cas en écart numérique : 0.';
  expect(await screen.findByText(measured)).toBeOnTheScreen();
  expect(native.repairNumericalProbe).toHaveBeenCalledTimes(1);
  expect(perform).toHaveBeenCalledTimes(1);

  await user.press(section);
  expect(screen.queryByText(measured)).toBeNull();
  await user.press(section);
  expect(await screen.findByText(measured)).toBeOnTheScreen();

  await user.press(
    screen.getByRole('button', {
      name: 'Partager le rapport de réparation',
    }),
  );
  expect(share).toHaveBeenCalledTimes(1);
  expect(JSON.parse(share.mock.calls[0][0].message!)).toEqual(qualification);
  expect(native.getLastSpecializationRepair).toHaveBeenCalledTimes(1);
  expect(native.repairNumericalProbe).toHaveBeenCalledTimes(1);
});
