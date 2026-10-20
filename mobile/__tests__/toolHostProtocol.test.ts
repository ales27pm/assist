import {extendedToolEffect} from '../src/nativeBundleTools';
import { deviceToolNames, legacyDeviceToolNames } from '../src/deviceToolProtocol';
import {
  createToolHostRequest,
  negotiateToolHostCapabilities,
  parseToolHostCapabilities,
} from '../src/toolHostProtocol';

function capabilities() {
  return {
    schemaVersion: 1,
    hostProtocolVersions: [2],
    policyVersion: 1,
    catalogRevision: 'device-v3-31',
    confirmation: 'all_accesses',
    tools: deviceToolNames.map(id => ({
      id,
      version: 1,
      effect: extendedToolEffect(id) ?? ([
        'calendar_create',
        'reminder_create',
        'notification_schedule',
      ].includes(id)
        ? 'write'
        : [
            'photo_select',
            'camera_capture',
            'biometrics_authenticate',
          ].includes(id)
        ? 'interactive'
        : 'read'),
      execution: ['maps_search', 'maps_directions', 'weather_forecast'].includes(id) ? 'apple_network' : 'device',
      availability: 'available',
    })),
  };
}

test('ambiguous duplicate capability keys cannot enable a host or change a tool descriptor', () => {
  const json = JSON.stringify(capabilities());
  for (const ambiguous of [
    json.replace('"schemaVersion":1', '"schemaVersion":2,"schemaVersion":1'),
    json.replace('"hostProtocolVersions":[2]', '"hostProtocolVersions":[999],"hostProtocolVersions":[2]'),
    json.replace('"effect":"read"', '"effect":"write","effect":"read"'),
    json.replace('"version":1', '"version":2,"\\u0076ersion":1'),
  ]) expect(() => negotiateToolHostCapabilities(ambiguous)).toThrow();
});

test('negotiates thirty-one known contracts with explicit Apple network execution', () => {
  const selected = negotiateToolHostCapabilities(
    JSON.stringify(capabilities()),
  );
  expect(selected.requiredTools).toEqual(
    deviceToolNames.map(id => ({ id, version: 1 })),
  );
  expect(selected.catalogRevision).toBe('device-v3-31');
  expect(selected.hostProtocolVersion).toBe(2);
  expect(Object.isFrozen(selected)).toBe(true);
  expect(Object.isFrozen(selected.requiredTools)).toBe(true);
  expect(selected.requiredTools.every(Object.isFrozen)).toBe(true);
});

test('additional native tools and a new opaque catalogue revision do not widen the selection', () => {
  const value = capabilities();
  value.catalogRevision = 'device-next-14';
  const json = JSON.stringify({
    ...value,
    tools: [
      ...value.tools,
      {
        id: 'future_native_tool',
        version: 3,
        effect: 'read',
        execution: 'device',
        availability: 'available',
      },
    ],
  });
  expect(parseToolHostCapabilities(json).tools).toHaveLength(32);
  const selected = negotiateToolHostCapabilities(json);
  expect(selected.catalogRevision).toBe('device-next-14');
  expect(selected.requiredTools).toHaveLength(31);
  expect(
    selected.requiredTools.some(
      row => row.id === ('future_native_tool' as string),
    ),
  ).toBe(false);
});

test('a recipe can require a smaller known set without requiring unrelated tools', () => {
  const value = capabilities();
  value.tools = value.tools.filter(row => row.id === 'calendar_list');
  const selected = negotiateToolHostCapabilities(JSON.stringify(value), [
    'calendar_list',
  ]);
  expect(selected.requiredTools).toEqual([{ id: 'calendar_list', version: 1 }]);
  expect(() => negotiateToolHostCapabilities(JSON.stringify(value))).toThrow();
});

