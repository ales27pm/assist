export type MonitoringPhase =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'generating'
  | 'cancelling'
  | 'failed'
  | 'diagnosing';

export type MonitoringSample = {
  phase: MonitoringPhase;
  sessionElapsedMs: number;
  physicalFootprintBytes?: number | null;
  peakPhysicalFootprintBytes?: number | null;
  availableMemoryBytes?: number | null;
  cpuPercent?: number | null;
  thermalState: 'nominal' | 'fair' | 'serious' | 'critical' | 'unknown';
  memoryPressure: 'normal' | 'warning' | 'critical' | 'unknown';
  lowPowerMode: boolean;
  promptTokens?: number | null;
  generatedTokens?: number | null;
  ttftMs?: number | null;
  decodeTokensPerSecond?: number | null;
  generationElapsedMs?: number | null;
  contextCapacity?: number | null;
  requestId?: string | null;
};

export type MonitoringEvent = {
  sequence: number;
  elapsedMs: number;
  code: string;
  severity: 'info' | 'warning' | 'critical';
  phase: MonitoringPhase;
};

export type MonitoringGeneration = Pick<
  MonitoringSample,
  | 'promptTokens'
  | 'generatedTokens'
  | 'ttftMs'
  | 'decodeTokensPerSecond'
  | 'generationElapsedMs'
  | 'requestId'
> & { finishReason?: string | null };

export type MonitoringSnapshot = {
  schemaVersion: 1;
  kind: 'assistRuntimeMonitoring';
  aneExecution: 'unverified';
  nativeBuild: string;
  osVersion: string;
  measurementMethods: Record<string, string>;
  current: MonitoringSample;
  history: MonitoringSample[];
  events: MonitoringEvent[];
  diagnostic: { completed: number; total: number; failed: number } | null;
  generations?: MonitoringGeneration[];
  [key: string]: unknown;
};

const phases: string[] = [
  'idle',
  'loading',
  'ready',
  'generating',
  'cancelling',
  'failed',
  'diagnosing',
];
const countFields = [
  'physicalFootprintBytes',
  'peakPhysicalFootprintBytes',
  'availableMemoryBytes',
  'promptTokens',
  'generatedTokens',
  'contextCapacity',
];
const timingFields = [
  'cpuPercent',
  'ttftMs',
  'decodeTokensPerSecond',
  'generationElapsedMs',
];
const privateKeys = new Set([
  'prompt',
  'text',
  'messages',
  'content',
  'path',
  'modelpath',
  'directory',
  'directoryurl',
  'modelurl',
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function count(value: unknown): value is number {
  return finite(value) && Number.isSafeInteger(value);
}
function string(value: unknown, maximum = 160): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maximum
  );
}
function optionalMetrics(value: Record<string, unknown>): boolean {
  return (
    countFields.every(key => value[key] == null || count(value[key])) &&
    timingFields.every(key => value[key] == null || finite(value[key])) &&
    (value.requestId == null || string(value.requestId, 128))
  );
}
function sample(value: unknown): value is MonitoringSample {
  return (
    record(value) &&
    typeof value.phase === 'string' &&
    phases.includes(value.phase) &&
    finite(value.sessionElapsedMs) &&
    typeof value.thermalState === 'string' &&
    ['nominal', 'fair', 'serious', 'critical', 'unknown'].includes(
      value.thermalState,
    ) &&
    typeof value.memoryPressure === 'string' &&
    ['normal', 'warning', 'critical', 'unknown'].includes(
      value.memoryPressure,
    ) &&
    typeof value.lowPowerMode === 'boolean' &&
    optionalMetrics(value)
  );
}

// Keep additional bounded native evidence, while rejecting conversation data.
function safeEvidence(value: unknown, depth = 0): boolean {
  if (depth > 12) {
    return false;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'string') {
    return value.length <= 4096;
  }
  if (Array.isArray(value)) {
    return (
      value.length <= 200 && value.every(item => safeEvidence(item, depth + 1))
    );
  }
  if (record(value)) {
    const entries = Object.entries(value);
    return (
      entries.length <= 64 &&
      entries.every(
        ([key, item]) =>
          !privateKeys.has(key.toLowerCase()) && safeEvidence(item, depth + 1),
      )
    );
  }
  return value === null || typeof value === 'boolean';
}

export function parseMonitoringSnapshot(json: string): MonitoringSnapshot {
  const invalid = () => new Error('Suivi natif invalide.');
  if (json.length > 1_048_576) {
    throw invalid();
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw invalid();
  }
  if (!record(value) || !safeEvidence(value)) {
    throw invalid();
  }
  const diagnostic = value.diagnostic;
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'assistRuntimeMonitoring' ||
    value.aneExecution !== 'unverified' ||
    !string(value.nativeBuild) ||
    !string(value.osVersion) ||
    !record(value.measurementMethods) ||
    !Object.values(value.measurementMethods).every(item =>
      string(item, 4096),
    ) ||
    !sample(value.current) ||
    !Array.isArray(value.history) ||
    value.history.length > 60 ||
    !value.history.every(sample) ||
    !Array.isArray(value.events) ||
    value.events.length > 200 ||
    !value.events.every(
      item =>
        record(item) &&
        count(item.sequence) &&
        finite(item.elapsedMs) &&
        string(item.code, 96) &&
        /^[A-Za-z0-9_]+$/.test(item.code) &&
        ['info', 'warning', 'critical'].includes(String(item.severity)) &&
        phases.includes(String(item.phase)),
    ) ||
    (value.generations !== undefined &&
      (!Array.isArray(value.generations) ||
        value.generations.length > 100 ||
        !value.generations.every(
          item =>
            record(item) &&
            optionalMetrics(item) &&
            (item.finishReason == null || string(item.finishReason, 96)),
        ))) ||
    (diagnostic !== null &&
      (!record(diagnostic) ||
        !count(diagnostic.completed) ||
        !count(diagnostic.total) ||
        diagnostic.total < 1 ||
        !count(diagnostic.failed) ||
        diagnostic.completed > diagnostic.total ||
        diagnostic.failed > diagnostic.completed))
  ) {
    throw invalid();
  }
  return value as MonitoringSnapshot;
}
