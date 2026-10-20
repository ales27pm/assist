import type { AppleForecast } from './applePlacesProtocol';

export type Message = { role: 'user' | 'assistant'; content: string };
export type Phase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'generating'
  | 'cancelling'
  | 'failed';
export type EngineState = {
  phase: Phase;
  contextCapacity: number;
  bundledModelAvailable?: boolean;
  selectedModelAvailable?: boolean;
  selectedModelName?: string | null;
  selectedModelError?: string | null;
  modelName?: string | null;
  error?: string | null;
  loadElapsedMs?: number | null;
  beforeLoadPhysicalFootprintBytes?: number | null;
  afterLoadPhysicalFootprintBytes?: number | null;
};
export type Progress = {
  requestId: string;
  text: string;
  generatedTokens: number;
  promptTokens: number;
  elapsedMs: number;
};
export type AgentCapabilities = {
  schemaVersion: 1;
  calendarReadOnly: true;
  protocolVersion: 1;
};
export type CalendarAgentTrace = {
  schemaVersion: 1;
  tool: 'calendar.list';
  callId: string;
  scope: {
    startISO: string;
    endISO: string;
    timeZoneIdentifier: string;
  };
  returnedCount: number;
  possiblyTruncated: boolean;
};
export type GenerationResult = Progress & {
  weather?: AppleForecast[];
  finishReason: string;
  aneExecution: 'unverified';
  ttftMs?: number | null;
  peakPhysicalFootprintBytes?: number | null;
  requestedMaxTokens?: number | null;
  effectiveMaxTokens?: number;
  agentTrace?: CalendarAgentTrace | null;
  numericalDiagnostics?: {
    schemaVersion: 1;
    promptTokenEncoding: 'uint32-little-endian';
    promptTokenSHA256: string;
    logitsDomain: 'engine_returned';
    temperature: number;
    processedTokensBefore: number;
    processedTokensAtGenerationStart: number;
    steps: {
      step: number;
      tokenId: number;
      topCandidates: { tokenId: number; logit: number }[];
      nonfiniteLogits: number;
      logitsAvailable: boolean;
    }[];
  };
};

function object(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Réponse native invalide.');
  }
  return value as Record<string, unknown>;
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function closedObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
  );
}

export function parseAgentCapabilities(json: string): AgentCapabilities {
  const value = object(json);
  if (
    !closedObject(value, [
      'schemaVersion',
      'calendarReadOnly',
      'protocolVersion',
    ]) ||
    value.schemaVersion !== 1 ||
    value.calendarReadOnly !== true ||
    value.protocolVersion !== 1
  )
    throw new Error(
      'La consultation du calendrier n’est pas disponible dans cette version.',
    );
  return value as AgentCapabilities;
}

export function boundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !!value.trim() &&
    value.length <= 128 &&
    !Array.from(value).some(character => {
      const code = character.charCodeAt(0);
      return (
        code < 32 || code === 127 || character === '<' || character === '>'
      );
    })
  );
}

