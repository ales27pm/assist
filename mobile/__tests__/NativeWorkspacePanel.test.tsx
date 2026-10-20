import React, { act } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import {
  fireEvent,
  renderAsync,
  screen,
  userEvent,
  waitFor,
} from '@testing-library/react-native';
import NativeAssist from '../specs/NativeAssist';
import { NativeWorkspacePanel } from '../src/NativeWorkspacePanel';
import {
  CheckpointSnapshot,
  InboxDocument,
} from '../src/nativeWorkspaceProtocol';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    getPrivateServiceStatus: jest.fn(),
    presentPrivateServiceSetup: jest.fn(),
    disconnectPrivateService: jest.fn(),
    searchPrivateService: jest.fn(),
    openPrivateSearchResult: jest.fn(),
    getDocumentStatus: jest.fn(),
    importDocument: jest.fn(),
    getDocumentInbox: jest.fn(),
    readDocument: jest.fn(),
    removeDocument: jest.fn(),
    exportDocumentText: jest.fn(),
    getTaskCheckpoints: jest.fn(),
    updateTaskCheckpoint: jest.fn(),
    cancelNativeWorkspace: jest.fn(),
    getResearchCapabilities: jest.fn(),
    generateResearch: jest.fn(),
    generate: jest.fn(),
    generateWithTools: jest.fn(),
  },
}));
const native = jest.mocked(NativeAssist!);
const id = '11111111-1111-4111-8111-111111111111';
const date = '2026-10-19T12:00:00Z';
const service = {
  schemaVersion: 1,
  configured: true,
  revision: id,
  state: 'configured',
  origin: 'https://ubuntu.tailnet.ts.net',
};
const document: InboxDocument = {
  schemaVersion: 1,
  id,
  kind: 'text',
  source: 'share',
  byteCount: 32,
  createdAt: date,
};
const encode = JSON.stringify;
const researchCapabilities = {
  schemaVersion: 1,
  protocolVersion: 1,
  profile: 'research_v1',
  tools: ['web_search', 'web_read'],
  maximumSearches: 1,
  maximumPageReads: 4,
  maximumDurationSeconds: 120,
};
function researchResult(requestId: string) {
  return {
    schemaVersion: 1,
    requestId,
    text: 'Synthèse locale fondée sur la documentation. [source:read-1]',
    degraded: false,
    sources: [
      {
        id: 'read-1',
        title: 'WeatherKit — documentation Apple',
        url: 'https://developer.apple.com/documentation/weatherkit/',
        readAt: date,
        truncated: false,
      },
    ],
  };
}
let tasks: CheckpointSnapshot;
let inbox: InboxDocument[];
let lifecycle: (state: AppStateStatus) => void;
let lifecycleSubscriptions: {
  listener: (state: AppStateStatus) => void;
  remove: jest.Mock;
  active: boolean;
}[];
const originalState = Object.getOwnPropertyDescriptor(
  AppState,
  'currentState',
)!;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  for (const method of Object.values(native)) method.mockReset();
  jest.replaceProperty(Platform, 'OS', 'ios');
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: 'active',
  });
  lifecycleSubscriptions = [];
  lifecycle = state => {
    Object.defineProperty(AppState, 'currentState', {
      configurable: true,
      value: state,
    });
    for (const subscription of [...lifecycleSubscriptions])
      if (subscription.active) subscription.listener(state);
  };
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      const subscription = { listener, remove: jest.fn(), active: true };
      subscription.remove.mockImplementation(() => {
        subscription.active = false;
      });
      lifecycleSubscriptions.push(subscription);
      return { remove: subscription.remove };
    });
  tasks = { schemaVersion: 1, revision: 0, tasks: [] };
  inbox = [];
  native.getPrivateServiceStatus.mockResolvedValue(encode(service));
  native.getResearchCapabilities.mockResolvedValue(
    encode(researchCapabilities),
  );
  native.generateResearch.mockImplementation(async json =>
    encode(researchResult(JSON.parse(json).requestId)),
  );
  native.presentPrivateServiceSetup.mockResolvedValue(encode(service));
  native.disconnectPrivateService.mockResolvedValue(
    encode({
      schemaVersion: 1,
      configured: false,
      revision: id,
      state: 'not_configured',
    }),
  );
  native.getDocumentStatus.mockResolvedValue(
    encode({
      schemaVersion: 1,
      available: true,
      import: true,
      export: true,
      readKinds: ['text', 'url', 'image', 'pdf'],
    }),
  );
  native.getDocumentInbox.mockImplementation(async () =>
    encode({ schemaVersion: 1, items: inbox }),
  );
  native.getTaskCheckpoints.mockImplementation(async () => encode(tasks));
  native.updateTaskCheckpoint.mockImplementation(async json => {
    const request = JSON.parse(json);
    if (request.action === 'start') {
      if (
        tasks.tasks.some(task => task.state === 'running') ||
        tasks.tasks.some(task => task.taskId === request.taskId)
      )
        throw new Error('busy or duplicate');
      if (tasks.tasks.length === 20) {
        const removable = tasks.tasks.findIndex(task =>
          ['completed', 'cancelled'].includes(task.state),
        );
        if (removable === -1) throw new Error('capacity');
        tasks.tasks.splice(removable, 1);
      }
      tasks = {
        ...tasks,
        revision: tasks.revision + 1,
        tasks: [
          ...tasks.tasks,
          {
            taskId: request.taskId,
            kind: request.kind,
            state: 'running',
            epoch: 1,
            revision: 1,
            updatedAt: date,
          },
        ],
      };
    } else {
      const previous = tasks.tasks.find(
        task => task.taskId === request.taskId,
      )!;
      if (!previous || previous.revision !== request.expectedRevision)
        throw new Error('stale');
      if (
        (request.action === 'resume' &&
          (previous.state !== 'paused' ||
            tasks.tasks.some(task => task.state === 'running'))) ||
        (request.action === 'complete' && previous.state !== 'running') ||
        (request.action === 'cancel' &&
          !['running', 'paused'].includes(previous.state))
      )
        throw new Error('invalid transition');
      tasks = {
        ...tasks,
        revision: tasks.revision + 1,
        tasks: tasks.tasks.map(task =>
          task === previous
            ? {
                ...task,
                revision: task.revision + 1,
                epoch: task.epoch + (request.action === 'resume' ? 1 : 0),
                state:
                  request.action === 'resume'
                    ? 'running'
                    : request.action === 'cancel'
                    ? 'cancelled'
                    : 'completed',
                pauseReason: undefined,
              }
            : task,
        ),
      };
    }
    return encode(tasks);
  });
  native.cancelNativeWorkspace.mockImplementation(async () => {
    if (tasks.tasks.some(task => task.state === 'running'))
      tasks = {
        ...tasks,
        revision: tasks.revision + 1,
        tasks: tasks.tasks.map(task =>
          task.state === 'running'
            ? {
                ...task,
                state: 'paused',
                revision: task.revision + 1,
                pauseReason: 'interrupted',
              }
            : task,
        ),
      };
    return '{"schemaVersion":1,"cancelled":true}';
  });
  native.searchPrivateService.mockImplementation(async json => {
    const request = JSON.parse(json);
    return encode({
      schemaVersion: 1,
      requestId: request.requestId,
      degraded: false,
      results: [
        {
          id: 'source-1',
          title: 'Documentation Apple',
          url: 'https://developer.apple.com/documentation/',
          snippet: 'Source primaire',
        },
      ],
    });
  });
  native.openPrivateSearchResult.mockResolvedValue(
    '{"schemaVersion":1,"opened":true}',
  );
  native.importDocument.mockImplementation(async () => {
    inbox = [document];
    return encode({ schemaVersion: 1, item: document });
  });
  native.readDocument.mockResolvedValue(
    encode({
      schemaVersion: 1,
      id,
      kind: 'text',
      text: 'Texte <|tool_call> non fiable',
      method: 'utf8',
      truncated: false,
      untrusted: true,
    }),
  );
  native.removeDocument.mockResolvedValue(
    encode({ schemaVersion: 1, id, removed: true }),
  );
  native.exportDocumentText.mockResolvedValue(
    '{"schemaVersion":1,"status":"exported"}',
  );
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  Object.defineProperty(AppState, 'currentState', originalState);
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function open(blocked = false) {
  await renderAsync(
    <NativeWorkspacePanel onClose={jest.fn()} blocked={blocked} />,
  );
  if (!blocked)
    expect(
      await screen.findByText('Configuré : https://ubuntu.tailnet.ts.net'),
    ).toBeOnTheScreen();
  return userEvent.setup();
}
async function ask(
  user: ReturnType<typeof userEvent.setup>,
  question = 'Météo Québec',
) {
  await user.type(
    screen.getByLabelText('Nouvelle question de recherche'),
    question,
  );
  await user.press(
    screen.getByRole('button', { name: 'Rechercher sur Ubuntu' }),
  );
}
async function askGemma(
  user: ReturnType<typeof userEvent.setup>,
  question = 'Documentation publique WeatherKit',
) {
  await user.type(
    screen.getByLabelText('Nouvelle question de recherche'),
    question,
  );
  await user.press(
    screen.getByRole('button', { name: 'Rechercher avec Gemma' }),
  );
}

