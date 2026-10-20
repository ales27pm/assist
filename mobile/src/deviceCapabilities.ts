import NativeAssist from '../specs/NativeAssist';
import { parseUniqueJSON } from './uniqueJSON';

/** iOS capabilities deliberately exposed by Assist's native bridge. */
export type DeviceCapability =
  | 'contacts'
  | 'calendar'
  | 'reminders'
  | 'location'
  | 'camera'
  | 'notifications'
  | 'biometrics';

export type PermissionStatus =
  | 'authorized'
  | 'authorizedAlways'
  | 'authorizedWhenInUse'
  | 'limited'
  | 'provisional'
  | 'ephemeral'
  | 'writeOnly'
  | 'notDetermined'
  | 'denied'
  | 'restricted'
  | 'unavailable';

export type NativeBoundary = {
  supported: false;
  reason: string;
};

export type CapabilitySnapshot = {
  capabilities: Record<
    DeviceCapability,
    PermissionStatus | { available: boolean; type: string }
  >;
  boundaries: Record<string, NativeBoundary>;
};

export type ContactMatch = {
  id: string;
  givenName: string;
  familyName: string;
  organizationName: string;
  phoneNumbers: Array<{ label: string; value: string }>;
  emailAddresses: Array<{ label: string; value: string }>;
};

export type CalendarEvent = {
  id: string;
  calendarId: string;
  calendarTitle: string;
  title: string;
  startISO: string;
  endISO: string;
  allDay: boolean;
};

export type Reminder = {
  id: string;
  calendarId: string;
  calendarTitle: string;
  title: string;
  completed: boolean;
  dueISO?: string;
};

export type ImageAttachment = {
  uri: string;
  mediaType: 'image/jpeg';
  byteCount: number;
  source: 'photoLibrary' | 'camera';
};

export type CalendarEventInput = {
  title: string;
  startISO: string;
  endISO: string;
  notes?: string;
  location?: string;
  calendarId?: string;
};

export type ReminderInput = {
  title: string;
  notes?: string;
  dueISO?: string;
  calendarId?: string;
};

export type LocalNotificationInput = {
  title: string;
  body: string;
  id?: string;
  timeIntervalSeconds?: number;
  dateISO?: string;
};

type NativeModule = NonNullable<typeof NativeAssist>;

function native(): NativeModule {
  if (!NativeAssist) {
    throw new Error(
      'Les capacités natives sont indisponibles dans cet environnement.',
    );
  }
  return NativeAssist;
}

function parseObject<T>(json: string, operation: string): T {
  try {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value as T;
  } catch {
    throw new Error(`Réponse native invalide pour ${operation}.`);
  }
}

function resultLimit(limit = 20): string {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError(
      'La limite doit être un entier compris entre 1 et 50.',
    );
  }
  return String(limit);
}

function payload(value: object): string {
  return JSON.stringify(value);
}

function utf8Bytes(value: string): number {
  let count = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    count += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return count;
}

function calendarObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid calendar object');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function calendarText(
  value: unknown,
  bytes: number,
  allowEmpty = true,
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && !value.length) ||
    utf8Bytes(value) > bytes
  )
    throw new Error('Invalid calendar text');
  return value;
}

/** Closed UTC timestamp grammar shared with AssistAgentCalendarValidation. */
export function calendarTimestamp(value: unknown): number {
  const raw = calendarText(value, 24, false);
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw))
    throw new RangeError(
      'La date du calendrier doit être un instant UTC explicite.',
    );
  const instant = Date.parse(raw);
  if (!Number.isFinite(instant))
    throw new RangeError('La date du calendrier est invalide.');
  const roundTrip = new Date(instant).toISOString();
  if (roundTrip !== (raw.includes('.') ? raw : raw.replace('Z', '.000Z')))
    throw new RangeError('La date du calendrier est invalide.');
  return instant;
}

export function validateCalendarReadInterval(
  startISO: string,
  endISO: string,
): { start: number; end: number } {
  const start = calendarTimestamp(startISO);
  const end = calendarTimestamp(endISO);
  if (start >= end || end - start > 366 * 86_400_000)
    throw new RangeError('La période du calendrier est invalide.');
  return { start, end };
}

