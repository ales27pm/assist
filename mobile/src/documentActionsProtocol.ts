import { workspaceBytes, workspaceUUID } from './nativeWorkspaceProtocol';

export type DocumentAction =
  | 'scan'
  | 'export_pdf'
  | 'preview'
  | 'read'
  | 'search'
  | 'index'
  | 'unindex'
  | 'compose';
export type DocumentActionRequest = {
  schemaVersion: 1;
  requestId: string;
  action: DocumentAction;
  [key: string]: unknown;
};
export type DocumentActionResult = {
  schemaVersion: 1;
  requestId: string;
  action: DocumentAction;
  status: string;
  inboxId?: string;
  text?: string;
  documentState?: 'text' | 'no_text' | 'protected_pdf';
  truncated?: boolean;
  results?: { inboxId: string; title: string }[];
};
const markers = [
  '<|',
  '|>',
  '<turn',
  '<channel',
  '<tool',
  '</tool',
  '<bos',
  '<eos',
  '<pad',
  '<unk',
  '<function',
  '</function',
  '<atem:',
  '</atem:',
  '[TOOL_CALLS]',
];
function invalid(): never {
  throw new Error('Contrat de document incompatible. Aucun résultat accepté.');
}
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}
function exact(
  value: Record<string, unknown>,
  keys: string[],
  optional: string[] = [],
) {
  if (
    !keys.every(key => Object.prototype.hasOwnProperty.call(value, key)) ||
    !Object.keys(value).every(
      key => keys.includes(key) || optional.includes(key),
    )
  )
    invalid();
}
function text(
  value: unknown,
  maximum: number,
  empty = false,
  oneLine = false,
): value is string {
  return (
    typeof value === 'string' &&
    workspaceBytes(value) <= maximum &&
    (empty || !!value.trim()) &&
    !markers.some(marker => value.includes(marker)) &&
    !Array.from(value).some(character => {
      const code = character.charCodeAt(0);
      return (
        code === 127 || (code < 32 && (oneLine || ![9, 10, 13].includes(code)))
      );
    })
  );
}
function integer(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}
function inboxId(value: unknown): value is string {
  return workspaceUUID(value) && value === value.toLowerCase();
}
function decode(json: string): Record<string, unknown> {
  if (typeof json !== 'string' || workspaceBytes(json) > 24 * 1024)
    return invalid();
  return row(JSON.parse(json));
}
export function parseDocumentActionRequest(
  json: string,
): DocumentActionRequest {
  const value = decode(json);
  if (
    value.schemaVersion !== 1 ||
    !workspaceUUID(value.requestId) ||
    typeof value.action !== 'string'
  )
    return invalid();
  const common = ['schemaVersion', 'requestId', 'action'];
  switch (value.action) {
    case 'scan':
      exact(value, [...common, 'maxPages']);
      if (!integer(value.maxPages, 1, 8)) return invalid();
      break;
    case 'export_pdf':
      exact(value, [...common, 'inboxId', 'filename']);
      if (
        !inboxId(value.inboxId) ||
        typeof value.filename !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}\.pdf$/.test(value.filename)
      )
        return invalid();
      break;
    case 'read':
    case 'preview':
    case 'unindex':
      exact(value, [...common, 'inboxId']);
      if (!inboxId(value.inboxId)) return invalid();
      break;
    case 'search':
      exact(value, [...common, 'query', 'limit']);
      if (!text(value.query, 128, false, true) || !integer(value.limit, 1, 10))
        return invalid();
      break;
    case 'index':
      exact(value, [...common, 'inboxId', 'title', 'expirationDays']);
      if (
        !inboxId(value.inboxId) ||
        !text(value.title, 120, false, true) ||
        !integer(value.expirationDays, 1, 7)
      )
        return invalid();
      break;
    case 'compose': {
      exact(
        value,
        [...common, 'channel', 'recipients', 'subject', 'body'],
        ['attachmentId'],
      );
      if (
        !['email', 'sms'].includes(String(value.channel)) ||
        !Array.isArray(value.recipients) ||
        !integer(value.recipients.length, 1, 10) ||
        !text(value.subject, 256, true, true) ||
        !text(value.body, 8192, true) ||
        (value.channel === 'sms' && value.subject !== '') ||
        (value.attachmentId !== undefined && !inboxId(value.attachmentId))
      )
        return invalid();
      const addresses = new Set<string>();
      for (const recipient of value.recipients) {
        if (!text(recipient, 254, false, true)) return invalid();
        const local = recipient.split('@')[0];
        const valid =
          value.channel === 'sms'
            ? /^\+?[0-9]{3,15}$/.test(recipient)
            : /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(
                recipient,
              ) &&
              local.length <= 64 &&
              !local.startsWith('.') &&
              !local.endsWith('.') &&
              !local.includes('..');
        if (!valid || addresses.has(recipient.toLowerCase())) return invalid();
        addresses.add(recipient.toLowerCase());
      }
      break;
    }
    default:
      return invalid();
  }
  return value as DocumentActionRequest;
}