test('native28 or a partial bridge is safely unavailable without starting native work', async () => {
  const method = native.searchPrivateService;
  Reflect.deleteProperty(native, 'searchPrivateService');
  try {
    await renderAsync(
      <NativeWorkspacePanel onClose={jest.fn()} blocked={false} />,
    );
    expect(screen.getByText(/Ce socle natif est absent/)).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Configurer le service privé' }),
    ).toBeDisabled();
    expect(native.getPrivateServiceStatus).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(native, 'searchPrivateService', {
      configurable: true,
      value: method,
    });
  }
});
test('setup delegates secret entry to native UI; no JS credential or implicit search', async () => {
  const user = await open();
  await user.press(
    screen.getByRole('button', { name: 'Configurer le service privé' }),
  );
  expect(native.presentPrivateServiceSetup).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByLabelText(/secret|jeton|password/i),
  ).not.toBeOnTheScreen();
  expect(native.searchPrivateService).not.toHaveBeenCalled();
  expect(native.generate).not.toHaveBeenCalled();
});
test('search records only metadata, completes the exact revision and opens a source by IDs only', async () => {
  const user = await open();
  await ask(user);
  expect(await screen.findByText('Documentation Apple')).toBeOnTheScreen();
  const request = JSON.parse(native.searchPrivateService.mock.calls[0][0]);
  expect(request).toEqual({
    schemaVersion: 1,
    requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
    query: 'Météo Québec',
  });
  const start = JSON.parse(native.updateTaskCheckpoint.mock.calls[0][0]);
  expect(start).toEqual({
    schemaVersion: 1,
    action: 'start',
    taskId: expect.any(String),
    expectedRevision: 0,
    kind: 'research',
  });
  expect(JSON.parse(native.updateTaskCheckpoint.mock.calls[1][0])).toEqual({
    schemaVersion: 1,
    action: 'complete',
    taskId: start.taskId,
    expectedRevision: 1,
  });
  expect(JSON.stringify(native.updateTaskCheckpoint.mock.calls)).not.toContain(
    'Météo',
  );
  expect(screen.getByText(/les pages n’ont pas été lues/)).toBeOnTheScreen();
  await user.press(screen.getByRole('button', { name: 'Ouvrir la source 1' }));
  expect(native.openPrivateSearchResult).toHaveBeenCalledWith(
    request.requestId,
    'source-1',
  );
  expect(native.generateWithTools).not.toHaveBeenCalled();
});
test('a synchronous latch prevents two search submissions before a render', async () => {
  const pending = deferred<string>();
  native.searchPrivateService.mockReturnValue(pending.promise);
  const user = await open();
  await user.type(
    screen.getByLabelText('Nouvelle question de recherche'),
    'Apple',
  );
  const button = screen.getByRole('button', { name: 'Rechercher sur Ubuntu' });
  fireEvent.press(button);
  fireEvent.press(button);
  await waitFor(() =>
    expect(native.searchPrivateService).toHaveBeenCalledTimes(1),
  );
  expect(native.updateTaskCheckpoint).toHaveBeenCalledTimes(1);
});
test('wrong request identity or malformed sources produce no trusted source buttons', async () => {
  native.searchPrivateService.mockResolvedValue(
    encode({ schemaVersion: 1, requestId: id, degraded: false, results: [] }),
  );
  const user = await open();
  await ask(user);
  expect(
    await screen.findByText(/Opération non confirmée ou contrat incompatible/),
  ).toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: 'Ouvrir la source 1' }),
  ).not.toBeOnTheScreen();
  expect(native.cancelNativeWorkspace).toHaveBeenCalledTimes(1);
  expect(native.updateTaskCheckpoint).toHaveBeenCalledTimes(1);
});
test('background cancels actual work before checkpoint recovery and ignores its late result', async () => {
  const pending = deferred<string>();
  native.searchPrivateService.mockReturnValueOnce(pending.promise);
  const user = await open();
  await ask(user, 'Ancienne question');
  const old = JSON.parse(native.searchPrivateService.mock.calls[0][0]);
  await act(async () => lifecycle('background'));
  expect(native.cancelNativeWorkspace).toHaveBeenCalledTimes(1);
  await act(async () =>
    pending.resolve(
      encode({
        schemaVersion: 1,
        requestId: old.requestId,
        degraded: false,
        results: [],
      }),
    ),
  );
  expect(native.updateTaskCheckpoint).toHaveBeenCalledTimes(1);
  expect(
    screen.getByLabelText('Nouvelle question de recherche'),
  ).toHaveDisplayValue('');
  await act(async () => lifecycle('active'));
  expect(
    await screen.findByRole('button', {
      name: 'Reprendre la recherche 1 avec une nouvelle question',
    }),
  ).toBeDisabled();
  await user.type(
    screen.getByLabelText('Nouvelle question de recherche'),
    'Nouvelle question',
  );
  await user.press(
    screen.getByRole('button', {
      name: 'Reprendre la recherche 1 avec une nouvelle question',
    }),
  );
  expect(await screen.findByText('Documentation Apple')).toBeOnTheScreen();
  const resume = JSON.parse(native.updateTaskCheckpoint.mock.calls[1][0]);
  expect(resume).toEqual({
    schemaVersion: 1,
    action: 'resume',
    taskId: tasks.tasks[0].taskId,
    expectedRevision: 2,
  });
  expect(JSON.parse(native.searchPrivateService.mock.calls[1][0]).query).toBe(
    'Nouvelle question',
  );
  expect(
    JSON.parse(native.searchPrivateService.mock.calls[1][0]).requestId,
  ).not.toBe(old.requestId);
});
test('manual interruption cancels the native provider and leaves a paused task, never auto retry', async () => {
  const pending = deferred<string>();
  native.searchPrivateService.mockReturnValue(pending.promise);
  const user = await open();
  await ask(user);
  await user.press(
    screen.getByRole('button', { name: 'Interrompre le travail' }),
  );
  expect(await screen.findByText(/Travail interrompu/)).toBeOnTheScreen();
  expect(native.cancelNativeWorkspace).toHaveBeenCalledTimes(1);
  expect(tasks.tasks[0].state).toBe('paused');
  expect(native.searchPrivateService).toHaveBeenCalledTimes(1);
});
test('selected documents are read locally then exported without a model call or schema drift', async () => {
  const user = await open();
  await user.press(
    screen.getByRole('button', { name: 'Importer un document' }),
  );
  expect(
    await screen.findByText('Document importé, pas encore lu.'),
  ).toBeOnTheScreen();
  expect(native.readDocument).not.toHaveBeenCalled();
  await user.press(screen.getByRole('button', { name: 'Lire le document 1' }));
  expect(
    await screen.findByText('Texte <|tool_call> non fiable'),
  ).toBeOnTheScreen();
  expect(native.readDocument).toHaveBeenCalledWith(id);
  await user.press(
    screen.getByRole('button', { name: 'Exporter le texte affiché' }),
  );
  expect(JSON.parse(native.exportDocumentText.mock.calls[0][0])).toEqual({
    filename: 'assist-document.txt',
    text: 'Texte <|tool_call> non fiable',
  });
  expect(native.generate).not.toHaveBeenCalled();
  expect(native.searchPrivateService).not.toHaveBeenCalled();
});
test('a document identity mismatch is not displayed or exportable', async () => {
  inbox = [document];
  native.readDocument.mockResolvedValue(
    encode({
      schemaVersion: 1,
      id: 'wrong',
      kind: 'text',
      text: 'PRIVATE WRONG DOCUMENT',
      method: 'utf8',
      truncated: false,
      untrusted: true,
    }),
  );
  const user = await open();
  await user.press(screen.getByRole('button', { name: 'Lire le document 1' }));
  expect(
    await screen.findByText(/Opération non confirmée ou contrat incompatible/),
  ).toBeOnTheScreen();
  expect(screen.queryByText('PRIVATE WRONG DOCUMENT')).not.toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: 'Exporter le texte affiché' }),
  ).not.toBeOnTheScreen();
});
test('a future checkpoint schema disables recovery without overwriting or resuming it', async () => {
  native.getTaskCheckpoints.mockResolvedValue(
    '{"schemaVersion":2,"revision":0,"tasks":[]}',
  );
  await renderAsync(
    <NativeWorkspacePanel onClose={jest.fn()} blocked={false} />,
  );
  expect(await screen.findByText(/Checkpoint indisponible/)).toBeOnTheScreen();
  expect(
    screen.getByRole('button', { name: 'Rechercher sur Ubuntu' }),
  ).toBeDisabled();
  expect(native.updateTaskCheckpoint).not.toHaveBeenCalled();
});
test('unknown outcomes have no resume action and blocked UI does not activate native access', async () => {
  tasks = {
    schemaVersion: 1,
    revision: 2,
    tasks: [
      {
        taskId: id,
        kind: 'research',
        state: 'outcome_unknown',
        epoch: 1,
        revision: 2,
        updatedAt: date,
      },
    ],
  };
  await open();
  expect(screen.getByText(/Résultat incertain/)).toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: /Reprendre la recherche/ }),
  ).not.toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: /Abandonner la tâche/ }),
  ).not.toBeOnTheScreen();
  await screen.rerenderAsync(
    <NativeWorkspacePanel onClose={jest.fn()} blocked />,
  );
  expect(
    screen.getByRole('button', { name: 'Configurer le service privé' }),
  ).toBeDisabled();
  expect(native.searchPrivateService).not.toHaveBeenCalled();
});
test('unmount removes listeners, cancels native work and cannot complete a late task', async () => {
  const pending = deferred<string>();
  native.searchPrivateService.mockReturnValue(pending.promise);
  const user = await open();
  await ask(user);
  const request = JSON.parse(native.searchPrivateService.mock.calls[0][0]);
  await screen.unmountAsync();
  expect(lifecycleSubscriptions.length).toBeGreaterThan(0);
  for (const subscription of lifecycleSubscriptions) {
    expect(subscription.remove).toHaveBeenCalledTimes(1);
    expect(subscription.active).toBe(false);
  }
  expect(native.cancelNativeWorkspace).toHaveBeenCalledTimes(1);
  await act(async () =>
    pending.resolve(
      encode({
        schemaVersion: 1,
        requestId: request.requestId,
        degraded: false,
        results: [],
      }),
    ),
  );
  expect(native.updateTaskCheckpoint).toHaveBeenCalledTimes(1);
});

