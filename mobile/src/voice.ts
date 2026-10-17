export type VoicePhase =
  | 'idle'
  | 'requesting'
  | 'listening'
  | 'finishing'
  | 'speaking';

/** Numeric input observations only; never retain PCM or dictated text here. */
export type VoiceInputDiagnostics = {
  bufferCount: number;
  frameCount: number;
  sampleRate: number;
  channels: number;
  peak: number;
  level: number;
  measured: boolean;
  elapsedMs: number;
  inputPort: string;
  firstBufferDelayMs?: number;
  errorDomain?: string;
  errorCode?: number;
};

export type VoiceStatus = {
  available: boolean;
  recognitionAvailable: boolean;
  synthesisAvailable: boolean;
  locale: 'fr-CA';
  phase: VoicePhase;
  reason?: string;
  voiceName?: string;
  diagnostics?: VoiceInputDiagnostics;
};

export type VoiceEvent = {
  sessionId: string;
  text?: string;
  isFinal?: boolean;
  message?: string;
} & (
  | { kind: 'input'; phase: 'listening'; diagnostics: VoiceInputDiagnostics }
  | {
      kind: 'transcript' | 'state' | 'error';
      phase: VoicePhase;
      diagnostics?: VoiceInputDiagnostics;
    }
);

const phases = ['idle', 'requesting', 'listening', 'finishing', 'speaking'];

function object(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Réponse vocale native invalide.');
  }
  return value as Record<string, unknown>;
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function count(value: unknown): value is number {
  return nonnegative(value) && Number.isSafeInteger(value);
}

function level(value: unknown): value is number {
  return nonnegative(value) && value <= 1;
}

function inputDiagnostics(value: unknown): VoiceInputDiagnostics {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Diagnostic du micro invalide.');
  }
  const data = value as Record<string, unknown>;
  if (
    !count(data.bufferCount) ||
    !count(data.frameCount) ||
    !nonnegative(data.sampleRate) ||
    !count(data.channels) ||
    !level(data.peak) ||
    !level(data.level) ||
    typeof data.measured !== 'boolean' ||
    !nonnegative(data.elapsedMs) ||
    typeof data.inputPort !== 'string' ||
    (data.firstBufferDelayMs !== undefined &&
      !nonnegative(data.firstBufferDelayMs)) ||
    (data.errorDomain !== undefined && typeof data.errorDomain !== 'string') ||
    (data.errorCode !== undefined &&
      (typeof data.errorCode !== 'number' ||
        !Number.isSafeInteger(data.errorCode)))
  ) {
    throw new Error('Diagnostic du micro invalide.');
  }
  // Reconstruct the allowed fields so an unexpected payload cannot retain text
  // or audio in the diagnostics later shown for copying.
  return {
    bufferCount: data.bufferCount,
    frameCount: data.frameCount,
    sampleRate: data.sampleRate,
    channels: data.channels,
    peak: data.peak,
    level: data.level,
    measured: data.measured,
    elapsedMs: data.elapsedMs,
    inputPort: data.inputPort,
    ...(data.firstBufferDelayMs !== undefined && {
      firstBufferDelayMs: data.firstBufferDelayMs,
    }),
    ...(data.errorDomain !== undefined && { errorDomain: data.errorDomain }),
    ...(data.errorCode !== undefined && { errorCode: data.errorCode }),
  } as VoiceInputDiagnostics;
}

export function parseVoiceStatus(json: string): VoiceStatus {
  const value = object(json);
  if (
    typeof value.available !== 'boolean' ||
    typeof value.recognitionAvailable !== 'boolean' ||
    typeof value.synthesisAvailable !== 'boolean' ||
    value.locale !== 'fr-CA' ||
    !phases.includes(value.phase as string) ||
    (value.reason !== undefined && typeof value.reason !== 'string') ||
    (value.voiceName !== undefined && typeof value.voiceName !== 'string')
  ) {
    throw new Error('État vocal natif invalide.');
  }
  return {
    ...value,
    ...(value.diagnostics !== undefined && {
      diagnostics: inputDiagnostics(value.diagnostics),
    }),
  } as VoiceStatus;
}

export function parseVoiceEvent(json: string): VoiceEvent {
  const value = object(json);
  if (
    typeof value.sessionId !== 'string' ||
    !value.sessionId ||
    !['transcript', 'state', 'error', 'input'].includes(value.kind as string) ||
    !phases.includes(value.phase as string) ||
    (value.kind === 'transcript' &&
      (typeof value.text !== 'string' || typeof value.isFinal !== 'boolean')) ||
    (value.kind === 'error' && typeof value.message !== 'string') ||
    (value.kind === 'input' &&
      (value.phase !== 'listening' || value.diagnostics === undefined))
  ) {
    throw new Error('Événement vocal natif invalide.');
  }
  return {
    ...value,
    ...(value.diagnostics !== undefined && {
      diagnostics: inputDiagnostics(value.diagnostics),
    }),
  } as VoiceEvent;
}
