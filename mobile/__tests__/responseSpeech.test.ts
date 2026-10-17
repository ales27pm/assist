import { ResponseSpeechStream } from '../src/responseSpeech';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function commands() {
  return {
    begin: jest.fn<Promise<boolean>, []>().mockResolvedValue(true),
    enqueue: jest.fn<Promise<boolean>, [string]>().mockResolvedValue(true),
    finish: jest.fn<Promise<boolean>, []>().mockResolvedValue(true),
    onError: jest.fn<void, [Error]>(),
  };
}

test('speaks a completed prosodic unit while the unfinished tail is still arriving', async () => {
  const native = commands();
  const heard = deferred<void>();
  native.enqueue.mockImplementation(async () => {
    heard.resolve();
    return true;
  });
  const stream = new ResponseSpeechStream(native);
  stream.push('Salut! Je peux');
  await heard.promise;

  expect(native.enqueue.mock.calls).toEqual([['Salut!']]);
  expect(native.finish).not.toHaveBeenCalled();
  await stream.finish('Salut! Je peux te répondre.');
  expect(native.enqueue.mock.calls).toEqual([
    ['Salut!'],
    ['Je peux te répondre.'],
  ]);
});

test('waits for whitespace after punctuation and never splits a decimal', async () => {
  const native = commands();
  const stream = new ResponseSpeechStream(native);
  stream.push('Le total est 12.50 dollars.');
  stream.push('Le total est 12.50 dollars. Ça va?\nTrès bien! ');
  await stream.finish('Le total est 12.50 dollars. Ça va?\nTrès bien! ');

  expect(native.enqueue.mock.calls).toEqual([
    ['Le total est 12.50 dollars.'],
    ['Ça va?'],
    ['Très bien!'],
  ]);
  expect(native.onError).not.toHaveBeenCalled();
});

test('deduplicates repeated cumulative snapshots and flushes the final unpunctuated tail once', async () => {
  const native = commands();
  const stream = new ResponseSpeechStream(native);
  stream.push('Oui.  La suite');
  stream.push('Oui.  La suite');
  stream.push('Oui.  La suite arrive');
  await stream.finish('Oui.  La suite arrive');
  await stream.finish('Texte tardif ignoré');
  stream.push('Une autre phrase. ');

  expect(native.enqueue.mock.calls).toEqual([['Oui.'], ['La suite arrive']]);
  expect(native.begin).toHaveBeenCalledTimes(1);
  expect(native.finish).toHaveBeenCalledTimes(1);
});

test('closes empty input without scheduling empty speech', async () => {
  const native = commands();
  const stream = new ResponseSpeechStream(native);
  stream.push(' \n ');
  await stream.finish(' \n ');
  expect(native.enqueue).not.toHaveBeenCalled();
  expect(native.finish).toHaveBeenCalledTimes(1);
});

test('bounds long unpunctuated clauses at word boundaries without losing words', async () => {
  const native = commands();
  const text = Array.from({ length: 120 }, (_, index) => `mot${index}`).join(' ');
  const stream = new ResponseSpeechStream(native);
  stream.push(text);
  await stream.finish(text);
  const chunks = native.enqueue.mock.calls.map(([chunk]) => chunk);

  expect(chunks.length).toBeGreaterThan(2);
  expect(chunks.every(chunk => chunk.length <= 180)).toBe(true);
  expect(chunks.join(' ')).toBe(text);
});