test.each(['before', 'after'] as const)(
  'inactive fences a late result %s returning active and waits for actual cancellation',
  async timing => {
    const pending = deferred<string>();
    const cancellation = deferred<string>();
    const cancelProvider =
      native.cancelNativeWorkspace.getMockImplementation()!;
    native.searchPrivateService.mockReturnValueOnce(pending.promise);
    native.cancelNativeWorkspace.mockImplementationOnce(async () => {
      await cancellation.promise;
      return cancelProvider();
    });
    const user = await open();
    await ask(user);
    const request = JSON.parse(native.searchPrivateService.mock.calls[0][0]);
    await act(async () => lifecycle('inactive'));
    expect(native.cancelNativeWorkspace).toHaveBeenCalledTimes(1);
    if (timing === 'after') await act(async () => lifecycle('active'));
    await act(async () =>
      pending.resolve(
        encode({
          schemaVersion: 1,
          requestId: request.requestId,
          degraded: false,
          results: [],
        }),
      ),
    );
    expect(native.updateTaskCheckpoint).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole('button', { name: 'Rechercher sur Ubuntu' }),
    ).toBeDisabled();
    expect(screen.queryByText('Aucun résultat reçu.')).not.toBeOnTheScreen();
    await act(async () => cancellation.resolve('cancelled'));
    if (timing === 'before') await act(async () => lifecycle('active'));
    expect(
      await screen.findByRole('button', {
        name: 'Reprendre la recherche 1 avec une nouvelle question',
      }),
    ).toBeDisabled();
    await user.type(
      screen.getByLabelText('Nouvelle question de recherche'),
      'Nouvelle question',
    );
    expect(
      screen.getByRole('button', { name: 'Rechercher sur Ubuntu' }),
    ).toBeEnabled();
    expect(native.searchPrivateService).toHaveBeenCalledTimes(1);
    expect(tasks.tasks[0].state).toBe('paused');
  },
);

