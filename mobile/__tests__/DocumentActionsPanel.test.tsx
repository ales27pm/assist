import React, { act } from 'react';
import { Alert, AppState, AppStateStatus, Platform } from 'react-native';
import {
  fireEventAsync,
  renderAsync,
  screen,
  waitFor,
} from '@testing-library/react-native';
import NativeAssist from '../specs/NativeAssist';
import { DocumentActionsPanel } from '../src/DocumentActionsPanel';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    getDocumentInbox: jest.fn(),
    executeDocumentAction: jest.fn(),
    cancelDocumentActions: jest.fn(),
  },
}));
const native = jest.mocked(
  NativeAssist as unknown as {
    getDocumentInbox(): Promise<string>;
    executeDocumentAction(json: string): Promise<string>;
    cancelDocumentActions(): Promise<string>;
  },
);
const id = '20123456-1234-4234-8234-123456789012';
let lifecycle: (state: AppStateStatus) => void;
let alertButtons: Parameters<typeof Alert.alert>[2];
const descriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState')!;
beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'ios';
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: 'active',
  });
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_name, callback) => {
      lifecycle = callback;
      return { remove: jest.fn() };
    });
  jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
    alertButtons = buttons;
  });
  native.getDocumentInbox.mockResolvedValue(
    JSON.stringify({
      schemaVersion: 1,
      items: [
        {
          schemaVersion: 1,
          id,
          kind: 'pdf',
          source: 'picker',
          byteCount: 100,
          createdAt: '2026-10-19T12:00:00Z',
        },
      ],
    }),
  );
  native.cancelDocumentActions.mockResolvedValue('{}');
  native.executeDocumentAction.mockImplementation(async json => {
    const request = JSON.parse(json);
    return JSON.stringify({
      schemaVersion: 1,
      requestId: request.requestId,
      action: request.action,
      status: 'cancelled',
    });
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  Object.defineProperty(AppState, 'currentState', descriptor);
});
async function choose() {
  await fireEventAsync.press(
    screen.getByText('Actualiser les documents Assist'),
  );
  await fireEventAsync.press(screen.getByText('Choisir le document 1'));
}
test('does not scan, send or index merely by mounting', async () => {
  await renderAsync(
    <DocumentActionsPanel blocked={false} onClose={() => {}} />,
  );
  expect(native.executeDocumentAction).not.toHaveBeenCalled();
  await fireEventAsync.press(screen.getByText('Scanner un document'));
  expect(
    JSON.parse(native.executeDocumentAction.mock.calls[0][0]),
  ).toMatchObject({ action: 'scan', maxPages: 8 });
});
test('freezes and confirms the exact indexing choice once', async () => {
  await renderAsync(
    <DocumentActionsPanel blocked={false} onClose={() => {}} />,
  );
  await choose();
  await fireEventAsync.changeText(
    screen.getByLabelText('Titre du document dans Spotlight'),
    'Facture choisie',
  );
  await fireEventAsync.press(
    screen.getByText('Indexer le document choisi pour 1 jour'),
  );
  expect(native.executeDocumentAction).not.toHaveBeenCalled();
  expect(Alert.alert).toHaveBeenCalledWith(
    expect.any(String),
    expect.stringContaining('Facture choisie'),
    expect.any(Array),
    expect.any(Object),
  );
  const confirm = alertButtons!.find(button => button.text === 'Confirmer')!
    .onPress!;
  await act(async () => {
    confirm();
    confirm();
  });
  expect(native.executeDocumentAction).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(native.executeDocumentAction.mock.calls[0][0]),
  ).toMatchObject({
    action: 'index',
    inboxId: id,
    title: 'Facture choisie',
    expirationDays: 1,
  });
});
test('backgrounding revokes an unconsumed confirmation', async () => {
  await renderAsync(
    <DocumentActionsPanel blocked={false} onClose={() => {}} />,
  );
  await choose();
  await fireEventAsync.press(
    screen.getByText('Indexer le document choisi pour 1 jour'),
  );
  const confirm = alertButtons!.find(button => button.text === 'Confirmer')!
    .onPress!;
  await act(async () => {
    lifecycle('background');
    lifecycle('active');
    confirm();
  });
  expect(native.executeDocumentAction).not.toHaveBeenCalled();
});
test('requires exact compose preview before opening Apple UI', async () => {
  await renderAsync(
    <DocumentActionsPanel blocked={false} onClose={() => {}} />,
  );
  await fireEventAsync.changeText(
    screen.getByLabelText('Destinataires séparés par des virgules'),
    'alexis@example.com',
  );
  await fireEventAsync.changeText(
    screen.getByLabelText('Objet du courriel'),
    'Objet exact',
  );
  await fireEventAsync.changeText(
    screen.getByLabelText('Texte du message'),
    'Texte exact',
  );
  await fireEventAsync.press(
    screen.getByText('Revoir puis ouvrir le composeur Apple'),
  );
  expect(native.executeDocumentAction).not.toHaveBeenCalled();
  expect(Alert.alert).toHaveBeenCalledWith(
    expect.any(String),
    expect.stringContaining('alexis@example.com'),
    expect.any(Array),
    expect.any(Object),
  );
  await act(async () =>
    alertButtons!.find(button => button.text === 'Confirmer')!.onPress!(),
  );
  expect(
    JSON.parse(native.executeDocumentAction.mock.calls[0][0]),
  ).toMatchObject({
    channel: 'email',
    recipients: ['alexis@example.com'],
    subject: 'Objet exact',
    body: 'Texte exact',
  });
});
test('rejects a late scan result after background cancellation', async () => {
  let resolve!: (json: string) => void;
  native.executeDocumentAction.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  await renderAsync(
    <DocumentActionsPanel blocked={false} onClose={() => {}} />,
  );
  await fireEventAsync.press(screen.getByText('Scanner un document'));
  const request = JSON.parse(native.executeDocumentAction.mock.calls[0][0]);
  await act(async () => {
    lifecycle('background');
  });
  await waitFor(() =>
    expect(native.cancelDocumentActions).toHaveBeenCalledTimes(1),
  );
  await act(async () => {
    resolve(
      JSON.stringify({
        schemaVersion: 1,
        requestId: request.requestId,
        action: 'scan',
        status: 'scanned',
        inboxId: id,
        pageCount: 1,
        byteCount: 100,
        text: 'Late OCR',
        method: 'vision_ocr',
        truncated: false,
        untrusted: true,
        documentState: 'text',
      }),
    );
  });
  expect(screen.queryByText('Late OCR')).toBeNull();
});