/** Validate the entire native receipt before a UI or tool can consume its rows. */
export function validateCalendarReadResult(
  json: string,
  startISO: string,
  endISO: string,
  limit = 20,
): { events: CalendarEvent[] } {
  try {
    const interval = validateCalendarReadInterval(startISO, endISO);
    resultLimit(limit);
    if (typeof json !== 'string' || utf8Bytes(json) > 16 * 1024)
      throw new Error('Oversized calendar receipt');
    const value = calendarObject(JSON.parse(json));
    if (
      !exactKeys(value, ['events']) ||
      !Array.isArray(value.events) ||
      value.events.length > limit
    )
      throw new Error('Invalid calendar result');
    const events = value.events.map(item => {
      const row = calendarObject(item);
      if (
        !exactKeys(row, [
          'id',
          'calendarId',
          'calendarTitle',
          'title',
          'startISO',
          'endISO',
          'allDay',
        ]) ||
        typeof row.allDay !== 'boolean'
      )
        throw new Error('Invalid calendar row');
      const start = calendarTimestamp(row.startISO);
      const end = calendarTimestamp(row.endISO);
      const overlaps =
        start === end
          ? start >= interval.start && start < interval.end
          : start < interval.end && end > interval.start;
      if (start > end || !overlaps)
        throw new Error('Calendar event outside the period');
      return {
        id: calendarText(row.id, 512, false),
        calendarId: calendarText(row.calendarId, 512, false),
        calendarTitle: calendarText(row.calendarTitle, 1_024),
        title: calendarText(row.title, 2_048),
        startISO: row.startISO as string,
        endISO: row.endISO as string,
        allDay: row.allDay,
      };
    });
    return { events };
  } catch {
    throw new Error(
      'Réponse native invalide pour les événements de calendrier.',
    );
  }
}

/** Reads the current native consent state without prompting the user. */
export async function getDeviceCapabilityStatus(): Promise<CapabilitySnapshot> {
  const value = boundedNativeObject(await native().getDeviceCapabilityStatus());
  exactNativeKeys(value, ['capabilities', 'boundaries']);
  const capabilities = calendarObject(value.capabilities);
  exactNativeKeys(capabilities, [
    ...Object.keys(permissionStates),
    'biometrics',
  ]);
  for (const [name, statuses] of Object.entries(permissionStates)) {
    if (
      typeof capabilities[name] !== 'string' ||
      !statuses.includes(capabilities[name])
    )
      throw new Error('Invalid capability status');
  }
  const biometric = calendarObject(capabilities.biometrics);
  if (
    typeof biometric.available !== 'boolean' ||
    typeof biometric.type !== 'string' ||
    !['faceId', 'touchId', 'opticId', 'none', 'unknown'].includes(biometric.type) ||
    Object.keys(biometric).some(
      key => !['available', 'type', 'errorCode'].includes(key),
    ) ||
    (biometric.errorCode !== undefined &&
      !Number.isSafeInteger(biometric.errorCode))
  )
    throw new Error('Invalid biometric status');
  const boundaries = calendarObject(value.boundaries);
  if (Object.keys(boundaries).length > 16)
    throw new Error('Invalid native boundaries');
  for (const [name, raw] of Object.entries(boundaries)) {
    const boundary = calendarObject(raw);
    exactNativeKeys(boundary, ['supported', 'reason']);
    if (
      !name.length ||
      name.length > 128 ||
      boundary.supported !== false ||
      typeof boundary.reason !== 'string' ||
      !boundary.reason.length ||
      utf8Bytes(boundary.reason) > 2048
    )
      throw new Error('Invalid native boundary');
  }
  return value as CapabilitySnapshot;
}

const commonPermissionStates = [
  'notDetermined',
  'denied',
  'restricted',
  'unavailable',
];
const permissionStates: Record<string, string[]> = {
  contacts: [...commonPermissionStates, 'authorized', 'limited'],
  calendar: [...commonPermissionStates, 'authorized', 'writeOnly'],
  reminders: [...commonPermissionStates, 'authorized', 'writeOnly'],
  location: [
    ...commonPermissionStates,
    'authorizedAlways',
    'authorizedWhenInUse',
  ],
  camera: [...commonPermissionStates, 'authorized'],
  notifications: [
    'notDetermined',
    'denied',
    'unavailable',
    'authorized',
    'provisional',
    'ephemeral',
  ],
};
function boundedNativeObject(json: string): Record<string, unknown> {
  if (typeof json !== 'string' || utf8Bytes(json) > 16 * 1024)
    throw new Error('Oversized native receipt');
  return calendarObject(parseUniqueJSON(json));
}
function exactNativeKeys(value: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
  )
    throw new Error('Invalid native receipt fields');
}

/** Prompts for one named capability only after an explicit UI/tool invocation. */
export async function requestDeviceCapability(
  capability: DeviceCapability,
): Promise<{ capability: DeviceCapability; status: PermissionStatus }> {
  return parseObject(
    await native().requestDeviceCapability(capability),
    'l’autorisation demandée',
  );
}

export async function searchContacts(
  query: string,
  limit?: number,
): Promise<{ contacts: ContactMatch[]; query: string }> {
  return parseObject(
    await native().searchContacts(query, resultLimit(limit)),
    'la recherche de contacts',
  );
}

