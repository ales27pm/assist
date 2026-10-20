import { act, renderHookAsync } from '@testing-library/react-native';
import { AppState, AppStateStatus } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { useSpeechVoiceComparison } from '../src/useSpeechVoiceComparison';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    getSpeechVoices: jest.fn(),
    setSpeechVoice: jest.fn(),
    previewSpeechVoice: jest.fn(),
    stopSpeechVoicePreview: jest.fn(),
  },
}));

const native = jest.mocked(NativeAssist!);
const voices = [
  { id: 'voice-a', name: 'Voix A', language: 'fr-CA', quality: 'default' },
  { id: 'voice-b', name: 'Voix B', language: 'fr-CA', quality: 'enhanced' },
];
function catalog(selectedVoiceId = '', inventory = voices) {
  return JSON.stringify({
    schemaVersion: 1,
    locale: 'fr-CA',
    voices: inventory,
    selectedVoiceId,
    resolvedVoiceId: selectedVoiceId || inventory[0]?.id || null,
    selectionMissing: false,
  });
}
function terminal(sessionId: string, outcome = 'completed') {
  return JSON.stringify({ sessionId, outcome });
}
function stoppedResult(sessionId: string, stopped = true) {
  return JSON.stringify({ sessionId, stopped });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
let previews: Map<string, ReturnType<typeof deferred<string>>>;
let changed: (state: AppStateStatus) => void;
function previewId() {
  return native.previewSpeechVoice.mock.calls.at(-1)![2];
}

beforeEach(() => {
  jest.resetAllMocks();
  previews = new Map();
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: 'active',
  });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
    changed = listener;
    return { remove: jest.fn() };
  });
  native.getSpeechVoices.mockResolvedValue(catalog());
  native.setSpeechVoice.mockImplementation(async id => catalog(id));
  native.previewSpeechVoice.mockImplementation((_id, _segments, sessionId) => {
    const work = deferred<string>();
    previews.set(sessionId, work);
    return work.promise;
  });
  native.stopSpeechVoicePreview.mockImplementation(async sessionId =>
    stoppedResult(sessionId),
  );
});
afterEach(() => jest.restoreAllMocks());

test('loads local candidates without playing and keeps blind labels stable across an unchanged inventory', async () => {
  const { result } = await renderHookAsync(useSpeechVoiceComparison);
  const order = result.current.candidates.map(voice => voice.id);
  expect(result.current.supported).toBe(true);
  expect(result.current.loading).toBe(false);
  expect(order.sort()).toEqual(['voice-a', 'voice-b']);
  expect(native.previewSpeechVoice).not.toHaveBeenCalled();
  const originalOrder = result.current.candidates.map(voice => voice.id);
  native.getSpeechVoices.mockResolvedValueOnce(
    catalog('', [voices[1], { ...voices[0], name: 'Nom actualisé' }]),
  );
  await act(async () => result.current.refresh());
  expect(result.current.candidates.map(voice => voice.id)).toEqual(
    originalOrder,
  );
  expect(
    result.current.candidates.find(voice => voice.id === 'voice-a')?.name,
  ).toBe('Nom actualisé');
});

test('plays ordered segments once and clears only after the matching terminal result', async () => {
  const { result } = await renderHookAsync(useSpeechVoiceComparison);
  let playing!: Promise<boolean>;
  await act(async () => {
    playing = result.current.play('voice-b', ['Bonjour. ', 'La suite.']);
  });
  const id = previewId();
  expect(result.current.playingId).toBe('voice-b');
  expect(native.previewSpeechVoice).toHaveBeenCalledWith(
    'voice-b',
    JSON.stringify(['Bonjour. ', 'La suite.']),
    id,
  );
  await act(async () => {
    expect(await result.current.play('voice-a', ['Autre.'])).toBe(false);
    previews.get(id)!.resolve(terminal(id));
    expect(await playing).toBe(true);
  });
  expect(native.previewSpeechVoice).toHaveBeenCalledTimes(1);
  expect(result.current.playingId).toBeNull();
  expect(native.stopSpeechVoicePreview).not.toHaveBeenCalled();
});

