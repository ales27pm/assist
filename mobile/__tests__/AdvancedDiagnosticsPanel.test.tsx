import React from 'react';
import {
  act,
  renderAsync,
  screen,
  userEvent,
} from '@testing-library/react-native';
import { AppState, AppStateStatus, Share } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { AdvancedDiagnosticsPanel } from '../src/AdvancedDiagnosticsPanel';
import {
  DebugMode,
  DebugStatus,
  debugCategories,
} from '../src/debugDiagnostics';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    getDebugDiagnostics: jest.fn(),
    configureDebugDiagnostics: jest.fn(),
    exportDebugDiagnostics: jest.fn(),
    clearDebugDiagnostics: jest.fn(),
    generate: jest.fn(),
    generateWithToolHost: jest.fn(),
    loadModel: jest.fn(),
    runNumericalProbe: jest.fn(),
    getMonitoringSnapshot: jest.fn(),
  },
}));
const native = jest.mocked(NativeAssist!);
const sessionId = '11111111-1111-4111-8111-111111111111';
function status(
  mode: DebugMode = 'standard',
  revision = 0,
  count = 1,
): DebugStatus {
  return {
    schemaVersion: 1,
    kind: 'assistDebugStatus',
    sessionId,
    revision,
    mode,
    detailExpiresAt: mode === 'detailed' ? '2026-10-21T00:15:00Z' : null,
    recordCount: count,
    omittedRecords: 0,
    rejectedRecords: 0,
    previousSessionCount: 0,
    persistence: 'saved',
    records: count
      ? [
          {
            sequence: 1,
            elapsedMs: 1,
            traceId: 't1',
            category: 'planning',
            stage: 'roots',
            outcome: 'rejected',
            reason: 'json',
            field: 'roots',
            metrics: {},
          },
        ]
      : [],
    findings: count
      ? [
          {
            code: 'preparationRejected',
            severity: 'warning',
            evidence: 'observed',
            sequence: 1,
            traceId: 't1',
          },
        ]
      : [],
    coverage: debugCategories.map(category => ({ category, state: 'partial' })),
    limits: {
      maxRecords: 512,
      maxSessionBytes: 262144,
      maxPreviousSessions: 2,
      detailedSeconds: 900,
    },
    privacy: { contentCaptured: false, automaticUpload: false },
  };
}
function bundle(state = status()) {
  return {
    schemaVersion: 1,
    kind: 'assistDebugBundle',
    exportedAt: '2026-10-21T00:01:00Z',
    status: state,
    current: {
      schemaVersion: 1,
      kind: 'assistDebugSession',
      sessionId: state.sessionId,
      nativeBuild: '31',
      osVersion: 'Version 27.2 (Build 24B5110a)',
      startedAt: '2026-10-21T00:00:00Z',
      capturedAt: '2026-10-21T00:01:00Z',
      records: state.records,
      omittedRecords: state.omittedRecords,
      rejectedRecords: state.rejectedRecords,
    },
    previous: [],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let listeners: Set<(state: AppStateStatus) => void>;
let user: ReturnType<typeof userEvent.setup>;
let shared: jest.SpyInstance;
async function press(name: string) {
  await user.press(screen.getByRole('button', { name }));
}
async function lifecycle(state: AppStateStatus) {
  Object.defineProperty(AppState, 'currentState', { value: state });
  await act(async () => {
    for (const listener of listeners) listener(state);
  });
}
async function advance(ms = 1000) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}
async function clear() {
  await press('Effacer le journal avancé');
  await press('Confirmer l’effacement du journal avancé');
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-21T00:00:00Z'));
  jest.resetAllMocks();
  user = userEvent.setup();
  listeners = new Set();
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: 'active',
  });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  });
  native.getDebugDiagnostics.mockResolvedValue(JSON.stringify(status()));
  native.configureDebugDiagnostics.mockImplementation(async json =>
    JSON.stringify(status(JSON.parse(json).mode, 1)),
  );
  native.clearDebugDiagnostics.mockResolvedValue(
    JSON.stringify(status('standard', 2, 0)),
  );
  native.exportDebugDiagnostics.mockResolvedValue(JSON.stringify(bundle()));
  shared = jest
    .spyOn(Share, 'share')
    .mockResolvedValue({ action: Share.sharedAction, activityType: undefined });
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('reads status only, explains its scope and exposes all 16 coverage categories without inventing qualification', async () => {
  await renderAsync(<AdvancedDiagnosticsPanel />);
  expect(screen.getByText('Niveau confirmé : Standard')).toBeOnTheScreen();
  expect(screen.getByText('Préparation locale refusée')).toBeOnTheScreen();
  expect(
    screen.getByText('Avertissement · Observé · événement 1 · trace t1'),
  ).toBeOnTheScreen();
  expect(
    screen.getByText(/Le désactiver ne coupe pas ce suivi/),
  ).toBeOnTheScreen();
  await press('Couverture des diagnostics');
  expect(
    screen.getByText(/pas une qualification exhaustive/),
  ).toBeOnTheScreen();
  expect(screen.getAllByText(/ : Partielle$/)).toHaveLength(16);
  expect(native.getDebugDiagnostics).toHaveBeenCalledTimes(1);
  expect(native.configureDebugDiagnostics).not.toHaveBeenCalled();
  expect(native.exportDebugDiagnostics).not.toHaveBeenCalled();
  expect(native.clearDebugDiagnostics).not.toHaveBeenCalled();
  expect(native.generate).not.toHaveBeenCalled();
  expect(native.generateWithToolHost).not.toHaveBeenCalled();
  expect(native.loadModel).not.toHaveBeenCalled();
  expect(native.runNumericalProbe).not.toHaveBeenCalled();
  expect(native.getMonitoringSnapshot).not.toHaveBeenCalled();
  expect(shared).not.toHaveBeenCalled();
});

