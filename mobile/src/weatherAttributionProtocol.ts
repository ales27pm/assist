import { AppleForecast, appleAttributionURL } from './applePlacesProtocol';
import { workspaceBytes } from './nativeWorkspaceProtocol';

export type WeatherAttributionData = AppleForecast['attribution'];
export type WeatherAttributionStatus = 'loading' | 'ready' | 'failed';
export type WeatherMark = {
  schemaVersion: 1;
  requestId: string;
  sourceURL: string;
  pngDataURI: string;
  width: number;
  height: number;
  rendered: true;
};
function invalid(): never {
  throw new Error('Attribution officielle non confirmée.');
}
function object(value: unknown, keys: string[]) {
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
function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    !!value.trim() &&
    workspaceBytes(value) <= maximum &&
    !value.includes('<|')
  );
}
export function officialWeatherMarkURL(
  value: unknown,
  appearance: 'light' | 'dark',
): value is string {
  if (typeof value !== 'string' || value.length > 1024) return false;
  return new RegExp(
    `^https://weatherkit\\.apple\\.com/assets/branding/[A-Za-z0-9-]{2,32}/Apple_Weather_${
      appearance === 'dark' ? 'wht' : 'blk'
    }_[A-Za-z0-9-]{2,32}_[1-3]X_[0-9]{6}\\.png$`,
  ).test(value);
}
export function parseWeatherAttribution(
  value: unknown,
): WeatherAttributionData {
  const row = object(value, [
    'serviceName',
    'legalPageURL',
    'combinedMarkLightURL',
    'combinedMarkDarkURL',
    'legalAttributionText',
  ]);
  if (
    !text(row.serviceName, 256) ||
    !text(row.legalAttributionText, 4096) ||
    !appleAttributionURL(row.legalPageURL) ||
    !officialWeatherMarkURL(row.combinedMarkLightURL, 'light') ||
    !officialWeatherMarkURL(row.combinedMarkDarkURL, 'dark')
  )
    return invalid();
  return row as WeatherAttributionData;
}
export function parseWeatherMark(
  json: string,
  expectedId: string,
  expectedURL: string,
): WeatherMark {
  if (typeof json !== 'string' || workspaceBytes(json) > 48 * 1024)
    return invalid();
  const row = object(JSON.parse(json), [
    'schemaVersion',
    'requestId',
    'sourceURL',
    'pngDataURI',
    'width',
    'height',
    'rendered',
  ]);
  if (
    row.schemaVersion !== 1 ||
    row.requestId !== expectedId ||
    row.sourceURL !== expectedURL ||
    row.rendered !== true ||
    typeof row.pngDataURI !== 'string' ||
    row.pngDataURI.length > 44 * 1024 ||
    !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(
      row.pngDataURI,
    ) ||
    typeof row.width !== 'number' ||
    !Number.isSafeInteger(row.width) ||
    row.width <= 0 ||
    row.width > 768 ||
    typeof row.height !== 'number' ||
    !Number.isSafeInteger(row.height) ||
    row.height <= 0 ||
    row.height > 128 ||
    row.width * row.height > 65536
  )
    return invalid();
  return row as WeatherMark;
}