test('stop is targeted, shared and does not clear playback before its acknowledgement', async () => {
  const stopped = deferred<string>();
  native.stopSpeechVoicePreview.mockReturnValueOnce(stopped.promise);
  const { result } = await renderHookAsync(useSpeechVoiceComparison);
  await act(async () => {
    result.current.play('voice-a', ['Une phrase.']);
  });
  const id = previewId();
  let first!: Promise<boolean>;
  let second!: Promise<boolean>;
  await act(async () => {
    first = result.current.stop();
    second = result.current.stop();
  });
  expect(result.current.playingId).toBe('voice-a');
  expect(native.stopSpeechVoicePreview.mock.calls).toEqual([[id]]);
  await act(async () => {
    stopped.resolve(stoppedResult(id));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
  });
  expect(result.current.playingId).toBeNull();
});

test('a failed stop keeps playback owned until a successful retry', async () => {
  native.stopSpeechVoicePreview.mockRejectedValueOnce(
    new Error('Arrêt non confirmé.'),
  );
  const { result } = await renderHookAsync(useSpeechVoiceComparison);
  await act(async () => {
    result.current.play('voice-a', ['Une phrase.']);
  });
  const id = previewId();
  await act(async () => {
    expect(await result.current.stop()).toBe(false);
  });
  expect(result.current.playingId).toBe('voice-a');
  expect(result.current.error).toContain('Arrêt non confirmé.');
  await act(async () => {
    expect(await result.current.play('voice-b', ['Autre.'])).toBe(false);
    expect(await result.current.stop()).toBe(true);
  });
  expect(native.stopSpeechVoicePreview.mock.calls).toEqual([[id], [id]]);
  expect(result.current.playingId).toBeNull();
});

test('a negative stop acknowledgement keeps playback owned and prevents saving', async () => {
  native.stopSpeechVoicePreview.mockImplementationOnce(async id =>
    stoppedResult(id, false),
  );
  const { result } = await renderHookAsync(useSpeechVoiceComparison);
  await act(async () => {
    result.current.play('voice-a', ['Une phrase.']);
  });
  await act(async () => {
    expect(await result.current.chooseVoice('voice-b')).toBe(false);
  });
  expect(result.current.playingId).toBe('voice-a');
  expect(result.current.error).toContain('n’a pas été confirmé');
  expect(native.setSpeechVoice).not.toHaveBeenCalled();
  expect(result.current.saving).toBe(false);
});

test('a matching terminal result confirms a natural end racing a targeted stop', async () => {
  const stopped = deferred<string>();
  native.stopSpeechVoicePreview.mockReturnValueOnce(stopped.promise);
  const { result } = await renderHookAsync(useSpeechVoiceComparison);
  let playing!: Promise<boolean>;
  let stopping!: Promise<boolean>;
  await act(async () => {
    playing = result.current.play('voice-a', ['Fin naturelle.']);
  });
  const id = previewId();
  await act(async () => {
    stopping = result.current.stop();
    previews.get(id)!.resolve(terminal(id));
    expect(await playing).toBe(false);
    stopped.resolve(stoppedResult(id, false));
    expect(await stopping).toBe(true);
  });
  expect(result.current.playingId).toBeNull();
  expect(result.current.error).toBe('');
  await act(async () => {
    result.current.play('voice-b', ['La suivante.']);
  });
  expect(result.current.playingId).toBe('voice-b');
  expect(native.stopSpeechVoicePreview.mock.calls).toEqual([[id]]);
});

test('a late rejected preview cannot stop a newer preview after a confirmed stop', async () => {
  const { result } = await renderHookAsync(useSpeechVoiceComparison);
  let playing!: Promise<boolean>;
  await act(async () => {
    playing = result.current.play('voice-a', ['Ancienne.']);
  });
  const oldId = previewId();
  await act(async () => {
    expect(await result.current.stop()).toBe(true);
    result.current.play('voice-b', ['Nouvelle.']);
  });
  await act(async () => {
    previews.get(oldId)!.reject(new Error('Échec tardif.'));
    expect(await playing).toBe(false);
  });
  expect(result.current.playingId).toBe('voice-b');
  expect(result.current.error).toBe('');
  expect(native.stopSpeechVoicePreview.mock.calls).toEqual([[oldId]]);
});

test.each(['inactive', 'background'] as const)(
  '%s stops the current preview and returning active never replays it',
  async state => {
    const { result } = await renderHookAsync(useSpeechVoiceComparison);
    let playing!: Promise<boolean>;
    await act(async () => {
      playing = result.current.play('voice-a', ['Locale.']);
    });
    const id = previewId();
    await act(async () => {
      changed(state);
    });
    expect(native.stopSpeechVoicePreview).toHaveBeenCalledWith(id);
    await act(async () => {
      expect(await result.current.play('voice-b', ['Bloqué.'])).toBe(false);
      changed('active');
      previews.get(id)!.resolve(terminal(id));
      expect(await playing).toBe(false);
    });
    expect(result.current.playingId).toBeNull();
    expect(native.previewSpeechVoice).toHaveBeenCalledTimes(1);
  },
);

