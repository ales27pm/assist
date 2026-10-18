import React from 'react';
import { AppState, Modal, Platform } from 'react-native';
import {
  act,
  fireEvent,
  renderAsync,
  screen,
  userEvent,
} from '@testing-library/react-native';
import { AssistantScreen } from '../App';
import NativeAssist from '../specs/NativeAssist';
import { deviceToolNames } from '../src/deviceToolProtocol';

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    getStatus: jest.fn(),
    getAgentCapabilities: jest.fn(),
    getDeviceToolCapabilities: jest.fn(),
    generateWithTools: jest.fn(),
    confirmToolAction: jest.fn(),
    getToolOperations: jest.fn(),
    onToolActivity: jest.fn(),
    generateCalendarToday: jest.fn(),
    generate: jest.fn(),
    cancel: jest.fn(),
    reset: jest.fn(),
    onProgress: jest.fn(),
    onCalendarActivity: jest.fn(),
    getVoiceStatus: jest.fn(),
    onVoiceEvent: jest.fn(),
    startListening: jest.fn(),
    stopListening: jest.fn(),
    cancelVoice: jest.fn(),
    speak: jest.fn(),
    beginSpeech: jest.fn(),
    enqueueSpeech: jest.fn(),
    finishSpeech: jest.fn(),
    requestDeviceCapability: jest.fn(),
    listCalendarEvents: jest.fn(),
  },
}));

const native = jest.mocked(NativeAssist!);
const appStateDescriptor = Object.getOwnPropertyDescriptor(
  AppState,
  'currentState',
)!;
const actionLabel = 'Consulter mon calendrier aujourd’hui';
const calendarPrompt =
  'Consulte mon calendrier d’aujourd’hui et résume les événements retournés, sans supposer que la liste est complète.';
const state = '{"phase":"ready","contextCapacity":8192}';
const voiceState =
  '{"available":true,"recognitionAvailable":true,"synthesisAvailable":true,"locale":"fr-CA","phase":"idle"}';
const trace = {
  schemaVersion: 1,
  tool: 'calendar.list',
  callId: 'calendar-read-1',
  scope: {
    startISO: '2026-10-18T04:00:00.000Z',
    endISO: '2026-10-19T04:00:00.000Z',
    timeZoneIdentifier: 'America/Toronto',
  },
  returnedCount: 1,
  possiblyTruncated: false,
};
let progress: (event: { json: string }) => void;
let calendarActivity: (event: { json: string }) => void;
let voiceEvent: (event: { json: string }) => void;
let deviceActivity: (event: { json: string }) => void;

