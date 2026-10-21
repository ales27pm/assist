import React from 'react';
import {
  act,
  renderAsync,
  screen,
  userEvent,
} from '@testing-library/react-native';
import { AppState, Share } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { DiagnosticsWorkspace } from '../src/DiagnosticsWorkspace';
import { debugCategories } from '../src/debugDiagnostics';
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
    getDebugDiagnostics: jest.fn(),
    configureDebugDiagnostics: jest.fn(),
    exportDebugDiagnostics: jest.fn(),
    clearDebugDiagnostics: jest.fn(),
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
    >
      {null}
    </DiagnosticsWorkspace>,
  );

  expect(
    screen.getByRole('heading', { name: 'Diagnostics' }),
  ).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: 'Gérer le modèle' })).toBeNull();
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

test('advanced diagnostics mount only in the opened active workspace and stay independent of probe admission', async () => {
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: 'active',
  });
  native.getDebugDiagnostics.mockResolvedValue(
    JSON.stringify({
      schemaVersion: 1,
      kind: 'assistDebugStatus',
      sessionId: '11111111-1111-4111-8111-111111111111',
      revision: 0,
      mode: 'standard',
      detailExpiresAt: null,
      recordCount: 0,
      omittedRecords: 0,
      rejectedRecords: 0,
      previousSessionCount: 0,
      persistence: 'notAttempted',
      records: [],
      findings: [],
      coverage: debugCategories.map(category => ({
        category,
        state: 'unavailable',
      })),
      limits: {
        maxRecords: 512,
        maxSessionBytes: 262144,
        maxPreviousSessions: 2,
        detailedSeconds: 900,
      },
      privacy: { contentCaptured: false, automaticUpload: false },
    }),
  );
  const perform = jest.fn(async (action: () => Promise<void>) => action());
  const user = userEvent.setup();
  const workspace = (active: boolean) => (
    <DiagnosticsWorkspace
      selected={false}
      selectionVersion={0}
      busy
      ready
      active={active}
      perform={perform}
    >
      {null}
    </DiagnosticsWorkspace>
  );
  await renderAsync(workspace(false));
  await user.press(screen.getByRole('button', { name: 'Diagnostic avancé' }));
  expect(native.getDebugDiagnostics).not.toHaveBeenCalled();
  await screen.rerenderAsync(workspace(true));
  expect(screen.getByText('Niveau confirmé : Standard')).toBeOnTheScreen();
  expect(native.getDebugDiagnostics).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole('button', { name: 'Activer le niveau détaillé (15 min)' }),
  ).toBeEnabled();
  expect(native.configureDebugDiagnostics).not.toHaveBeenCalled();
  expect(native.exportDebugDiagnostics).not.toHaveBeenCalled();
  expect(native.clearDebugDiagnostics).not.toHaveBeenCalled();
  expect(native.repairNumericalProbe).not.toHaveBeenCalled();
  expect(perform).not.toHaveBeenCalled();
  await user.press(screen.getByRole('button', { name: 'Diagnostic avancé' }));
  const reads = native.getDebugDiagnostics.mock.calls.length;
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(native.getDebugDiagnostics).toHaveBeenCalledTimes(reads);
});