test('an older binary is explicit and never simulates configuration or export', async () => {
  const original = native.clearDebugDiagnostics;
  Object.defineProperty(native, 'clearDebugDiagnostics', {
    configurable: true,
    value: undefined,
  });
  try {
    await renderAsync(<AdvancedDiagnosticsPanel />);
    expect(
      screen.getByText(/Une version native compatible est nécessaire/),
    ).toBeOnTheScreen();
    expect(
      screen.queryByRole('button', { name: 'Activer le niveau standard' }),
    ).not.toBeOnTheScreen();
    await advance(3000);
    expect(native.getDebugDiagnostics).not.toHaveBeenCalled();
    expect(shared).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(native, 'clearDebugDiagnostics', { value: original });
  }
});

test.each([
  ['observed', 'Observé'],
  ['inferred', 'Déduit'],
  ['unmeasured', 'Non mesuré'],
] as const)(
  'preserves the native evidence level %s without promoting it',
  async (evidence, label) => {
    const state = status();
    state.findings[0].evidence = evidence;
    native.getDebugDiagnostics.mockResolvedValue(JSON.stringify(state));
    await renderAsync(<AdvancedDiagnosticsPanel />);
    expect(
      screen.getByText(`Avertissement · ${label} · événement 1 · trace t1`),
    ).toBeOnTheScreen();
  },
);

test.each([
  ['Désactiver le journal avancé', 'off', 'Désactivé'],
  ['Activer le niveau standard', 'standard', 'Standard'],
  ['Activer le niveau détaillé (15 min)', 'detailed', 'Détaillé'],
] as const)(
  'configures %s only after the touch and accepts the native effective state',
  async (label, mode, display) => {
    await renderAsync(<AdvancedDiagnosticsPanel />);
    await press(label);
    expect(native.configureDebugDiagnostics.mock.calls).toEqual([
      [JSON.stringify({ schemaVersion: 1, mode })],
    ]);
    expect(screen.getByText(`Niveau confirmé : ${display}`)).toBeOnTheScreen();
    expect(native.generate).not.toHaveBeenCalled();
    expect(shared).not.toHaveBeenCalled();
  },
);

test('TTL display follows a native reread, never a JS-only expiry or automatic reconfiguration', async () => {
  await renderAsync(<AdvancedDiagnosticsPanel />);
  await press('Activer le niveau détaillé (15 min)');
  expect(screen.getByText(/Détaillé limité à 15 minutes/)).toBeOnTheScreen();
  jest.setSystemTime(new Date('2026-10-21T01:00:00Z'));
  expect(screen.getByText('Niveau confirmé : Détaillé')).toBeOnTheScreen();
  native.getDebugDiagnostics.mockResolvedValue(
    JSON.stringify(status('standard', 2)),
  );
  await advance();
  expect(screen.getByText('Niveau confirmé : Standard')).toBeOnTheScreen();
  expect(
    screen.queryByText(/Détaillé limité à 15 minutes/),
  ).not.toBeOnTheScreen();
  expect(native.configureDebugDiagnostics).toHaveBeenCalledTimes(1);
});

test('shares a freshly read reconstructed bundle only after an explicit export', async () => {
  await renderAsync(<AdvancedDiagnosticsPanel />);
  expect(native.exportDebugDiagnostics).not.toHaveBeenCalled();
  await press('Partager le diagnostic avancé');
  expect(native.exportDebugDiagnostics).toHaveBeenCalledTimes(1);
  expect(shared).toHaveBeenCalledTimes(1);
  expect(JSON.parse(shared.mock.calls[0][0].message)).toEqual(bundle());
});

