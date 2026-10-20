import {
  acceptDeviceToolActivity,
  DeviceToolActivity,
  DeviceToolName,
  DeviceToolReceipt,
  DeviceToolTransaction,
  deviceToolNames,
  legacyDeviceToolNames,
  deviceToolPublicAnswer,
  interruptDeviceToolActivity,
  parseDeviceToolActivity,
  parseDeviceToolCapabilities,
  parseDeviceToolResult,
  parseToolConfirmation,
  parseToolOperations,
} from '../src/deviceToolProtocol';

const capabilities = {
  schemaVersion: 1,
  protocolVersion: 1,
  confirmation: 'all_accesses',
  tools: [...legacyDeviceToolNames],
};
function encode(value: unknown): string {
  return JSON.stringify(value) ?? 'undefined';
}
function receipt(extra: Partial<DeviceToolReceipt> = {}): DeviceToolReceipt {
  return {
    operationId: 'operation-1',
    tool: 'calendar_create',
    status: 'success',
    completedAt: '2026-10-18T18:00:00Z',
    summary: [{ label: 'État', value: 'Création confirmée par iOS' }],
    ...extra,
  };
}
function activity(
  status: DeviceToolTransaction['status'] = 'awaiting_confirmation',
  extra: Partial<DeviceToolTransaction> = {},
): DeviceToolActivity {
  return {
    schemaVersion: 1,
    requestId: 'request-1',
    transaction: {
      id: 'operation-1',
      revision: 1,
      tool: 'calendar_create',
      effect: 'write',
      title: 'Créer un événement',
      status,
      preview: [{ label: 'Titre', value: 'Réunion {équipe}, "édition"' }],
      ...(status === 'awaiting_confirmation'
        ? { confirmationToken: 'private-consent-token' }
        : {}),
      ...(status === 'awaiting_permission'
        ? { capability: 'calendar' as const }
        : {}),
      ...(['success', 'outcome_unknown'].includes(status)
        ? {
            receipt: receipt({
              status: status as 'success' | 'outcome_unknown',
            }),
          }
        : {}),
      ...extra,
    },
  };
}
function parsed(event = activity()) {
  return parseDeviceToolActivity(encode(event));
}
const generation = {
  requestId: 'request-1',
  text: 'Voici le résultat confirmé.',
  generatedTokens: 12,
  promptTokens: 64,
  elapsedMs: 320,
  finishReason: 'eos',
  aneExecution: 'unverified',
  agentTools: true,
};

describe('closed native handshake', () => {
  test('requires exactly the thirteen known tools and explicit consent protocol', () => {
    expect(deviceToolNames).toHaveLength(31);
    expect(legacyDeviceToolNames).toHaveLength(13);
    expect(parseDeviceToolCapabilities(encode(capabilities))).toBe(true);
    expect(
      parseDeviceToolCapabilities(
        encode({ ...capabilities, tools: [...legacyDeviceToolNames].reverse() }),
      ),
    ).toBe(true);
  });
  test.each([
    null,
    [],
    {},
    false,
    { ...capabilities, schemaVersion: 2 },
    { ...capabilities, schemaVersion: '1' },
    { ...capabilities, protocolVersion: 0 },
    { ...capabilities, confirmation: 'writes_only' },
    { ...capabilities, tools: deviceToolNames.slice(1) },
    { ...capabilities, tools: [...deviceToolNames, 'calendar_delete'] },
    {
      ...capabilities,
      tools: [...deviceToolNames.slice(1), deviceToolNames[1]],
    },
    {
      ...capabilities,
      tools: [...deviceToolNames.slice(1), 'calendar_delete'],
    },
    { ...capabilities, tools: 'all' },
    { ...capabilities, extra: true },
  ])('rejects incompatible or widened handshake %#', value => {
    expect(() => parseDeviceToolCapabilities(encode(value))).toThrow();
  });
  test.each(Object.keys(capabilities))('rejects missing handshake %s', key => {
    const missing: Record<string, unknown> = { ...capabilities };
    delete missing[key];
    expect(() => parseDeviceToolCapabilities(encode(missing))).toThrow();
  });
});