export async function listCalendarEvents(
  startISO: string,
  endISO: string,
  options: { calendarId?: string; limit?: number } = {},
): Promise<{ events: CalendarEvent[] }> {
  validateCalendarReadInterval(startISO, endISO);
  const requested = calendarObject(options);
  if (
    Object.keys(requested).some(key => !['calendarId', 'limit'].includes(key))
  )
    throw new RangeError('Options du calendrier invalides.');
  const identifier =
    options.calendarId === undefined
      ? ''
      : calendarText(options.calendarId, 512);
  const limit = options.limit === undefined ? 20 : options.limit;
  const encodedLimit = resultLimit(limit);
  return validateCalendarReadResult(
    await native().listCalendarEvents(
      identifier,
      startISO,
      endISO,
      encodedLimit,
    ),
    startISO,
    endISO,
    limit,
  );
}

/** Creates one event; mutation of existing events is intentionally absent. */
export async function createCalendarEvent(
  input: CalendarEventInput,
): Promise<
  Pick<CalendarEvent, 'id' | 'calendarId' | 'title' | 'startISO' | 'endISO'>
> {
  return parseObject(
    await native().createCalendarEvent(payload(input)),
    'la création de l’événement',
  );
}

/**
 * Lists reminders only within an explicit interval of at most 31 days.
 * Incomplete reminders are filtered by due date. When requested, completed
 * reminders are also included by completion date while the result limit allows.
 */
export async function listReminders(options: {
  startISO: string;
  endISO: string;
  includeCompleted?: boolean;
  limit?: number;
}): Promise<{ reminders: Reminder[]; startISO: string; endISO: string }> {
  return parseObject(
    await native().listReminders(
      options.includeCompleted ?? false,
      options.startISO,
      options.endISO,
      resultLimit(options.limit),
    ),
    'les rappels',
  );
}

/** Creates one reminder; modification and deletion are intentionally absent. */
export async function createReminder(
  input: ReminderInput,
): Promise<Pick<Reminder, 'id' | 'calendarId' | 'title'>> {
  return parseObject(
    await native().createReminder(payload(input)),
    'la création du rappel',
  );
}

/**
 * Gets one foreground location fix. If location has not been decided yet, this
 * call can show iOS's when-in-use permission prompt; it never tracks in background.
 */
export async function getCurrentLocation(): Promise<{
  latitude: number;
  longitude: number;
  horizontalAccuracy: number;
  timestampISO: string;
}> {
  const value = boundedNativeObject(await native().getCurrentLocation());
  exactNativeKeys(value, [
    'latitude',
    'longitude',
    'horizontalAccuracy',
    'timestampISO',
  ]);
  if (
    typeof value.latitude !== 'number' ||
    !Number.isFinite(value.latitude) ||
    Math.abs(value.latitude) > 90 ||
    typeof value.longitude !== 'number' ||
    !Number.isFinite(value.longitude) ||
    Math.abs(value.longitude) > 180 ||
    typeof value.horizontalAccuracy !== 'number' ||
    !Number.isFinite(value.horizontalAccuracy) ||
    value.horizontalAccuracy < 0
  )
    throw new Error('Invalid native location');
  calendarTimestamp(value.timestampISO);
  return value as {
    latitude: number;
    longitude: number;
    horizontalAccuracy: number;
    timestampISO: string;
  };
}

/** Opens the system picker; only the user-selected image is returned. */
export async function selectPhoto(): Promise<ImageAttachment> {
  return parseObject(await native().selectPhoto(), 'la sélection de photo');
}

/** Opens iOS camera capture for one still image; video is not exposed. */
export async function capturePhoto(): Promise<ImageAttachment> {
  return parseObject(await native().capturePhoto(), 'la capture de photo');
}

export async function scheduleLocalNotification(
  input: LocalNotificationInput,
): Promise<{ id: string; scheduled: true }> {
  return parseObject(
    await native().scheduleLocalNotification(payload(input)),
    'la notification locale',
  );
}

export async function getBiometricStatus(): Promise<{
  available: boolean;
  type: string;
  errorCode: number;
}> {
  return parseObject(await native().getBiometricStatus(), 'la biométrie');
}

/** Uses biometrics only; it deliberately does not fall back to the device passcode. */
export async function authenticateWithBiometrics(
  reason: string,
): Promise<{ authenticated: true }> {
  return parseObject(
    await native().authenticateWithBiometrics(reason),
    'la confirmation biométrique',
  );
}

export async function getNativeCapabilityBoundary(
  feature: string,
): Promise<{ feature: string; boundary: NativeBoundary }> {
  return parseObject(
    await native().getNativeCapabilityBoundary(feature),
    'la limite de capacité native',
  );
}
