import NativeAssist from '../specs/NativeAssist';

/** iOS capabilities deliberately exposed by Assist's native bridge. */
export type DeviceCapability =
  | 'contacts'
  | 'calendar'
  | 'reminders'
  | 'location'
  | 'camera'
  | 'photoLibrary'
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

/** Reads the current native consent state without prompting the user. */
export async function getDeviceCapabilityStatus(): Promise<CapabilitySnapshot> {
  return parseObject(
    await native().getDeviceCapabilityStatus(),
    'les capacités de l’appareil',
  );
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
  return parseObject(
    await native().listCalendarEvents(
      options.calendarId ?? '',
      startISO,
      endISO,
      resultLimit(options.limit),
    ),
    'les événements de calendrier',
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

export async function listReminders(
  options: { includeCompleted?: boolean; limit?: number } = {},
): Promise<{ reminders: Reminder[] }> {
  return parseObject(
    await native().listReminders(
      options.includeCompleted ?? false,
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

/** Gets one foreground location fix; the native layer does not track in background. */
export async function getCurrentLocation(): Promise<{
  latitude: number;
  longitude: number;
  horizontalAccuracy: number;
  timestampISO: string;
}> {
  return parseObject(
    await native().getCurrentLocation(),
    'la position actuelle',
  );
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
