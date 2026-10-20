import { workspaceBytes } from './nativeWorkspaceProtocol';

export type AppleCoordinate = { latitude: number; longitude: number };
export type ApplePlace = {
  id: string;
  name: string;
  address: string;
  coordinate: AppleCoordinate;
};
export type AppleSearch = {
  schemaVersion: 1;
  requestId: string;
  provider: 'Apple Maps';
  results: ApplePlace[];
  truncated: boolean;
  untrusted: true;
};
export type AppleDirectionsRequest = {
  schemaVersion: 1;
  requestId: string;
  origin: AppleCoordinate;
  destination: AppleCoordinate;
  transport: 'walking' | 'automobile';
};
export type AppleDirections = AppleDirectionsRequest & {
  provider: 'Apple Maps';
  distanceMeters: number;
  expectedTravelSeconds: number;
  name: string;
  calculatedAt: string;
  estimateOnly: true;
  navigationStarted: false;
};
export type AppleForecastRequest = {
  schemaVersion: 1;
  requestId: string;
  coordinate: AppleCoordinate;
  unit: 'celsius' | 'fahrenheit';
  hourlyCount: number;
  dailyCount: number;
};
export type AppleHour = {
  date: string;
  condition: string;
  temperature: number;
  precipitationChance: number;
};
export type AppleDay = {
  date: string;
  condition: string;
  highTemperature: number;
  lowTemperature: number;
  precipitationChance: number;
};
export type AppleForecast = {
  schemaVersion: 1;
  requestId: string;
  coordinate: AppleCoordinate;
  temperatureUnit: 'celsius' | 'fahrenheit';
  retrievedAt: string;
  attribution: {
    serviceName: string;
    legalPageURL: string;
    combinedMarkLightURL: string;
    combinedMarkDarkURL: string;
    legalAttributionText: string;
  };
  current: {
    date: string;
    condition: string;
    symbolName: string;
    temperature: number;
    apparentTemperature: number;
    humidity: number;
    windKilometersPerHour: number;
  };
  hourly: AppleHour[];
  daily: AppleDay[];
  forecastNotGuarantee: true;
};

function invalid(): never {
  throw new Error(
    'Réponse Cartes ou Météo incompatible. Aucun résultat accepté.',
  );
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== keys.length ||
    !keys.every(key => Object.prototype.hasOwnProperty.call(row, key))
  )
    return invalid();
  return row;
}
function decode(json: string): unknown {
  if (typeof json !== 'string' || workspaceBytes(json) > 24 * 1024)
    return invalid();
  return JSON.parse(json) as unknown;
}
function text(value: unknown, bytes: number, empty = false): value is string {
  return (
    typeof value === 'string' &&
    (empty || !!value.trim()) &&
    workspaceBytes(value) <= bytes &&
    !Array.from(value).some(character => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    }) &&
    !value.includes('<|') &&
    !value.includes('|>')
  );
}
function number(
  value: unknown,
  min = -Number.MAX_VALUE,
  max = Number.MAX_VALUE,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}