function result(requestId: string, text: string, agent = true) {
  return JSON.stringify({
    requestId,
    text,
    generatedTokens: 5,
    promptTokens: 30,
    elapsedMs: 200,
    finishReason: 'eos',
    aneExecution: 'unverified',
    ...(agent ? { agentTrace: trace } : {}),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function emitActivity(
  requestId: string,
  sequence: 1 | 2 | 3,
  extra: Record<string, unknown> = {},
) {
  await act(async () => {
    calendarActivity({
      json: JSON.stringify({
        schemaVersion: 1,
        requestId,
        sequence,
        phase: ['planning', 'executing', 'observing'][sequence - 1],
        scope: trace.scope,
        ...(sequence === 3 ? { receipt: trace } : {}),
        ...extra,
      }),
    });
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  for (const method of Object.values(native)) method.mockReset();
  jest.replaceProperty(Platform, 'OS', 'ios');
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    writable: true,
    value: 'active',
  });
  native.getStatus.mockResolvedValue(state);
  native.cancel.mockResolvedValue(state);
  native.reset.mockResolvedValue(state);
  native.getDeviceToolCapabilities.mockResolvedValue('{}');
  native.getToolOperations.mockResolvedValue(
    '{"schemaVersion":1,"operations":[]}',
  );
  native.confirmToolAction.mockResolvedValue(
    '{"schemaVersion":1,"accepted":true}',
  );
  native.onToolActivity.mockImplementation(listener => {
    deviceActivity = listener;
    return { remove: jest.fn() };
  });
  native.getAgentCapabilities.mockResolvedValue(
    '{"schemaVersion":1,"calendarReadOnly":true,"protocolVersion":1}',
  );
  native.generateCalendarToday.mockImplementation(async json =>
    result(JSON.parse(json).requestId, 'Un événement retourné aujourd’hui.'),
  );
  native.generate.mockImplementation(async json =>
    result(JSON.parse(json).requestId, 'Réponse ordinaire.', false),
  );
  native.onProgress.mockImplementation(listener => {
    progress = listener;
    return { remove: jest.fn() };
  });
  native.onCalendarActivity.mockImplementation(listener => {
    calendarActivity = listener;
    return { remove: jest.fn() };
  });
  native.onVoiceEvent.mockImplementation(listener => {
    voiceEvent = listener;
    return { remove: jest.fn() };
  });
  native.getVoiceStatus.mockResolvedValue(voiceState);
  native.cancelVoice.mockResolvedValue(voiceState);
  native.startListening.mockImplementation(async id => {
    voiceEvent({
      json: JSON.stringify({
        sessionId: id,
        kind: 'state',
        phase: 'listening',
      }),
    });
    return voiceState.replace('idle', 'listening');
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  Object.defineProperty(AppState, 'currentState', appStateDescriptor);
});

async function openChat() {
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  expect(
    await screen.findByRole('button', { name: actionLabel, disabled: false }),
  ).toBeEnabled();
  return user;
}

test('normal send never invokes calendar reading or permission requests', async () => {
  const user = await openChat();
  await user.type(
    screen.getByLabelText('Message'),
    'Que contient mon calendrier ?',
  );
  await user.press(screen.getByRole('button', { name: 'Envoyer' }));
  expect(await screen.findByText('Réponse ordinaire.')).toBeOnTheScreen();
  expect(native.generate).toHaveBeenCalledTimes(1);
  expect(native.generateCalendarToday).not.toHaveBeenCalled();
  expect(native.listCalendarEvents).not.toHaveBeenCalled();
  expect(native.requestDeviceCapability).not.toHaveBeenCalled();
});

test('an older bridge missing the dedicated method stays disabled without a fallback', async () => {
  const original = native.generateCalendarToday;
  Object.defineProperty(native, 'generateCalendarToday', {
    configurable: true,
    writable: true,
    value: undefined,
  });
  try {
    const user = userEvent.setup();
    await renderAsync(<AssistantScreen />);
    const button = screen.getByRole('button', { name: actionLabel });
    expect(button).toBeDisabled();
    await user.press(button);
    expect(native.getAgentCapabilities).not.toHaveBeenCalled();
    expect(native.generate).not.toHaveBeenCalled();
    expect(native.requestDeviceCapability).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(native, 'generateCalendarToday', {
      configurable: true,
      writable: true,
      value: original,
    });
  }
});

test.each([
  null,
  { schemaVersion: 1, calendarReadOnly: false, protocolVersion: 1 },
  { schemaVersion: 1, calendarReadOnly: 'true', protocolVersion: 1 },
  { schemaVersion: 2, calendarReadOnly: true, protocolVersion: 1 },
  { schemaVersion: 1, calendarReadOnly: true, protocolVersion: 2 },
])('rejects an invalid capability handshake %j', async capabilities => {
  native.getAgentCapabilities.mockResolvedValue(JSON.stringify(capabilities));
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  const button = screen.getByRole('button', { name: actionLabel });
  expect(button).toBeDisabled();
  await user.press(button);
  expect(native.generateCalendarToday).not.toHaveBeenCalled();
  expect(native.generate).not.toHaveBeenCalled();
});

test('a synchronous capability bridge failure stays disabled instead of crashing', async () => {
  native.getAgentCapabilities.mockImplementation(() => {
    throw new Error('OLD_BRIDGE');
  });
  await renderAsync(<AssistantScreen />);
  expect(screen.getByRole('button', { name: actionLabel })).toBeDisabled();
  expect(native.generateCalendarToday).not.toHaveBeenCalled();
});

test.each([
  '<|tool_call>calendar_list() <tool_response>',
  'Une réponse suivie de <|',
  'Une réponse suivie de |>',
  '<tool_result>PRIVATE_EVENT_TITLE',
  '<channel|analysis>PRIVATE_EVENT_TITLE',
  '<turn|assistant>PRIVATE_EVENT_TITLE',
  `Un titre malveillant${String.fromCharCode(0)}PRIVATE_EVENT_TITLE`,
])(
  'rejects reserved calendar final-answer syntax %j before display',
  async text => {
    native.generateCalendarToday.mockImplementation(async json =>
      result(JSON.parse(json).requestId, text),
    );
    const user = await openChat();
    await user.press(screen.getByRole('button', { name: actionLabel }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /^La consultation du calendrier n’a pas abouti\./,
    );
    expect(screen.queryByText(text)).not.toBeOnTheScreen();
    expect(native.beginSpeech).not.toHaveBeenCalled();
  },
);

test('ordinary text mentioning a call name is not treated as a command', async () => {
  native.generateCalendarToday.mockImplementation(async json =>
    result(
      JSON.parse(json).requestId,
      'Le titre mentionne calendar_list, sans commande à exécuter.',
    ),
  );
  const user = await openChat();
  await user.press(screen.getByRole('button', { name: actionLabel }));
  expect(
    await screen.findByText(
      'Le titre mentionne calendar_list, sans commande à exécuter.',
    ),
  ).toBeOnTheScreen();
});

test('an explicit touch sends only the fixed user request and hides all intermediate tool progress', async () => {
  const pending = deferred<string>();
  native.generateCalendarToday.mockReturnValue(pending.promise);
  const user = await openChat();
  expect(native.generateCalendarToday).not.toHaveBeenCalled();
  await user.press(screen.getByRole('button', { name: actionLabel }));
  expect(native.generateCalendarToday).toHaveBeenCalledTimes(1);
  const request = JSON.parse(native.generateCalendarToday.mock.calls[0][0]);
  expect(request).toEqual({
    schemaVersion: 1,
    requestId: expect.any(String),
    messages: [{ role: 'user', content: calendarPrompt }],
    maxTokens: null,
    temperature: 0,
  });
  expect(screen.getByText('Consultation du calendrier…')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: actionLabel })).toBeDisabled();
  await act(async () => {
    progress({
      json: JSON.stringify({
        requestId: request.requestId,
        text: 'PRIVATE_TOOL_JSON calendar.list',
        generatedTokens: 3,
        promptTokens: 10,
        elapsedMs: 20,
      }),
    });
  });
  expect(screen.queryByText(/PRIVATE_TOOL_JSON/)).not.toBeOnTheScreen();
  await act(async () => {
    pending.resolve(
      result(request.requestId, 'Résumé visible des événements.'),
    );
  });
  expect(screen.getByText('Résumé visible des événements.')).toBeOnTheScreen();
  expect(
    screen.queryByText(/calendar\.list|calendar-read-1/),
  ).not.toBeOnTheScreen();
  expect(native.generate).not.toHaveBeenCalled();
  expect(native.listCalendarEvents).not.toHaveBeenCalled();
  expect(native.requestDeviceCapability).not.toHaveBeenCalled();
  expect(native.beginSpeech).not.toHaveBeenCalled();
  expect(native.enqueueSpeech).not.toHaveBeenCalled();
  expect(native.speak).not.toHaveBeenCalled();
});

test('calendar content remains display-only and never becomes trusted reusable model history', async () => {
  const user = await openChat();
  await user.type(screen.getByLabelText('Message'), 'Mon prochain message');
  await user.press(screen.getByRole('button', { name: actionLabel }));
  expect(
    await screen.findByText('Un événement retourné aujourd’hui.'),
  ).toBeOnTheScreen();
  expect(screen.getByLabelText('Message')).toHaveDisplayValue(
    'Mon prochain message',
  );
  await user.press(screen.getByRole('button', { name: 'Envoyer' }));
  expect(JSON.parse(native.generate.mock.calls[0][0]).messages).toEqual([
    { role: 'user', content: 'Mon prochain message' },
  ]);
  expect(
    screen.getByText('Un événement retourné aujourd’hui.'),
  ).toBeOnTheScreen();
});

test('cancelling a calendar turn rejects a late EOS answer and prevents reusable history', async () => {
  const pending = deferred<string>();
  native.generateCalendarToday.mockReturnValue(pending.promise);
  const user = await openChat();
  await user.press(screen.getByRole('button', { name: actionLabel }));
  const request = JSON.parse(native.generateCalendarToday.mock.calls[0][0]);
  await user.press(
    screen.getByRole('button', { name: 'Annuler la génération' }),
  );
  expect(native.cancel).toHaveBeenCalledTimes(1);
  await act(async () => {
    pending.resolve(result(request.requestId, 'LATE_PRIVATE_CALENDAR'));
  });
  expect(screen.queryByText('LATE_PRIVATE_CALENDAR')).not.toBeOnTheScreen();
  await user.type(screen.getByLabelText('Message'), 'Nouvelle question');
  await user.press(screen.getByRole('button', { name: 'Envoyer' }));
  expect(JSON.parse(native.generate.mock.calls[0][0]).messages).toEqual([
    { role: 'user', content: 'Nouvelle question' },
  ]);
  expect(native.generateCalendarToday).toHaveBeenCalledTimes(1);
});

test('an ASR partial never invokes the calendar agent', async () => {
  const user = await openChat();
  await user.press(screen.getByRole('button', { name: 'Mode vocal' }));
  const id = native.startListening.mock.calls[0][0];
  await act(async () => {
    voiceEvent({
      json: JSON.stringify({
        sessionId: id,
        kind: 'transcript',
        phase: 'listening',
        text: 'Consulte mon calendrier',
        isFinal: false,
      }),
    });
  });
  expect(native.generateCalendarToday).not.toHaveBeenCalled();
  expect(native.generate).not.toHaveBeenCalled();
  expect(native.listCalendarEvents).not.toHaveBeenCalled();
});

test('calendar failures are sanitized and never retried automatically', async () => {
  native.generateCalendarToday.mockRejectedValue(
    new Error('PRIVATE_EVENT_TITLE'),
  );
  const user = await openChat();
  await user.press(screen.getByRole('button', { name: actionLabel }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /^La consultation du calendrier n’a pas abouti\./,
  );
  expect(screen.queryByText(/PRIVATE_EVENT_TITLE/)).not.toBeOnTheScreen();
  await act(async () => {
    jest.advanceTimersByTime(60_000);
  });
  expect(native.generateCalendarToday).toHaveBeenCalledTimes(1);
});

test('the card follows only admitted native phases, with a receipt before the summary', async () => {
  const pending = deferred<string>();
  native.generateCalendarToday.mockReturnValue(pending.promise);
  const user = await openChat();
  await user.press(screen.getByRole('button', { name: actionLabel }));
  const { requestId } = JSON.parse(
    native.generateCalendarToday.mock.calls[0][0],
  );
  expect(screen.getByText('Préparation')).toBeOnTheScreen();
  expect(screen.queryByText('Lecture confirmée')).not.toBeOnTheScreen();
  await emitActivity('another-request', 1);
  await emitActivity(requestId, 2); // A missing admission cannot imply a read.
  expect(screen.queryByText('Consultation en cours')).not.toBeOnTheScreen();
  await emitActivity(requestId, 1);
  await emitActivity(requestId, 2);
  expect(screen.getByText('Consultation en cours')).toBeOnTheScreen();
  await emitActivity(requestId, 3);
  expect(screen.getByText('Réponse en préparation')).toBeOnTheScreen();
  expect(screen.getByText('Lecture confirmée')).toBeOnTheScreen();
  expect(screen.getByText('1 événement retourné.')).toBeOnTheScreen();
  await act(async () => pending.resolve(result(requestId, 'Résumé final.')));
  expect(screen.getByText('Résumé final.')).toBeOnTheScreen();
  expect(screen.getByText('Lecture confirmée')).toBeOnTheScreen();
  expect(screen.queryByText('Réponse en préparation')).not.toBeOnTheScreen();
  expect(native.speak).not.toHaveBeenCalled();
});

test('a plain model response never manufactures a calendar receipt', async () => {
  native.generateCalendarToday.mockImplementation(async json =>
    result(JSON.parse(json).requestId, 'Je ne peux pas le consulter.', false),
  );
  const user = await openChat();
  await user.press(screen.getByRole('button', { name: actionLabel }));
  expect(await screen.findByText('Calendrier non consulté')).toBeOnTheScreen();
  expect(screen.queryByText('Lecture confirmée')).not.toBeOnTheScreen();
  expect(screen.getByText('Je ne peux pas le consulter.')).toBeOnTheScreen();
});

test('a failure after observation retains the native receipt without exposing the error', async () => {
  let reject!: (error: Error) => void;
  native.generateCalendarToday.mockReturnValue(
    new Promise((_resolve, failed) => {
      reject = failed;
    }),
  );
  const user = await openChat();
  await user.press(screen.getByRole('button', { name: actionLabel }));
  const { requestId } = JSON.parse(
    native.generateCalendarToday.mock.calls[0][0],
  );
  await emitActivity(requestId, 1);
  await emitActivity(requestId, 2);
  await emitActivity(requestId, 3);
  await act(async () => reject(new Error('PRIVATE_EVENT_TITLE')));
  expect(screen.getByText('Réponse non finalisée')).toBeOnTheScreen();
  expect(screen.getByText('Lecture confirmée')).toBeOnTheScreen();
  expect(screen.queryByText(/PRIVATE_EVENT_TITLE/)).not.toBeOnTheScreen();
  expect(native.generateCalendarToday).toHaveBeenCalledTimes(1);
});

test('contradicting final evidence blocks the summary and preserves the acquired receipt', async () => {
  const pending = deferred<string>();
  native.generateCalendarToday.mockReturnValue(pending.promise);
  const user = await openChat();
  await user.press(screen.getByRole('button', { name: actionLabel }));
  const { requestId } = JSON.parse(
    native.generateCalendarToday.mock.calls[0][0],
  );
  for (const sequence of [1, 2, 3] as const)
    await emitActivity(requestId, sequence);
  await act(async () => {
    const final = JSON.parse(result(requestId, 'UNTRUSTED_FINAL_TEXT'));
    final.agentTrace.returnedCount = 2;
    pending.resolve(JSON.stringify(final));
  });
  expect(screen.getByText('Réponse non finalisée')).toBeOnTheScreen();
  expect(screen.getByText('1 événement retourné.')).toBeOnTheScreen();
  expect(screen.queryByText('UNTRUSTED_FINAL_TEXT')).not.toBeOnTheScreen();
});

test('cancellation waits for native ACK, rejects late activity, and keeps an earlier receipt', async () => {
  const pending = deferred<string>();
  const acknowledgement = deferred<string>();
  native.generateCalendarToday.mockReturnValue(pending.promise);
  native.cancel.mockReturnValue(acknowledgement.promise);
  const user = await openChat();
  await user.press(screen.getByRole('button', { name: actionLabel }));
  const { requestId } = JSON.parse(
    native.generateCalendarToday.mock.calls[0][0],
  );
  for (const sequence of [1, 2, 3] as const)
    await emitActivity(requestId, sequence);
  await user.press(
    screen.getByRole('button', { name: 'Arrêter la consultation' }),
  );
  expect(screen.getByText('Annulation demandée')).toBeOnTheScreen();
  await emitActivity(requestId, 3, { receipt: { ...trace, returnedCount: 2 } });
  expect(screen.queryByText('2 événements retournés.')).not.toBeOnTheScreen();
  await act(async () => {
    acknowledgement.resolve(state);
    pending.resolve(result(requestId, 'LATE_PRIVATE_CALENDAR'));
  });
  expect(screen.getByText('Réponse interrompue')).toBeOnTheScreen();
  expect(screen.getByText('Lecture confirmée')).toBeOnTheScreen();
  expect(screen.queryByText('LATE_PRIVATE_CALENDAR')).not.toBeOnTheScreen();
});

test('permission recovery never requests access or repeats a read implicitly', async () => {
  native.generateCalendarToday.mockRejectedValue(
    Object.assign(new Error('PRIVATE_NATIVE_MESSAGE'), {
      code: 'E_PERMISSION',
    }),
  );
  const user = await openChat();
  await user.press(screen.getByRole('button', { name: actionLabel }));
  expect(await screen.findByText('Accès calendrier requis')).toBeOnTheScreen();
  expect(native.requestDeviceCapability).not.toHaveBeenCalled();
  await user.press(
    screen.getByRole('button', { name: 'Gérer l’accès au calendrier' }),
  );
  expect(native.generateCalendarToday).toHaveBeenCalledTimes(1);
  expect(native.requestDeviceCapability).not.toHaveBeenCalled();
});

test('generation settlement before cancel ACK cannot admit a new task', async () => {
  const pending = deferred<string>();
  const acknowledgement = deferred<string>();
  native.generateCalendarToday.mockReturnValue(pending.promise);
  native.cancel.mockReturnValue(acknowledgement.promise);
  const user = await openChat();
  await user.press(screen.getByRole('button', { name: actionLabel }));
  const { requestId } = JSON.parse(
    native.generateCalendarToday.mock.calls[0][0],
  );
  await user.press(
    screen.getByRole('button', { name: 'Arrêter la consultation' }),
  );
  await act(async () =>
    pending.resolve(result(requestId, 'LATE_PRIVATE_SUMMARY')),
  );
  const calendarButton = screen.getByRole('button', { name: actionLabel });
  expect(calendarButton).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Envoyer' })).toBeDisabled();
  await act(async () => fireEvent.press(calendarButton));
  expect(native.generateCalendarToday).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Annulation demandée')).toBeOnTheScreen();
  expect(screen.queryByText('LATE_PRIVATE_SUMMARY')).not.toBeOnTheScreen();
  await act(async () => acknowledgement.resolve(state));
  expect(screen.getByText('Consultation interrompue')).toBeOnTheScreen();
  expect(calendarButton).toBeEnabled();
});

test('malformed activity cannot become visible data or an executable action', async () => {
  const pending = deferred<string>();
  native.generateCalendarToday.mockReturnValue(pending.promise);
  const user = await openChat();
  await user.press(screen.getByRole('button', { name: actionLabel }));
  const { requestId } = JSON.parse(
    native.generateCalendarToday.mock.calls[0][0],
  );
  await emitActivity(requestId, 1, { title: 'PRIVATE_EVENT_TITLE' });
  await emitActivity(requestId, 2);
  expect(screen.getByText('Préparation')).toBeOnTheScreen();
  expect(screen.queryByText(/PRIVATE_EVENT_TITLE/)).not.toBeOnTheScreen();
  await act(async () => pending.resolve(result(requestId, 'Résumé borné.')));
  expect(screen.getByText('Lecture confirmée')).toBeOnTheScreen();
});

test('backgrounding closes the transaction and never accepts a late receipt or resumes reading', async () => {
  const listeners: Array<(value: 'active' | 'background') => void> = [];
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      listeners.push(listener);
      return { remove: jest.fn() };
    });
  const pending = deferred<string>();
  native.generateCalendarToday.mockReturnValue(pending.promise);
  const user = await openChat();
  await user.press(screen.getByRole('button', { name: actionLabel }));
  const { requestId } = JSON.parse(
    native.generateCalendarToday.mock.calls[0][0],
  );
  await emitActivity(requestId, 1);
  await emitActivity(requestId, 2);
  await act(async () => listeners.forEach(listener => listener('background')));
  await emitActivity(requestId, 3);
  await act(async () => listeners.forEach(listener => listener('active')));
  await act(async () =>
    pending.resolve(result(requestId, 'STALE_PRIVATE_SUMMARY')),
  );
  expect(screen.getByText('Consultation interrompue')).toBeOnTheScreen();
  expect(screen.queryByText('Lecture confirmée')).not.toBeOnTheScreen();
  expect(screen.queryByText('STALE_PRIVATE_SUMMARY')).not.toBeOnTheScreen();
  expect(native.generateCalendarToday).toHaveBeenCalledTimes(1);
});

test('two calendar touches in the same frame submit only one native task', async () => {
  const pending = deferred<string>();
  native.generateCalendarToday.mockReturnValue(pending.promise);
  await openChat();
  const button = screen.getByRole('button', { name: actionLabel });
  await act(async () => {
    fireEvent.press(button);
    fireEvent.press(button);
  });
  expect(native.generateCalendarToday).toHaveBeenCalledTimes(1);
  const { requestId } = JSON.parse(
    native.generateCalendarToday.mock.calls[0][0],
  );
  await act(async () => pending.resolve(result(requestId, 'Résumé unique.')));
  expect(screen.getAllByText('Consulter aujourd’hui')).toHaveLength(1);
});

const toolsSwitch = 'Outils iOS dans la conversation';
const toolPreview = [{ label: 'Du', value: '2026-10-19T12:00:00Z' }];
function toolsResult(requestId: string, text = 'Lecture terminée.') {
  return JSON.stringify({
    ...JSON.parse(result(requestId, text, false)),
    agentTools: true,
  });
}
function toolReceipt(
  status: 'success' | 'outcome_unknown' = 'success',
  tool = 'calendar_list',
) {
  return {
    operationId: 'native-operation-1',
    tool,
    status,
    completedAt: '2026-10-18T12:00:00Z',
    summary: [
      {
        label: 'Résultat',
        value:
          status === 'success'
            ? 'Opération confirmée'
            : 'Vérification manuelle requise',
      },
    ],
  };
}
async function emitDeviceActivity(
  requestId: string,
  status: string,
  extra: Record<string, unknown> = {},
) {
  await act(async () =>
    deviceActivity({
      json: JSON.stringify({
        schemaVersion: 1,
        requestId,
        transaction: {
          id: 'native-operation-1',
          revision:
            status === 'awaiting_confirmation' ||
            status === 'awaiting_permission'
              ? 1
              : status === 'executing'
              ? 2
              : 3,
          tool: 'calendar_list',
          effect: 'read',
          title: 'Consulter le calendrier',
          status,
          preview: toolPreview,
          ...(status === 'awaiting_confirmation'
            ? { confirmationToken: 'native-confirmation-token' }
            : {}),
          ...(['success', 'outcome_unknown'].includes(status)
            ? { receipt: toolReceipt(status as 'success' | 'outcome_unknown') }
            : {}),
          ...extra,
        },
      }),
    }),
  );
}
async function openToolsChat() {
  native.getDeviceToolCapabilities.mockResolvedValue(
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: 1,
      tools: deviceToolNames,
      confirmation: 'all_accesses',
    }),
  );
  const user = await openChat();
  expect(
    await screen.findByRole('switch', { name: toolsSwitch, disabled: false }),
  ).toBeEnabled();
  await user.press(screen.getByRole('switch', { name: toolsSwitch }));
  return user;
}
async function sendToolTask(
  user: ReturnType<typeof userEvent.setup>,
  text = 'Qu’ai-je demain matin ?',
) {
  await user.type(screen.getByLabelText('Message'), text);
  await user.press(screen.getByRole('button', { name: 'Envoyer' }));
  return JSON.parse(native.generateWithTools.mock.calls[0][0])
    .requestId as string;
}