test('also bounds an unbroken token without splitting a surrogate pair', async () => {
  const native = commands();
  const text = 'a' + '🙂'.repeat(200);
  const stream = new ResponseSpeechStream(native);
  stream.push(text);
  await stream.finish(text);
  const chunks = native.enqueue.mock.calls.map(([chunk]) => chunk);

  expect(chunks.every(chunk => chunk.length <= 180)).toBe(true);
  expect(chunks.join('')).toBe(text);
  expect(chunks.every(chunk => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
});

test('allows a correction confined to the unconsumed tail', async () => {
  const native = commands();
  const stream = new ResponseSpeechStream(native);
  stream.push('Oui. Je peux peut');
  await stream.finish('Oui. Je peux le faire');
  expect(native.enqueue.mock.calls).toEqual([['Oui.'], ['Je peux le faire']]);
  expect(native.onError).not.toHaveBeenCalled();
});

test.each(['Non. Autre réponse. ', 'Ou', 'Oui. Autre réponse. '])(
  'stops on rewritten or shortened consumed input without repeating speech: %s',
  async divergent => {
    const native = commands();
    const heard = deferred<void>();
    native.enqueue.mockImplementation(async () => {
      heard.resolve();
      return true;
    });
    const stream = new ResponseSpeechStream(native);
    stream.push('Oui.  La suite');
    await heard.promise;
    stream.push(divergent);
    await stream.finish(divergent);

    expect(native.enqueue.mock.calls).toEqual([['Oui.']]);
    expect(native.finish).not.toHaveBeenCalled();
    expect(native.onError).toHaveBeenCalledTimes(1);
    expect(native.onError).toHaveBeenCalledWith(expect.any(Error));
  },
);

test('cancel immediately after construction prevents even delayed begin', async () => {
  const native = commands();
  const stream = new ResponseSpeechStream(native);
  stream.push('Ne lis pas ceci. ');
  stream.cancel();
  stream.push('Encore moins ceci. ');
  await stream.finish('Ne lis pas ceci. ');

  expect(native.begin).not.toHaveBeenCalled();
  expect(native.enqueue).not.toHaveBeenCalled();
  expect(native.finish).not.toHaveBeenCalled();
  expect(native.onError).not.toHaveBeenCalled();
});

test('a divergent prefix invalidates speech queued before begin can run', async () => {
  const native = commands();
  const stream = new ResponseSpeechStream(native);
  stream.push('Ancienne réponse. ');
  stream.push('Nouvelle réponse. ');
  await stream.finish('Nouvelle réponse. ');

  expect(native.begin).not.toHaveBeenCalled();
  expect(native.enqueue).not.toHaveBeenCalled();
  expect(native.finish).not.toHaveBeenCalled();
  expect(native.onError).toHaveBeenCalledTimes(1);
});

test('cancel while begin is pending prevents queued speech and finish', async () => {
  const native = commands();
  const started = deferred<void>();
  const pending = deferred<boolean>();
  native.begin.mockImplementation(() => {
    started.resolve();
    return pending.promise;
  });
  const stream = new ResponseSpeechStream(native);
  stream.push('Première phrase. Deuxième phrase. ');
  const finished = stream.finish('Première phrase. Deuxième phrase. ');
  await started.promise;
  stream.cancel();
  pending.resolve(true);
  await finished;

  expect(native.enqueue).not.toHaveBeenCalled();
  expect(native.finish).not.toHaveBeenCalled();
});

test('serializes commands and cancels the queue behind an already-started enqueue', async () => {
  const native = commands();
  const started = deferred<void>();
  const pending = deferred<boolean>();
  native.enqueue.mockImplementationOnce(() => {
    started.resolve();
    return pending.promise;
  });
  const stream = new ResponseSpeechStream(native);
  stream.push('Première. Deuxième. Troisième');
  const finished = stream.finish('Première. Deuxième. Troisième');
  await started.promise;
  expect(native.enqueue.mock.calls).toEqual([['Première.']]);
  expect(native.finish).not.toHaveBeenCalled();
  stream.cancel();
  pending.reject(new Error('Échec tardif après annulation'));
  await finished;

  expect(native.enqueue.mock.calls).toEqual([['Première.']]);
  expect(native.finish).not.toHaveBeenCalled();
  expect(native.onError).not.toHaveBeenCalled();
});

test.each(['begin', 'enqueue', 'finish'] as const)(
  'stops after a false %s result and resolves without throwing',
  async command => {
    const native = commands();
    native[command].mockResolvedValueOnce(false);
    const stream = new ResponseSpeechStream(native);
    stream.push('Bonjour. Une autre phrase. ');
    await expect(stream.finish('Bonjour. Une autre phrase. ')).resolves.toBeUndefined();
    expect(native.onError).toHaveBeenCalledTimes(1);
    if (command === 'begin') expect(native.enqueue).not.toHaveBeenCalled();
    if (command !== 'finish') expect(native.finish).not.toHaveBeenCalled();
  },
);

test.each(['begin', 'enqueue', 'finish'] as const)(
  'catches a rejected %s command without rejecting the LLM caller',
  async command => {
    const native = commands();
    const error = new Error('Audio indisponible');
    native[command].mockRejectedValueOnce(error);
    const stream = new ResponseSpeechStream(native);
    await expect(stream.finish('Bonjour')).resolves.toBeUndefined();
    expect(native.onError).toHaveBeenCalledWith(error);
    expect(native.onError).toHaveBeenCalledTimes(1);
  },
);

test('finish waits for native commands to drain and excludes later input', async () => {
  const native = commands();
  const started = deferred<void>();
  const pending = deferred<boolean>();
  native.finish.mockImplementation(() => {
    started.resolve();
    return pending.promise;
  });
  const stream = new ResponseSpeechStream(native);
  let settled = false;
  const finished = stream.finish('Réponse complète').then(() => { settled = true; });
  await started.promise;
  expect(settled).toBe(false);
  stream.push('Réponse complète et texte tardif');
  pending.resolve(true);
  await finished;

  expect(native.enqueue.mock.calls).toEqual([['Réponse complète']]);
  expect(settled).toBe(true);
});

test('contains synchronous command and error-observer exceptions', async () => {
  const native = commands();
  native.begin.mockImplementation(() => { throw new Error('Échec synchrone'); });
  native.onError.mockImplementation(() => { throw new Error('Observateur défaillant'); });
  const stream = new ResponseSpeechStream(native);
  await expect(stream.finish('Bonjour')).resolves.toBeUndefined();
  expect(native.enqueue).not.toHaveBeenCalled();
  expect(native.onError).toHaveBeenCalledTimes(1);
});

test('contains a rejected promise returned by an async error observer', async () => {
  const native = commands();
  native.begin.mockResolvedValueOnce(false);
  native.onError.mockImplementation(async () => {
    throw new Error('Observateur asynchrone défaillant');
  });
  const stream = new ResponseSpeechStream(native);
  await expect(stream.finish('Bonjour')).resolves.toBeUndefined();
  expect(native.onError).toHaveBeenCalledTimes(1);
});
