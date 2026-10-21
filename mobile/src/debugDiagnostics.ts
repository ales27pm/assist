/** Closed, content-free bridge contract. Never return the decoded input object. */
export const debugCategories = [
  'engine',
  'planning',
  'context',
  'tools',
  'consent',
  'voice',
  'network',
  'apple',
  'documents',
  'translation',
  'alarms',
  'storage',
  'bridge',
  'lifecycle',
  'performance',
  'system',
] as const;
export const debugStages = [
  'admission',
  'context',
  'tokenization',
  'roots',
  'leaves',
  'generation',
  'validation',
  'proposal',
  'permission',
  'confirmation',
  'execution',
  'receipt',
  'presentation',
  'cancellation',
  'modelLoad',
  'lifecycle',
  'systemReport',
  'configuration',
] as const;
export const debugOutcomes = [
  'began',
  'completed',
  'rejected',
  'failed',
  'cancelled',
  'unknown',
  'stalled',
] as const;
export const debugReasons = [
  'context',
  'prompt',
  'budget',
  'json',
  'shape',
  'branch',
  'text',
  'distinctness',
  'unsupported',
  'boundary',
  'stop',
  'length',
  'deadline',
  'engine',
  'unknown',
  'eos1',
  'turn106',
  'tool50',
  'otherStop',
  'noStop',
  'typeMismatch',
  'missingField',
  'unexpectedKeys',
  'integerRange',
  'duplicateID',
  'fieldTooLong',
  'controlCharacter',
  'reservedContent',
  'permissionDenied',
  'outcomeUnknown',
  'imageUnavailable',
  'connectionUnavailable',
  'cancelRequested',
  'notObserved',
  'systemCrash',
  'systemHang',
  'systemCPU',
  'systemDisk',
  'memoryWarning',
  'thermalSerious',
  'thermalCritical',
  'systemMemory',
  'systemAppLaunch',
] as const;
export const debugFields = [
  'roots',
  'leaves',
  'id',
  'root',
  'mode',
  'tool',
  'intent',
  'condition',
  'fit',
  'grounding',
  'payload',
  'protocol',
  'output',
] as const;
export const debugMetrics = [
  'durationMs',
  'inputBytes',
  'outputBytes',
  'promptTokens',
  'generatedTokens',
  'budgetTokens',
  'contextCapacity',
  'messageCount',
  'passIndex',
  'branchIndex',
  'fieldBytes',
  'limitBytes',
  'itemCount',
  'pendingOperations',
  'physicalFootprintBytes',
  'availableMemoryBytes',
  'cpuPercent',
  'signal',
  'exceptionType',
  'reportCount',
  'hangDurationMs',
] as const;
export const debugFindingCodes = [
  'preparationRejected',
  'generationInterrupted',
  'nativeFailure',
  'permissionDenied',
  'outcomeUnknown',
  'cancellationObserved',
  'collectionTruncated',
  'persistenceUnavailable',
  'systemCrashReport',
  'systemHangReport',
  'systemResourceReport',
  'noCausalEvidence',
  'operationStalled',
] as const;
export type DebugCategory = (typeof debugCategories)[number];
export type DebugStage = (typeof debugStages)[number];
export type DebugMode = 'off' | 'standard' | 'detailed';
export type DebugRecord = {
  sequence: number;
  elapsedMs: number;
  traceId: string | null;
  category: DebugCategory;
  stage: DebugStage;
  outcome: (typeof debugOutcomes)[number];
  reason: (typeof debugReasons)[number] | null;
  field: (typeof debugFields)[number] | null;
  metrics: Partial<Record<(typeof debugMetrics)[number], number>>;
};
export type DebugFinding = {
  code: (typeof debugFindingCodes)[number];
  severity: 'info' | 'warning' | 'critical';
  evidence: 'observed' | 'inferred' | 'unmeasured';
  sequence: number | null;
  traceId: string | null;
};
export type DebugCoverage = {
  category: DebugCategory;
  state: 'instrumented' | 'partial' | 'unavailable';
};
export type DebugStatus = {
  schemaVersion: 1;
  kind: 'assistDebugStatus';
  sessionId: string;
  revision: number;
  mode: DebugMode;
  detailExpiresAt: string | null;
  recordCount: number;
  omittedRecords: number;
  rejectedRecords: number;
  previousSessionCount: number;
  persistence: 'notAttempted' | 'saved' | 'unavailable';
  records: DebugRecord[];
  findings: DebugFinding[];
  coverage: DebugCoverage[];
  limits: {
    maxRecords: 512;
    maxSessionBytes: 262144;
    maxPreviousSessions: 2;
    detailedSeconds: 900;
  };
  privacy: { contentCaptured: false; automaticUpload: false };
};
export type DebugSession = {
  schemaVersion: 1;
  kind: 'assistDebugSession';
  sessionId: string;
  nativeBuild: string;
  osVersion: string;
  startedAt: string;
  capturedAt: string;
  records: DebugRecord[];
  omittedRecords: number;
  rejectedRecords: number;
};
export type DebugBundle = {
  schemaVersion: 1;
  kind: 'assistDebugBundle';
  exportedAt: string;
  status: DebugStatus;
  current: DebugSession;
  previous: DebugSession[];
};

