import { extendedDeviceToolNames, extendedToolLabels, extendedToolEffect, interactiveMayCommit } from './nativeBundleTools';
import { AppleForecast, appleCoordinate, parseAppleForecast } from './applePlacesProtocol';
import {
  boundedIdentifier,
  GenerationResult,
  parseCalendarResult,
} from './protocol';

export const deviceToolNames = [
  'contacts_search',
  'calendar_list',
  'calendar_create',
  'reminders_list',
  'reminder_create',
  'location_current',
  'photo_select',
  'camera_capture',
  'notification_schedule',
  'biometrics_status',
  'biometrics_authenticate',
  'device_capabilities',
  'native_boundary',
  'maps_search',
  'maps_directions',
  'weather_forecast',
  ...extendedDeviceToolNames,
] as const;
export const legacyDeviceToolNames = deviceToolNames.slice(0, 13);
export const placesDeviceToolNames = deviceToolNames.slice(0, 16);
export type DeviceToolName = (typeof deviceToolNames)[number];
export type ToolPermission =
  | 'contacts'
  | 'calendar'
  | 'reminders'
  | 'location'
  | 'camera'
  | 'notifications'
  | 'biometrics';
export type ToolField = { label: string; value: string };
const toolFailureMessages = {
  apple_network: 'Le service Apple est inaccessible sur le réseau pour le moment.',
  weather_authorization: 'Le service météo Apple n’autorise pas cette version d’Assist. Aucune prévision n’a été affichée.',
  weather_attribution: 'L’attribution Apple Weather n’a pas pu être obtenue ou validée. Aucune prévision n’est affichée.',
  apple_unavailable: 'Le service Apple n’a pas fourni de résultat utilisable.',
  invalid_native_result: 'Le résultat natif ne respecte pas le contrat attendu.',
} as const;
export type DeviceToolFailure = keyof typeof toolFailureMessages;
export function toolFailureMessage(failure: DeviceToolFailure): string {
  return toolFailureMessages[failure];
}
export type DeviceToolReceipt = {
  operationId: string;
  tool: DeviceToolName;
  status: 'success' | 'outcome_unknown';
  completedAt: string;
  summary: ToolField[];
};
/** Recovery metadata only: an unknown journal entry is never executable. */
export type UnknownToolOperationReceipt = {
  operationId: string;
  tool: null;
  unknownToolName: string;
  status: 'success' | 'outcome_unknown';
  completedAt: string;
  summary: ToolField[];
};
export type ToolOperationReceipt =
  | DeviceToolReceipt
  | UnknownToolOperationReceipt;
export type DeviceToolTransaction = {
  id: string;
  revision: number;
  tool: DeviceToolName;
  effect: 'read' | 'write' | 'interactive';
  title: string;
  status:
    | 'awaiting_confirmation'
    | 'awaiting_permission'
    | 'executing'
    | 'success'
    | 'failed_safe'
    | 'outcome_unknown'
    | 'cancelled';
  preview: ToolField[];
  confirmationToken?: string;
  capability?: ToolPermission;
  receipt?: DeviceToolReceipt;
  weather?: AppleForecast;
  failure?: DeviceToolFailure;
};
export type DeviceToolActivity = {
  schemaVersion: 1;
  requestId: string;
  transaction: DeviceToolTransaction;
};

