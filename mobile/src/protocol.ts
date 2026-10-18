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
export type GenerationResult = Progress & {
  finishReason: string;
  aneExecution: 'unverified';
  ttftMs?: number | null;
  peakPhysicalFootprintBytes?: number | null;
  requestedMaxTokens?: number | null;
  effectiveMaxTokens?: number;
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
    value.aneExecution !== 'unverified'
  ) {
    throw new Error('Rapport natif invalide.');
  }
  return value as GenerationResult;
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