export const debugCategoryLabels: Record<DebugCategory, string> = {
  engine: 'Moteur',
  planning: 'Préparation',
  context: 'Contexte',
  tools: 'Outils',
  consent: 'Consentement',
  voice: 'Voix',
  network: 'Réseau',
  apple: 'Services Apple',
  documents: 'Documents',
  translation: 'Traduction',
  alarms: 'Alarmes',
  storage: 'Stockage',
  bridge: 'Pont natif',
  lifecycle: 'Cycle de vie',
  performance: 'Performances',
  system: 'Système',
};
export const debugFindingLabels: Record<DebugFinding['code'], string> = {
  preparationRejected: 'Préparation locale refusée',
  generationInterrupted: 'Génération interrompue',
  nativeFailure: 'Échec natif',
  permissionDenied: 'Autorisation refusée',
  outcomeUnknown: 'Résultat d’action incertain',
  cancellationObserved: 'Annulation observée',
  collectionTruncated: 'Journal tronqué',
  persistenceUnavailable: 'Sauvegarde locale indisponible',
  systemCrashReport: 'Rapport système de plantage reçu',
  systemHangReport: 'Rapport système de blocage reçu',
  systemResourceReport: 'Rapport système de ressources reçu',
  noCausalEvidence: 'Cause non établie',
  operationStalled: 'Opération sans fin observée',
};
export const debugEvidenceLabels: Record<DebugFinding['evidence'], string> = {
  observed: 'Observé',
  inferred: 'Déduit',
  unmeasured: 'Non mesuré',
};
export const debugSeverityLabels: Record<DebugFinding['severity'], string> = {
  info: 'Information',
  warning: 'Avertissement',
  critical: 'Critique',
};
export const debugCoverageLabels: Record<DebugCoverage['state'], string> = {
  instrumented: 'Instrumentée',
  partial: 'Partielle',
  unavailable: 'Indisponible',
};
export const debugReasonLabels: Record<
  NonNullable<DebugRecord['reason']>,
  string
> = {
  context: 'Contexte',
  prompt: 'Entrée du modèle',
  budget: 'Budget',
  json: 'Format JSON',
  shape: 'Structure',
  branch: 'Branche',
  text: 'Texte',
  distinctness: 'Distinction des branches',
  unsupported: 'Non pris en charge',
  boundary: 'Frontière de génération',
  stop: 'Arrêt',
  length: 'Limite de longueur',
  deadline: 'Délai atteint',
  engine: 'Moteur',
  unknown: 'Inconnu',
  eos1: 'Arrêt EOS (1)',
  turn106: 'Fin de tour (106)',
  tool50: 'Frontière outil (50)',
  otherStop: 'Autre arrêt',
  noStop: 'Aucun arrêt observé',
  typeMismatch: 'Type incorrect',
  missingField: 'Champ manquant',
  unexpectedKeys: 'Champs inattendus',
  integerRange: 'Entier hors limites',
  duplicateID: 'Identifiant répété',
  fieldTooLong: 'Champ trop long',
  controlCharacter: 'Caractère de contrôle',
  reservedContent: 'Contenu réservé',
  permissionDenied: 'Autorisation refusée',
  outcomeUnknown: 'Résultat incertain',
  imageUnavailable: 'Image indisponible',
  connectionUnavailable: 'Connexion indisponible',
  cancelRequested: 'Annulation demandée',
  notObserved: 'Non observé',
  systemCrash: 'Plantage signalé par le système',
  systemHang: 'Blocage signalé par le système',
  systemCPU: 'Rapport CPU du système',
  systemDisk: 'Rapport disque du système',
  memoryWarning: 'Avertissement mémoire',
  thermalSerious: 'État thermique élevé',
  thermalCritical: 'État thermique critique',
  systemMemory: 'Rapport mémoire du système',
  systemAppLaunch: 'Rapport de lancement de l’app',
};

