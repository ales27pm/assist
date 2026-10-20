import { workspaceBytes } from './nativeWorkspaceProtocol';

export type AlarmAction = 'list' | 'create' | 'update' | 'stop' | 'cancel';
export type AlarmItem = {
  alarm_id: string;
  kind: 'alarm' | 'timer';
  title: string;
  date_iso?: string;
  duration_seconds?: number;
  state:
    | 'scheduled'
    | 'countdown'
    | 'paused'
    | 'alerting'
    | 'not_present'
    | 'unknown';
  uncertain: boolean;
};
export type AlarmRequest = {
  schemaVersion: 1;
  requestId: string;
  operationId: string;
  action: AlarmAction;
  alarm_id?: string;
  kind?: 'alarm' | 'timer';
  title?: string;
  date_iso?: string;
  duration_seconds?: number;
};
export type AlarmReceipt = {
  schemaVersion: 1;
  requestId: string;
  operationId: string;
  action: AlarmAction;
  status: 'succeeded' | 'failed_safe' | 'outcome_unknown';
  code: string;
  items: AlarmItem[];
};
const codes = [
  'ok',
  'cancelled',
  'permission_denied',
  'unavailable',
  'storage_unavailable',
  'ownership_required',
  'operation_conflict',
  'outcome_unknown',
  'not_found',
  'limit_reached',
];
const uuidPattern =
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
function invalid(): never {
  throw new Error(
    'Réponse des alarmes incompatible. Actualise la liste avant de continuer.',
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
export function parseAlarmReceipt(
  raw: string,
  request: AlarmRequest,
): AlarmReceipt {
  if (typeof raw !== 'string' || workspaceBytes(raw) > 256 * 1024)
    return invalid();
  const row = object(JSON.parse(raw), [
    'schemaVersion',
    'requestId',
    'operationId',
    'action',
    'status',
    'code',
    'items',
  ]);
  if (
    row.schemaVersion !== 1 ||
    row.requestId !== request.requestId ||
    row.operationId !== request.operationId ||
    row.action !== request.action ||
    !['succeeded', 'failed_safe', 'outcome_unknown'].includes(
      String(row.status),
    ) ||
    !codes.includes(String(row.code)) ||
    (row.status === 'succeeded' ? row.code !== 'ok' : row.code === 'ok') ||
    (row.status === 'outcome_unknown' && row.code !== 'outcome_unknown') ||
    !Array.isArray(row.items) ||
    row.items.length > 1024
  )
    return invalid();
  const ids = new Set<string>();
  for (const value of row.items) {
    if (!value || typeof value !== 'object') return invalid();
    const kind = (value as Record<string, unknown>).kind;
    const item = object(value, [
      'alarm_id',
      'kind',
      'title',
      kind === 'alarm' ? 'date_iso' : 'duration_seconds',
      'state',
      'uncertain',
    ]);
    if (
      typeof item.alarm_id !== 'string' ||
      !uuidPattern.test(item.alarm_id) ||
      ids.has(item.alarm_id) ||
      typeof item.title !== 'string' ||
      !item.title.trim() ||
      workspaceBytes(item.title) > 120 ||
      Array.from(item.title).some(
        character =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      ![
        'scheduled',
        'countdown',
        'paused',
        'alerting',
        'not_present',
        'unknown',
      ].includes(String(item.state)) ||
      typeof item.uncertain !== 'boolean'
    )
      return invalid();
    ids.add(item.alarm_id);
    if (kind === 'alarm') {
      if (
        typeof item.date_iso !== 'string' ||
        item.date_iso.length > 40 ||
        !/^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/.test(item.date_iso) ||
        !Number.isFinite(Date.parse(item.date_iso))
      )
        return invalid();
    } else if (
      kind !== 'timer' ||
      typeof item.duration_seconds !== 'number' ||
      !Number.isInteger(item.duration_seconds) ||
      item.duration_seconds < 1 ||
      item.duration_seconds > 86400
    )
      return invalid();
  }
  return row as AlarmReceipt;
}
/** Correlation and durable ownership identity; never a permission token. */
export function newAlarmOperationId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'
    .replace(/[xy]/g, character => {
      const value = Math.floor(Math.random() * 16);
      return (character === 'x' ? value : (value % 4) + 8).toString(16);
    })
    .toUpperCase();
}