test.each(['status', 'export'] as const)(
  'rejects unknown private fields in %s without rendering or sharing them',
  async source => {
    if (source === 'status')
      native.getDebugDiagnostics.mockResolvedValue(
        JSON.stringify({
          ...status(),
          arguments: { url: 'SYNTHETIC_PRIVATE' },
        }),
      );
    else
      native.exportDebugDiagnostics.mockResolvedValue(
        JSON.stringify({ ...bundle(), error: 'SYNTHETIC_PRIVATE' }),
      );
    await renderAsync(<AdvancedDiagnosticsPanel />);
    if (source === 'export') await press('Partager le diagnostic avancé');
    expect(screen.getByRole('alert')).toBeOnTheScreen();
    expect(screen.queryByText(/SYNTHETIC_PRIVATE/)).not.toBeOnTheScreen();
    expect(shared).not.toHaveBeenCalled();
  },
);

test('purge requires its own confirmation and invalidates an older poll', async () => {
  const old = deferred<string>();
  native.getDebugDiagnostics.mockReturnValueOnce(old.promise);
  await renderAsync(<AdvancedDiagnosticsPanel />);
  await press('Effacer le journal avancé');
  expect(native.clearDebugDiagnostics).not.toHaveBeenCalled();
  await press('Conserver le journal avancé');
  expect(native.clearDebugDiagnostics).not.toHaveBeenCalled();
  await clear();
  expect(screen.getByText('Journal avancé effacé.')).toBeOnTheScreen();
  await act(async () => old.resolve(JSON.stringify(status('detailed', 1))));
  expect(screen.getByText(/0\/512 événements conservés/)).toBeOnTheScreen();
  expect(
    screen.queryByText('Préparation locale refusée'),
  ).not.toBeOnTheScreen();
  expect(
    screen.queryByText(/Niveau confirmé : Détaillé/),
  ).not.toBeOnTheScreen();
  expect(native.clearDebugDiagnostics).toHaveBeenCalledTimes(1);
});

test('purge retires a pending configuration acknowledgement without letting it restore the old level', async () => {
  const old = deferred<string>();
  native.configureDebugDiagnostics.mockReturnValueOnce(old.promise);
  await renderAsync(<AdvancedDiagnosticsPanel />);
  await press('Activer le niveau détaillé (15 min)');
  await clear();
  await act(async () => old.resolve(JSON.stringify(status('detailed', 1))));
  expect(screen.getByText('Niveau confirmé : Standard')).toBeOnTheScreen();
  expect(screen.getByText(/0\/512 événements conservés/)).toBeOnTheScreen();
  expect(
    screen.getByRole('button', { name: 'Activer le niveau standard' }),
  ).toBeEnabled();
});

test('purge retires a pending export and a later explicit export can share the cleared session', async () => {
  const old = deferred<string>();
  native.exportDebugDiagnostics.mockReturnValueOnce(old.promise);
  await renderAsync(<AdvancedDiagnosticsPanel />);
  await press('Partager le diagnostic avancé');
  await clear();
  await act(async () => old.resolve(JSON.stringify(bundle())));
  expect(shared).not.toHaveBeenCalled();
  native.exportDebugDiagnostics.mockResolvedValue(
    JSON.stringify(bundle(status('standard', 2, 0))),
  );
  await press('Partager le diagnostic avancé');
  expect(shared).toHaveBeenCalledTimes(1);
  expect(JSON.parse(shared.mock.calls[0][0].message).current.records).toEqual(
    [],
  );
});

test.each(['read', 'configuration', 'export', 'purge'] as const)(
  'retires a late %s on background and admits fresh work after return',
  async action => {
    const old = deferred<string>();
    if (action === 'read')
      native.getDebugDiagnostics.mockReturnValueOnce(old.promise);
    if (action === 'configuration')
      native.configureDebugDiagnostics.mockReturnValueOnce(old.promise);
    if (action === 'export')
      native.exportDebugDiagnostics.mockReturnValueOnce(old.promise);
    if (action === 'purge')
      native.clearDebugDiagnostics.mockReturnValueOnce(old.promise);
    await renderAsync(<AdvancedDiagnosticsPanel />);
    if (action === 'configuration')
      await press('Activer le niveau détaillé (15 min)');
    if (action === 'export') await press('Partager le diagnostic avancé');
    if (action === 'purge') await clear();
    await lifecycle('background');
    const reads = native.getDebugDiagnostics.mock.calls.length;
    await advance(3000);
    expect(native.getDebugDiagnostics).toHaveBeenCalledTimes(reads);
    expect(
      screen.getByRole('button', { name: 'Partager le diagnostic avancé' }),
    ).toBeDisabled();
    native.getDebugDiagnostics.mockResolvedValue(
      JSON.stringify(status('off', 3, 0)),
    );
    await lifecycle('active');
    await act(async () =>
      old.resolve(
        JSON.stringify(action === 'export' ? bundle() : status('detailed', 1)),
      ),
    );
    expect(screen.getByText('Niveau confirmé : Désactivé')).toBeOnTheScreen();
    expect(shared).not.toHaveBeenCalled();
  },
);

