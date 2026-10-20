import React, { act } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import {
  fireEventAsync,
  renderAsync,
  screen,
  waitFor,
} from '@testing-library/react-native';
import NativeAssist from '../specs/NativeAssist';
import { AlarmPanel } from '../src/AlarmPanel';
jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: { executeAlarms: jest.fn(), cancelAlarms: jest.fn() },
}));
const native = NativeAssist as unknown as {
  executeAlarms: jest.Mock;
  cancelAlarms: jest.Mock;
};
let lifecycle: (state: AppStateStatus) => void;
const originalState = Object.getOwnPropertyDescriptor(
  AppState,
  'currentState',
)!;
function response(raw: string) {
  const request = JSON.parse(raw);
  return JSON.stringify({
    schemaVersion: 1,
    requestId: request.requestId,
    operationId: request.operationId,
    action: request.action,
    status: 'succeeded',
    code: 'ok',
    items:
      request.action === 'list'
        ? []
        : [
            {
              alarm_id: request.alarm_id,
              kind: request.kind,
              title: request.title,
              duration_seconds: request.duration_seconds,
              state: 'countdown',
              uncertain: false,
            },
          ],
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.replaceProperty(Platform, 'OS', 'ios');
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: 'active',
  });
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      lifecycle = listener;
      return { remove: jest.fn() };
    });
  native.executeAlarms.mockImplementation(async raw => response(raw));
  native.cancelAlarms.mockResolvedValue('{}');
});
afterEach(() => {
  jest.restoreAllMocks();
  Object.defineProperty(AppState, 'currentState', originalState);
});
test('mount does not contact AlarmKit or request authorization', async () => {
  await renderAsync(<AlarmPanel onClose={jest.fn()} blocked={false} />);
  expect(native.executeAlarms).not.toHaveBeenCalled();
});
test('mutation requires exact preview then confirmation', async () => {
  await renderAsync(<AlarmPanel onClose={jest.fn()} blocked={false} />);
  await fireEventAsync.press(
    screen.getByRole('button', { name: 'Préparer la création' }),
  );
  expect(native.executeAlarms).not.toHaveBeenCalled();
  expect(screen.getByText(/300 secondes à partir/)).toBeTruthy();
  await fireEventAsync.press(
    screen.getByRole('button', { name: 'Confirmer l’action' }),
  );
  await waitFor(() => expect(native.executeAlarms).toHaveBeenCalledTimes(1));
  const request = JSON.parse(native.executeAlarms.mock.calls[0][0]);
  expect(request.alarm_id).toBe(request.operationId);
  expect(request.duration_seconds).toBe(300);
  expect(screen.getByText('Action confirmée par AlarmKit.')).toBeTruthy();
});
test('abandoning a preview submits nothing', async () => {
  await renderAsync(<AlarmPanel onClose={jest.fn()} blocked={false} />);
  await fireEventAsync.press(
    screen.getByRole('button', { name: 'Préparer la création' }),
  );
  await fireEventAsync.press(
    screen.getByRole('button', { name: 'Annuler la préparation' }),
  );
  expect(native.executeAlarms).not.toHaveBeenCalled();
});
test('uncertain result remains visible and is never automatically retried', async () => {
  native.executeAlarms.mockImplementation(async raw =>
    JSON.stringify({
      ...JSON.parse(response(raw)),
      status: 'outcome_unknown',
      code: 'outcome_unknown',
    }),
  );
  await renderAsync(<AlarmPanel onClose={jest.fn()} blocked={false} />);
  await fireEventAsync.press(
    screen.getByRole('button', { name: 'Préparer la création' }),
  );
  await fireEventAsync.press(
    screen.getByRole('button', { name: 'Confirmer l’action' }),
  );
  expect(screen.getByText(/Résultat incertain/)).toBeTruthy();
  expect(native.executeAlarms).toHaveBeenCalledTimes(1);
});
test('background fences a late successful response and asks native to stop', async () => {
  let finish!: (raw: string) => void;
  let request = '';
  native.executeAlarms.mockImplementation(raw => {
    request = raw;
    return new Promise(resolve => {
      finish = resolve;
    });
  });
  await renderAsync(<AlarmPanel onClose={jest.fn()} blocked={false} />);
  await fireEventAsync.press(
    screen.getByRole('button', { name: 'Préparer la création' }),
  );
  await fireEventAsync.press(
    screen.getByRole('button', { name: 'Confirmer l’action' }),
  );
  await act(async () => {
    lifecycle('background');
  });
  expect(native.cancelAlarms).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish(response(request));
  });
  expect(screen.queryByText('Action confirmée par AlarmKit.')).toBeNull();
  expect(screen.getByText(/Action interrompue/)).toBeTruthy();
});