test('failed inactive cancellation stays closed until an explicit cancellation succeeds', async () => {
  const pending = deferred<string>();
  native.searchPrivateService.mockReturnValueOnce(pending.promise);
  native.cancelNativeWorkspace.mockRejectedValueOnce(new Error('unconfirmed'));
  const user = await open();
  await ask(user);
  await act(async () => lifecycle('inactive'));
  await act(async () => pending.reject(new Error('late provider failure')));
  await act(async () => lifecycle('active'));
  expect(native.searchPrivateService).toHaveBeenCalledTimes(1);
  expect(native.cancelNativeWorkspace).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole('button', { name: 'Configurer le service privé' }),
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Interrompre le travail' }),
  ).toBeEnabled();
  await user.press(
    screen.getByRole('button', { name: 'Interrompre le travail' }),
  );
  expect(await screen.findByText(/Travail interrompu/)).toBeOnTheScreen();
  expect(tasks.tasks[0].state).toBe('paused');
  expect(native.searchPrivateService).toHaveBeenCalledTimes(1);
});

test('a native setup result received after inactive cancellation cannot report a new configuration', async () => {
  const pending = deferred<string>();
  const unconfigured = encode({
    schemaVersion: 1,
    configured: false,
    revision: id,
    state: 'not_configured',
  });
  native.getPrivateServiceStatus.mockResolvedValue(unconfigured);
  native.presentPrivateServiceSetup.mockReturnValueOnce(pending.promise);
  await renderAsync(
    <NativeWorkspacePanel onClose={jest.fn()} blocked={false} />,
  );
  await screen.findByText('Non configuré');
  const user = userEvent.setup();
  await user.press(
    screen.getByRole('button', { name: 'Configurer le service privé' }),
  );
  await act(async () => lifecycle('inactive'));
  await act(async () => lifecycle('active'));
  await act(async () => pending.resolve(encode(service)));
  expect(native.cancelNativeWorkspace).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Non configuré')).toBeOnTheScreen();
  expect(screen.queryByText(/Configuré :/)).not.toBeOnTheScreen();
});