test('the generic catalogue is opt-in and ordinary chat never reads private data', async () => {
  native.getDeviceToolCapabilities.mockResolvedValue(
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: 1,
      tools: deviceToolNames,
      confirmation: 'all_accesses',
    }),
  );
  const user = await openChat();
  expect(
    screen.getByRole('switch', { name: toolsSwitch }).props.accessibilityState
      .checked,
  ).toBe(false);
  await user.type(screen.getByLabelText('Message'), 'Bonjour');
  await user.press(screen.getByRole('button', { name: 'Envoyer' }));
  expect(native.generate).toHaveBeenCalledTimes(1);
  expect(native.generateWithTools).not.toHaveBeenCalled();
  expect(native.confirmToolAction).not.toHaveBeenCalled();
  expect(native.listCalendarEvents).not.toHaveBeenCalled();
});

test('generic actions stay disabled on native27 or an incomplete catalogue', async () => {
  const user = await openChat();
  const toggle = screen.getByRole('switch', { name: toolsSwitch });
  expect(toggle).toBeDisabled();
  await user.press(toggle);
  expect(native.generateWithTools).not.toHaveBeenCalled();
});

test('a generic task uses fresh isolated context and does not leak raw planning to UI or TTS', async () => {
  const pending = deferred<string>();
  native.generateWithTools.mockReturnValue(pending.promise);
  const user = await openToolsChat();
  const requestId = await sendToolTask(user);
  expect(JSON.parse(native.generateWithTools.mock.calls[0][0])).toEqual({
    schemaVersion: 1,
    requestId,
    messages: [{ role: 'user', content: 'Qu’ai-je demain matin ?' }],
    maxTokens: expect.any(Number),
    temperature: 0,
  });
  await act(async () =>
    progress({ json: result(requestId, '<|tool_call>PRIVATE_PLAN', false) }),
  );
  expect(screen.queryByText(/PRIVATE_PLAN/)).not.toBeOnTheScreen();
  expect(native.beginSpeech).not.toHaveBeenCalled();
  expect(native.enqueueSpeech).not.toHaveBeenCalled();
  await act(async () => pending.resolve(toolsResult(requestId)));
  expect(screen.getByText('Lecture terminée.')).toBeOnTheScreen();
});