export const deviceToolLabels: Record<DeviceToolName, string> = {
  ...extendedToolLabels,
  contacts_search: 'Rechercher un contact',
  calendar_list: 'Consulter le calendrier',
  calendar_create: 'Créer un événement',
  reminders_list: 'Consulter les rappels',
  reminder_create: 'Créer un rappel',
  location_current: 'Obtenir la position',
  photo_select: 'Lire le texte d’une photo',
  camera_capture: 'Photographier et lire le texte',
  notification_schedule: 'Programmer une notification',
  biometrics_status: 'Vérifier la biométrie',
  biometrics_authenticate: 'Demander une authentification',
  device_capabilities: 'Vérifier les accès iOS',
  native_boundary: 'Vérifier une capacité',
  maps_search: 'Rechercher un lieu',
  maps_directions: 'Estimer un trajet',
  weather_forecast: 'Consulter la météo',
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Contrat outil invalide.');
  return value as Record<string, unknown>;
}
function keys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) {
  return (
    required.every(key => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every(key => [...required, ...optional].includes(key))
  );
}
function text(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.length <= limit &&
    !value.includes('<|') &&
    !value.includes('|>') &&
    !Array.from(value).some(character => {
      const code = character.charCodeAt(0);
      return (code < 32 && code !== 9 && code !== 10) || code === 127;
    })
  );
}
function tool(value: unknown): value is DeviceToolName {
  return (
    typeof value === 'string' && deviceToolNames.some(name => name === value)
  );
}
function fields(value: unknown): value is ToolField[] {
  return (
    Array.isArray(value) &&
    value.length <= 10 &&
    value.every(field => {
      const row = object(field);
      return (
        keys(row, ['label', 'value']) &&
        text(row.label, 128) &&
        !!row.label.trim() &&
        text(row.value, 4096)
      );
    })
  );
}
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}
function decode(json: string) {
  if (typeof json !== 'string' || utf8Bytes(json) > 32768)
    throw new Error('Contrat outil trop volumineux.');
  return object(JSON.parse(json));
}
function receiptMetadata(value: unknown): boolean {
  const row = object(value);
  return (
    keys(row, ['operationId', 'tool', 'status', 'completedAt', 'summary']) &&
    boundedIdentifier(row.operationId) &&
    utf8Bytes(row.operationId) <= 128 &&
    typeof row.status === 'string' &&
    ['success', 'outcome_unknown'].includes(row.status) &&
    text(row.completedAt, 32) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
      row.completedAt,
    ) &&
    !row.completedAt.startsWith('0000-') &&
    Number.isFinite(Date.parse(row.completedAt)) &&
    new Date(row.completedAt).toISOString().replace('.000Z', 'Z') ===
      row.completedAt.replace('.000Z', 'Z') &&
    fields(row.summary)
  );
}
function receipt(value: unknown): value is DeviceToolReceipt {
  return receiptMetadata(value) && tool(object(value).tool);
}
export function parseDeviceToolCapabilities(json: string) {
  const value = decode(json);
  if (
    !keys(value, [
      'schemaVersion',
      'protocolVersion',
      'tools',
      'confirmation',
    ]) ||
    value.schemaVersion !== 1 ||
    value.protocolVersion !== 1 ||
    value.confirmation !== 'all_accesses' ||
    !Array.isArray(value.tools) ||
    value.tools.length !== legacyDeviceToolNames.length ||
    new Set(value.tools).size !== legacyDeviceToolNames.length ||
    !value.tools.every(name => legacyDeviceToolNames.includes(name))
  )
    throw new Error('Outils iOS incompatibles.');
  return true;
}
export function parseDeviceToolActivity(json: string): DeviceToolActivity {
  const event = decode(json);
  const row = object(event.transaction);
  const statuses = [
    'awaiting_confirmation',
    'awaiting_permission',
    'executing',
    'success',
    'failed_safe',
    'outcome_unknown',
    'cancelled',
  ];
  const expectedEffect = extendedToolEffect(String(row.tool)) ?? ([
    'calendar_create',
    'reminder_create',
    'notification_schedule',
  ].includes(String(row.tool))
    ? 'write'
    : ['photo_select', 'camera_capture', 'biometrics_authenticate'].includes(
        String(row.tool),
      )
    ? 'interactive'
    : 'read');
  if (
    !keys(event, ['schemaVersion', 'requestId', 'transaction']) ||
    event.schemaVersion !== 1 ||
    !boundedIdentifier(event.requestId) ||
    !keys(
      row,
      ['id', 'revision', 'tool', 'effect', 'title', 'status', 'preview'],
      ['confirmationToken', 'capability', 'receipt', 'weather', 'failure'],
    ) ||
    !boundedIdentifier(row.id) ||
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 1 ||
    (row.revision as number) > 128 ||
    !tool(row.tool) ||
    row.effect !== expectedEffect ||
    !text(row.title, 128) ||
    !row.title.trim() ||
    !statuses.includes(String(row.status)) ||
    !fields(row.preview)
  )
    throw new Error('Activité outil invalide.');
  if (
    (row.status === 'awaiting_confirmation') !==
      (typeof row.confirmationToken === 'string') ||
    (row.confirmationToken !== undefined &&
      !boundedIdentifier(row.confirmationToken))
  )
    throw new Error('Confirmation outil invalide.');
  if (
    row.capability !== undefined &&
    ![
      'contacts',
      'calendar',
      'reminders',
      'location',
      'camera',
      'notifications',
      'biometrics',
    ].includes(String(row.capability))
  )
    throw new Error('Permission outil invalide.');
  if (row.status === 'awaiting_permission' && !row.capability)
    throw new Error('Permission outil absente.');
  if (row.failure !== undefined) {
    const appleTool = ['maps_search', 'maps_directions', 'weather_forecast'].includes(String(row.tool));
    if (
      row.status !== 'failed_safe' ||
      typeof row.failure !== 'string' ||
      !Object.prototype.hasOwnProperty.call(toolFailureMessages, row.failure) ||
      (row.failure.startsWith('apple_') && !appleTool) ||
      (row.failure.startsWith('weather_') && row.tool !== 'weather_forecast')
    ) throw new Error('Échec outil invalide.');
  }
  if (
    row.receipt !== undefined &&
    (!['success', 'outcome_unknown'].includes(String(row.status)) ||
      !receipt(row.receipt) ||
      row.receipt.operationId !== row.id ||
      row.receipt.tool !== row.tool)
  )
    throw new Error('Reçu outil incohérent.');
  if (
    ['success', 'outcome_unknown'].includes(String(row.status)) &&
    (!row.receipt || (row.receipt as DeviceToolReceipt).status !== row.status)
  )
    throw new Error('Preuve outil absente.');
  if (row.weather !== undefined) {
    if (row.tool !== 'weather_forecast' || row.status !== 'success')
      throw new Error('Preuve météo incohérente.');
    const forecast = validatedForecast(row.weather);
    if (forecast.requestId !== row.id)
      throw new Error('Identité météo incohérente.');
  }
  if (row.tool === 'weather_forecast' && row.status === 'success' && !row.weather)
    throw new Error('Preuve météo absente.');
  return event as DeviceToolActivity;
}
export function acceptDeviceToolActivity(
  previous: DeviceToolActivity | undefined,
  next: DeviceToolActivity,
): boolean {
  return (
    !previous ||
    (previous.requestId === next.requestId &&
      previous.transaction.tool === next.transaction.tool &&
      previous.transaction.id === next.transaction.id &&
      previous.transaction.effect === next.transaction.effect &&
      previous.transaction.title === next.transaction.title &&
      previous.transaction.capability === next.transaction.capability &&
      previous.transaction.preview.length === next.transaction.preview.length &&
      previous.transaction.preview.every(
        (field, index) =>
          field.label === next.transaction.preview[index].label &&
          field.value === next.transaction.preview[index].value,
      ) &&
      previous.transaction.revision < next.transaction.revision &&
      !['awaiting_confirmation', 'awaiting_permission'].includes(
        next.transaction.status,
      ) &&
      !['success', 'outcome_unknown', 'failed_safe', 'cancelled'].includes(
        previous.transaction.status,
      ))
  );
}