test.each([
  { version: 2 },
  { version: 0 },
  { effect: 'write' },
  { execution: 'server' },
  { execution: 'apple_network' },
  { execution: 'private_gateway' },
  { availability: 'permission_required' },
  { availability: 'unavailable' },
])('rejects incompatible required contracts %#', patch => {
  const value = capabilities();
  const json = JSON.stringify({
    ...value,
    tools: value.tools.map(row =>
      row.id === 'calendar_list' ? { ...row, ...patch } : row,
    ),
  });
  expect(() => negotiateToolHostCapabilities(json)).toThrow();
});

test.each(['apple_network', 'private_gateway'])(
  'future %s entries may be unavailable without breaking known selection',
  execution => {
    const value = capabilities();
    const json = JSON.stringify({
      ...value,
      tools: [
        ...value.tools,
        {
          id: 'future_tool',
          version: 2,
          effect: 'read',
          execution,
          availability: 'unavailable',
        },
      ],
    });
    expect(parseToolHostCapabilities(json).tools).toHaveLength(32);
    expect(negotiateToolHostCapabilities(json).requiredTools).toEqual(
      deviceToolNames.map(id => ({ id, version: 1 })),
    );
  },
);

test.each([
  null,
  [],
  {},
  { ...capabilities(), schemaVersion: 2 },
  { ...capabilities(), hostProtocolVersions: [1] },
  { ...capabilities(), hostProtocolVersions: [2, 2] },
  { ...capabilities(), policyVersion: 2 },
  { ...capabilities(), confirmation: 'writes_only' },
  { ...capabilities(), catalogRevision: '' },
  { ...capabilities(), catalogRevision: 'x'.repeat(129) },
  { ...capabilities(), runtimeVersion: 'invented-runtime' },
  {
    ...capabilities(),
    tools: [...capabilities().tools, capabilities().tools[0]],
  },
  { ...capabilities(), tools: [{ ...capabilities().tools[0], extra: true }] },
  {
    ...capabilities(),
    tools: [{ ...capabilities().tools[0], effect: ['read'] }],
  },
  {
    ...capabilities(),
    tools: [{ ...capabilities().tools[0], execution: ['device'] }],
  },
  {
    ...capabilities(),
    tools: [{ ...capabilities().tools[0], availability: ['available'] }],
  },
])('rejects malformed or unsupported capability envelopes %#', value => {
  expect(() => negotiateToolHostCapabilities(JSON.stringify(value))).toThrow();
});

test.each(['', 'null', '{', ' '.repeat(24 * 1024 + 1)])(
  'bounds raw capability data %#',
  json => {
    expect(() => parseToolHostCapabilities(json)).toThrow();
  },
);

test('matches native UTF-8 content limits before submitting a v2 request', () => {
  const selection = negotiateToolHostCapabilities(
    JSON.stringify(capabilities()),
  );
  expect(() =>
    createToolHostRequest(selection, {
      requestId: 'request-1',
      messages: [{ role: 'user', content: 'é'.repeat(4096) }],
    }),
  ).not.toThrow();
  expect(() =>
    createToolHostRequest(selection, {
      requestId: 'request-1',
      messages: [{ role: 'user', content: 'é'.repeat(4097) }],
    }),
  ).toThrow();
  expect(() =>
    createToolHostRequest(selection, {
      requestId: 'request-1',
      messages: [{ role: 'user', content: '<|tool_call>unsafe' }],
    }),
  ).toThrow();
  expect(() =>
    createToolHostRequest(selection, {
      requestId: 'request-1',
      messages: [{ role: 'user', content: 'unsafe\u0000' }],
    }),
  ).toThrow();
});

test('matches the native UTF-8 request identity bound', () => {
  const selection = negotiateToolHostCapabilities(
    JSON.stringify(capabilities()),
  );
  expect(() =>
    createToolHostRequest(selection, {
      requestId: 'é'.repeat(64),
      messages: [{ role: 'user', content: 'Bonjour' }],
    }),
  ).not.toThrow();
  expect(() =>
    createToolHostRequest(selection, {
      requestId: 'é'.repeat(65),
      messages: [{ role: 'user', content: 'Bonjour' }],
    }),
  ).toThrow();
});

