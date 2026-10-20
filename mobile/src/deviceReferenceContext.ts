import { parseUniqueJSON } from './uniqueJSON';

export type DeviceReferenceTurn = Readonly<{ user: string; assistant: string }>;
export type DeviceReferenceContext = Readonly<{
  schemaVersion: 1;
  turns: readonly DeviceReferenceTurn[];
  omittedTurns: number;
}>;

export function emptyDeviceReferenceContext(): DeviceReferenceContext {
  return Object.freeze({ schemaVersion: 1, turns: Object.freeze([]), omittedTurns: 0 });
}
function bytes(text: string): number {
  let total = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    total += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return total;
}
function safeText(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || bytes(value) > 2048) return false;
  if (/<\||\|>|<\/?(?:turn|channel|tool|bos|eos|pad|unk|function|atem:)|\[TOOL_CALLS\]/i.test(value)) return false;
  if (Array.from(value).some(character => {
    const code = character.codePointAt(0)!;
    return code === 127 || (code < 32 && ![9, 10, 13].includes(code));
  })) return false;
  return ![
    /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i,
    /\b(?:requestId|operationId|confirmationToken|inbox_id|document_id|calendarId|tool_calls|tool_responses)\b/i,
    /(?:file|content):\/\/|(?:^|[\s"'(])\/(?:[^\s/]+\/)*[^\s]+|[a-z]:\\/i,
    /^\s*[{[]/m,
  ].some(pattern => pattern.test(value));
}
function frozen(turns: readonly DeviceReferenceTurn[], omittedTurns: number): DeviceReferenceContext {
  return Object.freeze({ schemaVersion: 1, turns: Object.freeze(turns.map(turn => Object.freeze({ ...turn }))), omittedTurns });
}
export function validateDeviceReferenceContext(value: DeviceReferenceContext): DeviceReferenceContext {
  if (!value || Object.keys(value).sort().join(',') !== 'omittedTurns,schemaVersion,turns' ||
      value.schemaVersion !== 1 || !Array.isArray(value.turns) || value.turns.length > 3 ||
      !Number.isSafeInteger(value.omittedTurns) || value.omittedTurns < 0 || value.omittedTurns > 1_000_000 ||
      value.turns.some(turn => !turn || Object.keys(turn).sort().join(',') !== 'assistant,user' || !safeText(turn.user) || !safeText(turn.assistant)) ||
      value.turns.reduce((total, turn) => total + bytes(turn.user) + bytes(turn.assistant), 0) > 8192) {
    throw new Error('Contexte de référence incompatible.');
  }
  return frozen(value.turns, value.omittedTurns);
}

/** Keep whole completed turns only; exclusions remain explicit, never truncated. */
export function appendDeviceReferenceTurn(
  context: DeviceReferenceContext, user: string, assistant: string, eligible: boolean,
): DeviceReferenceContext {
  const turns = [...context.turns];
  let omitted = context.omittedTurns;
  if (!eligible || !safeText(user) || !safeText(assistant)) {
    return frozen(turns, Math.min(1_000_000, omitted + 1));
  }
  turns.push({ user, assistant });
  while (turns.length > 3 || turns.reduce((total, turn) => total + bytes(turn.user) + bytes(turn.assistant), 0) > 8192) {
    turns.shift();
    omitted = Math.min(1_000_000, omitted + 1);
  }
  return frozen(turns, omitted);
}

/** Background/opt-out removes reusable text while preserving the omission fact. */
export function omitDeviceReferenceContext(context: DeviceReferenceContext): DeviceReferenceContext {
  return frozen([], Math.min(1_000_000, context.omittedTurns + context.turns.length));
}

/** Only explicit native v3 proof admits a tool answer, even if activity was lost. */
export function deviceReferenceResultEligible(json: string): boolean {
  try {
    const value = parseUniqueJSON(json);
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      (value as Record<string, unknown>).referenceContextEligible === true;
  } catch { return false; }
}