test('a native preview needs a tactile confirmation and double tap cannot confirm twice', async () => {
  const pending = deferred<string>();
  const acknowledgement = deferred<string>();
  native.generateWithTools.mockReturnValue(pending.promise);
  native.confirmToolAction.mockReturnValue(acknowledgement.promise);
  const user = await openToolsChat();
  const requestId = await sendToolTask(user);
  await emitDeviceActivity(requestId, 'awaiting_confirmation');
  const confirm = screen.getByRole('button', {
    name: 'Autoriser cette lecture',
  });
  expect(native.confirmToolAction).not.toHaveBeenCalled();
  expect(native.listCalendarEvents).not.toHaveBeenCalled();
  expect(screen.queryByText('native-confirmation-token')).not.toBeOnTheScreen();
  await act(async () => {
    fireEvent.press(confirm);
    fireEvent.press(confirm);
  });
  expect(native.confirmToolAction).toHaveBeenCalledTimes(1);
  expect(native.confirmToolAction).toHaveBeenCalledWith(
    'native-operation-1',
    'native-confirmation-token',
  );
  await act(async () =>
    acknowledgement.resolve('{"schemaVersion":1,"accepted":true}'),
  );
  await emitDeviceActivity(requestId, 'executing');
  expect(screen.getByText('Exécution en cours')).toBeOnTheScreen();
  await emitDeviceActivity(requestId, 'success');
  await act(async () => pending.resolve(toolsResult(requestId)));
  expect(screen.getByText('Résultat confirmé')).toBeOnTheScreen();
  expect(screen.getByText('Résultat : Opération confirmée')).toBeOnTheScreen();
  expect(native.listCalendarEvents).not.toHaveBeenCalled();
});