describe('strict native activity and receipt', () => {
  test.each([
    'awaiting_confirmation',
    'awaiting_permission',
    'executing',
    'success',
    'failed_safe',
    'outcome_unknown',
    'cancelled',
  ] as const)('accepts a valid %s observation', status => {
    expect(parsed(activity(status))).toEqual(activity(status));
  });
  test.each(deviceToolNames)('enforces the native effect for %s', tool => {
    const effect = [
      'calendar_create',
      'reminder_create',
      'notification_schedule',
      'alarm_create', 'alarm_update', 'alarm_stop', 'alarm_cancel', 'document_index', 'document_unindex',
    ].includes(tool)
      ? 'write'
      : ['photo_select', 'camera_capture', 'biometrics_authenticate', 'text_translate', 'document_scan', 'document_export_pdf', 'document_preview', 'message_compose'].includes(
          tool,
        )
      ? 'interactive'
      : 'read';
    expect(
      parsed(activity('executing', { tool, effect })).transaction.effect,
    ).toBe(effect);
    expect(() =>
      parsed(
        activity('executing', {
          tool,
          effect: effect === 'write' ? 'read' : 'write',
        }),
      ),
    ).toThrow();
  });
  test.each([
    { schemaVersion: 2 },
    { requestId: '' },
    { requestId: 'x'.repeat(129) },
    { requestId: '<request>' },
    { extra: true },
  ])('rejects invalid activity envelope %#', extra => {
    expect(() =>
      parseDeviceToolActivity(encode({ ...activity(), ...extra })),
    ).toThrow();
  });
  test.each(['schemaVersion', 'requestId', 'transaction'])(
    'rejects missing activity %s',
    key => {
      const missing: Record<string, unknown> = { ...activity() };
      delete missing[key];
      expect(() => parseDeviceToolActivity(encode(missing))).toThrow();
    },
  );
  test.each(['id', 'revision', 'tool', 'effect', 'title', 'status', 'preview'])(
    'rejects missing transaction %s',
    key => {
      const missing: Record<string, unknown> = { ...activity().transaction };
      delete missing[key];
      expect(() =>
        parseDeviceToolActivity(
          encode({ ...activity(), transaction: missing }),
        ),
      ).toThrow();
    },
  );
  test.each([
    { id: '' },
    { id: 'x'.repeat(129) },
    { revision: 0 },
    { revision: 129 },
    { revision: 1.5 },
    { revision: '1' },
    { tool: 'calendar_delete' },
    { title: '' },
    { title: ' \t' },
    { title: 'x'.repeat(129) },
    { status: 'done' },
    { preview: {} },
    { preview: Array.from({ length: 11 }, () => ({ label: 'a', value: 'b' })) },
    { preview: [{ label: '', value: 'ok' }] },
    { preview: [{ label: 'x'.repeat(129), value: 'ok' }] },
    { preview: [{ label: 'ok', value: 'x'.repeat(4097) }] },
    { preview: [{ label: 'ok', value: 1 }] },
    { preview: [{ label: 'ok', value: 'ok', hidden: 'not allowed' }] },
    { capability: 'microphone' },
    { extra: true },
  ])('rejects malformed transaction %#', extra => {
    expect(() =>
      parseDeviceToolActivity(
        encode({
          ...activity(),
          transaction: { ...activity().transaction, ...extra },
        }),
      ),
    ).toThrow();
  });
  test('accepts the explicit identifier, revision, field and text boundaries', () => {
    const event = activity('awaiting_confirmation', {
      id: 'i'.repeat(128),
      revision: 128,
      title: 't'.repeat(128),
      confirmationToken: 'c'.repeat(128),
      preview: Array.from({ length: 10 }, () => ({
        label: 'l'.repeat(128),
        value: 'v'.repeat(4096),
      })),
    });
    event.transaction.preview = event.transaction.preview.slice(0, 1);
    event.requestId = 'r'.repeat(128);
    expect(parsed(event)).toEqual(event);
    expect(
      parsed(
        activity('executing', {
          preview: Array.from({ length: 10 }, () => ({
            label: 'a',
            value: 'b',
          })),
        }),
      ),
    ).toBeDefined();
  });
  test('rejects oversized wire JSON before processing its fields', () => {
    expect(() => parseDeviceToolActivity(' '.repeat(32769))).toThrow();
  });
  test.each([
    '\u0000',
    '\u001b',
    '\r',
    '\u007f',
    '<|tool_call>',
    '<tool_call|>',
  ])(
    'rejects control or protocol marker %j in all human-facing fields',
    marker => {
      for (const extra of [
        { title: `bad${marker}` },
        { preview: [{ label: `bad${marker}`, value: 'ok' }] },
        { preview: [{ label: 'ok', value: `bad${marker}` }] },
      ]) {
        expect(() => parsed(activity('executing', extra))).toThrow();
      }
      expect(() =>
        parsed(
          activity('success', {
            receipt: receipt({
              summary: [{ label: 'État', value: `bad${marker}` }],
            }),
          }),
        ),
      ).toThrow();
    },
  );
  test('requires a private token only while consent is pending', () => {
    expect(() =>
      parsed(
        activity('awaiting_confirmation', { confirmationToken: undefined }),
      ),
    ).toThrow();
    expect(() =>
      parsed(activity('awaiting_confirmation', { confirmationToken: '' })),
    ).toThrow();
    expect(() =>
      parsed(activity('executing', { confirmationToken: 'stale-token' })),
    ).toThrow();
    expect(() =>
      parsed(activity('awaiting_permission', { capability: undefined })),
    ).toThrow();
  });
  test.each([
    { operationId: 'different-operation' },
    { tool: 'reminder_create' as DeviceToolName },
    { status: 'outcome_unknown' as const },
    { completedAt: 'not-a-date' },
    { completedAt: '2026-02-30T12:00:00Z' },
    { completedAt: '2026-10-18T24:00:00Z' },
    { completedAt: '2026-10-18T14:00:00-04:00' },
    { completedAt: '2026-10-18T18:00:00.1Z' },
    { completedAt: '0000-01-01T00:00:00Z' },
    { summary: [{ label: 'ok', value: 'x'.repeat(4097) }] },
  ])('rejects mismatched or invalid native receipt %#', extra => {
    expect(() =>
      parsed(activity('success', { receipt: receipt(extra) })),
    ).toThrow();
  });
  test.each(Object.keys(receipt()))('rejects receipt missing %s', key => {
    const missing: Record<string, unknown> = { ...receipt() };
    delete missing[key];
    expect(() =>
      parseDeviceToolActivity(
        encode({
          ...activity('success'),
          transaction: { ...activity('success').transaction, receipt: missing },
        }),
      ),
    ).toThrow();
  });
  test('success and uncertainty require matching native proof, never model prose', () => {
    expect(() => parsed(activity('success', { receipt: undefined }))).toThrow();
    expect(() =>
      parsed(activity('outcome_unknown', { receipt: undefined })),
    ).toThrow();
    expect(() =>
      parsed(activity('executing', { receipt: receipt() })),
    ).toThrow();
    expect(
      parsed(
        activity('success', {
          receipt: receipt({ completedAt: '2026-10-18T18:00:00.123Z' }),
        }),
      ).transaction.receipt,
    ).toBeDefined();
  });
});

