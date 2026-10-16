import React from 'react';
import {
  act,
  renderAsync,
  screen,
  userEvent,
} from '@testing-library/react-native';
import { AppState, AppStateStatus, Share } from 'react-native';
import { MonitoringPanel } from '../src/MonitoringPanel';
import NativeAssist from '../specs/NativeAssist';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: { getMonitoringSnapshot: jest.fn() },
}));
const native = jest.mocked(NativeAssist!);
const nativeModule = jest.requireMock('../specs/NativeAssist');
let stateChanged: (state: AppStateStatus) => void;
let remove: jest.Mock;

function snapshot(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: 'assistRuntimeMonitoring',
    nativeBuild: '7',
    osVersion: 'iOS 27.2',
    aneExecution: 'unverified',
    measurementMethods: { memory: 'sampled physical footprint' },
    current: {
      phase: 'loading',
      sessionElapsedMs: 1000,
      thermalState: 'unknown',
      memoryPressure: 'unknown',
      lowPowerMode: false,
      cpuPercent: 245.5,
      physicalFootprintBytes: 1_073_741_824,
      availableMemoryBytes: 536_870_912,
      contextCapacity: 32768,
    },
    history: [],
    events: [],
    diagnostic: null,
    ...extra,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  nativeModule.default = native;
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    writable: true,
    value: 'active',
  });
  remove = jest.fn();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
    stateChanged = listener;
    return { remove };
  });
  native.getMonitoringSnapshot.mockResolvedValue(JSON.stringify(snapshot()));
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

async function expandDashboard() {
  const user = userEvent.setup();
  await user.press(
    screen.getByRole('button', { name: 'Afficher le tableau de bord' }),
  );
}

test('shows process metrics without inventing unknown values or capping multicore CPU', async () => {
  await renderAsync(<MonitoringPanel />);
  await expandDashboard();
  expect(screen.getByText('CPU du processus : 245,5 %')).toBeOnTheScreen();
  expect(screen.getByText('Mémoire de l’app : 1 024,0 Mio')).toBeOnTheScreen();
  expect(
    screen.getByText('Budget mémoire disponible pour l’app : 512,0 Mio'),
  ).toBeOnTheScreen();
  expect(screen.getByText('Pic mémoire échantillonné : —')).toBeOnTheScreen();
  expect(screen.getByText('Premier jeton : —')).toBeOnTheScreen();
  expect(screen.getByText('Décodage : —')).toBeOnTheScreen();
  expect(screen.getByText('État thermique : Inconnu')).toBeOnTheScreen();
  expect(
    screen.getByText('Contexte du modèle : 32 768 jetons'),
  ).toBeOnTheScreen();
  expect(screen.getByText('ANE : utilisation non vérifiée.')).toBeOnTheScreen();
});

test('keeps polling while native work changes from loading to generation and diagnosis', async () => {
  const generating = snapshot();
  generating.current.phase = 'generating';
  const diagnosing = snapshot({
    diagnostic: { completed: 17, total: 48, failed: 3 },
  });
  diagnosing.current.phase = 'diagnosing';
  native.getMonitoringSnapshot
    .mockResolvedValueOnce(JSON.stringify(snapshot()))
    .mockResolvedValueOnce(JSON.stringify(generating))
    .mockResolvedValueOnce(JSON.stringify(diagnosing));
  await renderAsync(<MonitoringPanel />);
  expect(screen.getByText('État : Chargement')).toBeOnTheScreen();
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(screen.getByText('État : Génération')).toBeOnTheScreen();
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(screen.getByText('État : Diagnostic')).toBeOnTheScreen();
  expect(
    screen.getByRole('progressbar', {
      name: 'Diagnostic de calcul',
      value: { min: 0, max: 48, now: 17 },
    }),
  ).toBeOnTheScreen();
  expect(
    screen.getByText('17/48 contrôles terminés · 3 échecs'),
  ).toBeOnTheScreen();
});

