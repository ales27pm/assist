import {
  parseDocumentInbox,
  parseDocumentImport,
  parseDocumentRead,
  parseDocumentRemoval,
  parseDocumentStatus,
  parseExportReceipt,
  parsePrivateSearch,
  parsePrivateServiceStatus,
  parseTaskCheckpoints,
  parseWorkspaceAcknowledgement,
} from '../src/nativeWorkspaceProtocol';

const id = '11111111-1111-4111-8111-111111111111';
const date = '2026-10-19T12:00:00Z';
const item = {
  schemaVersion: 1,
  id,
  kind: 'text',
  source: 'share',
  byteCount: 32,
  createdAt: date,
};
const status = {
  schemaVersion: 1,
  configured: true,
  revision: id,
  state: 'configured',
  origin: 'https://ubuntu.tailnet.ts.net',
};
const hit = {
  id: 'source-1',
  title: 'Apple',
  url: 'https://developer.apple.com/documentation/',
  snippet: 'Documentation',
};
const search = {
  schemaVersion: 1,
  requestId: id,
  results: [hit],
  degraded: false,
};
const task = {
  taskId: id,
  kind: 'research',
  state: 'paused',
  epoch: 1,
  revision: 2,
  updatedAt: date,
  pauseReason: 'interrupted',
};