test('an orphaned running checkpoint can be explicitly interrupted without current work', async () => {
  tasks = {
    schemaVersion: 1,
    revision: 1,
    tasks: [
      {
        taskId: id,
        kind: 'document',
        state: 'running',
        epoch: 1,
        revision: 1,
        updatedAt: date,
      },
    ],
  };
  const user = await open();
  expect(native.cancelNativeWorkspace).not.toHaveBeenCalled();
  await user.press(
    screen.getByRole('button', { name: 'Interrompre le travail' }),
  );
  expect(await screen.findByText(/Travail interrompu/)).toBeOnTheScreen();
  expect(tasks.tasks[0].state).toBe('paused');
  expect(native.readDocument).not.toHaveBeenCalled();
  expect(native.searchPrivateService).not.toHaveBeenCalled();
});

test.each(['document', 'research'] as const)(
  'abandoning a paused %s is revision fenced and never executes or resumes it',
  async kind => {
    tasks = {
      schemaVersion: 1,
      revision: 2,
      tasks: [
        {
          taskId: id,
          kind,
          state: 'paused',
          epoch: 1,
          revision: 2,
          updatedAt: date,
          pauseReason: 'interrupted',
        },
      ],
    };
    await open();
    const button = screen.getByRole('button', {
      name: 'Abandonner la tâche 1',
    });
    fireEvent.press(button);
    fireEvent.press(button);
    expect(await screen.findByText(/Tâche abandonnée/)).toBeOnTheScreen();
    expect(native.updateTaskCheckpoint).toHaveBeenCalledTimes(1);
    expect(JSON.parse(native.updateTaskCheckpoint.mock.calls[0][0])).toEqual({
      schemaVersion: 1,
      action: 'cancel',
      taskId: id,
      expectedRevision: 2,
    });
    expect(tasks.tasks[0]).toMatchObject({
      state: 'cancelled',
      revision: 3,
      epoch: 1,
    });
    expect(native.readDocument).not.toHaveBeenCalled();
    expect(native.searchPrivateService).not.toHaveBeenCalled();
    expect(native.generate).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Abandonner la tâche 1' }),
    ).not.toBeOnTheScreen();
  },
);