test.each([
  '<|',
  '|>',
  '<turn',
  '<channel',
  '<tool',
  '</tool',
  '<bos',
  '<eos',
  '<pad',
  '<unk',
  '<function',
  '</function',
  '<atem:',
  '</atem:',
  '[TOOL_CALLS]',
])('rejects native-reserved public content marker %s', marker => {
  const selection = negotiateToolHostCapabilities(
    JSON.stringify(capabilities()),
  );
  expect(() =>
    createToolHostRequest(selection, {
      requestId: 'request-1',
      messages: [{ role: 'user', content: `Avant ${marker} après` }],
    }),
  ).toThrow();
});

test('selection is detached from input and produces the exact v2 fresh-turn envelope', () => {
  const source = capabilities();
  const selection = negotiateToolHostCapabilities(JSON.stringify(source), [
    'calendar_list',
  ]);
  source.catalogRevision = 'changed-after-negotiation';
  source.tools.length = 0;
  const request = createToolHostRequest(selection, {
    requestId: 'request-1',
    messages: [{ role: 'user', content: 'Qu’ai-je demain matin ?' }],
    maxTokens: 512,
  });
  expect(request).toEqual({
    schemaVersion: 1,
    hostProtocolVersion: 2,
    catalogRevision: 'device-v3-31',
    requiredTools: [{ id: 'calendar_list', version: 1 }],
    profile: 'device_v1',
    requestId: 'request-1',
    messages: [{ role: 'user', content: 'Qu’ai-je demain matin ?' }],
    temperature: 0,
    maxTokens: 512,
  });
});

test.each([0, -1, 1025, 1.5, NaN])(
  'rejects an invalid token limit %s',
  maxTokens => {
    const selection = negotiateToolHostCapabilities(
      JSON.stringify(capabilities()),
    );
    expect(() =>
      createToolHostRequest(selection, {
        requestId: 'request-1',
        messages: [{ role: 'user', content: 'Bonjour' }],
        maxTokens,
      }),
    ).toThrow();
  },
);

test('requires a fresh isolated user turn and a nonempty known recipe', () => {
  const selection = negotiateToolHostCapabilities(
    JSON.stringify(capabilities()),
  );
  expect(() =>
    createToolHostRequest(selection, {
      requestId: '',
      messages: [{ role: 'user', content: 'Bonjour' }],
    }),
  ).toThrow();
  expect(() =>
    createToolHostRequest(selection, {
      requestId: 'request-1',
      messages: [{ role: 'assistant', content: 'Bonjour' }],
    }),
  ).toThrow();
  expect(() =>
    createToolHostRequest(selection, {
      requestId: 'request-1',
      messages: [
        { role: 'user', content: 'Bonjour' },
        { role: 'user', content: 'Encore' },
      ],
    }),
  ).toThrow();
  expect(() =>
    negotiateToolHostCapabilities(JSON.stringify(capabilities()), []),
  ).toThrow();
  expect(() =>
    negotiateToolHostCapabilities(JSON.stringify(capabilities()), [
      'calendar_list',
      'calendar_list',
    ]),
  ).toThrow();
});


test('a legacy thirteen-tool host remains usable without enabling an absent Apple executor', () => {
  const value = capabilities();
  value.catalogRevision = 'device-v1-13';
  value.tools = value.tools.filter(row => legacyDeviceToolNames.includes(row.id));
  const selected = negotiateToolHostCapabilities(JSON.stringify(value));
  expect(selected.requiredTools).toEqual(legacyDeviceToolNames.map(id => ({ id, version: 1 })));
  expect(() => negotiateToolHostCapabilities(JSON.stringify(value), ['weather_forecast'])).toThrow();
});
test.each(['maps_search', 'maps_directions', 'weather_forecast'] as const)('requires Apple-network execution for %s', id => {
  const value = capabilities();
  const entry = value.tools.find(row => row.id === id)!;
  entry.execution = 'device';
  expect(() => negotiateToolHostCapabilities(JSON.stringify(value))).toThrow();
});