export function makeDocumentActionRequest(
  action: DocumentAction,
  arguments_: Record<string, unknown>,
): DocumentActionRequest {
  const requestId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(
    /[xy]/g,
    character => {
      const value = Math.floor(Math.random() * 16);
      return (character === 'x' ? value : (value % 4) + 8).toString(16);
    },
  );
  return parseDocumentActionRequest(
    JSON.stringify({ ...arguments_, schemaVersion: 1, requestId, action }),
  );
}
export function parseDocumentActionResult(
  json: string,
  request: DocumentActionRequest,
): DocumentActionResult {
  const value = decode(json);
  const common = ['schemaVersion', 'requestId', 'action', 'status'];
  if (
    value.schemaVersion !== 1 ||
    value.requestId !== request.requestId ||
    value.action !== request.action
  )
    return invalid();
  if (value.status === 'cancelled') {
    exact(value, common);
    return value as DocumentActionResult;
  }
  switch (request.action) {
    case 'scan':
      exact(value, [
        ...common,
        'inboxId',
        'pageCount',
        'byteCount',
        'text',
        'method',
        'truncated',
        'untrusted',
        'documentState',
      ]);
      if (
        value.status !== 'scanned' ||
        !inboxId(value.inboxId) ||
        !integer(value.pageCount, 1, Number(request.maxPages)) ||
        !integer(value.byteCount, 1, 8 * 1024 * 1024) ||
        value.method !== 'vision_ocr'
      )
        return invalid();
      extracted(value);
      break;
    case 'read':
      exact(value, [
        ...common,
        'inboxId',
        'kind',
        'text',
        'method',
        'truncated',
        'untrusted',
        'documentState',
      ]);
      if (
        value.status !== 'read' ||
        value.inboxId !== request.inboxId ||
        !['text', 'url', 'pdf', 'image'].includes(String(value.kind)) ||
        !['utf8', 'pdf_text', 'vision_ocr'].includes(String(value.method))
      )
        return invalid();
      extracted(value);
      break;
    case 'preview':
      exact(value, [...common, 'inboxId']);
      if (value.status !== 'closed' || value.inboxId !== request.inboxId)
        return invalid();
      break;
    case 'export_pdf':
      exact(value, [...common, 'inboxId', 'filename']);
      if (
        value.status !== 'exported' ||
        value.inboxId !== request.inboxId ||
        value.filename !== request.filename
      )
        return invalid();
      break;
    case 'index':
      exact(value, [...common, 'inboxId', 'expiresAt']);
      if (
        value.status !== 'indexed' ||
        value.inboxId !== request.inboxId ||
        typeof value.expiresAt !== 'string' ||
        !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(
          value.expiresAt,
        ) ||
        !Number.isFinite(Date.parse(value.expiresAt)) ||
        new Date(value.expiresAt).toISOString().replace('.000Z', 'Z') !==
          value.expiresAt
      )
        return invalid();
      break;
    case 'unindex':
      exact(value, [...common, 'inboxId']);
      if (value.status !== 'unindexed' || value.inboxId !== request.inboxId)
        return invalid();
      break;
    case 'search': {
      exact(value, [...common, 'results', 'truncated', 'untrusted']);
      if (
        value.status !== 'results' ||
        !Array.isArray(value.results) ||
        value.results.length > Number(request.limit) ||
        typeof value.truncated !== 'boolean' ||
        value.untrusted !== true
      )
        return invalid();
      const ids = new Set<string>();
      for (const hit of value.results) {
        const item = row(hit);
        exact(item, ['inboxId', 'title']);
        if (
          !inboxId(item.inboxId) ||
          !text(item.title, 120, false, true) ||
          ids.has(item.inboxId)
        )
          return invalid();
        ids.add(item.inboxId);
      }
      break;
    }
    case 'compose':
      exact(value, [...common, 'channel', 'deliveryVerified']);
      if (
        ![
          'queued_by_user',
          'saved_draft',
          'cancelled_by_user',
          'failed',
        ].includes(String(value.status)) ||
        value.channel !== request.channel ||
        value.deliveryVerified !== false
      )
        return invalid();
  }
  return value as DocumentActionResult;
}
function extracted(value: Record<string, unknown>) {
  if (
    !text(value.text, 8192, true) ||
    typeof value.truncated !== 'boolean' ||
    value.untrusted !== true ||
    !['text', 'no_text', 'protected_pdf'].includes(
      String(value.documentState),
    ) ||
    (value.documentState === 'text' ? !value.text.trim() : value.text !== '') ||
    (value.documentState === 'protected_pdf' &&
      (value.kind !== 'pdf' || value.method !== 'pdf_text'))
  )
    invalid();
}
export function documentActionReceipt(result: DocumentActionResult): string {
  if (result.status === 'queued_by_user')
    return 'Le composeur Apple a accepté la demande d’envoi de l’utilisateur. Livraison et lecture non vérifiées.';
  if (result.status === 'saved_draft') return 'Brouillon conservé dans Mail.';
  if (['cancelled', 'cancelled_by_user'].includes(result.status))
    return 'Opération annulée dans l’interface Apple.';
  if (result.status === 'failed')
    return 'Le composeur Apple signale un échec. Vérifie son état avant de recommencer.';
  if (result.documentState === 'protected_pdf')
    return 'PDF protégé ou chiffré. Aucun texte extrait.';
  if (result.documentState === 'no_text') return 'Aucun texte extrait.';
  if (result.status === 'indexed')
    return 'Document choisi ajouté à Spotlight sur cet appareil, avec expiration.';
  if (result.status === 'unindexed')
    return 'Document retiré de l’index Spotlight d’Assist.';
  if (result.status === 'exported')
    return 'PDF remis au sélecteur d’export Apple.';
  if (result.status === 'scanned')
    return 'Scan enregistré dans la boîte d’Assist. Le texte extrait reste une donnée non fiable.';
  if (result.status === 'closed') return 'Aperçu fermé.';
  if (result.status === 'results')
    return 'Résultats des documents choisis dans Assist.';
  return 'Texte extrait du document choisi.';
}