test('abandoning one of twenty paused documents frees capacity only for a later explicit read', async () => {
  inbox = [document];
  tasks = {
    schemaVersion: 1,
    revision: 40,
    tasks: Array.from({ length: 20 }, (_, index) => ({
      taskId: `11111111-1111-4111-8111-${(index + 1)
        .toString(16)
        .padStart(12, '0')}`,
      kind: 'document',
      state: 'paused',
      epoch: 1,
      revision: 2,
      updatedAt: date,
      pauseReason: 'interrupted',
    })),
  };
  const user = await open();
  await user.press(screen.getByRole('button', { name: 'Lire le document 1' }));
  expect(await screen.findByText(/Opération non confirmée/)).toBeOnTheScreen();
  expect(tasks.tasks).toHaveLength(20);
  expect(native.readDocument).not.toHaveBeenCalled();
  await user.press(
    screen.getByRole('button', { name: 'Abandonner la tâche 1' }),
  );
  expect(await screen.findByText(/Tâche abandonnée/)).toBeOnTheScreen();
  expect(native.readDocument).not.toHaveBeenCalled();
  await user.press(screen.getByRole('button', { name: 'Lire le document 1' }));
  expect(
    await screen.findByText('Texte <|tool_call> non fiable'),
  ).toBeOnTheScreen();
  expect(native.readDocument).toHaveBeenCalledTimes(1);
  expect(tasks.tasks).toHaveLength(20);
  expect(tasks.tasks.filter(task => task.state === 'paused')).toHaveLength(19);
});

test('a stale abandon is not reported as successful and cannot replay work', async () => {
  tasks = {
    schemaVersion: 1,
    revision: 2,
    tasks: [
      {
        taskId: id,
        kind: 'document',
        state: 'paused',
        epoch: 1,
        revision: 2,
        updatedAt: date,
        pauseReason: 'interrupted',
      },
    ],
  };
  const user = await open();
  tasks = {
    ...tasks,
    revision: 3,
    tasks: tasks.tasks.map(task => ({ ...task, revision: 3 })),
  };
  await user.press(
    screen.getByRole('button', { name: 'Abandonner la tâche 1' }),
  );
  expect(await screen.findByText(/Opération non confirmée/)).toBeOnTheScreen();
  expect(screen.queryByText(/Tâche abandonnée/)).not.toBeOnTheScreen();
  expect(
    JSON.parse(native.updateTaskCheckpoint.mock.calls[0][0]).expectedRevision,
  ).toBe(2);
  expect(tasks.tasks[0].state).toBe('paused');
  expect(native.updateTaskCheckpoint).toHaveBeenCalledTimes(1);
  expect(native.readDocument).not.toHaveBeenCalled();
  expect(native.searchPrivateService).not.toHaveBeenCalled();
});

test.each(['getResearchCapabilities', 'generateResearch'] as const)(
  'a native28/partial research bridge missing %s keeps manual search available',
  async methodName => {
    const method = native[methodName];
    Reflect.deleteProperty(native, methodName);
    try {
      const user = await open();
      await user.type(
        screen.getByLabelText('Nouvelle question de recherche'),
        'Documentation Apple',
      );
      expect(
        screen.getByRole('button', { name: 'Rechercher avec Gemma' }),
      ).toBeDisabled();
      expect(
        screen.getByRole('button', { name: 'Rechercher sur Ubuntu' }),
      ).toBeEnabled();
      expect(native.searchPrivateService).not.toHaveBeenCalled();
      await user.press(
        screen.getByRole('button', { name: 'Rechercher sur Ubuntu' }),
      );
      expect(await screen.findByText('Documentation Apple')).toBeOnTheScreen();
      expect(native.searchPrivateService).toHaveBeenCalledTimes(1);
      expect(method).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(native, methodName, {
        configurable: true,
        value: method,
      });
    }
  },
);