test('never overlaps native snapshot requests when a sample takes several seconds', async () => {
  let finish!: (json: string) => void;
  native.getMonitoringSnapshot.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  await renderAsync(<MonitoringPanel />);
  await act(async () => {
    jest.advanceTimersByTime(5000);
  });
  expect(native.getMonitoringSnapshot).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish(JSON.stringify(snapshot()));
  });
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(native.getMonitoringSnapshot).toHaveBeenCalledTimes(2);
});

test('pauses in background, ignores a late pre-background sample, and resumes in foreground', async () => {
  let finish!: (json: string) => void;
  native.getMonitoringSnapshot.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  await renderAsync(<MonitoringPanel />);
  await act(async () => {
    stateChanged('background');
  });
  await act(async () => {
    jest.advanceTimersByTime(5000);
  });
  expect(native.getMonitoringSnapshot).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/Suivi en pause/)).toBeOnTheScreen();
  await act(async () => {
    stateChanged('active');
  });
  expect(native.getMonitoringSnapshot).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish(JSON.stringify(snapshot()));
  });
  expect(
    screen.queryByText('Mémoire de l’app : 1 024,0 Mio'),
  ).not.toBeOnTheScreen();
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(screen.getByText('Mémoire de l’app : 1 024,0 Mio')).toBeOnTheScreen();
  expect(native.getMonitoringSnapshot).toHaveBeenCalledTimes(2);
});

test('unmount removes its listener and timer without accepting a pending sample', async () => {
  let finish!: (json: string) => void;
  native.getMonitoringSnapshot.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  await renderAsync(<MonitoringPanel />);
  await screen.unmountAsync();
  await act(async () => {
    finish(JSON.stringify(snapshot()));
    jest.advanceTimersByTime(5000);
  });
  expect(remove).toHaveBeenCalledTimes(1);
  expect(native.getMonitoringSnapshot).toHaveBeenCalledTimes(1);
});

test('shares monitoring only after an explicit press and retains failed diagnostic evidence', async () => {
  const report = snapshot({
    diagnostic: { completed: 48, total: 48, failed: 12 },
    sourceRevision: 'native-evidence',
    diagnosticSummary: { failed: 12, nonfinite: 0 },
    events: [
      {
        sequence: 1,
        elapsedMs: 1000,
        phase: 'diagnosing',
        severity: 'warning',
        code: 'DIAGNOSTIC_FAILED',
      },
    ],
  });
  native.getMonitoringSnapshot.mockResolvedValue(JSON.stringify(report));
  const share = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
  const user = userEvent.setup();
  await renderAsync(<MonitoringPanel />);
  expect(share).not.toHaveBeenCalled();
  await expandDashboard();
  await user.press(screen.getByRole('button', { name: 'Partager le suivi' }));
  expect(JSON.parse(share.mock.calls[0][0].message!)).toEqual(report);
  expect(share.mock.calls[0][0].message).not.toMatch(
    /"(prompt|text|messages|content|modelPath)"/,
  );
});

test('labels old data when a new snapshot is malformed instead of presenting it as live', async () => {
  native.getMonitoringSnapshot
    .mockResolvedValueOnce(JSON.stringify(snapshot()))
    .mockResolvedValueOnce('{"aneExecution":"verified"}');
  await renderAsync(<MonitoringPanel />);
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(
    screen.getByText(/Suivi temporairement indisponible/),
  ).toBeOnTheScreen();
  expect(screen.getByText(/Dernier échantillon reçu/)).toBeOnTheScreen();
  expect(screen.getByText('Mémoire de l’app : 1 024,0 Mio')).toBeOnTheScreen();
});

test('shows an unsupported state without polling when the native backend is absent', async () => {
  nativeModule.default = null;
  await renderAsync(<MonitoringPanel />);
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(
    screen.getByText('Suivi natif indisponible sur cette plateforme.'),
  ).toBeOnTheScreen();
  expect(native.getMonitoringSnapshot).not.toHaveBeenCalled();
});