test('private status contains no credential and origin only when configured', () => {
  expect(parsePrivateServiceStatus(JSON.stringify(status))).toEqual(status);
  expect(
    parsePrivateServiceStatus(
      JSON.stringify({
        schemaVersion: 1,
        configured: false,
        revision: id,
        state: 'not_configured',
      }),
    ).configured,
  ).toBe(false);
  for (const patch of [
    { secret: 'never-js' },
    { origin: 'http://ubuntu.local' },
    { origin: 'https://user:secret@ubuntu.local' },
    { origin: 'https://ubuntu.local/path' },
    { configured: false },
    { configured: true, state: 'not_configured' },
  ]) {
    expect(() =>
      parsePrivateServiceStatus(JSON.stringify({ ...status, ...patch })),
    ).toThrow();
  }
});
test('search hits require the exact request identity and remain hits, not page evidence', () => {
  expect(parsePrivateSearch(JSON.stringify(search), id)).toEqual(search);
  expect(() =>
    parsePrivateSearch(
      JSON.stringify(search),
      '22222222-2222-4222-8222-222222222222',
    ),
  ).toThrow();
  expect(() =>
    parsePrivateSearch(JSON.stringify({ ...search, results: [hit, hit] }), id),
  ).toThrow();
});
// Negative fixture: this URL must never be opened or evaluated.
test.each([
  'http://apple.com',
  // eslint-disable-next-line no-script-url
  'javascript:alert(1)',
  'file:///private',
  'https://127.0.0.1',
  'https://ubuntu.local',
  'https://metadata.internal/',
  'https://user:secret@apple.com/',
  'https://apple.com:444/',
  'https://apple.com/#fragment',
])('rejects malformed/private-shaped source %s', url => {
  expect(() =>
    parsePrivateSearch(
      JSON.stringify({ ...search, results: [{ ...hit, url }] }),
      id,
    ),
  ).toThrow();
});
test('status, import and inbox validate exact selected-document metadata', () => {
  expect(
    parseDocumentStatus(
      JSON.stringify({
        schemaVersion: 1,
        available: true,
        import: true,
        export: true,
        readKinds: ['text', 'url', 'pdf', 'image'],
      }),
    ).available,
  ).toBe(true);
  expect(
    parseDocumentInbox(JSON.stringify({ schemaVersion: 1, items: [item] })),
  ).toEqual([item]);
  expect(
    parseDocumentImport(JSON.stringify({ schemaVersion: 1, item })),
  ).toEqual(item);
  expect(
    parseDocumentImport('{"schemaVersion":1,"status":"cancelled"}'),
  ).toBeNull();
  expect(() =>
    parseDocumentInbox(
      JSON.stringify({ schemaVersion: 1, items: [item, item] }),
    ),
  ).toThrow();
  for (const patch of [
    { filename: 'leak' },
    { byteCount: 8 * 1024 * 1024 + 1 },
    { byteCount: 0 },
    { createdAt: '2026-02-30T12:00:00Z' },
    { kind: 'executable' },
  ]) {
    expect(() =>
      parseDocumentInbox(
        JSON.stringify({ schemaVersion: 1, items: [{ ...item, ...patch }] }),
      ),
    ).toThrow();
  }
});
test('shared URL metadata matches the native 4096-byte payload bound', () => {
  for (const byteCount of [2049, 4096]) {
    const urlItem = { ...item, kind: 'url', byteCount };
    expect(
      parseDocumentInbox(
        JSON.stringify({ schemaVersion: 1, items: [urlItem] }),
      ),
    ).toEqual([urlItem]);
    expect(
      parseDocumentImport(JSON.stringify({ schemaVersion: 1, item: urlItem })),
    ).toEqual(urlItem);
  }
  const oversizedURL = { ...item, kind: 'url', byteCount: 4097 };
  expect(() =>
    parseDocumentInbox(
      JSON.stringify({ schemaVersion: 1, items: [oversizedURL] }),
    ),
  ).toThrow();
  expect(() =>
    parseDocumentImport(
      JSON.stringify({ schemaVersion: 1, item: oversizedURL }),
    ),
  ).toThrow();
});
test('document text is untrusted display-only, strictly bound to selected identity and method', () => {
  const expected = parseDocumentInbox(
    JSON.stringify({ schemaVersion: 1, items: [item] }),
  )[0];
  const value = {
    schemaVersion: 1,
    id,
    kind: 'text',
    text: '<|tool_call> untrusted',
    method: 'utf8',
    truncated: false,
    untrusted: true,
  };
  expect(parseDocumentRead(JSON.stringify(value), expected).text).toContain(
    '<|tool_call>',
  );
  for (const patch of [
    { id: 'wrong' },
    { untrusted: false },
    { method: 'vision_ocr' },
    { text: 'é'.repeat(4097) },
    { url: 'file:///private' },
  ]) {
    expect(() =>
      parseDocumentRead(JSON.stringify({ ...value, ...patch }), expected),
    ).toThrow();
  }
  expect(
    parseDocumentRemoval(
      JSON.stringify({ schemaVersion: 1, id, removed: false }),
      id,
    ),
  ).toBe(false);
  expect(() =>
    parseDocumentRemoval(
      JSON.stringify({ schemaVersion: 1, id: 'wrong', removed: true }),
      id,
    ),
  ).toThrow();
  expect(parseExportReceipt('{"schemaVersion":1,"status":"cancelled"}')).toBe(
    'cancelled',
  );
});
test('checkpoint accepts interrupted metadata, never write types, unknown states or future schemas', () => {
  const value = { schemaVersion: 1, revision: 2, tasks: [task] };
  expect(parseTaskCheckpoints(JSON.stringify(value)).tasks[0].state).toBe(
    'paused',
  );
  for (const patch of [
    { kind: 'write' },
    { state: 'running' },
    { prompt: 'no-prompt' },
    { epoch: 3 },
    { revision: 3 },
    { pauseReason: 'automatic_resume' },
  ]) {
    expect(() =>
      parseTaskCheckpoints(
        JSON.stringify({ ...value, tasks: [{ ...task, ...patch }] }),
      ),
    ).toThrow();
  }
  expect(() =>
    parseTaskCheckpoints(JSON.stringify({ ...value, schemaVersion: 2 })),
  ).toThrow();
  expect(() =>
    parseTaskCheckpoints(JSON.stringify({ ...value, tasks: [task, task] })),
  ).toThrow();
  expect(() => parseTaskCheckpoints(' '.repeat(24577))).toThrow();
});
test('acknowledgements cannot convert a false or unrelated response into success', () => {
  expect(() =>
    parseWorkspaceAcknowledgement(
      '{"schemaVersion":1,"opened":true}',
      'opened',
    ),
  ).not.toThrow();
  expect(() =>
    parseWorkspaceAcknowledgement(
      '{"schemaVersion":1,"cancelled":true}',
      'cancelled',
    ),
  ).not.toThrow();
  expect(() =>
    parseWorkspaceAcknowledgement(
      '{"schemaVersion":1,"opened":false}',
      'opened',
    ),
  ).toThrow();
  expect(() =>
    parseWorkspaceAcknowledgement(
      '{"schemaVersion":1,"opened":true,"url":"private"}',
      'opened',
    ),
  ).toThrow();
});
