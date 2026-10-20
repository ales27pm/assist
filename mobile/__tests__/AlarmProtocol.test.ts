import {
  AlarmRequest,
  newAlarmOperationId,
  parseAlarmReceipt,
} from '../src/alarmProtocol';
const id = '11111111-1111-4111-8111-111111111111';
const request: AlarmRequest = {
  schemaVersion: 1,
  requestId: id,
  operationId: id,
  action: 'create',
  alarm_id: id,
  kind: 'timer',
  title: 'Thé',
  duration_seconds: 120,
};
const item = {
  alarm_id: id,
  kind: 'timer',
  title: 'Thé',
  duration_seconds: 120,
  state: 'countdown',
  uncertain: false,
};
const receipt = {
  schemaVersion: 1,
  requestId: id,
  operationId: id,
  action: 'create',
  status: 'succeeded',
  code: 'ok',
  items: [item],
};
test('accepts closed native receipt with actual AlarmKit countdown state', () => {
  expect(parseAlarmReceipt(JSON.stringify(receipt), request)).toEqual(receipt);
});
test('preserves uncertainty without manufacturing success', () => {
  const unknown = {
    ...receipt,
    status: 'outcome_unknown',
    code: 'outcome_unknown',
    items: [{ ...item, uncertain: true, state: 'not_present' }],
  };
  expect(parseAlarmReceipt(JSON.stringify(unknown), request).status).toBe(
    'outcome_unknown',
  );
});
test.each([
  { ...receipt, extra: true },
  { ...receipt, operationId: 'other' },
  { ...receipt, status: 'outcome_unknown', code: 'ok' },
  { ...receipt, items: [{ ...item, url: 'https://example.com' }] },
  { ...receipt, items: [item, item] },
  { ...receipt, items: [{ ...item, duration_seconds: 86401 }] },
  { ...receipt, items: [{ ...item, kind: 'notification' }] },
  { ...receipt, items: [{ ...item, state: 'delivered_to_iphone' }] },
  { ...receipt, items: [{ ...item, title: 'a\nb' }] },
])('rejects forged or incompatible fields %#', candidate => {
  expect(() => parseAlarmReceipt(JSON.stringify(candidate), request)).toThrow();
});
test('generates canonical operation IDs used as durable ownership references', () => {
  expect(newAlarmOperationId()).toMatch(
    /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/,
  );
});
describe('successful mutations acknowledge the exact approved alarm', () => {
  for (const action of ['create', 'update', 'stop', 'cancel'] as const) {
    const mutation = { ...request, action };
    const response = { ...receipt, action };
    test.each(
      [
        [],
        [{ ...item, alarm_id: '22222222-2222-4222-8222-222222222222' }],
        [{ ...item, uncertain: true }],
      ].map(items => ({ items })),
    )(
      `${action} rejects missing, foreign or uncertain targets %#`,
      ({ items }) => {
        expect(() =>
          parseAlarmReceipt(JSON.stringify({ ...response, items }), mutation),
        ).toThrow();
      },
    );
    test(`${action} accepts the target alongside other owned alarms`, () => {
      expect(
        parseAlarmReceipt(
          JSON.stringify({
            ...response,
            items: [
              item,
              { ...item, alarm_id: '22222222-2222-4222-8222-222222222222' },
            ],
          }),
          mutation,
        ).status,
      ).toBe('succeeded');
    });
  }
  test.each([
    { title: 'Café' },
    { duration_seconds: 600 },
    {
      kind: 'alarm',
      date_iso: '2027-01-15T09:00:00Z',
      duration_seconds: undefined,
    },
  ])('create/update reject changed approved configuration %#', changes => {
    for (const action of ['create', 'update'] as const) {
      expect(() =>
        parseAlarmReceipt(
          JSON.stringify({
            ...receipt,
            action,
            items: [{ ...item, ...changes }],
          }),
          { ...request, action },
        ),
      ).toThrow();
    }
  });
  test('keeps historical success and empty list receipts valid', () => {
    expect(
      parseAlarmReceipt(
        JSON.stringify({
          ...receipt,
          items: [{ ...item, state: 'not_present' }],
        }),
        request,
      ).status,
    ).toBe('succeeded');
    expect(
      parseAlarmReceipt(
        JSON.stringify({ ...receipt, action: 'list', items: [] }),
        { ...request, action: 'list' },
      ).items,
    ).toEqual([]);
  });
  test.each(['"status":"failed_safe",', '"st\\u0061tus":"failed_safe",'])(
    'rejects duplicate decoded envelope keys %s',
    duplicate => {
      expect(() =>
        parseAlarmReceipt(
          JSON.stringify(receipt).replace('{', `{${duplicate}`),
          request,
        ),
      ).toThrow();
    },
  );
});
