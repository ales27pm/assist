export type SpeechVoice = {
  id: string;
  name: string;
  language: 'fr-CA';
  quality: 'default' | 'enhanced' | 'premium';
};

export type SpeechVoiceCatalog = {
  schemaVersion: 1;
  locale: 'fr-CA';
  voices: SpeechVoice[];
  selectedVoiceId: string;
  resolvedVoiceId: string | null;
  selectionMissing: boolean;
  nativeBuild?: string;
  osVersion?: string;
};

export type SpeechVoicePreviewResult = {
  sessionId: string;
  outcome: 'completed' | 'cancelled';
};

export type SpeechVoiceStopResult = {
  sessionId: string;
  stopped: boolean;
};

const CATALOG_ERROR = 'Le catalogue de voix locales est invalide.';
const PREVIEW_ERROR = 'Le résultat de l’écoute comparative est invalide.';

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readObject(
  json: string,
  maximumLength: number,
  message: string,
): Record<string, unknown> {
  // Also bound the bridge payload before JSON.parse. The catalog allowance
  // covers all 200 entries at their field limits, even with JSON escapes.
  if (typeof json !== 'string' || json.length > maximumLength)
    throw new Error(message);
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error(message);
  }
  if (!record(value)) throw new Error(message);
  return value;
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum && !!value.trim();
}

function quality(value: unknown): value is SpeechVoice['quality'] {
  return value === 'default' || value === 'enhanced' || value === 'premium';
}

export function parseSpeechVoiceCatalog(json: string): SpeechVoiceCatalog {
  const value = readObject(json, 1_000_000, CATALOG_ERROR);
  if (
    value.schemaVersion !== 1 ||
    value.locale !== 'fr-CA' ||
    !Array.isArray(value.voices) ||
    value.voices.length > 200 ||
    (value.selectedVoiceId !== '' &&
      !boundedText(value.selectedVoiceId, 512)) ||
    (value.resolvedVoiceId !== null &&
      !boundedText(value.resolvedVoiceId, 512)) ||
    typeof value.selectionMissing !== 'boolean' ||
    (value.nativeBuild !== undefined && !boundedText(value.nativeBuild, 128)) ||
    (value.osVersion !== undefined && !boundedText(value.osVersion, 128))
  ) {
    throw new Error(CATALOG_ERROR);
  }

  const identifiers = new Set<string>();
  const voices = value.voices.map((entry: unknown): SpeechVoice => {
    if (
      !record(entry) ||
      !boundedText(entry.id, 512) ||
      !boundedText(entry.name, 160) ||
      entry.language !== 'fr-CA' ||
      !quality(entry.quality) ||
      identifiers.has(entry.id)
    ) {
      throw new Error(CATALOG_ERROR);
    }
    identifiers.add(entry.id);
    return {
      id: entry.id,
      name: entry.name,
      language: 'fr-CA',
      quality: entry.quality,
    };
  });

  const selectedVoiceId = value.selectedVoiceId;
  const resolvedVoiceId = value.resolvedVoiceId;
  const selectionMissing =
    selectedVoiceId !== '' && !identifiers.has(selectedVoiceId);
  if (
    value.selectionMissing !== selectionMissing ||
    (resolvedVoiceId === null
      ? voices.length !== 0
      : !identifiers.has(resolvedVoiceId)) ||
    (selectedVoiceId !== '' &&
      !selectionMissing &&
      resolvedVoiceId !== selectedVoiceId)
  ) {
    throw new Error(CATALOG_ERROR);
  }

  return {
    schemaVersion: 1,
    locale: 'fr-CA',
    voices,
    selectedVoiceId,
    resolvedVoiceId,
    selectionMissing,
    ...(value.nativeBuild !== undefined && { nativeBuild: value.nativeBuild }),
    ...(value.osVersion !== undefined && { osVersion: value.osVersion }),
  };
}

/** Scheduling is not a terminal result: callers await playback or cancellation. */
export function parseSpeechVoicePreviewResult(
  json: string,
): SpeechVoicePreviewResult {
  const value = readObject(json, 4_096, PREVIEW_ERROR);
  if (
    !boundedText(value.sessionId, 512) ||
    (value.outcome !== 'completed' && value.outcome !== 'cancelled')
  ) {
    throw new Error(PREVIEW_ERROR);
  }
  return { sessionId: value.sessionId, outcome: value.outcome };
}

/** A stop ACK describes only the requested session, including a stale ID. */
export function parseSpeechVoiceStopResult(
  json: string,
): SpeechVoiceStopResult {
  const value = readObject(json, 4_096, PREVIEW_ERROR);
  if (
    !boundedText(value.sessionId, 512) ||
    typeof value.stopped !== 'boolean'
  ) {
    throw new Error(PREVIEW_ERROR);
  }
  return { sessionId: value.sessionId, stopped: value.stopped };
}

/** Whole and segmented listening share this exact text, including whitespace. */
export const VOICE_COMPARISON_SAMPLES = [
  {
    id: 'conversation',
    label: 'Conversation et heure',
    text: 'Salut! Peux-tu me rappeler d’acheter du lait tantôt, vers quatre heures et quart?',
    segments: [
      'Salut! ',
      'Peux-tu me rappeler d’acheter du lait tantôt, ',
      'vers quatre heures et quart?',
    ],
  },
  {
    id: 'noms-locaux',
    label: 'Noms québécois',
    text: 'Le rendez-vous est à Sainte-Foy. Ensuite, passe sur René-Lévesque, près de l’UQAM, à Montréal.',
    segments: [
      'Le rendez-vous est à Sainte-Foy. ',
      'Ensuite, passe sur René-Lévesque, ',
      'près de l’UQAM, à Montréal.',
    ],
  },
  {
    id: 'montants',
    label: 'Montants et nombres',
    text: 'Ça coûte vingt piasses, taxes incluses. Pour deux articles à 12,50 $, quel est le total?',
    segments: [
      'Ça coûte vingt piasses, taxes incluses. ',
      'Pour deux articles à 12,50 $, ',
      'quel est le total?',
    ],
  },
  {
    id: 'code-switching',
    label: 'Français et anglais',
    text: 'Build le projet en release, puis check le log de Core ML. Si le Wi-Fi lag, peux-tu retry le download?',
    segments: [
      'Build le projet en release, ',
      'puis check le log de Core ML. ',
      'Si le Wi-Fi lag, ',
      'peux-tu retry le download?',
    ],
  },
  {
    id: 'hesitations',
    label: 'Hésitation et correction',
    text: 'Euh… attends deux secondes… je pense que… oui, vas-y. Mets ça demain — attends, non, finalement vendredi matin.',
    segments: [
      'Euh… attends deux secondes… ',
      'je pense que… oui, vas-y. ',
      'Mets ça demain — attends, non, ',
      'finalement vendredi matin.',
    ],
  },
];

/** One blind session owns this returned order; a later call draws a new order. */
export function blindVoiceOrder(
  voices: readonly SpeechVoice[],
  random: () => number = Math.random,
): SpeechVoice[] {
  const ordered = [...voices];
  for (let index = ordered.length - 1; index > 0; index--) {
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
      throw new Error('La source aléatoire de comparaison est invalide.');
    }
    const other = Math.floor(sample * (index + 1));
    [ordered[index], ordered[other]] = [ordered[other], ordered[index]];
  }
  return ordered;
}