test('late preview completion after unmount cannot affect a newer preview or stop another session', async () => {
  const first = await renderHookAsync(useSpeechVoiceComparison);
  let oldPlaying!: Promise<boolean>;
  await act(async () => {
    oldPlaying = first.result.current.play('voice-a', ['Ancienne.']);
  });
  const oldId = previewId();
  await first.unmountAsync();
  expect(native.stopSpeechVoicePreview.mock.calls).toEqual([[oldId]]);
  const next = await renderHookAsync(useSpeechVoiceComparison);
  await act(async () => {
    next.result.current.play('voice-b', ['Nouvelle.']);
  });
  const newId = previewId();
  expect(newId).not.toBe(oldId);
  await act(async () => {
    previews.get(oldId)!.resolve(terminal(oldId));
    expect(await oldPlaying).toBe(false);
  });
  expect(next.result.current.playingId).toBe('voice-b');
  expect(native.stopSpeechVoicePreview.mock.calls).toEqual([[oldId]]);
});

test('choosing stops its preview first, then persists only the acknowledged selection', async () => {
  const stopped = deferred<string>();
  const saved = deferred<string>();
  native.stopSpeechVoicePreview.mockReturnValueOnce(stopped.promise);
  native.setSpeechVoice.mockReturnValueOnce(saved.promise);
  const { result } = await renderHookAsync(useSpeechVoiceComparison);
  await act(async () => {
    result.current.play('voice-b', ['À choisir.']);
  });
  const id = previewId();
  let choosing!: Promise<boolean>;
  await act(async () => {
    choosing = result.current.chooseVoice('voice-b');
  });
  expect(result.current.saving).toBe(true);
  expect(result.current.catalog?.selectedVoiceId).toBe('');
  expect(native.setSpeechVoice).not.toHaveBeenCalled();
  await act(async () => {
    expect(await result.current.play('voice-a', ['Bloqué.'])).toBe(false);
    expect(await result.current.chooseVoice('voice-a')).toBe(false);
    stopped.resolve(stoppedResult(id));
  });
  expect(native.setSpeechVoice.mock.calls).toEqual([['voice-b']]);
  expect(result.current.catalog?.selectedVoiceId).toBe('');
  await act(async () => {
    saved.resolve(catalog('voice-b'));
    expect(await choosing).toBe(true);
  });
  expect(result.current.catalog?.selectedVoiceId).toBe('voice-b');
  expect(result.current.saving).toBe(false);
});

test.each(['rejected', 'mismatched', 'malformed'] as const)(
  'a %s save preserves the last confirmed selection',
  async failure => {
    native.getSpeechVoices.mockResolvedValueOnce(catalog('voice-a'));
    if (failure === 'rejected')
      native.setSpeechVoice.mockRejectedValueOnce(
        new Error('Sauvegarde impossible.'),
      );
    else
      native.setSpeechVoice.mockResolvedValueOnce(
        failure === 'mismatched' ? catalog('voice-a') : '{}',
      );
    const { result } = await renderHookAsync(useSpeechVoiceComparison);
    await act(async () => {
      expect(await result.current.chooseVoice('voice-b')).toBe(false);
    });
    expect(result.current.catalog?.selectedVoiceId).toBe('voice-a');
    expect(result.current.error).not.toBe('');
    expect(result.current.saving).toBe(false);
  },
);

test('a catalog read issued before a choice cannot overwrite the confirmed choice', async () => {
  const refreshing = deferred<string>();
  const { result } = await renderHookAsync(useSpeechVoiceComparison);
  native.getSpeechVoices.mockReturnValueOnce(refreshing.promise);
  let refreshed!: Promise<void>;
  await act(async () => {
    refreshed = result.current.refresh();
  });
  await act(async () => {
    expect(await result.current.chooseVoice('voice-b')).toBe(true);
  });
  await act(async () => {
    refreshing.resolve(catalog());
    await refreshed;
  });
  expect(result.current.catalog?.selectedVoiceId).toBe('voice-b');
  expect(result.current.loading).toBe(false);
});