/** A stopped task cannot keep a live consent button. This is not a receipt:
 * a submitted write remains uncertain until the native journal settles it. */
export function interruptDeviceToolActivity(
  activity: DeviceToolActivity,
  preservePermission = false,
): DeviceToolActivity {
  const { transaction } = activity;
  if (
    ['success', 'outcome_unknown', 'failed_safe', 'cancelled'].includes(
      transaction.status,
    ) ||
    (preservePermission && transaction.status === 'awaiting_permission')
  )
    return activity;
  return {
    ...activity,
    transaction: {
      ...transaction,
      confirmationToken: undefined,
      status:
        (transaction.effect === 'write' || interactiveMayCommit(transaction.tool)) && transaction.status === 'executing'
          ? 'outcome_unknown'
          : 'cancelled',
    },
  };
}

export function deviceToolPublicAnswer(
  textValue: string,
  activities: DeviceToolActivity[],
): string {
  if (
    activities.some(
      activity => activity.transaction.status === 'outcome_unknown',
    )
  )
    return 'L’action a peut-être eu lieu, mais son résultat n’est pas confirmé. Vérifie dans l’app concernée avant toute nouvelle création. Aucun nouvel essai automatique.';
  return textValue;
}
export function deviceToolFailureMessage(activities: DeviceToolActivity[]): string | undefined {
  if (activities.some(activity => activity.transaction.status === 'outcome_unknown')) return undefined;
  const failed = [...activities].reverse().find(activity => activity.transaction.status === 'failed_safe' && activity.transaction.failure);
  return failed?.transaction.failure ? toolFailureMessage(failed.transaction.failure) : undefined;
}
export function parseToolConfirmation(json: string) {
  const value = decode(json);
  if (
    !keys(value, ['schemaVersion', 'accepted']) ||
    value.schemaVersion !== 1 ||
    typeof value.accepted !== 'boolean'
  )
    throw new Error('Confirmation native invalide.');
  return value.accepted;
}
export function parseToolOperations(json: string): ToolOperationReceipt[] {
  const value = decode(json);
  if (
    !keys(value, ['schemaVersion', 'operations']) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.operations) ||
    value.operations.length > 100 ||
    !value.operations.every(
      item =>
        receiptMetadata(item) &&
        typeof item.tool === 'string' &&
        /^[a-z][a-z0-9_]{0,63}$/.test(item.tool),
    ) ||
    new Set(value.operations.map(item => item.operationId)).size !==
      value.operations.length
  )
    throw new Error('Journal outil invalide.');
  return value.operations.map((item): ToolOperationReceipt => {
    if (tool(item.tool)) return item as DeviceToolReceipt;
    // Keep the native outcome and operation identity visible after rollback,
    // but never trust a future tool's summary, label, schema or executor.
    const uncertain = item.status === 'outcome_unknown';
    return {
      operationId: item.operationId,
      tool: null,
      unknownToolName: item.tool,
      status: item.status,
      completedAt: item.completedAt,
      summary: [
        {
          label: uncertain ? 'Vérification requise' : 'Résultat archivé',
          value: uncertain
            ? 'Une opération d’une autre version reste incertaine. Vérifie dans l’app concernée. Aucun nouvel essai automatique.'
            : 'Le journal conserve un résultat d’une autre version. Aucune action ni relance n’est disponible.',
        },
      ],
    };
  });
}
export function toolOperationLabel(operation: ToolOperationReceipt): string {
  return operation.tool === null
    ? 'Opération d’une autre version'
    : deviceToolLabels[operation.tool];
}
function validatedForecast(value: unknown): AppleForecast {
  const row = object(value);
  const coordinate = appleCoordinate(row.coordinate);
  if (!Array.isArray(row.hourly) || !Array.isArray(row.daily))
    throw new Error('Preuve météo invalide.');
  return parseAppleForecast(JSON.stringify(value), {
    schemaVersion: 1,
    requestId: row.requestId as string,
    coordinate,
    unit: row.temperatureUnit as 'celsius' | 'fahrenheit',
    hourlyCount: row.hourly.length,
    dailyCount: row.daily.length,
  });
}
export function parseDeviceToolResult(json: string): GenerationResult {
  if (typeof json !== 'string' || utf8Bytes(json) > 128 * 1024)
    throw new Error('Réponse outil trop volumineuse.');
  const result = parseCalendarResult(json);
  const row = object(JSON.parse(json));
  if (row.agentTools !== true || utf8Bytes(result.text) > 8192)
    throw new Error('Réponse outil invalide.');
  if (row.weather !== undefined) {
    if (!Array.isArray(row.weather) || row.weather.length > 4)
      throw new Error('Preuves météo invalides.');
    const weather = row.weather.map(validatedForecast);
    if (new Set(weather.map(item => item.requestId)).size !== weather.length)
      throw new Error('Preuves météo répétées.');
    return { ...result, weather };
  }
  return result;
}
