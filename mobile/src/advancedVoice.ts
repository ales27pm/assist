export type AdvancedVoiceBackend = 'apple' | 'fluid';
export type AdvancedVoiceVariant = 'redux' | 'ultra';
export type AdvancedVoiceState = {
  schemaVersion: 2;
  revision: number;
  selectedBackend: AdvancedVoiceBackend;
  selectedVariant: AdvancedVoiceVariant;
  effectiveBackend: AdvancedVoiceBackend;
  ready: boolean;
  resources: {
    pocket: boolean;
    redux: boolean;
    ultra: boolean;
    silero: boolean;
  };
  voice: 'estelle';
  reason?: string;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('État de la voix avancée invalide.');
  return value as Record<string, unknown>;
}

/** Accept only bounded metadata. Model paths stay native; the voice is a fixed public preset. */
export function parseAdvancedVoiceState(json: string): AdvancedVoiceState {
  if (typeof json !== 'string' || json.length > 16384)
    throw new Error('État de la voix avancée invalide.');
  const value = record(JSON.parse(json));
  const resources = record(value.resources);
  if (
    value.schemaVersion !== 2 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !['apple', 'fluid'].includes(value.selectedBackend as string) ||
    !['redux', 'ultra'].includes(value.selectedVariant as string) ||
    !['apple', 'fluid'].includes(value.effectiveBackend as string) ||
    typeof value.ready !== 'boolean' ||
    ['pocket', 'redux', 'ultra', 'silero'].some(
      key => typeof resources[key] !== 'boolean',
    ) ||
    value.voice !== 'estelle' ||
    (value.reason !== undefined &&
      (typeof value.reason !== 'string' || value.reason.length > 2000)) ||
    (value.effectiveBackend === 'fluid' &&
      (value.selectedBackend !== 'fluid' ||
        !value.ready ||
        !resources.pocket ||
        !resources.silero ||
        !resources[value.selectedVariant as string]))
  )
    throw new Error('État de la voix avancée invalide.');
  return {
    schemaVersion: 2,
    revision: value.revision as number,
    selectedBackend: value.selectedBackend as AdvancedVoiceBackend,
    selectedVariant: value.selectedVariant as AdvancedVoiceVariant,
    effectiveBackend: value.effectiveBackend as AdvancedVoiceBackend,
    ready: value.ready,
    resources: {
      pocket: resources.pocket as boolean,
      redux: resources.redux as boolean,
      ultra: resources.ultra as boolean,
      silero: resources.silero as boolean,
    },
    voice: 'estelle',
    ...(value.reason !== undefined && { reason: value.reason as string }),
  };
}