test('cancel before approval removes the live consent and ignores late native events/results', async () => {
  const pending = deferred<string>();
  native.generateWithTools.mockReturnValue(pending.promise);
  const user = await openToolsChat();
  const requestId = await sendToolTask(user);
  await emitDeviceActivity(requestId, 'awaiting_confirmation');
  await user.press(screen.getByRole('button', { name: 'Annuler l’action' }));
  await emitDeviceActivity(requestId, 'success');
  await act(async () =>
    pending.resolve(toolsResult(requestId, 'LATE_PRIVATE_ANSWER')),
  );
  expect(screen.getByText('Action interrompue')).toBeOnTheScreen();
  expect(screen.queryByText('LATE_PRIVATE_ANSWER')).not.toBeOnTheScreen();
  expect(screen.queryByText('Résultat confirmé')).not.toBeOnTheScreen();
  expect(native.confirmToolAction).not.toHaveBeenCalled();
});

test('a rejected or expired token never falls back to a low-level native action', async () => {
  const pending = deferred<string>();
  native.generateWithTools.mockReturnValue(pending.promise);
  native.confirmToolAction.mockResolvedValue(
    '{"schemaVersion":1,"accepted":false}',
  );
  const user = await openToolsChat();
  const requestId = await sendToolTask(user);
  await emitDeviceActivity(requestId, 'awaiting_confirmation');
  await user.press(
    screen.getByRole('button', { name: 'Autoriser cette lecture' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /Cette confirmation n’est plus valide/,
  );
  await act(async () => pending.resolve(toolsResult(requestId, 'IGNORED')));
  expect(native.generateWithTools).toHaveBeenCalledTimes(1);
  expect(native.listCalendarEvents).not.toHaveBeenCalled();
});

test('an unknown write cannot be represented as success by model prose', async () => {
  const pending = deferred<string>();
  native.generateWithTools.mockReturnValue(pending.promise);
  const user = await openToolsChat();
  const requestId = await sendToolTask(user, 'Crée un rappel');
  const write = {
    tool: 'reminder_create',
    effect: 'write',
    title: 'Créer un rappel',
  };
  await emitDeviceActivity(requestId, 'awaiting_confirmation', write);
  await user.press(
    screen.getByRole('button', { name: 'Confirmer cette modification' }),
  );
  await emitDeviceActivity(requestId, 'executing', write);
  await emitDeviceActivity(requestId, 'outcome_unknown', {
    ...write,
    receipt: toolReceipt('outcome_unknown', 'reminder_create'),
  });
  await act(async () =>
    pending.resolve(
      toolsResult(requestId, 'Le rappel est définitivement créé.'),
    ),
  );
  expect(screen.getByText('Vérification requise')).toBeOnTheScreen();
  expect(
    screen.queryByText('Le rappel est définitivement créé.'),
  ).not.toBeOnTheScreen();
  expect(
    screen.getByText(/^L’action a peut-être eu lieu, mais son résultat/),
  ).toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: /Réessayer/ }),
  ).not.toBeOnTheScreen();
});

