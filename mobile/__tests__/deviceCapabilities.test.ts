import NativeAssist from '../specs/NativeAssist';
import {
  getDeviceCapabilityStatus,
  getCurrentLocation,
  listCalendarEvents,
  listReminders,
  requestDeviceCapability,
  searchContacts,
} from '../src/deviceCapabilities';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    getDeviceCapabilityStatus: jest.fn(),
    getCurrentLocation: jest.fn(),
    requestDeviceCapability: jest.fn(),
    searchContacts: jest.fn(),
    listCalendarEvents: jest.fn(),
    listReminders: jest.fn(),
  },
}));

const native = jest.mocked(NativeAssist!);
const capabilityStates = {
  contacts: 'notDetermined',
  calendar: 'authorized',
  reminders: 'authorized',
  location: 'authorizedWhenInUse',
  camera: 'denied',
  notifications: 'provisional',
  biometrics: { available: true, type: 'faceId', errorCode: 0 },
};

describe('device capability bridge', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads permission state without requesting a capability', async () => {
    native.getDeviceCapabilityStatus.mockResolvedValue(
      JSON.stringify({
        capabilities: capabilityStates,
        boundaries: {
          telephony: { supported: false, reason: 'iOS limitation' },
        },
      }),
    );

    await expect(getDeviceCapabilityStatus()).resolves.toMatchObject({
      capabilities: { contacts: 'notDetermined' },
    });
    expect(native.requestDeviceCapability).not.toHaveBeenCalled();
  });

  it('requests exactly the capability chosen by the caller', async () => {
    native.requestDeviceCapability.mockResolvedValue(
      JSON.stringify({
        capability: 'location',
        status: 'authorizedWhenInUse',
      }),
    );

    await expect(requestDeviceCapability('location')).resolves.toEqual({
      capability: 'location',
      status: 'authorizedWhenInUse',
    });
    expect(native.requestDeviceCapability).toHaveBeenCalledWith('location');
  });

  it('bounds contact and calendar reads before entering native code', async () => {
    await expect(searchContacts('Alice', 51)).rejects.toThrow('entre 1 et 50');
    expect(native.searchContacts).not.toHaveBeenCalled();

    native.listCalendarEvents.mockResolvedValue(JSON.stringify({ events: [] }));
    await expect(
      listCalendarEvents('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'),
    ).resolves.toEqual({ events: [] });
    expect(native.listCalendarEvents).toHaveBeenCalledWith(
      '',
      '2026-10-01T00:00:00Z',
      '2026-10-02T00:00:00Z',
      '20',
    );
  });

  it('requires and forwards an explicit bounded reminder interval', async () => {
    native.listReminders.mockResolvedValue(
      JSON.stringify({
        reminders: [],
        startISO: '2026-10-01T00:00:00Z',
        endISO: '2026-10-02T00:00:00Z',
      }),
    );

    await expect(
      listReminders({
        startISO: '2026-10-01T00:00:00Z',
        endISO: '2026-10-02T00:00:00Z',
        includeCompleted: true,
        limit: 3,
      }),
    ).resolves.toEqual({
      reminders: [],
      startISO: '2026-10-01T00:00:00Z',
      endISO: '2026-10-02T00:00:00Z',
    });
    expect(native.listReminders).toHaveBeenCalledWith(
      true,
      '2026-10-01T00:00:00Z',
      '2026-10-02T00:00:00Z',
      '3',
    );
  });
});

describe('native location and capability receipts are validated before UI consumption', () => {
  const location = {
    latitude: 45.5,
    longitude: -73.5,
    horizontalAccuracy: 12,
    timestampISO: '2026-10-18T12:00:00Z',
  };
  test.each([
    { latitude: 91 },
    { latitude: -91 },
    { longitude: 181 },
    { longitude: -181 },
    { horizontalAccuracy: -1 },
    { timestampISO: 'not-a-timestamp' },
    { timestampISO: '2026-02-30T12:00:00Z' },
  ])('rejects malformed location %#', async changes => {
    native.getCurrentLocation.mockResolvedValue(
      JSON.stringify({ ...location, ...changes }),
    );
    await expect(getCurrentLocation()).rejects.toThrow();
  });
  test.each([
    { latitude: 90, longitude: 180 },
    { latitude: -90, longitude: -180 },
  ])('accepts geographic boundary %#', async changes => {
    native.getCurrentLocation.mockResolvedValue(
      JSON.stringify({ ...location, ...changes }),
    );
    await expect(getCurrentLocation()).resolves.toMatchObject(changes);
  });
  test.each([
    {},
    { ...capabilityStates, contacts: 'totallyGranted' },
    { ...capabilityStates, camera: 'limited' },
    { ...capabilityStates, notifications: 'checkRequired' },
  ])(
    'rejects missing or invented permission inventory %#',
    async capabilities => {
      native.getDeviceCapabilityStatus.mockResolvedValue(
        JSON.stringify({ capabilities, boundaries: {} }),
      );
      await expect(getDeviceCapabilityStatus()).rejects.toThrow();
    },
  );
  test.each([
    ['contacts', 'limited'],
    ['calendar', 'writeOnly'],
    ['reminders', 'writeOnly'],
    ['location', 'authorizedAlways'],
    ['notifications', 'ephemeral'],
  ])('keeps native %s=%s statuses', async (name, value) => {
    native.getDeviceCapabilityStatus.mockResolvedValue(
      JSON.stringify({
        capabilities: { ...capabilityStates, [name]: value },
        boundaries: {},
      }),
    );
    await expect(getDeviceCapabilityStatus()).resolves.toMatchObject({
      capabilities: { [name]: value },
    });
  });
  test.each(['faceID', 'futureSensor', 'authenticated'])(
    'rejects biometric type outside the native enum: %s',
    async type => {
      native.getDeviceCapabilityStatus.mockResolvedValue(
        JSON.stringify({
          capabilities: {
            ...capabilityStates,
            biometrics: { available: true, type, errorCode: 0 },
          },
          boundaries: {},
        }),
      );
      await expect(getDeviceCapabilityStatus()).rejects.toThrow();
    },
  );
  test.each(['faceId', 'touchId', 'opticId', 'none', 'unknown'])(
    'accepts native biometric type %s',
    async type => {
      native.getDeviceCapabilityStatus.mockResolvedValue(
        JSON.stringify({
          capabilities: {
            ...capabilityStates,
            biometrics: { available: type.endsWith('Id'), type, errorCode: 0 },
          },
          boundaries: {},
        }),
      );
      await expect(getDeviceCapabilityStatus()).resolves.toMatchObject({
        capabilities: { biometrics: { type } },
      });
    },
  );
});

