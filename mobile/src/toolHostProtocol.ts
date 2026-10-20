import { extendedToolEffects } from './nativeBundleTools';
import { DeviceToolName, deviceToolNames, legacyDeviceToolNames } from './deviceToolProtocol';
import { boundedIdentifier, Message } from './protocol';

type ToolEffect = 'read' | 'write' | 'interactive';
type ToolExecution = 'device' | 'apple_network' | 'private_gateway';
type ToolAvailability = 'available' | 'unavailable';
type ToolHostEntry = Readonly<{
  id: string;
  version: number;
  effect: ToolEffect;
  execution: ToolExecution;
  // Compiled support only. This does not grant any iOS permission or consent.
  availability: ToolAvailability;
}>;
export type ToolHostCapabilities = Readonly<{
  schemaVersion: 1;
  hostProtocolVersions: readonly number[];
  policyVersion: 1;
  catalogRevision: string;
  confirmation: 'all_accesses';
  tools: readonly ToolHostEntry[];
}>;
export type ToolHostSelection = Readonly<{
  hostProtocolVersion: 2;
  policyVersion: 1;
  catalogRevision: string;
  confirmation: 'all_accesses';
  requiredTools: readonly Readonly<{ id: DeviceToolName; version: 1 }>[];
}>;

const knownEffects: Readonly<Record<DeviceToolName, ToolEffect>> = {
  ...extendedToolEffects,
  contacts_search: 'read',
  calendar_list: 'read',
  calendar_create: 'write',
  reminders_list: 'read',
  reminder_create: 'write',
  location_current: 'read',
  photo_select: 'interactive',
  camera_capture: 'interactive',
  notification_schedule: 'write',
  biometrics_status: 'read',
  biometrics_authenticate: 'interactive',
  device_capabilities: 'read',
  native_boundary: 'read',
  maps_search: 'read',
  maps_directions: 'read',
  weather_forecast: 'read',
};
// Keep this public-text boundary aligned with native AssistToolContent.validate.
const reservedContentMarkers = [
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
] as const;

function incompatible(): never {
  throw new Error(
    'Le socle natif des outils est incompatible. Aucun accès lancé.',
  );
}
function closedObject(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return incompatible();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== fields.length ||
    !fields.every(field => Object.prototype.hasOwnProperty.call(row, field))
  )
    return incompatible();
  return row;
}
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}
function positiveVersion(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 65535
  );
}

/** Structural parsing permits future entries, never enables them automatically. */
export function parseToolHostCapabilities(json: string): ToolHostCapabilities {
  if (typeof json !== 'string' || utf8Bytes(json) > 24 * 1024)
    return incompatible();
  const row = closedObject(JSON.parse(json), [
    'schemaVersion',
    'hostProtocolVersions',
    'policyVersion',
    'catalogRevision',
    'confirmation',
    'tools',
  ]);
  if (
    row.schemaVersion !== 1 ||
    row.policyVersion !== 1 ||
    row.confirmation !== 'all_accesses' ||
    !boundedIdentifier(row.catalogRevision) ||
    !Array.isArray(row.hostProtocolVersions) ||
    row.hostProtocolVersions.length < 1 ||
    row.hostProtocolVersions.length > 8 ||
    !row.hostProtocolVersions.every(positiveVersion) ||
    new Set(row.hostProtocolVersions).size !==
      row.hostProtocolVersions.length ||
    !Array.isArray(row.tools) ||
    row.tools.length < 1 ||
    row.tools.length > 128
  )
    return incompatible();
  const ids = new Set<string>();
  const tools = row.tools.map(value => {
    const entry = closedObject(value, [
      'id',
      'version',
      'effect',
      'execution',
      'availability',
    ]);
    if (
      typeof entry.id !== 'string' ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(entry.id) ||
      ids.has(entry.id) ||
      !positiveVersion(entry.version) ||
      typeof entry.effect !== 'string' ||
      !['read', 'write', 'interactive'].includes(entry.effect) ||
      typeof entry.execution !== 'string' ||
      !['device', 'apple_network', 'private_gateway'].includes(
        entry.execution,
      ) ||
      typeof entry.availability !== 'string' ||
      !['available', 'unavailable'].includes(entry.availability)
    )
      return incompatible();
    ids.add(entry.id);
    return Object.freeze({
      id: entry.id,
      version: entry.version,
      effect: entry.effect as ToolEffect,
      execution: entry.execution as ToolExecution,
      availability: entry.availability as ToolAvailability,
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    hostProtocolVersions: Object.freeze([...row.hostProtocolVersions]),
    policyVersion: 1,
    catalogRevision: row.catalogRevision,
    confirmation: 'all_accesses',
    tools: Object.freeze(tools),
  });
}

/** Freeze only contracts understood by this JS bundle, not the entire host catalogue. */
export function negotiateToolHostCapabilities(
  json: string,
  required?: readonly DeviceToolName[],
): ToolHostSelection {
  const host = parseToolHostCapabilities(json);
  required ??= deviceToolNames.filter(id => legacyDeviceToolNames.includes(id) || host.tools.some(entry => entry.id === id));
  if (
    !host.hostProtocolVersions.includes(2) ||
    required.length === 0 ||
    required.length > deviceToolNames.length ||
    new Set(required).size !== required.length
  )
    return incompatible();
  const requiredTools = required.map(id => {
    if (!deviceToolNames.some(known => known === id)) return incompatible();
    const entry = host.tools.find(tool => tool.id === id);
    if (
      !entry ||
      entry.version !== 1 ||
      entry.effect !== knownEffects[id] ||
      entry.execution !== (['maps_search', 'maps_directions', 'weather_forecast'].includes(id) ? 'apple_network' : 'device') ||
      entry.availability !== 'available'
    )
      return incompatible();
    return Object.freeze({ id, version: 1 as const });
  });
  return Object.freeze({
    hostProtocolVersion: 2,
    policyVersion: 1,
    catalogRevision: host.catalogRevision,
    confirmation: 'all_accesses',
    requiredTools: Object.freeze(requiredTools),
  });
}

export function createToolHostRequest(
  selection: ToolHostSelection,
  turn: { requestId: string; messages: readonly Message[]; maxTokens?: number },
) {
  if (
    !boundedIdentifier(turn.requestId) ||
    utf8Bytes(turn.requestId) > 128 ||
    turn.messages.length !== 1 ||
    turn.messages[0].role !== 'user' ||
    !turn.messages[0].content.trim() ||
    utf8Bytes(turn.messages[0].content) > 8192 ||
    reservedContentMarkers.some(marker =>
      turn.messages[0].content.includes(marker),
    ) ||
    Array.from(turn.messages[0].content).some(character => {
      const code = character.codePointAt(0)!;
      return code === 127 || (code < 32 && ![9, 10, 13].includes(code));
    }) ||
    (turn.maxTokens !== undefined &&
      (!Number.isSafeInteger(turn.maxTokens) ||
        turn.maxTokens < 1 ||
        turn.maxTokens > 1024))
  )
    return incompatible();
  const request = {
    schemaVersion: 1 as const,
    hostProtocolVersion: selection.hostProtocolVersion,
    catalogRevision: selection.catalogRevision,
    requiredTools: selection.requiredTools.map(tool => ({ ...tool })),
    profile: 'device_v1' as const,
    requestId: turn.requestId,
    messages: turn.messages.map(message => ({ ...message })),
    temperature: 0,
    ...(turn.maxTokens === undefined ? {} : { maxTokens: turn.maxTokens }),
  };
  if (utf8Bytes(JSON.stringify(request)) > 24 * 1024) return incompatible();
  return request;
}