function date(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return false;
  return new Date(value).toISOString().replace('.000Z', 'Z') === value;
}
function id(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  );
}
export function appleCoordinate(value: unknown): AppleCoordinate {
  const row = object(value, ['latitude', 'longitude']);
  if (!number(row.latitude, -90, 90) || !number(row.longitude, -180, 180))
    return invalid();
  return row as AppleCoordinate;
}
function sameCoordinate(value: unknown, expected: AppleCoordinate): boolean {
  const row = appleCoordinate(value);
  return (
    row.latitude === expected.latitude && row.longitude === expected.longitude
  );
}
export function appleAttributionURL(value: unknown): value is string {
  if (!text(value, 2048) || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (!url.port || url.port === '443') &&
      (url.hostname === 'apple.com' || url.hostname.endsWith('.apple.com'))
    );
  } catch {
    return false;
  }
}
export function validAppleQuery(value: string): boolean {
  return text(value.trim(), 256) && !/[\r\n\t]/.test(value);
}
export function parseApplePlacesStatus(json: string) {
  const row = object(decode(json), [
    'schemaVersion',
    'maps',
    'weather',
    'weatherDeviceVerified',
    'locationMode',
  ]);
  if (
    row.schemaVersion !== 1 ||
    row.maps !== 'available' ||
    row.weather !== 'requires_signed_weatherkit_entitlement' ||
    row.weatherDeviceVerified !== false ||
    row.locationMode !== 'explicit_text_or_coordinates'
  )
    return invalid();
  return row;
}
export function parseAppleSearch(json: string, expected: string): AppleSearch {
  const row = object(decode(json), [
    'schemaVersion',
    'requestId',
    'provider',
    'results',
    'truncated',
    'untrusted',
  ]);
  if (
    row.schemaVersion !== 1 ||
    !id(expected) ||
    row.requestId !== expected ||
    row.provider !== 'Apple Maps' ||
    row.untrusted !== true ||
    typeof row.truncated !== 'boolean' ||
    !Array.isArray(row.results) ||
    row.results.length > 10
  )
    return invalid();
  const ids = new Set<string>();
  for (const value of row.results) {
    const item = object(value, ['id', 'name', 'address', 'coordinate']);
    if (
      !id(item.id) ||
      ids.has(item.id) ||
      !text(item.name, 256, true) ||
      !text(item.address, 512, true)
    )
      return invalid();
    appleCoordinate(item.coordinate);
    ids.add(item.id);
  }
  return row as AppleSearch;
}
export function parseAppleDirections(
  json: string,
  expected: AppleDirectionsRequest,
): AppleDirections {
  const row = object(decode(json), [
    'schemaVersion',
    'requestId',
    'provider',
    'origin',
    'destination',
    'transport',
    'distanceMeters',
    'expectedTravelSeconds',
    'name',
    'calculatedAt',
    'estimateOnly',
    'navigationStarted',
  ]);
  if (
    row.schemaVersion !== 1 ||
    !id(expected.requestId) ||
    row.requestId !== expected.requestId ||
    row.provider !== 'Apple Maps' ||
    !sameCoordinate(row.origin, expected.origin) ||
    !sameCoordinate(row.destination, expected.destination) ||
    !['walking', 'automobile'].includes(expected.transport) ||
    row.transport !== expected.transport ||
    !number(row.distanceMeters, 0) ||
    !number(row.expectedTravelSeconds, 0) ||
    !text(row.name, 256, true) ||
    !date(row.calculatedAt) ||
    row.estimateOnly !== true ||
    row.navigationStarted !== false
  )
    return invalid();
  return row as AppleDirections;
}
export function parseAppleForecast(
  json: string,
  expected: AppleForecastRequest,
): AppleForecast {
  const row = object(decode(json), [
    'schemaVersion',
    'requestId',
    'coordinate',
    'temperatureUnit',
    'retrievedAt',
    'attribution',
    'current',
    'hourly',
    'daily',
    'forecastNotGuarantee',
  ]);
  if (
    row.schemaVersion !== 1 ||
    !id(expected.requestId) ||
    row.requestId !== expected.requestId ||
    !sameCoordinate(row.coordinate, expected.coordinate) ||
    !['celsius', 'fahrenheit'].includes(expected.unit) ||
    row.temperatureUnit !== expected.unit ||
    !date(row.retrievedAt) ||
    row.forecastNotGuarantee !== true ||
    !Number.isSafeInteger(expected.hourlyCount) ||
    expected.hourlyCount < 0 ||
    expected.hourlyCount > 12 ||
    !Number.isSafeInteger(expected.dailyCount) ||
    expected.dailyCount < 0 ||
    expected.dailyCount > 5 ||
    !Array.isArray(row.hourly) ||
    row.hourly.length > expected.hourlyCount ||
    !Array.isArray(row.daily) ||
    row.daily.length > expected.dailyCount
  )
    return invalid();
  const credit = object(row.attribution, [
    'serviceName',
    'legalPageURL',
    'combinedMarkLightURL',
    'combinedMarkDarkURL',
    'legalAttributionText',
  ]);
  if (
    !text(credit.serviceName, 256) ||
    !text(credit.legalAttributionText, 4096) ||
    !appleAttributionURL(credit.legalPageURL) ||
    !appleAttributionURL(credit.combinedMarkLightURL) ||
    !appleAttributionURL(credit.combinedMarkDarkURL)
  )
    return invalid();
  const current = object(row.current, [
    'date',
    'condition',
    'symbolName',
    'temperature',
    'apparentTemperature',
    'humidity',
    'windKilometersPerHour',
  ]);
  if (
    !date(current.date) ||
    !text(current.condition, 128) ||
    !text(current.symbolName, 128) ||
    !number(current.temperature) ||
    !number(current.apparentTemperature) ||
    !number(current.humidity, 0, 1) ||
    !number(current.windKilometersPerHour, 0)
  )
    return invalid();
  for (const value of row.hourly) {
    const hour = object(value, [
      'date',
      'condition',
      'temperature',
      'precipitationChance',
    ]);
    if (
      !date(hour.date) ||
      !text(hour.condition, 128) ||
      !number(hour.temperature) ||
      !number(hour.precipitationChance, 0, 1)
    )
      return invalid();
  }
  for (const value of row.daily) {
    const day = object(value, [
      'date',
      'condition',
      'highTemperature',
      'lowTemperature',
      'precipitationChance',
    ]);
    if (
      !date(day.date) ||
      !text(day.condition, 128) ||
      !number(day.highTemperature) ||
      !number(day.lowTemperature) ||
      day.highTemperature < day.lowTemperature ||
      !number(day.precipitationChance, 0, 1)
    )
      return invalid();
  }
  return row as AppleForecast;
}
export function parseAppleOpenReceipt(json: string): boolean {
  const row = object(decode(json), [
    'schemaVersion',
    'opened',
    'navigationStarted',
  ]);
  if (
    row.schemaVersion !== 1 ||
    typeof row.opened !== 'boolean' ||
    row.navigationStarted !== false
  )
    return invalid();
  return row.opened;
}
export function parseAppleCancellation(json: string): void {
  const row = object(decode(json), ['schemaVersion', 'cancelled']);
  if (row.schemaVersion !== 1 || row.cancelled !== true) return invalid();
}
/** Only fixed native messages may replace the generic service error. Never
 * display arbitrary bridge/provider descriptions, URLs or nested userInfo. */
export function applePlacesFailureMessage(cause: unknown): string | undefined {
  if (!cause || typeof cause !== 'object' || !('message' in cause)) return undefined;
  const native = cause.message;
  const messages: Record<string, string> = {
    'Le service Apple est inaccessible sur le réseau pour le moment.': 'Le service Apple est inaccessible sur le réseau pour le moment.',
    'WeatherKit n’est pas autorisé pour cette build ou ce compte Apple.': 'Le service météo Apple n’autorise pas cette version d’Assist. Aucune prévision n’a été affichée.',
    'L’attribution Apple Weather n’a pas pu être obtenue ou validée. Aucune prévision n’est affichée.': 'L’attribution Apple Weather n’a pas pu être obtenue ou validée. Aucune prévision n’est affichée.',
    'Le service Apple n’a pas fourni de résultat utilisable.': 'Le service Apple n’a pas fourni de résultat utilisable.',
  };
  return typeof native === 'string' && Object.prototype.hasOwnProperty.call(messages, native) ? messages[native] : undefined;
}