test('a prior unknown operation is visible after restart without repeating it', async () => {
  native.getToolOperations.mockResolvedValue(
    JSON.stringify({
      schemaVersion: 1,
      operations: [toolReceipt('outcome_unknown', 'reminder_create')],
    }),
  );
  await openToolsChat();
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /Une action antérieure reste à vérifier/,
  );
  expect(native.generateWithTools).not.toHaveBeenCalled();
  expect(native.confirmToolAction).not.toHaveBeenCalled();
});

test('permission management is separate and cannot resume the old tool task', async () => {
  const pending = deferred<string>();
  native.generateWithTools.mockReturnValue(pending.promise);
  native.requestDeviceCapability.mockResolvedValue(
    '{"capability":"calendar","status":"authorized"}',
  );
  const user = await openToolsChat();
  const requestId = await sendToolTask(user);
  await emitDeviceActivity(requestId, 'awaiting_permission', {
    capability: 'calendar',
    preview: [],
  });
  expect(native.requestDeviceCapability).not.toHaveBeenCalled();
  await user.press(screen.getByRole('button', { name: 'Gérer cet accès iOS' }));
  expect(native.cancel).toHaveBeenCalledTimes(1);
  expect(native.requestDeviceCapability).toHaveBeenCalledWith('calendar');
  await act(async () =>
    pending.resolve(toolsResult(requestId, 'STALE_AFTER_PERMISSION')),
  );
  expect(screen.queryByText('STALE_AFTER_PERMISSION')).not.toBeOnTheScreen();
  expect(screen.getByRole('alert')).toHaveTextContent(
    /rien n’a été relancé automatiquement/,
  );
  expect(native.generateWithTools).toHaveBeenCalledTimes(1);
  expect(native.confirmToolAction).not.toHaveBeenCalled();
});