function validISO(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts =
    /^(?!0000)(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?Z$/.exec(
      value,
    );
  if (!parts) return false;
  const [, year, month, day, hour, minute, second] = parts;
  const y = Number(year),
    m = Number(month),
    d = Number(day);
  const days = [
    31,
    y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    m >= 1 &&
    m <= 12 &&
    d >= 1 &&
    d <= days[m - 1] &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

export function validCalendarScope(
  scope: unknown,
): scope is CalendarAgentTrace['scope'] {
  return (
    closedObject(scope, ['startISO', 'endISO', 'timeZoneIdentifier']) &&
    validISO(scope.startISO) &&
    validISO(scope.endISO) &&
    Date.parse(scope.endISO) - Date.parse(scope.startISO) >= 23 * 3_600_000 &&
    Date.parse(scope.endISO) - Date.parse(scope.startISO) <= 25 * 3_600_000 &&
    boundedIdentifier(scope.timeZoneIdentifier)
  );
}

export function validAgentTrace(value: unknown): value is CalendarAgentTrace {
  if (
    !closedObject(value, [
      'schemaVersion',
      'tool',
      'callId',
      'scope',
      'returnedCount',
      'possiblyTruncated',
    ])
  )
    return false;
  const scope = value.scope;
  return (
    value.schemaVersion === 1 &&
    value.tool === 'calendar.list' &&
    boundedIdentifier(value.callId) &&
    validCalendarScope(scope) &&
    typeof value.returnedCount === 'number' &&
    Number.isSafeInteger(value.returnedCount) &&
    value.returnedCount >= 0 &&
    value.returnedCount <= 5 &&
    typeof value.possiblyTruncated === 'boolean' &&
    value.possiblyTruncated === (value.returnedCount === 5)
  );
}
export function parseState(json: string): EngineState {
  const value = object(json);
  const phases = [
    'idle',
    'loading',
    'ready',
    'generating',
    'cancelling',
    'failed',
  ];
  if (
    typeof value.phase !== 'string' ||
    !phases.includes(value.phase) ||
    !finite(value.contextCapacity) ||
    (value.bundledModelAvailable !== undefined &&
      typeof value.bundledModelAvailable !== 'boolean') ||
    (value.selectedModelAvailable !== undefined &&
      typeof value.selectedModelAvailable !== 'boolean') ||
    (value.selectedModelName != null &&
      typeof value.selectedModelName !== 'string') ||
    (value.selectedModelError != null &&
      typeof value.selectedModelError !== 'string') ||
    (value.modelName != null && typeof value.modelName !== 'string') ||
    (value.error != null && typeof value.error !== 'string') ||
    (value.loadElapsedMs != null && !finite(value.loadElapsedMs))
  ) {
    throw new Error('État natif invalide.');
  }
  return value as EngineState;
}
export function parseProgress(json: string): Progress {
  return progress(object(json));
}
function progress(value: Record<string, unknown>): Progress {
  if (
    typeof value.requestId !== 'string' ||
    typeof value.text !== 'string' ||
    !finite(value.generatedTokens) ||
    !finite(value.promptTokens) ||
    !finite(value.elapsedMs)
  ) {
    throw new Error('Mesure native invalide.');
  }
  return value as Progress;
}
export function parseResult(json: string): GenerationResult {
  const value = object(json);
  progress(value);
  if (
    typeof value.finishReason !== 'string' ||
    value.aneExecution !== 'unverified' ||
    (value.agentTrace != null && !validAgentTrace(value.agentTrace))
  ) {
    throw new Error('Rapport natif invalide.');
  }
  return value as GenerationResult;
}

/** This tool grammar reserves its control delimiters; ordinary chat stays unchanged. */
export function parseCalendarResult(json: string): GenerationResult {
  const result = parseResult(json);
  if (/<\||\|>|<tool_|<channel|<turn/.test(result.text)) {
    throw new Error('Réponse de consultation invalide.');
  }
  for (const character of result.text) {
    const code = character.charCodeAt(0);
    if (
      (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) &&
      !/\s/.test(character)
    ) {
      throw new Error('Réponse de consultation invalide.');
    }
  }
  return result;
}

export type PrimitiveReport = {
  schemaVersion: 1 | 2;
  kind: 'assistPrimitiveQualification';
  scope: 'primitive_only_gemma_unqualified';
  aneExecution: 'unverified';
  summary: {
    cases: number;
    failed: number;
    nonfinite: number;
    maxULP: number | null;
  };
};

export function parsePrimitiveReport(json: string): PrimitiveReport {
  const value = object(json);
  const summary = value.summary as Record<string, unknown> | undefined;
  const count = (item: unknown): item is number =>
    finite(item) && Number.isSafeInteger(item);
  const assets = Array.isArray(value.assets) ? value.assets : [];
  const hash = (item: unknown): boolean =>
    typeof item === 'string' && /^[0-9a-f]{64}$/.test(item);
  const comparisonAssets =
    assets.length === 2 &&
    ['f16_boundary', 'f32_boundary'].every(variant =>
      assets.some(
        item =>
          item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          item.variant === variant &&
          hash(item.fixtureAssetSHA256) &&
          hash(item.manifestSHA256),
      ),
    );
  if (
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    value.kind !== 'assistPrimitiveQualification' ||
    value.scope !== 'primitive_only_gemma_unqualified' ||
    value.aneExecution !== 'unverified' ||
    !summary ||
    !count(summary.cases) ||
    (value.schemaVersion === 1
      ? summary.cases !== 24
      : summary.cases !== 48 || !comparisonAssets) ||
    !count(summary.failed) ||
    summary.failed > summary.cases ||
    !count(summary.nonfinite) ||
    (summary.maxULP !== null && !count(summary.maxULP))
  ) {
    throw new Error('Diagnostic natif invalide.');
  }
  return value as PrimitiveReport;
}
// Empty means real remaining context, never an implicit 32-token cap.
export function outputBudget(input: string): number | null {
  if (!input.trim()) {
    return null;
  }
  if (!/^\d+$/.test(input.trim())) {
    throw new Error('Entre un entier positif, ou laisse vide.');
  }
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Le budget doit être un entier positif.');
  }
  return value;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
