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
export type GenerationResult = Progress & {
  finishReason: string;
  aneExecution: 'unverified';
  ttftMs?: number | null;
  peakPhysicalFootprintBytes?: number | null;
  requestedMaxTokens?: number | null;
  effectiveMaxTokens?: number;
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
    (value.modelName != null && typeof value.modelName !== 'string') ||
    (value.error != null && typeof value.error !== 'string') ||
    (value.loadElapsedMs != null && !finite(value.loadElapsedMs))
  ) {
    throw new Error('État natif invalide.');
  }
  return value as EngineState;
}
export function parseProgress(json: string): Progress {
  const value = object(json);
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
  parseProgress(json);
  if (
    typeof value.finishReason !== 'string' ||
    value.aneExecution !== 'unverified'
  ) {
    throw new Error('Rapport natif invalide.');
  }
  return value as GenerationResult;
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
