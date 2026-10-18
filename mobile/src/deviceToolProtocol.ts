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
] as const;
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
export type DeviceToolReceipt = {
  operationId: string;
  tool: DeviceToolName;
  status: 'success' | 'outcome_unknown';
  completedAt: string;
  summary: ToolField[];
};
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
};
export type DeviceToolActivity = {
  schemaVersion: 1;
  requestId: string;
  transaction: DeviceToolTransaction;
};

export const deviceToolLabels: Record<DeviceToolName, string> = {
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
function receipt(value: unknown): value is DeviceToolReceipt {
  const row = object(value);
  return (
    keys(row, ['operationId', 'tool', 'status', 'completedAt', 'summary']) &&
    boundedIdentifier(row.operationId) &&
    tool(row.tool) &&
    ['success', 'outcome_unknown'].includes(String(row.status)) &&
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
    value.tools.length !== deviceToolNames.length ||
    new Set(value.tools).size !== deviceToolNames.length ||
    !value.tools.every(tool)
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
  const expectedEffect = [
    'calendar_create',
    'reminder_create',
    'notification_schedule',
  ].includes(String(row.tool))
    ? 'write'
    : ['photo_select', 'camera_capture', 'biometrics_authenticate'].includes(
        String(row.tool),
      )
    ? 'interactive'
    : 'read';
  if (
    !keys(event, ['schemaVersion', 'requestId', 'transaction']) ||
    event.schemaVersion !== 1 ||
    !boundedIdentifier(event.requestId) ||
    !keys(
      row,
      ['id', 'revision', 'tool', 'effect', 'title', 'status', 'preview'],
      ['confirmationToken', 'capability', 'receipt'],
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
        transaction.effect === 'write' && transaction.status === 'executing'
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
export function parseToolOperations(json: string): DeviceToolReceipt[] {
  const value = decode(json);
  if (
    !keys(value, ['schemaVersion', 'operations']) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.operations) ||
    value.operations.length > 100 ||
    !value.operations.every(receipt) ||
    new Set(value.operations.map(item => item.operationId)).size !==
      value.operations.length
  )
    throw new Error('Journal outil invalide.');
  return value.operations as DeviceToolReceipt[];
}
export function parseDeviceToolResult(json: string): GenerationResult {
  const result = parseCalendarResult(json);
  if (decode(json).agentTools !== true || utf8Bytes(result.text) > 8192)
    throw new Error('Réponse outil invalide.');
  return result;
}