test('returning active after a save reconciles the committed choice instead of applying the old acknowledgement', async () => {
  const saved = deferred<string>();
  native.getSpeechVoices.mockResolvedValueOnce(catalog('voice-a'));
  native.setSpeechVoice.mockReturnValueOnce(saved.promise);
  const { result } = await renderHookAsync(useSpeechVoiceComparison);
  let choosing!: Promise<boolean>;
  await act(async () => {
    choosing = result.current.chooseVoice('voice-b');
  });
  native.getSpeechVoices.mockResolvedValueOnce(catalog('voice-b'));
  await act(async () => {
    changed('inactive');
    changed('active');
    saved.resolve(catalog('voice-b'));
    expect(await choosing).toBe(false);
  });
  expect(result.current.catalog?.selectedVoiceId).toBe('voice-b');
  expect(result.current.saving).toBe(false);
  expect(native.getSpeechVoices).toHaveBeenCalledTimes(2);
});

test('a terminal native rejection exposes the error and permits retry or close without another stop', async () => {
  native.stopSpeechVoicePreview.mockImplementation(async id =>
    stoppedResult(id, false),
  );
  const { result } = await renderHookAsync(useSpeechVoiceComparison);
  let playing!: Promise<boolean>;
  await act(async () => {
    playing = result.current.play('voice-a', ['Une phrase.']);
  });
  const id = previewId();
  await act(async () => {
    previews.get(id)!.reject(new Error('Lecture indisponible.'));
    expect(await playing).toBe(false);
  });
  expect(result.current.playingId).toBeNull();
  expect(result.current.error).toContain('Lecture indisponible.');
  await act(async () => {
    expect(await result.current.stop()).toBe(true);
    playing = result.current.play('voice-b', ['Un nouvel essai.']);
  });
  const nextId = previewId();
  expect(nextId).not.toBe(id);
  expect(result.current.playingId).toBe('voice-b');
  await act(async () => {
    previews.get(nextId)!.resolve(terminal(nextId));
    expect(await playing).toBe(true);
  });
  expect(native.stopSpeechVoicePreview).not.toHaveBeenCalled();
});

test.each(['malformed', 'mismatched'] as const)(
  'a %s preview result still requires a confirmed targeted stop',
  async failure => {
    native.stopSpeechVoicePreview.mockImplementationOnce(async id =>
      stoppedResult(id, false),
    );
    const { result } = await renderHookAsync(useSpeechVoiceComparison);
    let playing!: Promise<boolean>;
    await act(async () => {
      playing = result.current.play('voice-a', ['Une phrase.']);
    });
    const id = previewId();
    await act(async () => {
      previews
        .get(id)!
        .resolve(failure === 'malformed' ? '{}' : terminal('another-preview'));
      expect(await playing).toBe(false);
    });
    expect(native.stopSpeechVoicePreview.mock.calls).toEqual([[id]]);
    expect(result.current.playingId).toBe('voice-a');
    expect(result.current.error).not.toBe('');
    await act(async () => {
      expect(await result.current.play('voice-b', ['Bloqué.'])).toBe(false);
      expect(await result.current.stop()).toBe(true);
    });
    expect(result.current.playingId).toBeNull();
  },
);

test('a terminal native rejection racing a requested stop confirms that its audio has ended', async () => {
  const stopped = deferred<string>();
  native.stopSpeechVoicePreview.mockReturnValueOnce(stopped.promise);
  const { result } = await renderHookAsync(useSpeechVoiceComparison);
  let playing!: Promise<boolean>;
  let stopping!: Promise<boolean>;
  await act(async () => {
    playing = result.current.play('voice-a', ['Une phrase.']);
  });
  const id = previewId();
  await act(async () => {
    stopping = result.current.stop();
    previews.get(id)!.reject(new Error('Échec terminal natif.'));
    expect(await playing).toBe(false);
    stopped.resolve(stoppedResult(id, false));
    expect(await stopping).toBe(true);
  });
  expect(result.current.playingId).toBeNull();
  expect(result.current.error).toBe('');
});

test('a missing preview API is unsupported without attempting native reads or playback', async () => {
  const original = native.previewSpeechVoice;
  Object.defineProperty(native, 'previewSpeechVoice', {
    configurable: true,
    value: undefined,
  });
  try {
    const { result } = await renderHookAsync(useSpeechVoiceComparison);
    expect(result.current.supported).toBe(false);
    expect(result.current.error).not.toBe('');
    await act(async () => {
      expect(await result.current.play('voice-a', ['Non.'])).toBe(false);
    });
    expect(native.getSpeechVoices).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(native, 'previewSpeechVoice', {
      configurable: true,
      value: original,
    });
  }
});