test('permission management fails closed without a native cancellation acknowledgement', async () => {
  const pending = deferred<string>();
  native.generateWithTools.mockReturnValue(pending.promise);
  native.cancel.mockRejectedValue(new Error('CANCEL_FAILED'));
  const user = await openToolsChat();
  const requestId = await sendToolTask(user);
  await emitDeviceActivity(requestId, 'awaiting_permission', {
    capability: 'calendar',
    preview: [],
  });
  await user.press(screen.getByRole('button', { name: 'Gérer cet accès iOS' }));
  expect(native.requestDeviceCapability).not.toHaveBeenCalled();
  await act(async () => pending.resolve(toolsResult(requestId)));
});

test('background invalidates a generic preview and reactivation never submits it', async () => {
  const listeners: Array<(value: 'active' | 'background') => void> = [];
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      listeners.push(listener);
      return { remove: jest.fn() };
    });
  const pending = deferred<string>();
  native.generateWithTools.mockReturnValue(pending.promise);
  const user = await openToolsChat();
  const requestId = await sendToolTask(user);
  await emitDeviceActivity(requestId, 'awaiting_confirmation');
  await act(async () => listeners.forEach(listener => listener('background')));
  await act(async () => listeners.forEach(listener => listener('active')));
  await emitDeviceActivity(requestId, 'success');
  await act(async () =>
    pending.resolve(toolsResult(requestId, 'STALE_AFTER_BACKGROUND')),
  );
  expect(screen.queryByText('STALE_AFTER_BACKGROUND')).not.toBeOnTheScreen();
  expect(
    screen.queryByRole('button', { name: 'Autoriser cette lecture' }),
  ).not.toBeOnTheScreen();
  expect(native.confirmToolAction).not.toHaveBeenCalled();
});

test('tool-derived private data stays out of the next ordinary chat history', async () => {
  native.generateWithTools.mockImplementation(async json =>
    toolsResult(JSON.parse(json).requestId, 'PRIVATE_TOOL_ANSWER'),
  );
  const user = await openToolsChat();
  await sendToolTask(user, 'PRIVATE_USER_TOOL_REQUEST');
  await user.press(screen.getByRole('switch', { name: toolsSwitch }));
  await user.type(screen.getByLabelText('Message'), 'Question ordinaire');
  await user.press(screen.getByRole('button', { name: 'Envoyer' }));
  expect(JSON.parse(native.generate.mock.calls[0][0]).messages).toEqual([
    { role: 'user', content: 'Question ordinaire' },
  ]);
});