describe('immutable consent and interruption', () => {
  test('accepts newer observations without mutating the frozen preview', () => {
    const previous = parsed();
    const next = parsed(activity('executing', { revision: 2 }));
    const snapshot = encode(previous);
    Object.freeze(previous.transaction.preview[0]);
    Object.freeze(previous.transaction.preview);
    Object.freeze(previous.transaction);
    Object.freeze(previous);
    expect(acceptDeviceToolActivity(undefined, previous)).toBe(true);
    expect(acceptDeviceToolActivity(previous, next)).toBe(true);
    expect(encode(previous)).toBe(snapshot);
  });
  test.each([
    { id: 'different' },
    { tool: 'reminder_create' as const },
    { effect: 'read' as const },
    { title: 'Changed' },
    { capability: 'calendar' as const },
    { preview: [] },
    { preview: [{ label: 'Titre', value: 'Changed' }] },
    { preview: [{ label: 'Changed', value: 'Réunion {équipe}, "édition"' }] },
    { revision: 1 },
    { revision: 0 },
    { status: 'awaiting_confirmation' as const },
    { status: 'awaiting_permission' as const },
  ])('rejects replay or mutated operation identity/consent %#', change => {
    const previous = activity();
    const next = activity('executing', { revision: 2, ...change });
    expect(acceptDeviceToolActivity(previous, next)).toBe(false);
  });
  test('rejects another request and reordered preview fields', () => {
    const previous = activity();
    expect(
      acceptDeviceToolActivity(previous, {
        ...activity('executing', { revision: 2 }),
        requestId: 'other-request',
      }),
    ).toBe(false);
    previous.transaction.preview.push({ label: 'Début', value: '18 octobre' });
    const next = activity('executing', {
      revision: 2,
      preview: [...previous.transaction.preview].reverse(),
    });
    expect(acceptDeviceToolActivity(previous, next)).toBe(false);
  });
  test.each([
    'success',
    'outcome_unknown',
    'failed_safe',
    'cancelled',
  ] as const)('terminal %s cannot be reopened', status => {
    const previous = activity(status, { revision: 3 });
    expect(
      acceptDeviceToolActivity(
        previous,
        activity('executing', { revision: 4 }),
      ),
    ).toBe(false);
    expect(interruptDeviceToolActivity(previous)).toBe(previous);
  });
  test.each(['read', 'interactive'] as const)(
    'an executing %s stops without claiming a write outcome',
    effect => {
      const event = activity('executing', { effect, receipt: undefined });
      const stopped = interruptDeviceToolActivity(event);
      expect(stopped.transaction.status).toBe('cancelled');
      expect(stopped.transaction.confirmationToken).toBeUndefined();
      expect(stopped.transaction.receipt).toBeUndefined();
      expect(event.transaction.status).toBe('executing');
    },
  );
  test('an executing write becomes uncertain, not safe to repeat or falsely successful', () => {
    const event = activity('executing');
    const stopped = interruptDeviceToolActivity(event);
    expect(stopped.transaction.status).toBe('outcome_unknown');
    expect(stopped.transaction.receipt).toBeUndefined();
    expect(stopped.transaction.confirmationToken).toBeUndefined();
    expect(deviceToolPublicAnswer('C’est créé !', [stopped])).toMatch(
      /peut-être.*pas confirmé/,
    );
    expect(deviceToolPublicAnswer('C’est créé !', [stopped])).toContain(
      'Aucun nouvel essai automatique',
    );
  });
  test.each(['document_scan', 'document_export_pdf', 'message_compose'] as const)(
    'interruption preserves uncertainty after %s hands control to Apple', tool => {
      const event = activity('executing', {tool, effect: 'interactive', receipt: undefined});
      const stopped = interruptDeviceToolActivity(event);
      expect(stopped.transaction.status).toBe('outcome_unknown');
      expect(stopped.transaction.confirmationToken).toBeUndefined();
      expect(stopped.transaction.receipt).toBeUndefined();
      expect(interruptDeviceToolActivity(activity('awaiting_confirmation', {tool, effect: 'interactive'})).transaction.status).toBe('cancelled');
      expect(deviceToolPublicAnswer('Message envoyé', [stopped])).toContain('Aucun nouvel essai automatique');
    },
  );
  test('stopping an unconfirmed proposal revokes its token without inventing an effect', () => {
    const stopped = interruptDeviceToolActivity(activity());
    expect(stopped.transaction.status).toBe('cancelled');
    expect(stopped.transaction.confirmationToken).toBeUndefined();
  });
  test('permission UI may be preserved explicitly but never turns into consent', () => {
    const event = activity('awaiting_permission');
    expect(interruptDeviceToolActivity(event, true)).toBe(event);
    expect(interruptDeviceToolActivity(event).transaction.status).toBe(
      'cancelled',
    );
  });
  test('uncertainty in any operation overrides model success while proven results remain unchanged', () => {
    expect(
      deviceToolPublicAnswer('Tout est réussi.', [
        activity('success'),
        activity('outcome_unknown'),
      ]),
    ).not.toBe('Tout est réussi.');
    expect(
      deviceToolPublicAnswer('Résultat natif confirmé.', [activity('success')]),
    ).toBe('Résultat natif confirmé.');
    expect(deviceToolPublicAnswer('Je ne sais pas.', [])).toBe(
      'Je ne sais pas.',
    );
  });
});

