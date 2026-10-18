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
  default: {
    getMonitoringSnapshot: jest.fn(),
    getPreviousMonitoringSnapshot: jest.fn(),
  },
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
  native.getPreviousMonitoringSnapshot.mockResolvedValue('null');
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
  const share = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
  const user = userEvent.setup();
  await renderAsync(<MonitoringPanel />);
  await expandDashboard();
  expect(screen.queryByText('Info · NATIVE_EVENT_0')).not.toBeOnTheScreen();
  expect(screen.queryByText('Info · NATIVE_EVENT_1')).not.toBeOnTheScreen();
  expect(screen.getByText('Info · NATIVE_EVENT_2')).toBeOnTheScreen();
  expect(screen.getByText('Critique · NATIVE_EVENT_9')).toBeOnTheScreen();
  expect(share).not.toHaveBeenCalled();
  await user.press(screen.getByRole('button', { name: 'Partager le suivi' }));
  expect(share).toHaveBeenCalledTimes(1);
  const exported = JSON.parse(share.mock.calls[0][0].message!);
  expect(exported.events).toHaveLength(10);
  expect(exported.events).toEqual(report.events);
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

test('reads the previous session only on explicit export and preserves its own build and recovery evidence', async () => {
  const report = snapshot({
    nativeBuild: '24',
    recovery: {
      source: 'previousSessionCheckpoint',
      sessionEndedNormally: false,
      checkpointIntervalMs: 5000,
    },
  });
  native.getPreviousMonitoringSnapshot.mockResolvedValue(JSON.stringify(report));
  const share = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
  const user = userEvent.setup();
  await renderAsync(<MonitoringPanel />);
  expect(native.getPreviousMonitoringSnapshot).not.toHaveBeenCalled();
  expect(share).not.toHaveBeenCalled();
  const currentRequests = native.getMonitoringSnapshot.mock.calls.length;
  await user.press(
    screen.getByRole('button', { name: 'Exporter la session précédente' }),
  );
  expect(native.getPreviousMonitoringSnapshot).toHaveBeenCalledTimes(1);
  expect(native.getMonitoringSnapshot).toHaveBeenCalledTimes(currentRequests);
  expect(JSON.parse(share.mock.calls[0][0].message!)).toEqual(report);
});

test('keeps previous-session export available when current monitoring has no sample', async () => {
  native.getMonitoringSnapshot.mockRejectedValue(new Error('current unavailable'));
  native.getPreviousMonitoringSnapshot.mockResolvedValue(
    JSON.stringify(snapshot({ nativeBuild: '24' })),
  );
  const share = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: Share.dismissedAction, activityType: undefined });
  const user = userEvent.setup();
  await renderAsync(<MonitoringPanel />);
  await user.press(
    screen.getByRole('button', { name: 'Exporter la session précédente' }),
  );
  expect(share).toHaveBeenCalledTimes(1);
  expect(JSON.parse(share.mock.calls[0][0].message!).nativeBuild).toBe('24');
});

test('explains the native update needed by an older binary without falling back to the current session', async () => {
  nativeModule.default = {
    getMonitoringSnapshot: native.getMonitoringSnapshot,
  };
  const share = jest.spyOn(Share, 'share');
  await renderAsync(<MonitoringPanel />);
  expect(
    screen.getByRole('button', { name: 'Exporter la session précédente' }),
  ).toBeDisabled();
  expect(
    screen.getByText(
      'L’export de la session précédente nécessite une version native plus récente.',
    ),
  ).toBeOnTheScreen();
  expect(native.getPreviousMonitoringSnapshot).not.toHaveBeenCalled();
  expect(share).not.toHaveBeenCalled();
});

test.each([
  ['null', 'Aucune session précédente sauvegardée n’est disponible.'],
  [' { broken', 'La session précédente est illisible ou incompatible. Aucun rapport n’a été partagé.'],
  [
    JSON.stringify(snapshot({ recovery: { messages: ['private'] } })),
    'La session précédente est illisible ou incompatible. Aucun rapport n’a été partagé.',
  ],
])('does not share an absent or unsafe previous report: %#', async (json, message) => {
  native.getPreviousMonitoringSnapshot.mockResolvedValue(json);
  const share = jest.spyOn(Share, 'share');
  const user = userEvent.setup();
  await renderAsync(<MonitoringPanel />);
  await user.press(
    screen.getByRole('button', { name: 'Exporter la session précédente' }),
  );
  expect(screen.getByText(message)).toBeOnTheScreen();
  expect(share).not.toHaveBeenCalled();
  expect(
    screen.getByRole('button', { name: 'Exporter la session précédente' }),
  ).toBeEnabled();
});

test('allows a fresh read after a previous-session request rejects', async () => {
  native.getPreviousMonitoringSnapshot
    .mockRejectedValueOnce(new Error('disk unavailable'))
    .mockResolvedValueOnce(JSON.stringify(snapshot({ nativeBuild: '24' })));
  const share = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: Share.dismissedAction, activityType: undefined });
  const user = userEvent.setup();
  await renderAsync(<MonitoringPanel />);
  const exportButton = screen.getByRole('button', {
    name: 'Exporter la session précédente',
  });
  await user.press(exportButton);
  expect(
    screen.getByRole('alert', {
      name: 'Lecture de la session précédente indisponible. Réessaie.',
    }),
  ).toBeOnTheScreen();
  await user.press(exportButton);
  expect(native.getPreviousMonitoringSnapshot).toHaveBeenCalledTimes(2);
  expect(share).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByText('Lecture de la session précédente indisponible. Réessaie.'),
  ).not.toBeOnTheScreen();
});