test.each(['read', 'configuration', 'export', 'purge'] as const)(
  'ignores late %s after unmount',
  async action => {
    const old = deferred<string>();
    if (action === 'read')
      native.getDebugDiagnostics.mockReturnValueOnce(old.promise);
    if (action === 'configuration')
      native.configureDebugDiagnostics.mockReturnValueOnce(old.promise);
    if (action === 'export')
      native.exportDebugDiagnostics.mockReturnValueOnce(old.promise);
    if (action === 'purge')
      native.clearDebugDiagnostics.mockReturnValueOnce(old.promise);
    await renderAsync(<AdvancedDiagnosticsPanel />);
    if (action === 'configuration')
      await press('Activer le niveau détaillé (15 min)');
    if (action === 'export') await press('Partager le diagnostic avancé');
    if (action === 'purge') await clear();
    await screen.unmountAsync();
    await act(async () =>
      old.resolve(JSON.stringify(action === 'export' ? bundle() : status())),
    );
    expect(shared).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  },
);

test('bounds concurrent status reads and ignores a lower native configuration revision', async () => {
  const pending = deferred<string>();
  native.getDebugDiagnostics.mockReturnValueOnce(pending.promise);
  await renderAsync(<AdvancedDiagnosticsPanel />);
  await advance(3000);
  expect(native.getDebugDiagnostics).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(JSON.stringify(status('standard', 5))));
  native.getDebugDiagnostics.mockResolvedValue(
    JSON.stringify(status('off', 4)),
  );
  await advance();
  expect(screen.getByText('Niveau confirmé : Standard')).toBeOnTheScreen();
});

test('native failures never expose raw errors or automatically retry mutations', async () => {
  native.configureDebugDiagnostics.mockRejectedValueOnce(
    new Error('SYNTHETIC_PRIVATE_PATH'),
  );
  native.clearDebugDiagnostics.mockRejectedValueOnce(
    new Error('SYNTHETIC_PRIVATE_PATH'),
  );
  await renderAsync(<AdvancedDiagnosticsPanel />);
  await press('Activer le niveau détaillé (15 min)');
  expect(
    screen.getByText('Le niveau du journal n’a pas pu être confirmé.'),
  ).toBeOnTheScreen();
  await clear();
  expect(
    screen.getByText(
      'L’effacement du journal avancé n’a pas pu être confirmé.',
    ),
  ).toBeOnTheScreen();
  expect(screen.queryByText(/SYNTHETIC_PRIVATE/)).not.toBeOnTheScreen();
  expect(native.configureDebugDiagnostics).toHaveBeenCalledTimes(1);
  expect(native.clearDebugDiagnostics).toHaveBeenCalledTimes(1);
});

test('a valid old or uncleared response cannot establish successful deletion', async () => {
  native.clearDebugDiagnostics.mockResolvedValueOnce(JSON.stringify(status()));
  await renderAsync(<AdvancedDiagnosticsPanel />);
  await clear();
  expect(
    screen.getByText(
      'L’effacement du journal avancé n’a pas pu être confirmé.',
    ),
  ).toBeOnTheScreen();
  expect(screen.queryByText('Journal avancé effacé.')).not.toBeOnTheScreen();
  expect(native.clearDebugDiagnostics).toHaveBeenCalledTimes(1);
});

test('system reports retain their evidence label and never imply the active request caused them', async () => {
  const state = status();
  state.findings = [
    {
      code: 'systemResourceReport',
      severity: 'warning',
      evidence: 'observed',
      sequence: null,
      traceId: null,
    },
  ];
  state.records[0].reason = 'systemAppLaunch';
  native.getDebugDiagnostics.mockResolvedValue(JSON.stringify(state));
  await renderAsync(<AdvancedDiagnosticsPanel />);
  expect(
    screen.getByText('Rapport système de ressources reçu'),
  ).toBeOnTheScreen();
  expect(
    screen.getByText(/peut concerner une exécution antérieure/),
  ).toBeOnTheScreen();
  await press('Événements avancés récents');
  expect(screen.getByText(/Rapport de lancement de l’app/)).toBeOnTheScreen();
});
