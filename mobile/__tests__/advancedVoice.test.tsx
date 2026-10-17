import { act, renderHookAsync } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { AppStateStatus } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { parseAdvancedVoiceState } from '../src/advancedVoice';
import { useAdvancedVoice } from '../src/useAdvancedVoice';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    getAdvancedVoiceState: jest.fn(),
    importAdvancedVoicePack: jest.fn(),
    setAdvancedVoiceBackend: jest.fn(),
    importAdvancedVoiceReference: jest.fn(),
    removeAdvancedVoiceReference: jest.fn(),
    startListening: jest.fn(),
  },
}));
const native = jest.mocked(NativeAssist!);
const empty = {
  schemaVersion: 1,
  revision: 0,
  selectedBackend: 'apple',
  selectedVariant: 'redux',
  effectiveBackend: 'apple',
  ready: false,
  resources: { pocket: false, redux: false, ultra: false, silero: false },
  reference: { ready: false },
};
const complete = {
  ...empty,
  revision: 1,
  ready: true,
  resources: { pocket: true, redux: true, ultra: true, silero: true },
  reference: { ready: true, speakerName: 'Personne autorisée' },
};
const json = (value = empty) => JSON.stringify(value);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
let lifecycle: (state: AppStateStatus) => void;
beforeEach(() => {
  jest.resetAllMocks();
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: 'active',
  });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
    lifecycle = listener;
    return { remove: jest.fn() };
  });
  native.getAdvancedVoiceState.mockResolvedValue(json());
  native.importAdvancedVoicePack.mockResolvedValue(json(complete));
  native.importAdvancedVoiceReference.mockResolvedValue(json(complete));
  native.removeAdvancedVoiceReference.mockResolvedValue(json());
  native.setAdvancedVoiceBackend.mockImplementation(async (backend, variant) =>
    json({
      ...complete,
      selectedBackend: backend,
      selectedVariant: variant,
      effectiveBackend: backend,
    }),
  );
});
afterEach(() => jest.restoreAllMocks());

test('opening reads bounded state without starting capture or importing anything', async () => {
  const { result } = await renderHookAsync(useAdvancedVoice);
  expect(result.current.state).toEqual(empty);
  expect(result.current.loading).toBe(false);
  expect(native.startListening).not.toHaveBeenCalled();
  expect(native.importAdvancedVoicePack).not.toHaveBeenCalled();
  expect(native.importAdvancedVoiceReference).not.toHaveBeenCalled();
  expect(native.setAdvancedVoiceBackend).not.toHaveBeenCalled();
});

test('a late initial read cannot overwrite an acknowledged backend choice', async () => {
  const initial = deferred<string>();
  native.getAdvancedVoiceState.mockReturnValueOnce(initial.promise);
  const { result } = await renderHookAsync(useAdvancedVoice);
  await act(async () =>
    expect(await result.current.setBackend('fluid', 'ultra')).toBe(true),
  );
  await act(async () => initial.resolve(json()));
  expect(result.current.state?.selectedBackend).toBe('fluid');
  expect(result.current.state?.selectedVariant).toBe('ultra');
  expect(result.current.state?.effectiveBackend).toBe('fluid');
});

test('pack import stays busy until terminal acknowledgement and blocks parallel mutations', async () => {
  const importing = deferred<string>();
  native.importAdvancedVoicePack.mockReturnValueOnce(importing.promise);
  const { result } = await renderHookAsync(useAdvancedVoice);
  let imported!: Promise<boolean>;
  await act(async () => {
    imported = result.current.importPack();
  });
  expect(result.current.busy).toBe(true);
  expect(result.current.state?.resources.pocket).toBe(false);
  await act(async () => {
    expect(await result.current.setBackend('apple', 'redux')).toBe(false);
    expect(await result.current.removeReference()).toBe(false);
    await result.current.refresh();
  });
  expect(native.setAdvancedVoiceBackend).not.toHaveBeenCalled();
  expect(native.removeAdvancedVoiceReference).not.toHaveBeenCalled();
  expect(native.getAdvancedVoiceState).toHaveBeenCalledTimes(1);
  await act(async () => {
    importing.resolve(json(complete));
    expect(await imported).toBe(true);
  });
  expect(result.current.busy).toBe(false);
  expect(result.current.state?.resources.pocket).toBe(true);
});

test.each(['rejected', 'mismatched', 'malformed'] as const)(
  'a %s backend acknowledgement preserves the previous confirmed choice',
  async failure => {
    if (failure === 'rejected')
      native.setAdvancedVoiceBackend.mockRejectedValueOnce(
        new Error('Modèles absents.'),
      );
    else
      native.setAdvancedVoiceBackend.mockResolvedValueOnce(
        failure === 'mismatched' ? json() : '{}',
      );
    const { result } = await renderHookAsync(useAdvancedVoice);
    await act(async () =>
      expect(await result.current.setBackend('fluid', 'redux')).toBe(false),
    );
    expect(result.current.state?.selectedBackend).toBe('apple');
    expect(result.current.error).not.toBe('');
    expect(result.current.busy).toBe(false);
  },
);