test('clears a rejected share and never exposes native error details', async () => {
  native.getPreviousMonitoringSnapshot.mockResolvedValue(JSON.stringify(snapshot()));
  const share = jest
    .spyOn(Share, 'share')
    .mockRejectedValueOnce(new Error('private-path-and-credentials'))
    .mockResolvedValueOnce({ action: Share.dismissedAction, activityType: undefined });
  const user = userEvent.setup();
  await renderAsync(<MonitoringPanel />);
  const exportButton = screen.getByRole('button', {
    name: 'Exporter la session précédente',
  });
  await user.press(exportButton);
  expect(
    screen.getByText('Export de la session précédente indisponible.'),
  ).toBeOnTheScreen();
  expect(screen.queryByText(/private-path/)).not.toBeOnTheScreen();
  await user.press(exportButton);
  expect(share).toHaveBeenCalledTimes(2);
  expect(exportButton).toBeEnabled();
});

test('ignores a previous-session read resolved after the panel unmounts', async () => {
  let finish!: (json: string) => void;
  native.getPreviousMonitoringSnapshot.mockImplementationOnce(
    () => new Promise(resolve => { finish = resolve; }),
  );
  const share = jest.spyOn(Share, 'share');
  const user = userEvent.setup();
  await renderAsync(<MonitoringPanel />);
  await user.press(
    screen.getByRole('button', { name: 'Exporter la session précédente' }),
  );
  await screen.unmountAsync();
  await act(async () => finish(JSON.stringify(snapshot())));
  expect(share).not.toHaveBeenCalled();
});

test('drops a pre-background previous-session read and fetches the latest archive on a new export', async () => {
  let finish!: (json: string) => void;
  const latestReport = snapshot({ nativeBuild: '25' });
  native.getPreviousMonitoringSnapshot
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(JSON.stringify(latestReport));
  const share = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: Share.dismissedAction, activityType: undefined });
  const user = userEvent.setup();
  await renderAsync(<MonitoringPanel />);
  const exportButton = screen.getByRole('button', {
    name: 'Exporter la session précédente',
  });
  await user.press(exportButton);
  await act(async () => stateChanged('background'));
  await act(async () => finish(JSON.stringify(snapshot({ nativeBuild: '24' }))));
  expect(share).not.toHaveBeenCalled();
  await act(async () => stateChanged('active'));
  await user.press(exportButton);
  expect(native.getPreviousMonitoringSnapshot).toHaveBeenCalledTimes(2);
  expect(JSON.parse(share.mock.calls[0][0].message!)).toEqual(latestReport);
});

test('allows another export on foreground return even if a cancelled share never settles', async () => {
  let finishShare!: (result: {
    action: string;
    activityType: string | undefined;
  }) => void;
  native.getPreviousMonitoringSnapshot.mockResolvedValue(JSON.stringify(snapshot()));
  const share = jest
    .spyOn(Share, 'share')
    .mockImplementationOnce(() => new Promise(resolve => { finishShare = resolve; }))
    .mockResolvedValue({ action: Share.dismissedAction, activityType: undefined });
  const user = userEvent.setup();
  await renderAsync(<MonitoringPanel />);
  const exportButton = screen.getByRole('button', {
    name: 'Exporter la session précédente',
  });
  await user.press(exportButton);
  expect(exportButton).toBeDisabled();
  await act(async () => stateChanged('inactive'));
  await act(async () => stateChanged('active'));
  expect(exportButton).toBeEnabled();
  await user.press(exportButton);
  expect(native.getPreviousMonitoringSnapshot).toHaveBeenCalledTimes(2);
  expect(share).toHaveBeenCalledTimes(2);
  await act(async () => finishShare({ action: Share.dismissedAction, activityType: undefined }));
  expect(exportButton).toBeEnabled();
});

test('labels the voice stage separately from Core AI phase', async () => {
  const report = snapshot();
  native.getMonitoringSnapshot.mockResolvedValue(JSON.stringify({
    ...report,
    current: { ...report.current, voiceStage: 'pocket' },
  }));
  await renderAsync(<MonitoringPanel />);
  expect(screen.getByText('État : Chargement')).toBeOnTheScreen();
  expect(screen.getByText('Voix : Chargement de PocketTTS')).toBeOnTheScreen();
  expect(screen.getByText(/indépendamment de cet écran/)).toBeOnTheScreen();
  expect(screen.getByText(/peut précéder l’arrêt et manquer un pic/)).toBeOnTheScreen();
});

test('warns when native checkpoint storage is unavailable', async () => {
  native.getMonitoringSnapshot.mockResolvedValue(JSON.stringify({
    ...snapshot(),
    persistence: { status: 'unavailable' },
  }));
  await renderAsync(<MonitoringPanel />);
  expect(screen.getByRole('alert')).toHaveTextContent(/Sauvegarde locale indisponible\./);
  expect(screen.getByRole('button', { name: 'Exporter la session précédente' })).toBeEnabled();
});
