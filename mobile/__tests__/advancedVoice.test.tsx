import { act, renderHookAsync } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { AppStateStatus } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { parseAdvancedVoiceState } from '../src/advancedVoice';
import type {
  AdvancedVoiceBackend,
  AdvancedVoiceState,
  AdvancedVoiceVariant,
} from '../src/advancedVoice';
import { useAdvancedVoice } from '../src/useAdvancedVoice';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    getAdvancedVoiceState: jest.fn(),
    importAdvancedVoicePack: jest.fn(),
    restorePreviousAdvancedVoicePack: jest.fn(),
    setAdvancedVoiceBackend: jest.fn(),
    startListening: jest.fn(),
  },
}));
const native = jest.mocked(NativeAssist!);
const empty: AdvancedVoiceState = {
  schemaVersion: 2,
  revision: 0,
  selectedBackend: 'apple',
  selectedVariant: 'redux',
  effectiveBackend: 'apple',
  ready: false,
  resources: { pocket: false, redux: false, ultra: false, silero: false },
  voice: 'estelle',
};
const complete = {
  ...empty,
  revision: 1,
  ready: true,
  resources: { pocket: true, redux: true, ultra: true, silero: true },
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
  native.restorePreviousAdvancedVoicePack.mockResolvedValue(
    json({
      ...complete,
      revision: 2,
      packVersion: '2026.10',
      previousPackAvailable: false,
    }),
  );
  native.setAdvancedVoiceBackend.mockImplementation(async (backend, variant) =>
    json({
      ...complete,
      selectedBackend: backend as AdvancedVoiceBackend,
      selectedVariant: variant as AdvancedVoiceVariant,
      effectiveBackend: backend as AdvancedVoiceBackend,
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
    expect(await result.current.importPack()).toBe(false);
    await result.current.refresh();
  });
  expect(native.setAdvancedVoiceBackend).not.toHaveBeenCalled();
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

test('a rejected rollback preserves the confirmed pack and never starts audio', async () => {
  const restorable = {
    ...complete,
    packVersion: '2026.10',
    previousPackAvailable: true,
  };
  native.getAdvancedVoiceState.mockResolvedValueOnce(json(restorable));
  native.restorePreviousAdvancedVoicePack.mockRejectedValueOnce(
    new Error('Le pack précédent est incomplet.'),
  );
  const { result } = await renderHookAsync(useAdvancedVoice);
  await act(async () =>
    expect(await result.current.restorePreviousPack()).toBe(false),
  );
  expect(result.current.state).toEqual(restorable);
  expect(result.current.error).toContain('précédent est incomplet');
  expect(native.startListening).not.toHaveBeenCalled();
});

test('rollback stays pending until native acknowledgement and blocks other resource changes', async () => {
  const restoring = deferred<string>();
  native.getAdvancedVoiceState.mockResolvedValueOnce(
    json({ ...complete, previousPackAvailable: true }),
  );
  native.restorePreviousAdvancedVoicePack.mockReturnValueOnce(restoring.promise);
  const { result } = await renderHookAsync(useAdvancedVoice);
  let restored!: Promise<boolean>;
  await act(async () => {
    restored = result.current.restorePreviousPack();
  });
  expect(result.current.operation).toBe('restore');
  expect(result.current.busy).toBe(true);
  await act(async () => {
    expect(await result.current.importPack()).toBe(false);
    expect(await result.current.setBackend('fluid', 'redux')).toBe(false);
  });
  expect(native.importAdvancedVoicePack).not.toHaveBeenCalled();
  expect(native.setAdvancedVoiceBackend).not.toHaveBeenCalled();
  expect(native.startListening).not.toHaveBeenCalled();
  await act(async () => {
    restoring.resolve(json({ ...complete, revision: 3, previousPackAvailable: false }));
    expect(await restored).toBe(true);
  });
  expect(result.current.busy).toBe(false);
  expect(result.current.state?.previousPackAvailable).toBe(false);
});

test('an older native revision cannot replace a newer confirmed inventory', async () => {
  native.getAdvancedVoiceState.mockResolvedValueOnce(
    json({ ...complete, revision: 4 }),
  );
  const { result } = await renderHookAsync(useAdvancedVoice);
  await act(async () => result.current.refresh());
  expect(result.current.state?.revision).toBe(4);
  expect(result.current.state?.ready).toBe(true);
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

test('an older binary without rollback support remains readable and receives no rollback call', async () => {
  const original = native.restorePreviousAdvancedVoicePack;
  Object.defineProperty(native, 'restorePreviousAdvancedVoicePack', {
    configurable: true,
    value: undefined,
  });
  try {
    native.getAdvancedVoiceState.mockResolvedValueOnce(
      json({ ...complete, previousPackAvailable: true }),
    );
    const { result } = await renderHookAsync(useAdvancedVoice);
    expect(result.current.supported).toBe(true);
    expect(result.current.canRestorePreviousPack).toBe(false);
    await act(async () =>
      expect(await result.current.restorePreviousPack()).toBe(false),
    );
    expect(native.startListening).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(native, 'restorePreviousAdvancedVoicePack', {
      configurable: true,
      value: original,
    });
  }
});

test('parser strips private or unexpected data including obsolete reference metadata', () => {
  expect(
    parseAdvancedVoiceState(
      JSON.stringify({
        ...complete,
        path: '/private/audio.wav',
        audio: 'secret',
        reference: {
          ready: true,
          speakerName: 'private',
          consentDocument: 'private',
        },
        resources: { ...complete.resources, path: '/private/models' },
      }),
    ),
  ).toEqual(complete);
});

test('parser retains only bounded safe rollback metadata', () => {
  const restorable = {
    ...complete,
    packVersion: '2026.10-rc_1',
    previousPackAvailable: true,
  };
  expect(parseAdvancedVoiceState(JSON.stringify(restorable))).toEqual(restorable);
  expect(() =>
    parseAdvancedVoiceState(
      JSON.stringify({ ...complete, packVersion: '../private/path' }),
    ),
  ).toThrow();
  expect(() =>
    parseAdvancedVoiceState(
      JSON.stringify({ ...complete, previousPackAvailable: 'true' }),
    ),
  ).toThrow();
});

test.each([
  { ...empty, revision: -1 },
  { ...empty, revision: 1.5 },
  { ...empty, revision: null },
  { ...empty, schemaVersion: 1 },
  { ...empty, selectedVariant: 'unknown' },
  { ...empty, resources: { ...empty.resources, pocket: 'true' } },
  { ...empty, voice: 'custom' },
  {
    ...empty,
    selectedBackend: 'fluid',
    effectiveBackend: 'fluid',
    ready: true,
  },
])('parser rejects malformed or falsely active state %#', value => {
  expect(() => parseAdvancedVoiceState(JSON.stringify(value))).toThrow();
});

test('a verified pack alone permits a Fluid selection with the public Estelle preset', () => {
  const active = {
    ...complete,
    selectedBackend: 'fluid',
    effectiveBackend: 'fluid',
  };
  expect(parseAdvancedVoiceState(JSON.stringify(active))).toEqual(active);
});
