import NativeAssist from '../specs/NativeAssist';
import {
  getDeviceCapabilityStatus,
  listCalendarEvents,
  listReminders,
  requestDeviceCapability,
  searchContacts,
} from '../src/deviceCapabilities';

jest.mock('../specs/NativeAssist', () => ({
  __esModule: true,
  default: {
    getDeviceCapabilityStatus: jest.fn(),
    requestDeviceCapability: jest.fn(),
    searchContacts: jest.fn(),
    listCalendarEvents: jest.fn(),
    listReminders: jest.fn(),
  },
}));

const native = jest.mocked(NativeAssist!);

describe('device capability bridge', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads permission state without requesting a capability', async () => {
    native.getDeviceCapabilityStatus.mockResolvedValue(
      JSON.stringify({
        capabilities: { contacts: 'notDetermined' },
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