describe('confirmation, durable journal and final public result', () => {
  test.each([true, false])(
    'accepts explicit native confirmation %s',
    accepted => {
      expect(
        parseToolConfirmation(encode({ schemaVersion: 1, accepted })),
      ).toBe(accepted);
    },
  );
  test.each([
    {},
    { schemaVersion: 2, accepted: true },
    { schemaVersion: 1, accepted: 'true' },
    { schemaVersion: 1, accepted: true, token: 'leak' },
  ])('rejects malformed confirmation %#', value => {
    expect(() => parseToolConfirmation(encode(value))).toThrow();
  });
  test.each([0, 1, 100])(
    'accepts exactly %i bounded unique journal operations',
    count => {
      const operations = Array.from({ length: count }, (_, index) =>
        receipt({ operationId: `operation-${index}`, summary: [] }),
      );
      expect(
        parseToolOperations(encode({ schemaVersion: 1, operations })),
      ).toEqual(operations);
    },
  );
  test.each([
    { schemaVersion: 1, operations: [receipt(), receipt()] },
    {
      schemaVersion: 1,
      operations: Array.from({ length: 101 }, (_, index) =>
        receipt({ operationId: `op-${index}`, summary: [] }),
      ),
    },
    {
      schemaVersion: 1,
      operations: [receipt({ status: 'outcome_unknown', completedAt: 'bad' })],
    },
    { schemaVersion: 1, operations: {} },
    { schemaVersion: 2, operations: [] },
    { schemaVersion: 1, operations: [], extra: true },
  ])('rejects duplicate, widened or oversized native journal %#', value => {
    expect(() => parseToolOperations(encode(value))).toThrow();
  });
  test('generic tool result requires the explicit native flag and preserves provenance', () => {
    expect(parseDeviceToolResult(encode(generation))).toEqual(generation);
    for (const agentTools of [undefined, false, 'true', 1]) {
      expect(() =>
        parseDeviceToolResult(encode({ ...generation, agentTools })),
      ).toThrow();
    }
  });
  test.each([
    '<|tool_call>',
    '<tool_call|>',
    '<tool_',
    '<channel',
    '<turn',
    '\u0000',
    '\u001b',
    '\u007f',
    '\u0080',
  ])('rejects protocol/control content in public answer %j', marker => {
    expect(() =>
      parseDeviceToolResult(
        encode({ ...generation, text: `Réponse ${marker}` }),
      ),
    ).toThrow();
  });
  test('enforces the same 8192 UTF8-byte public boundary as native Swift', () => {
    expect(
      parseDeviceToolResult(encode({ ...generation, text: 'a'.repeat(8192) }))
        .text,
    ).toHaveLength(8192);
    expect(
      parseDeviceToolResult(encode({ ...generation, text: 'é'.repeat(4096) }))
        .text,
    ).toHaveLength(4096);
    expect(() =>
      parseDeviceToolResult(encode({ ...generation, text: 'a'.repeat(8193) })),
    ).toThrow();
    expect(() =>
      parseDeviceToolResult(encode({ ...generation, text: 'é'.repeat(4097) })),
    ).toThrow();
  });
});

