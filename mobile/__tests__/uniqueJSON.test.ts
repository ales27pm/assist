import { parseUniqueJSON } from '../src/uniqueJSON';

test.each([
  '{"status":"failed_safe","status":"succeeded"}',
  '{"status":"failed_safe","st\\u0061tus":"succeeded"}',
  '{"items":[{"title":"approved","title":"changed"}]}',
])('rejects ambiguous object identity %#', raw => {
  expect(() => parseUniqueJSON(raw)).toThrow();
});

test('repeated keys in independent records and punctuation inside strings are data', () => {
  const expected = {
    items: [{ title: '{"title": \\"quoted\\"}' }, { title: 'Second' }],
    title: 'Envelope',
  };
  const raw = JSON.stringify(expected);
  expect(parseUniqueJSON(raw)).toEqual(expected);
});

test.each(['{"items":[}', '{"status":"ok",}', '{"items":true} trailing'])(
  'rejects invalid JSON %#',
  raw => {
    expect(() => parseUniqueJSON(raw)).toThrow();
  },
);