test('a failed import preserves installed resources and can be retried', async () => {
  native.getAdvancedVoiceState.mockResolvedValueOnce(json(complete));
  native.importAdvancedVoicePack.mockRejectedValueOnce(
    new Error('Vérification du pack échouée.'),
  );
  const { result } = await renderHookAsync(useAdvancedVoice);
  await act(async () => expect(await result.current.importPack()).toBe(false));
  expect(result.current.state?.resources).toEqual(complete.resources);
  expect(result.current.error).toContain('Vérification');
  await act(async () => expect(await result.current.importPack()).toBe(true));
  expect(result.current.error).toBe('');
});

test('consent is explicit and only the trimmed label and confirmation cross the native boundary', async () => {
  const { result } = await renderHookAsync(useAdvancedVoice);
  await act(async () => {
    expect(await result.current.importReference('Personne', false)).toBe(false);
    expect(await result.current.importReference(' ', true)).toBe(false);
    expect(await result.current.importReference('x'.repeat(121), true)).toBe(
      false,
    );
  });
  expect(native.importAdvancedVoiceReference).not.toHaveBeenCalled();
  await act(async () =>
    expect(await result.current.importReference('  Personne  ', true)).toBe(
      true,
    ),
  );
  expect(native.importAdvancedVoiceReference).toHaveBeenCalledWith(
    JSON.stringify({ speakerName: 'Personne', consentConfirmed: true }),
  );
  expect(result.current.state?.reference.ready).toBe(true);
});

test('an older native revision cannot replace a newer confirmed inventory', async () => {
  native.getAdvancedVoiceState.mockResolvedValueOnce(
    json({ ...complete, revision: 4 }),
  );
  const { result } = await renderHookAsync(useAdvancedVoice);
  await act(async () => result.current.refresh());
  expect(result.current.state?.revision).toBe(4);
  expect(result.current.state?.reference.ready).toBe(true);
});

test('returning from a lifecycle interruption re-reads committed native state instead of applying the old import ACK', async () => {
  const importing = deferred<string>();
  native.importAdvancedVoicePack.mockReturnValueOnce(importing.promise);
  const { result } = await renderHookAsync(useAdvancedVoice);
  let imported!: Promise<boolean>;
  await act(async () => {
    imported = result.current.importPack();
  });
  native.getAdvancedVoiceState.mockResolvedValueOnce(
    json({ ...complete, revision: 3 }),
  );
  await act(async () => {
    lifecycle('background');
    lifecycle('active');
  });
  await act(async () => {
    importing.resolve(json(complete));
    expect(await imported).toBe(false);
  });
  expect(result.current.state?.revision).toBe(3);
  expect(result.current.busy).toBe(false);
});

test('an import finishing after unmount neither renders nor starts any other operation', async () => {
  const importing = deferred<string>();
  native.importAdvancedVoicePack.mockReturnValueOnce(importing.promise);
  let renders = 0;
  const { result, unmountAsync } = await renderHookAsync(() => {
    ++renders;
    return useAdvancedVoice();
  });
  let imported!: Promise<boolean>;
  await act(async () => {
    imported = result.current.importPack();
  });
  await unmountAsync();
  const before = renders;
  importing.resolve(json(complete));
  expect(await imported).toBe(false);
  expect(renders).toBe(before);
  expect(native.getAdvancedVoiceState).toHaveBeenCalledTimes(1);
  expect(native.startListening).not.toHaveBeenCalled();
});

test('missing new APIs leaves older builds readable and makes no unsupported call', async () => {
  const original = native.importAdvancedVoicePack;
  Object.defineProperty(native, 'importAdvancedVoicePack', {
    configurable: true,
    value: undefined,
  });
  try {
    const { result } = await renderHookAsync(useAdvancedVoice);
    expect(result.current.supported).toBe(false);
    expect(result.current.error).toContain('version compatible');
    await act(async () =>
      expect(await result.current.importPack()).toBe(false),
    );
    expect(native.getAdvancedVoiceState).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(native, 'importAdvancedVoicePack', {
      configurable: true,
      value: original,
    });
  }
});

test('parser strips private or unexpected data from resource and reference metadata', () => {
  expect(
    parseAdvancedVoiceState(
      JSON.stringify({
        ...complete,
        path: '/private/audio.wav',
        audio: 'secret',
        reference: { ...complete.reference, consentDocument: 'private' },
        resources: { ...complete.resources, path: '/private/models' },
      }),
    ),
  ).toEqual(complete);
});

test.each([
  { ...empty, revision: -1 },
  { ...empty, revision: 1.5 },
  { ...empty, revision: null },
  { ...empty, schemaVersion: 2 },
  { ...empty, selectedVariant: 'unknown' },
  { ...empty, resources: { ...empty.resources, pocket: 'true' } },
  { ...empty, reference: { ready: false, speakerName: 'x'.repeat(121) } },
  {
    ...empty,
    selectedBackend: 'fluid',
    effectiveBackend: 'fluid',
    ready: true,
  },
])('parser rejects malformed or falsely active state %#', value => {
  expect(() => parseAdvancedVoiceState(JSON.stringify(value))).toThrow();
});