function invalid(): never {
  throw new Error('Diagnostic avancé invalide ou incompatible.');
}
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid();
  const result = value as Record<string, unknown>;
  const actual = Object.keys(result);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key)))
    invalid();
  return result;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid();
  return value as T;
}
function number(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > maximum
  )
    invalid();
  return value;
}
function integer(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
  minimum = 0,
): number {
  const result = number(value, maximum);
  if (!Number.isSafeInteger(result) || result < minimum) invalid();
  return result;
}
function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    invalid();
  return value;
}
function trace(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    !/^t[1-9][0-9]{0,9}$/.test(value) ||
    Number(value.slice(1)) > 2_147_483_647
  )
    invalid();
  return value;
}
function date(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  )
    invalid();
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    invalid();
  return value;
}
function metadata(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > maximum ||
    !/^[A-Za-z0-9 ()._-]+$/.test(value)
  )
    invalid();
  return value;
}
function array<T>(
  value: unknown,
  maximum: number,
  parse: (entry: unknown) => T,
): T[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  return value.map(parse);
}
function record(value: unknown): DebugRecord {
  const data = object(value, [
    'sequence',
    'elapsedMs',
    'traceId',
    'category',
    'stage',
    'outcome',
    'reason',
    'field',
    'metrics',
  ]);
  if (
    data.metrics === null ||
    typeof data.metrics !== 'object' ||
    Array.isArray(data.metrics)
  )
    invalid();
  const metrics: DebugRecord['metrics'] = {};
  const values = data.metrics as Record<string, unknown>;
  Object.keys(values).forEach(key => choice(key, debugMetrics));
  for (const key of debugMetrics)
    if (Object.prototype.hasOwnProperty.call(values, key))
      metrics[key] = number(values[key]);
  return {
    sequence: integer(data.sequence, Number.MAX_SAFE_INTEGER, 1),
    elapsedMs: number(data.elapsedMs),
    traceId: trace(data.traceId),
    category: choice(data.category, debugCategories),
    stage: choice(data.stage, debugStages),
    outcome: choice(data.outcome, debugOutcomes),
    reason: data.reason === null ? null : choice(data.reason, debugReasons),
    field: data.field === null ? null : choice(data.field, debugFields),
    metrics,
  };
}
function records(value: unknown, maximum: number): DebugRecord[] {
  const result = array(value, maximum, record);
  if (
    result.some(
      (entry, index) =>
        index > 0 &&
        (entry.sequence <= result[index - 1].sequence ||
          entry.elapsedMs < result[index - 1].elapsedMs),
    )
  )
    invalid();
  return result;
}
function finding(value: unknown): DebugFinding {
  const data = object(value, [
    'code',
    'severity',
    'evidence',
    'sequence',
    'traceId',
  ]);
  return {
    code: choice(data.code, debugFindingCodes),
    severity: choice(data.severity, ['info', 'warning', 'critical']),
    evidence: choice(data.evidence, ['observed', 'inferred', 'unmeasured']),
    sequence:
      data.sequence === null
        ? null
        : integer(data.sequence, Number.MAX_SAFE_INTEGER, 1),
    traceId: trace(data.traceId),
  };
}
function status(value: unknown): DebugStatus {
  const data = object(value, [
    'schemaVersion',
    'kind',
    'sessionId',
    'revision',
    'mode',
    'detailExpiresAt',
    'recordCount',
    'omittedRecords',
    'rejectedRecords',
    'previousSessionCount',
    'persistence',
    'records',
    'findings',
    'coverage',
    'limits',
    'privacy',
  ]);
  if (data.schemaVersion !== 1 || data.kind !== 'assistDebugStatus') invalid();
  const limits = object(data.limits, [
    'maxRecords',
    'maxSessionBytes',
    'maxPreviousSessions',
    'detailedSeconds',
  ]);
  if (
    limits.maxRecords !== 512 ||
    limits.maxSessionBytes !== 262144 ||
    limits.maxPreviousSessions !== 2 ||
    limits.detailedSeconds !== 900
  )
    invalid();
  const privacy = object(data.privacy, ['contentCaptured', 'automaticUpload']);
  if (privacy.contentCaptured !== false || privacy.automaticUpload !== false)
    invalid();
  const coverage = array(data.coverage, 16, entry => {
    const item = object(entry, ['category', 'state']);
    return {
      category: choice(item.category, debugCategories),
      state: choice(item.state, [
        'instrumented',
        'partial',
        'unavailable',
      ] as const),
    };
  });
  if (
    coverage.length !== 16 ||
    new Set(coverage.map(entry => entry.category)).size !== 16
  )
    invalid();
  const mode = choice(data.mode, ['off', 'standard', 'detailed'] as const);
  const detailExpiresAt =
    data.detailExpiresAt === null ? null : date(data.detailExpiresAt);
  if ((mode === 'detailed') !== (detailExpiresAt !== null)) invalid();
  const recent = records(data.records, 30);
  const recordCount = integer(data.recordCount, 512);
  if (recordCount < recent.length) invalid();
  return {
    schemaVersion: 1,
    kind: 'assistDebugStatus',
    sessionId: uuid(data.sessionId),
    revision: integer(data.revision),
    mode,
    detailExpiresAt,
    recordCount,
    omittedRecords: integer(data.omittedRecords),
    rejectedRecords: integer(data.rejectedRecords),
    previousSessionCount: integer(data.previousSessionCount, 2),
    persistence: choice(data.persistence, [
      'notAttempted',
      'saved',
      'unavailable',
    ]),
    records: recent,
    findings: array(data.findings, 32, finding),
    coverage,
    limits: {
      maxRecords: 512,
      maxSessionBytes: 262144,
      maxPreviousSessions: 2,
      detailedSeconds: 900,
    },
    privacy: { contentCaptured: false, automaticUpload: false },
  };
}
function session(value: unknown): DebugSession {
  const data = object(value, [
    'schemaVersion',
    'kind',
    'sessionId',
    'nativeBuild',
    'osVersion',
    'startedAt',
    'capturedAt',
    'records',
    'omittedRecords',
    'rejectedRecords',
  ]);
  if (data.schemaVersion !== 1 || data.kind !== 'assistDebugSession') invalid();
  const result: DebugSession = {
    schemaVersion: 1,
    kind: 'assistDebugSession',
    sessionId: uuid(data.sessionId),
    nativeBuild: metadata(data.nativeBuild, 64),
    osVersion: metadata(data.osVersion, 256),
    startedAt: date(data.startedAt),
    capturedAt: date(data.capturedAt),
    records: records(data.records, 512),
    omittedRecords: integer(data.omittedRecords),
    rejectedRecords: integer(data.rejectedRecords),
  };
  // Every accepted string/key is ASCII, so encoded length is also its UTF-8 size.
  if (JSON.stringify(result).length > 262144) invalid();
  return result;
}
function decode(json: string): unknown {
  if (typeof json !== 'string' || json.length > 1_048_576) invalid();
  try {
    return JSON.parse(json);
  } catch {
    return invalid();
  }
}
export function parseDebugDiagnosticsStatus(json: string): DebugStatus {
  return status(decode(json));
}
export function parseDebugDiagnosticsBundle(json: string): DebugBundle {
  const data = object(decode(json), [
    'schemaVersion',
    'kind',
    'exportedAt',
    'status',
    'current',
    'previous',
  ]);
  if (data.schemaVersion !== 1 || data.kind !== 'assistDebugBundle') invalid();
  const current = session(data.current);
  const state = status(data.status);
  const previous = array(data.previous, 2, session);
  if (
    state.sessionId !== current.sessionId ||
    state.recordCount !== current.records.length ||
    state.omittedRecords !== current.omittedRecords ||
    state.rejectedRecords !== current.rejectedRecords ||
    state.previousSessionCount !== previous.length ||
    JSON.stringify(state.records) !==
      JSON.stringify(current.records.slice(-30)) ||
    new Set([current.sessionId, ...previous.map(entry => entry.sessionId)])
      .size !==
      previous.length + 1
  )
    invalid();
  return {
    schemaVersion: 1,
    kind: 'assistDebugBundle',
    exportedAt: date(data.exportedAt),
    status: state,
    current,
    previous,
  };
}
