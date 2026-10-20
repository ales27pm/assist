import React, { act } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import {
  fireEventAsync,
  renderAsync,
  screen,
} from '@testing-library/react-native';
import NativeAssist from '../specs/NativeAssist';
import { TranslationPanel } from '../src/TranslationPanel';
import { TranslationRequest } from '../src/translationProtocol';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: { executeTranslation: jest.fn(), cancelTranslation: jest.fn() },
}));
const native = NativeAssist as unknown as {
  executeTranslation: jest.Mock<Promise<string>, [string]>;
  cancelTranslation: jest.Mock<Promise<string>, []>;
};
let lifecycle: (state: AppStateStatus) => void;
const originalState = Object.getOwnPropertyDescriptor(
  AppState,
  'currentState',
)!;
function result(request: TranslationRequest, translatedText = 'Hello world.') {
  return JSON.stringify({
    schemaVersion: 1,
    requestId: request.requestId,
    action: 'translate',
    sourceLanguage: request.source_language || 'fr',
    targetLanguage: request.target_language,
    sourceDetected: request.source_language === '',
    translatedText,
    status: 'installed',
    localOnly: true,
    untrusted: true,
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  native.executeTranslation.mockReset();
  native.cancelTranslation.mockReset();
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
  native.cancelTranslation.mockResolvedValue(
    '{"schemaVersion":1,"cancelled":true}',
  );
  native.executeTranslation.mockImplementation(async json =>
    result(JSON.parse(json) as TranslationRequest),
  );
});
afterEach(() => {
  jest.restoreAllMocks();
  Object.defineProperty(AppState, 'currentState', originalState);
});
async function fill() {
  await fireEventAsync(
    screen.getByLabelText('Texte à traduire'),
    'changeText',
    'Bonjour le monde.',
  );
}
async function translate() {
  await fireEventAsync.press(
    screen.getByRole('button', {
      name: 'Traduire avec les langues installées',
    }),
  );
}

test('mount performs no translation, download, availability check or native work', async () => {
  await renderAsync(<TranslationPanel blocked={false} />);
  expect(native.executeTranslation).not.toHaveBeenCalled();
  expect(native.cancelTranslation).not.toHaveBeenCalled();
});
test('explicit translation uses installed-only mode and validates the receipt', async () => {
  await renderAsync(<TranslationPanel blocked={false} />);
  await fill();
  await translate();
  expect(JSON.parse(native.executeTranslation.mock.calls[0][0])).toMatchObject({
    action: 'translate',
    source_language: '',
    target_language: 'en',
    allow_download: false,
    text: 'Bonjour le monde.',
  });
  expect(screen.getByText('Hello world.')).toBeOnTheScreen();
});
test('only the separate tactile action authorizes a model download', async () => {
  await renderAsync(<TranslationPanel blocked={false} />);
  await fill();
  await fireEventAsync.press(
    screen.getByRole('button', {
      name: 'Autoriser le téléchargement et traduire',
    }),
  );
  expect(
    JSON.parse(native.executeTranslation.mock.calls[0][0]).allow_download,
  ).toBe(true);
});
test('availability reads dynamic languages without authorizing downloads or translating text', async () => {
  native.executeTranslation.mockImplementation(async json => {
    const request = JSON.parse(json) as TranslationRequest;
    return JSON.stringify({
      schemaVersion: 1,
      requestId: request.requestId,
      action: 'availability',
      sourceLanguage: '',
      targetLanguage: 'en',
      languages: [{ identifier: 'fr', label: 'Français' }],
      status: 'not_checked',
      localOnly: true,
      untrusted: true,
    });
  });
  await renderAsync(<TranslationPanel blocked={false} />);
  await fireEventAsync.press(
    screen.getByRole('button', { name: 'Vérifier les langues' }),
  );
  const request = JSON.parse(native.executeTranslation.mock.calls[0][0]);
  expect(request).toMatchObject({
    action: 'availability',
    allow_download: false,
  });
  expect(request.text).toBeUndefined();
  expect(screen.getByText('Français (fr)')).toBeOnTheScreen();
});
test('invalid, oversized or marker-bearing text never reaches native', async () => {
  await renderAsync(<TranslationPanel blocked={false} />);
  for (const text of ['é'.repeat(4097), '<|tool_call>']) {
    await fireEventAsync(
      screen.getByLabelText('Texte à traduire'),
      'changeText',
      text,
    );
    await translate();
  }
  expect(native.executeTranslation).not.toHaveBeenCalled();
});
test('background cancels, clears private input and rejects a late translated result without automatic restart', async () => {
  let resolve!: (value: string) => void;
  let request!: TranslationRequest;
  native.executeTranslation.mockImplementation(json => {
    request = JSON.parse(json) as TranslationRequest;
    return new Promise(done => {
      resolve = done;
    });
  });
  await renderAsync(<TranslationPanel blocked={false} />);
  await fill();
  await translate();
  await act(async () => {
    lifecycle('inactive');
  });
  expect(native.cancelTranslation).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Texte à traduire').props.value).toBe('');
  await act(async () => {
    resolve(result(request, 'LATE PRIVATE RESULT'));
  });
  expect(screen.queryByText('LATE PRIVATE RESULT')).not.toBeOnTheScreen();
  await act(async () => {
    lifecycle('active');
  });
  expect(native.executeTranslation).toHaveBeenCalledTimes(1);
});
test('failed cancellation blocks a second request until an exact cancellation receipt', async () => {
  native.executeTranslation.mockImplementation(() => new Promise(() => {}));
  native.cancelTranslation.mockRejectedValueOnce(new Error('bridge failure'));
  await renderAsync(<TranslationPanel blocked={false} />);
  await fill();
  await translate();
  await fireEventAsync.press(
    screen.getByRole('button', { name: 'Interrompre la traduction' }),
  );
  expect(
    screen.getByRole('button', {
      name: 'Traduire avec les langues installées',
    }),
  ).toBeDisabled();
  await fireEventAsync.press(
    screen.getByRole('button', { name: 'Interrompre la traduction' }),
  );
  expect(
    screen.getByRole('button', {
      name: 'Traduire avec les langues installées',
    }),
  ).not.toBeDisabled();
});
test('replaced target invalidates a prior result and a foreign receipt is rejected', async () => {
  await renderAsync(<TranslationPanel blocked={false} />);
  await fill();
  await translate();
  await fireEventAsync(
    screen.getByLabelText('Langue cible'),
    'changeText',
    'es',
  );
  expect(screen.queryByText('Hello world.')).not.toBeOnTheScreen();
  native.executeTranslation.mockImplementation(async json =>
    result({ ...JSON.parse(json), requestId: 'foreign-request' }),
  );
  await translate();
  expect(screen.queryByText('Hello world.')).not.toBeOnTheScreen();
  expect(screen.getByRole('alert')).toBeOnTheScreen();
});
test('blocked panel cannot start and closing a pending panel cancels', async () => {
  const close = jest.fn();
  const rendered = await renderAsync(
    <TranslationPanel blocked onClose={close} />,
  );
  expect(
    screen.getByRole('button', { name: 'Vérifier les langues' }),
  ).toBeDisabled();
  await rendered.rerenderAsync(
    <TranslationPanel blocked={false} onClose={close} />,
  );
  native.executeTranslation.mockImplementation(() => new Promise(() => {}));
  await fill();
  await translate();
  await fireEventAsync.press(
    screen.getByRole('button', { name: 'Retour aux réglages' }),
  );
  expect(close).toHaveBeenCalledTimes(1);
  expect(native.cancelTranslation).toHaveBeenCalledTimes(1);
});
