import { act, renderHookAsync } from '@testing-library/react-native';
import NativeAssist from '../specs/NativeAssist';
import { useVoicePreferences } from '../src/useVoicePreferences';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    getVoicePreferences: jest.fn(),
    setVoicePreferences: jest.fn(),
  },
}));

const native = jest.mocked(NativeAssist!);
const saved = (readResponses: boolean) => JSON.stringify({ readResponses });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.resetAllMocks();
  native.getVoicePreferences.mockResolvedValue(saved(true));
  native.setVoicePreferences.mockImplementation(async enabled =>
    saved(enabled),
  );
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('defaults reading on while loading, then restores a saved opt-out without writing', async () => {
  const loading = deferred<string>();
  native.getVoicePreferences.mockReturnValueOnce(loading.promise);
  const { result } = await renderHookAsync(() => useVoicePreferences());

  expect(result.current.readResponses).toBe(true);
  expect(result.current.ready).toBe(false);
  expect(result.current.error).toBe('');
  expect(native.setVoicePreferences).not.toHaveBeenCalled();
  await act(async () => loading.resolve(saved(false)));

  expect(result.current.readResponses).toBe(false);
  expect(result.current.ready).toBe(true);
  expect(native.getVoicePreferences).toHaveBeenCalledTimes(1);
  expect(native.setVoicePreferences).not.toHaveBeenCalled();
});

test.each([true, false])(
  'a late saved value cannot overwrite the explicit choice %s',
  async choice => {
    const loading = deferred<string>();
    native.getVoicePreferences.mockReturnValueOnce(loading.promise);
    const { result } = await renderHookAsync(() => useVoicePreferences());
    await act(async () => result.current.change(choice));
    expect(result.current.readResponses).toBe(choice);
    await act(async () => loading.resolve(saved(!choice)));

    expect(result.current.readResponses).toBe(choice);
    expect(result.current.ready).toBe(true);
    expect(result.current.error).toBe('');
    expect(native.setVoicePreferences.mock.calls).toEqual([[choice]]);
  },
);

test('serializes rapid toggles in their original native write order', async () => {
  const pending = [deferred<string>(), deferred<string>(), deferred<string>()];
  let writeIndex = 0;
  native.setVoicePreferences.mockImplementation(
    () => pending[writeIndex++].promise,
  );
  const { result } = await renderHookAsync(() => useVoicePreferences());
  await act(async () => {
    result.current.change(false);
    result.current.change(true);
    result.current.change(false);
  });

  expect(result.current.readResponses).toBe(false);
  expect(native.setVoicePreferences.mock.calls).toEqual([[false]]);
  await act(async () => pending[0].resolve(saved(false)));
  expect(native.setVoicePreferences.mock.calls).toEqual([[false], [true]]);
  await act(async () => pending[1].resolve(saved(true)));
  expect(native.setVoicePreferences.mock.calls).toEqual([
    [false],
    [true],
    [false],
  ]);
  await act(async () => pending[2].resolve(saved(false)));

  expect(result.current.readResponses).toBe(false);
  expect(result.current.error).toBe('');
});

test.each(['rejected', 'mismatched', 'malformed'] as const)(
  'keeps the session choice and reports a %s save failure',
  async failure => {
    if (failure === 'rejected') {
      native.setVoicePreferences.mockRejectedValueOnce(
        new Error('Stockage indisponible'),
      );
    } else {
      native.setVoicePreferences.mockResolvedValueOnce(
        failure === 'mismatched' ? saved(true) : '{}',
      );
    }
    const { result } = await renderHookAsync(() => useVoicePreferences());
    await act(async () => result.current.change(false));

    expect(result.current.readResponses).toBe(false);
    expect(result.current.error).toMatch(
      /cette session.*enregistrement a échoué/,
    );
    expect(native.setVoicePreferences.mock.calls).toEqual([[false]]);
    await act(async () => result.current.change(true));
    expect(result.current.readResponses).toBe(true);
    expect(result.current.error).toBe('');
    expect(native.setVoicePreferences.mock.calls).toEqual([[false], [true]]);
  },
);

test('an older failed write does not replace the newer choice or prevent saving it', async () => {
  const older = deferred<string>();
  const newer = deferred<string>();
  native.setVoicePreferences
    .mockReturnValueOnce(older.promise)
    .mockReturnValueOnce(newer.promise);
  const { result } = await renderHookAsync(() => useVoicePreferences());
  await act(async () => {
    result.current.change(false);
    result.current.change(true);
  });
  await act(async () => older.reject(new Error('Ancienne écriture échouée')));

  expect(result.current.readResponses).toBe(true);
  expect(result.current.error).toBe('');
  expect(native.setVoicePreferences.mock.calls).toEqual([[false], [true]]);
  await act(async () => newer.resolve(saved(true)));
  expect(result.current.error).toBe('');
});

test.each(['{}', '{"readResponses":"false"}', 'null', 'not json'])(
  'rejects malformed stored preferences without silently opting out: %s',
  async json => {
    native.getVoicePreferences.mockResolvedValueOnce(json);
    const { result } = await renderHookAsync(() => useVoicePreferences());

    expect(result.current.readResponses).toBe(true);
    expect(result.current.ready).toBe(true);
    expect(result.current.error).toMatch(/n’a pas pu être chargé/);
    expect(native.setVoicePreferences).not.toHaveBeenCalled();
  },
);

test('a failed initial read cannot overwrite the state of an explicitly saved choice', async () => {
  const loading = deferred<string>();
  native.getVoicePreferences.mockReturnValueOnce(loading.promise);
  const { result } = await renderHookAsync(() => useVoicePreferences());
  await act(async () => result.current.change(false));
  await act(async () =>
    loading.reject(new Error('Lecture initiale devenue obsolète')),
  );

  expect(result.current.readResponses).toBe(false);
  expect(result.current.error).toBe('');
  expect(result.current.ready).toBe(true);
});

test('late initial loading after unmount neither renders UI nor writes a preference', async () => {
  const loading = deferred<string>();
  native.getVoicePreferences.mockReturnValueOnce(loading.promise);
  let renders = 0;
  const { unmountAsync } = await renderHookAsync(() => {
    renders += 1;
    return useVoicePreferences();
  });
  await unmountAsync();
  const beforeResolution = renders;
  await act(async () => loading.resolve(saved(false)));

  expect(renders).toBe(beforeResolution);
  expect(native.setVoicePreferences).not.toHaveBeenCalled();
});

test('an explicit pending save can settle after unmount without another write or UI update', async () => {
  const writing = deferred<string>();
  native.setVoicePreferences.mockReturnValueOnce(writing.promise);
  let renders = 0;
  const { result, unmountAsync } = await renderHookAsync(() => {
    renders += 1;
    return useVoicePreferences();
  });
  await act(async () => result.current.change(false));
  expect(native.setVoicePreferences.mock.calls).toEqual([[false]]);
  await unmountAsync();
  const beforeResolution = renders;
  await act(async () => writing.reject(new Error('Échec après fermeture')));

  expect(renders).toBe(beforeResolution);
  expect(native.setVoicePreferences.mock.calls).toEqual([[false]]);
});
