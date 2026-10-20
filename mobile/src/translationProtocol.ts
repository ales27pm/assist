import { workspaceBytes } from './nativeWorkspaceProtocol';

export type TranslationRequest = {
  schemaVersion: 1;
  requestId: string;
  action: 'availability' | 'translate';
  source_language: string;
  target_language: string;
  allow_download: boolean;
  text?: string;
};
export type TranslationAvailability = {
  schemaVersion: 1;
  requestId: string;
  action: 'availability';
  languages: { identifier: string; label: string }[];
  sourceLanguage: string;
  targetLanguage: string;
  status: 'not_checked' | 'installed' | 'supported' | 'unsupported';
  localOnly: true;
  untrusted: true;
};
export type TranslationResult = {
  schemaVersion: 1;
  requestId: string;
  action: 'translate';
  sourceLanguage: string;
  targetLanguage: string;
  sourceDetected: boolean;
  translatedText: string;
  status: 'installed';
  localOnly: true;
  untrusted: true;
};
export function validTranslationLanguage(
  value: string,
  empty = false,
): boolean {
  return (
    (empty && value === '') ||
    (workspaceBytes(value) <= 35 &&
      value.match(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/)?.[0] === value)
  );
}
export function validTranslationText(value: string, maxBytes = 8192): boolean {
  return (
    !!value.trim() &&
    workspaceBytes(value) <= maxBytes &&
    !value.includes('<|') &&
    !value.includes('|>') &&
    !Array.from(value).some(character => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    })
  );
}
function invalid(): never {
  throw new Error(
    'Réponse de traduction incompatible. Aucun résultat accepté.',
  );
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== keys.length ||
    !keys.every(key => Object.prototype.hasOwnProperty.call(row, key))
  )
    return invalid();
  return row;
}
function decode(json: string): unknown {
  if (typeof json !== 'string' || workspaceBytes(json) > 24576)
    return invalid();
  return JSON.parse(json) as unknown;
}
function common(row: Record<string, unknown>, request: TranslationRequest) {
  if (
    row.schemaVersion !== 1 ||
    row.requestId !== request.requestId ||
    row.action !== request.action ||
    row.targetLanguage !== request.target_language ||
    row.localOnly !== true ||
    row.untrusted !== true
  )
    return invalid();
}
export function parseTranslationAvailability(
  json: string,
  request: TranslationRequest,
): TranslationAvailability {
  const row = object(decode(json), [
    'schemaVersion',
    'requestId',
    'action',
    'languages',
    'sourceLanguage',
    'targetLanguage',
    'status',
    'localOnly',
    'untrusted',
  ]);
  common(row, request);
  if (
    request.action !== 'availability' ||
    row.sourceLanguage !== request.source_language ||
    !['not_checked', 'installed', 'supported', 'unsupported'].includes(
      row.status as string,
    ) ||
    (request.source_language === '') !== (row.status === 'not_checked') ||
    !Array.isArray(row.languages) ||
    row.languages.length > 64
  )
    return invalid();
  const identifiers = new Set<string>();
  for (const value of row.languages) {
    const language = object(value, ['identifier', 'label']);
    if (
      typeof language.identifier !== 'string' ||
      !validTranslationLanguage(language.identifier) ||
      identifiers.has(language.identifier) ||
      typeof language.label !== 'string' ||
      !validTranslationText(language.label, 128)
    )
      return invalid();
    identifiers.add(language.identifier);
  }
  return row as TranslationAvailability;
}
export function parseTranslationResult(
  json: string,
  request: TranslationRequest,
): TranslationResult {
  const row = object(decode(json), [
    'schemaVersion',
    'requestId',
    'action',
    'sourceLanguage',
    'targetLanguage',
    'sourceDetected',
    'translatedText',
    'status',
    'localOnly',
    'untrusted',
  ]);
  common(row, request);
  if (
    request.action !== 'translate' ||
    row.status !== 'installed' ||
    typeof row.sourceLanguage !== 'string' ||
    !validTranslationLanguage(row.sourceLanguage) ||
    row.sourceDetected !== (request.source_language === '') ||
    (request.source_language !== '' &&
      row.sourceLanguage !== request.source_language) ||
    typeof row.translatedText !== 'string' ||
    !validTranslationText(row.translatedText)
  )
    return invalid();
  return row as TranslationResult;
}
export function parseTranslationCancellation(json: string): void {
  const row = object(decode(json), ['schemaVersion', 'cancelled']);
  if (row.schemaVersion !== 1 || row.cancelled !== true) invalid();
}