test('a partial speech transcription never calls any of the thirteen tools', async () => {
  const user = await openToolsChat();
  await user.press(screen.getByRole('button', { name: 'Mode vocal' }));
  const id = native.startListening.mock.calls[0][0];
  await act(async () =>
    voiceEvent({
      json: JSON.stringify({
        sessionId: id,
        kind: 'transcript',
        phase: 'listening',
        text: 'Lis le texte de ma photo',
        isFinal: false,
      }),
    }),
  );
  expect(native.generateWithTools).not.toHaveBeenCalled();
  expect(native.confirmToolAction).not.toHaveBeenCalled();
  expect(native.requestDeviceCapability).not.toHaveBeenCalled();
});

test('a photo tool waits for the real consent modal dismissal before native confirmation', async () => {
  const pending = deferred<string>();
  native.generateWithTools.mockReturnValue(pending.promise);
  const user = await openToolsChat();
  const requestId = await sendToolTask(user, 'Lis le texte de ma photo');
  const photo = {
    tool: 'photo_select',
    effect: 'interactive',
    title: 'Choisir une photo',
  };
  await emitDeviceActivity(requestId, 'awaiting_confirmation', photo);
  const modal = screen
    .UNSAFE_getAllByType(Modal)
    .find(item => item.props.visible);
  expect(modal).toBeDefined();
  await user.press(screen.getByRole('button', { name: 'Continuer dans iOS' }));
  expect(native.confirmToolAction).not.toHaveBeenCalled();
  await act(async () => modal!.props.onDismiss());
  expect(native.confirmToolAction).toHaveBeenCalledTimes(1);
  await emitDeviceActivity(requestId, 'executing', photo);
  await emitDeviceActivity(requestId, 'success', {
    ...photo,
    receipt: toolReceipt('success', 'photo_select'),
  });
  await act(async () =>
    pending.resolve(toolsResult(requestId, 'Texte OCR extrait.')),
  );
  expect(screen.getByText('Texte OCR extrait.')).toBeOnTheScreen();
});

test('background during photo modal dismissal cannot consume the confirmation token', async () => {
  const listeners: Array<(value: 'active' | 'background') => void> = [];
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      listeners.push(listener);
      return { remove: jest.fn() };
    });
  const pending = deferred<string>();
  native.generateWithTools.mockReturnValue(pending.promise);
  const user = await openToolsChat();
  const requestId = await sendToolTask(user, 'Lis cette photo');
  await emitDeviceActivity(requestId, 'awaiting_confirmation', {
    tool: 'photo_select',
    effect: 'interactive',
    title: 'Choisir une photo',
  });
  const modal = screen
    .UNSAFE_getAllByType(Modal)
    .find(item => item.props.visible)!;
  await user.press(screen.getByRole('button', { name: 'Continuer dans iOS' }));
  await act(async () => listeners.forEach(listener => listener('background')));
  await act(async () => modal.props.onDismiss());
  await act(async () =>
    pending.resolve(toolsResult(requestId, 'STALE_PHOTO_OCR')),
  );
  expect(native.confirmToolAction).not.toHaveBeenCalled();
  expect(screen.queryByText('STALE_PHOTO_OCR')).not.toBeOnTheScreen();
});

test('a finalized voice turn uses the same consent and speaks only the validated final tool answer', async () => {
  const pending = deferred<string>();
  native.generateWithTools.mockReturnValue(pending.promise);
  native.speak.mockResolvedValue(voiceState.replace('idle', 'speaking'));
  const user = await openToolsChat();
  await user.press(screen.getByRole('button', { name: 'Mode vocal' }));
  const id = native.startListening.mock.calls[0][0];
  await act(async () =>
    voiceEvent({
      json: JSON.stringify({
        sessionId: id,
        kind: 'transcript',
        phase: 'idle',
        text: 'Qu’ai-je demain matin ?',
        isFinal: true,
      }),
    }),
  );
  expect(native.generateWithTools).toHaveBeenCalledTimes(1);
  const { requestId } = JSON.parse(native.generateWithTools.mock.calls[0][0]);
  await act(async () =>
    progress({
      json: result(requestId, '<|tool_call>PRIVATE_VOICE_PLAN', false),
    }),
  );
  await emitDeviceActivity(requestId, 'awaiting_confirmation');
  expect(
    screen.getByRole('button', { name: 'Autoriser cette lecture' }),
  ).toBeEnabled();
  expect(native.speak).not.toHaveBeenCalled();
  expect(native.beginSpeech).not.toHaveBeenCalled();
  expect(native.enqueueSpeech).not.toHaveBeenCalled();
  await user.press(
    screen.getByRole('button', { name: 'Autoriser cette lecture' }),
  );
  await emitDeviceActivity(requestId, 'executing');
  await emitDeviceActivity(requestId, 'success');
  await act(async () =>
    pending.resolve(toolsResult(requestId, 'Voici les événements retournés.')),
  );
  expect(native.speak).toHaveBeenCalledWith(
    'Voici les événements retournés.',
    requestId,
  );
  expect(native.confirmToolAction).toHaveBeenCalledTimes(1);
  expect(native.generate).not.toHaveBeenCalled();
});