test('waits for a foreground lifecycle event before requesting native data', async () => {
  Object.defineProperty(AppState, 'currentState', { value: 'background' });
  await renderAsync(<MonitoringPanel />);
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(native.getMonitoringSnapshot).not.toHaveBeenCalled();
  await act(async () => {
    stateChanged('active');
  });
  expect(native.getMonitoringSnapshot).toHaveBeenCalledTimes(1);
  expect(screen.getByText('État : Chargement')).toBeOnTheScreen();
});

test('shows only the latest eight events while preserving the bounded full log for sharing', async () => {
  const report = snapshot({
    events: Array.from({ length: 10 }, (_, sequence) => ({
      sequence,
      elapsedMs: sequence * 1000,
      phase: 'loading',
      severity: sequence === 9 ? 'critical' : 'info',
      code: `NATIVE_EVENT_${sequence}`,
    })),
  });
  native.getMonitoringSnapshot.mockResolvedValue(JSON.stringify(report));
  await renderAsync(<MonitoringPanel />);
  await expandDashboard();
  expect(screen.queryByText('Info · NATIVE_EVENT_0')).not.toBeOnTheScreen();
  expect(screen.queryByText('Info · NATIVE_EVENT_1')).not.toBeOnTheScreen();
  expect(screen.getByText('Info · NATIVE_EVENT_2')).toBeOnTheScreen();
  expect(screen.getByText('Critique · NATIVE_EVENT_9')).toBeOnTheScreen();
});

test('charts measured zero separately from missing data and exposes a textual range', async () => {
  const current = snapshot().current;
  native.getMonitoringSnapshot.mockResolvedValue(
    JSON.stringify(
      snapshot({
        history: [
          { ...current, decodeTokensPerSecond: null },
          { ...current, decodeTokensPerSecond: 0 },
          { ...current, decodeTokensPerSecond: 20 },
        ],
      }),
    ),
  );
  await renderAsync(<MonitoringPanel />);
  await expandDashboard();
  expect(
    screen.getByRole('img', {
      name: 'Décodage, historique de 3 échantillons. 2 mesures disponibles. 0,0 jetons/s à 20,0 jetons/s.',
    }),
  ).toBeOnTheScreen();
});

test('starts compact and keeps live summaries polling after the full dashboard is collapsed', async () => {
  const next = snapshot();
  next.current.phase = 'generating';
  const user = userEvent.setup();
  await renderAsync(<MonitoringPanel />);
  expect(screen.getByText('État : Chargement')).toBeOnTheScreen();
  expect(screen.getByText('Mémoire de l’app : 1 024,0 Mio')).toBeOnTheScreen();
  expect(screen.getByText('Décodage : —')).toBeOnTheScreen();
  expect(screen.getByText('État thermique : Inconnu')).toBeOnTheScreen();
  expect(
    screen.queryByText('CPU du processus : 245,5 %'),
  ).not.toBeOnTheScreen();
  expect(screen.queryByText('Événements récents')).not.toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: 'Partager le suivi' }),
  ).not.toBeOnTheScreen();
  await expandDashboard();
  expect(screen.getByText('CPU du processus : 245,5 %')).toBeOnTheScreen();
  await user.press(
    screen.getByRole('button', { name: 'Réduire le tableau de bord' }),
  );
  expect(screen.queryByText('Événements récents')).not.toBeOnTheScreen();
  native.getMonitoringSnapshot.mockResolvedValue(JSON.stringify(next));
  const callsBefore = native.getMonitoringSnapshot.mock.calls.length;
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(native.getMonitoringSnapshot).toHaveBeenCalledTimes(callsBefore + 1);
  expect(screen.getByText('État : Génération')).toBeOnTheScreen();
  expect(
    screen.getByRole('button', {
      name: 'Afficher le tableau de bord',
      expanded: false,
    }),
  ).toBeOnTheScreen();
});
