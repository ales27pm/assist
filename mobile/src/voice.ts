export type VoicePhase =
  | 'idle'
  | 'requesting'
  | 'listening'
  | 'finishing'
  | 'speaking';

export type VoiceStatus = {
  available: boolean;
  recognitionAvailable: boolean;
  synthesisAvailable: boolean;
  locale: 'fr-CA';
  phase: VoicePhase;
  reason?: string;
  voiceName?: string;
};

export type VoiceEvent = {
  sessionId: string;
  kind: 'transcript' | 'state' | 'error';
  phase: VoicePhase;
  text?: string;
  isFinal?: boolean;
  message?: string;
};

const phases = ['idle', 'requesting', 'listening', 'finishing', 'speaking'];

function object(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Réponse vocale native invalide.');
  }
  return value as Record<string, unknown>;
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
  return value as VoiceStatus;
}

export function parseVoiceEvent(json: string): VoiceEvent {
  const value = object(json);
  if (
    typeof value.sessionId !== 'string' ||
    !value.sessionId ||
    !['transcript', 'state', 'error'].includes(value.kind as string) ||
    !phases.includes(value.phase as string) ||
    (value.kind === 'transcript' &&
      (typeof value.text !== 'string' || typeof value.isFinal !== 'boolean')) ||
    (value.kind === 'error' && typeof value.message !== 'string')
  ) {
    throw new Error('Événement vocal natif invalide.');
  }
  return value as VoiceEvent;
}