const forecastEvidence = {
  schemaVersion: 1,
  requestId: 'operation-1',
  coordinate: { latitude: 46.8139, longitude: -71.208 },
  temperatureUnit: 'celsius',
  retrievedAt: '2026-10-19T12:00:00Z',
  attribution: {
    serviceName: 'Apple Weather',
    legalPageURL: 'https://weatherkit.apple.com/legal-attribution.html',
    combinedMarkLightURL: 'https://weatherkit.apple.com/light.png',
    combinedMarkDarkURL: 'https://weatherkit.apple.com/dark.png',
    legalAttributionText: 'Apple Weather',
  },
  current: { date: '2026-10-19T12:00:00Z', condition: 'Clear', symbolName: 'sun.max', temperature: 10, apparentTemperature: 9, humidity: 0.5, windKilometersPerHour: 3 },
  hourly: [], daily: [], forecastNotGuarantee: true,
};

test('a validated weather receipt binds its forecast to the native operation and survives final-only delivery', () => {
  const event = activity('success', {
    tool: 'weather_forecast', effect: 'read',
    receipt: receipt({ tool: 'weather_forecast' }),
    weather: forecastEvidence as DeviceToolTransaction['weather'],
  });
  expect(parseDeviceToolActivity(encode(event))).toEqual(event);
  expect(parseDeviceToolResult(encode({ ...generation, weather: [forecastEvidence] })).weather).toEqual([forecastEvidence]);
  expect(() => parseDeviceToolActivity(encode({ ...event, transaction: { ...event.transaction, weather: undefined } }))).toThrow();
  expect(() => parseDeviceToolActivity(encode({ ...event, transaction: { ...event.transaction, weather: { ...forecastEvidence, requestId: 'another-operation' } } }))).toThrow();
});

test.each([
  { ...forecastEvidence, coordinate: { latitude: 91, longitude: 0 } },
  { ...forecastEvidence, temperatureUnit: 'kelvin' },
  { ...forecastEvidence, forecastNotGuarantee: false },
  { ...forecastEvidence, attribution: { ...forecastEvidence.attribution, combinedMarkLightURL: 'https://evil.example/apple.png' } },
  { ...forecastEvidence, current: { ...forecastEvidence.current, humidity: 2 } },
  { ...forecastEvidence, current: { ...forecastEvidence.current, condition: '<|tool_call>' } },
  { ...forecastEvidence, extra: true },
])('rejects malformed native weather evidence before it reaches cards or the presentation gate %#', weather => {
  expect(() => parseDeviceToolResult(encode({ ...generation, weather: [weather] }))).toThrow();
});
test('rejects duplicate or oversized final weather receipt collections', () => {
  expect(() => parseDeviceToolResult(encode({ ...generation, weather: [forecastEvidence, forecastEvidence] }))).toThrow();
  expect(() => parseDeviceToolResult(encode({ ...generation, weather: Array(5).fill(forecastEvidence) }))).toThrow();
});