test('Gemma research is explicit, isolated from document text, and opens a read source by native IDs only', async () => {
  inbox = [document];
  const user = await open();
  expect(native.getResearchCapabilities).not.toHaveBeenCalled();
  expect(native.generateResearch).not.toHaveBeenCalled();
  await user.press(screen.getByRole('button', { name: 'Lire le document 1' }));
  expect(
    await screen.findByText('Texte <|tool_call> non fiable'),
  ).toBeOnTheScreen();
  await askGemma(user, '  Documentation publique WeatherKit  ');
  expect(await screen.findByText(researchResult(id).text)).toBeOnTheScreen();
  expect(native.getResearchCapabilities).toHaveBeenCalledTimes(1);
  expect(native.generateResearch).toHaveBeenCalledTimes(1);
  const request = JSON.parse(native.generateResearch.mock.calls[0][0]);
  expect(request).toEqual({
    schemaVersion: 1,
    requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
    messages: [{ role: 'user', content: 'Documentation publique WeatherKit' }],
    temperature: 0,
    maxTokens: 1024,
  });
  expect(native.generateResearch.mock.calls[0][0]).not.toContain('non fiable');
  expect(native.generate).not.toHaveBeenCalled();
  expect(native.generateWithTools).not.toHaveBeenCalled();
  expect(native.searchPrivateService).not.toHaveBeenCalled();
  expect(
    screen.getByText('Page lue : WeatherKit — documentation Apple'),
  ).toBeOnTheScreen();
  await user.press(
    screen.getByRole('button', { name: 'Ouvrir la page lue 1' }),
  );
  expect(native.openPrivateSearchResult).toHaveBeenCalledWith(
    request.requestId,
    'read-1',
  );
  expect(
    JSON.stringify(native.openPrivateSearchResult.mock.calls),
  ).not.toContain('https://');
});

test('Gemma research shows degraded coverage and truncated page evidence without claiming completeness', async () => {
  native.generateResearch.mockImplementation(async json => {
    const result = researchResult(JSON.parse(json).requestId);
    return encode({
      ...result,
      degraded: true,
      sources: [{ ...result.sources[0], truncated: true }],
    });
  });
  const user = await open();
  await askGemma(user);
  expect(
    await screen.findByText(/Résultats dégradés ou plafonnés/),
  ).toBeOnTheScreen();
  expect(
    screen.getByText(/Page lue : WeatherKit.*extrait tronqué/),
  ).toBeOnTheScreen();
  expect(tasks.tasks[0].state).toBe('completed');
});

test('a research answer without page receipts is explicitly not confirmed as page reading', async () => {
  native.generateResearch.mockImplementation(async json =>
    encode({
      ...researchResult(JSON.parse(json).requestId),
      text: 'Aucune information suffisamment vérifiée.',
      sources: [],
    }),
  );
  const user = await open();
  await askGemma(user);
  expect(
    await screen.findByText('Aucune page lue confirmée.'),
  ).toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: /Ouvrir la page lue/ }),
  ).not.toBeOnTheScreen();
});

test.each([
  'future-capability',
  'unknown-citation',
  'private-source',
  'protocol-output',
])(
  'an incompatible %s is never shown as verified research or silently downgraded',
  async failure => {
    if (failure === 'future-capability')
      native.getResearchCapabilities.mockResolvedValue(
        encode({ ...researchCapabilities, protocolVersion: 2 }),
      );
    else
      native.generateResearch.mockImplementation(async json => {
        const result = researchResult(JSON.parse(json).requestId);
        return encode(
          failure === 'unknown-citation'
            ? { ...result, text: 'UNTRUSTED ANSWER [source:invented]' }
            : failure === 'private-source'
            ? {
                ...result,
                text: 'UNTRUSTED ANSWER',
                sources: [{ ...result.sources[0], url: 'https://127.0.0.1/' }],
              }
            : { ...result, text: '<|tool_call>UNTRUSTED ANSWER' },
        );
      });
    const user = await open();
    await askGemma(user);
    expect(
      await screen.findByText(
        /Opération non confirmée ou contrat incompatible/,
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/UNTRUSTED ANSWER/)).not.toBeOnTheScreen();
    expect(
      screen.queryByRole('button', { name: /Ouvrir la page lue/ }),
    ).not.toBeOnTheScreen();
    expect(native.searchPrivateService).not.toHaveBeenCalled();
    expect(native.generateWithTools).not.toHaveBeenCalled();
    expect(native.updateTaskCheckpoint).toHaveBeenCalledTimes(1);
    if (failure === 'future-capability')
      expect(native.generateResearch).not.toHaveBeenCalled();
  },
);