describe('closed calendar read boundary', () => {
  const startISO = '2026-10-01T00:00:00Z';
  const endISO = '2026-10-02T00:00:00Z';
  const event = {
    id: 'private-event-id',
    calendarId: 'private-calendar-id',
    calendarTitle: 'Personal',
    title: 'Dentiste',
    startISO: '2026-10-01T10:00:00Z',
    endISO: '2026-10-01T10:30:00Z',
    allDay: false,
  };

  beforeEach(() => jest.clearAllMocks());

  it('accepts a complete bounded native event', async () => {
    native.listCalendarEvents.mockResolvedValue(
      JSON.stringify({ events: [event] }),
    );
    await expect(
      listCalendarEvents(startISO, endISO, { limit: 5 }),
    ).resolves.toEqual({ events: [event] });
  });

  it.each([
    ['missing time zone', '2026-10-01T00:00:00', endISO],
    ['impossible date', '2026-02-30T00:00:00Z', '2026-03-02T00:00:00Z'],
    ['equal boundaries', startISO, startISO],
    ['reversed boundaries', endISO, startISO],
    ['over one year', startISO, '2027-10-03T00:00:00Z'],
  ])('rejects %s before calling EventKit', async (_label, start, end) => {
    await expect(
      listCalendarEvents(start, end, { limit: 5 }),
    ).rejects.toThrow();
    expect(native.listCalendarEvents).not.toHaveBeenCalled();
  });

  it('rejects unknown options and overlong calendar identifiers before calling native', async () => {
    await expect(
      listCalendarEvents(startISO, endISO, { limit: 5, write: true } as never),
    ).rejects.toThrow();
    await expect(
      listCalendarEvents(startISO, endISO, { calendarId: 'x'.repeat(513) }),
    ).rejects.toThrow();
    expect(native.listCalendarEvents).not.toHaveBeenCalled();
  });

  it.each([null, true, '5', 5.5, 0, 51])(
    'rejects the non-integer or out-of-range limit %s before calling native',
    async limit => {
      await expect(
        listCalendarEvents(startISO, endISO, { limit } as never),
      ).rejects.toThrow();
      expect(native.listCalendarEvents).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['wrong result collection', { events: {} }],
    ['extra result field', { events: [], notes: 'private' }],
    ['missing event field', { events: [{ ...event, allDay: undefined }] }],
    ['unexpected event field', { events: [{ ...event, notes: 'private' }] }],
    ['non-string title', { events: [{ ...event, title: 42 }] }],
    ['non-boolean allDay', { events: [{ ...event, allDay: 1 }] }],
    ['invalid timestamp', { events: [{ ...event, startISO: '2026-10-01' }] }],
    [
      'reversed event dates',
      {
        events: [{ ...event, startISO: event.endISO, endISO: event.startISO }],
      },
    ],
    [
      'event outside the period',
      {
        events: [
          { ...event, startISO: endISO, endISO: '2026-10-03T00:00:00Z' },
        ],
      },
    ],
    ['overlong title', { events: [{ ...event, title: 'é'.repeat(1_025) }] }],
    ['overlong identifier', { events: [{ ...event, id: 'x'.repeat(513) }] }],
    ['too many events', { events: Array.from({ length: 6 }, () => event) }],
  ])('rejects %s in a native result', async (_label, response) => {
    native.listCalendarEvents.mockResolvedValue(JSON.stringify(response));
    await expect(
      listCalendarEvents(startISO, endISO, { limit: 5 }),
    ).rejects.toThrow('Réponse native invalide');
  });

  it('accepts overlapping and zero-duration events without requiring chronological order', async () => {
    const overlapping = {
      ...event,
      startISO: '2026-09-30T23:00:00Z',
      endISO: '2026-10-01T01:00:00Z',
    };
    const instant = {
      ...event,
      startISO: '2026-10-01T12:00:00.000Z',
      endISO: '2026-10-01T12:00:00.000Z',
    };
    const events = [instant, overlapping];
    native.listCalendarEvents.mockResolvedValue(JSON.stringify({ events }));
    await expect(
      listCalendarEvents(startISO, endISO, { limit: 5 }),
    ).resolves.toEqual({ events });
  });

  it('does not request permission or retry a denied read', async () => {
    native.listCalendarEvents.mockRejectedValue(
      Object.assign(new Error('private native detail'), {
        code: 'E_PERMISSION',
      }),
    );
    await expect(
      listCalendarEvents(startISO, endISO, { limit: 5 }),
    ).rejects.toMatchObject({ code: 'E_PERMISSION' });
    expect(native.requestDeviceCapability).not.toHaveBeenCalled();
    expect(native.listCalendarEvents).toHaveBeenCalledTimes(1);
  });
});