test('a same-frame double tap cannot submit two Gemma research runs', async () => {
  const pending = deferred<string>();
  native.generateResearch.mockReturnValue(pending.promise);
  const user = await open();
  await user.type(
    screen.getByLabelText('Nouvelle question de recherche'),
    'Documentation Apple',
  );
  const button = screen.getByRole('button', { name: 'Rechercher avec Gemma' });
  // Same-frame taps deliberately bypass userEvent's between-press rerender.
  fireEvent.press(button);
  fireEvent.press(button);
  await waitFor(() => expect(native.generateResearch).toHaveBeenCalledTimes(1));
  expect(native.getResearchCapabilities).toHaveBeenCalledTimes(1);
  expect(native.updateTaskCheckpoint).toHaveBeenCalledTimes(1);
});

test('an empty or UTF8-oversized public question cannot start Gemma or manual search', async () => {
  const user = await open();
  expect(
    screen.getByRole('button', { name: 'Rechercher avec Gemma' }),
  ).toBeDisabled();
  await user.type(
    screen.getByLabelText('Nouvelle question de recherche'),
    'é'.repeat(257),
  );
  expect(
    screen.getByRole('button', { name: 'Rechercher avec Gemma' }),
  ).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Rechercher sur Ubuntu' }),
  ).toBeDisabled();
  expect(native.getResearchCapabilities).not.toHaveBeenCalled();
  expect(native.generateResearch).not.toHaveBeenCalled();
  expect(native.updateTaskCheckpoint).not.toHaveBeenCalled();
});

test('a late capability response after inactivity cannot start a model research request', async () => {
  const capabilities = deferred<string>();
  native.getResearchCapabilities.mockReturnValueOnce(capabilities.promise);
  const user = await open();
  await askGemma(user);
  expect(native.getResearchCapabilities).toHaveBeenCalledTimes(1);
  expect(native.generateResearch).not.toHaveBeenCalled();
  await act(async () => lifecycle('inactive'));
  await act(async () => lifecycle('active'));
  await act(async () => capabilities.resolve(encode(researchCapabilities)));
  expect(native.generateResearch).not.toHaveBeenCalled();
  expect(native.searchPrivateService).not.toHaveBeenCalled();
  expect(native.updateTaskCheckpoint).toHaveBeenCalledTimes(1);
  expect(tasks.tasks[0].state).toBe('paused');
});

test.each(['cancel', 'inactive', 'disconnect'] as const)(
  '%s fences an outstanding Gemma answer and page receipts',
  async interruption => {
    const pending = deferred<string>();
    native.generateResearch.mockReturnValueOnce(pending.promise);
    const user = await open();
    await askGemma(user);
    const request = JSON.parse(native.generateResearch.mock.calls[0][0]);
    if (interruption === 'inactive') {
      await act(async () => lifecycle('inactive'));
      await act(async () => lifecycle('active'));
    } else {
      await user.press(
        screen.getByRole('button', { name: 'Interrompre le travail' }),
      );
      if (interruption === 'disconnect') {
        await user.press(
          screen.getByRole('button', { name: 'Déconnecter le service privé' }),
        );
        expect(await screen.findByText('Non configuré')).toBeOnTheScreen();
        expect(native.disconnectPrivateService).toHaveBeenCalledTimes(1);
      }
    }
    // Resolve the external native callback after the UI revocation boundary.
    await act(async () =>
      pending.resolve(encode(researchResult(request.requestId))),
    );
    expect(screen.queryByText(researchResult(id).text)).not.toBeOnTheScreen();
    expect(
      screen.queryByRole('button', { name: /Ouvrir la page lue/ }),
    ).not.toBeOnTheScreen();
    expect(native.generateResearch).toHaveBeenCalledTimes(1);
    expect(native.updateTaskCheckpoint).toHaveBeenCalledTimes(1);
    expect(native.searchPrivateService).not.toHaveBeenCalled();
    expect(tasks.tasks[0].state).toBe('paused');
  },
);

test('unmount fences an outstanding research callback without completing the task', async () => {
  const pending = deferred<string>();
  native.generateResearch.mockReturnValueOnce(pending.promise);
  const user = await open();
  await askGemma(user);
  const request = JSON.parse(native.generateResearch.mock.calls[0][0]);
  await screen.unmountAsync();
  await act(async () =>
    pending.resolve(encode(researchResult(request.requestId))),
  );
  expect(native.cancelNativeWorkspace).toHaveBeenCalledTimes(1);
  expect(native.updateTaskCheckpoint).toHaveBeenCalledTimes(1);
  expect(native.generateResearch).toHaveBeenCalledTimes(1);
});
