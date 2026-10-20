/** Presentation contracts only. None of these values grants tool authority. */
export type PrivateServiceStatus = {
  schemaVersion: 1;
  configured: boolean;
  origin?: string;
  revision: string;
  state: 'configured' | 'not_configured' | 'disconnect_failed';
};
export type SearchHit = {
  id: string;
  title: string;
  url: string;
  snippet: string;
};
export type PrivateSearch = {
  schemaVersion: 1;
  requestId: string;
  results: SearchHit[];
  degraded: boolean;
};
export type ResearchResult = {
  schemaVersion: 1;
  requestId: string;
  text: string;
  degraded: boolean;
  sources: {
    id: string;
    title: string;
    url: string;
    readAt: string;
    truncated: boolean;
  }[];
};
export type DocumentKind = 'text' | 'url' | 'image' | 'pdf';
export type InboxDocument = {
  schemaVersion: 1;
  id: string;
  kind: DocumentKind;
  source: 'picker' | 'share';
  byteCount: number;
  createdAt: string;
  consumedAt?: string;
};
export type DocumentRead = {
  schemaVersion: 1;
  id: string;
  kind: DocumentKind;
  text: string;
  method: 'utf8' | 'pdf_text' | 'vision_ocr';
  truncated: boolean;
  untrusted: true;
};
export type TaskCheckpoint = {
  taskId: string;
  kind: 'research' | 'document';
  state: 'running' | 'paused' | 'completed' | 'cancelled' | 'outcome_unknown';
  epoch: number;
  revision: number;
  updatedAt: string;
  pauseReason?: 'user' | 'interrupted';
};
export type CheckpointSnapshot = {
  schemaVersion: 1;
  revision: number;
  tasks: TaskCheckpoint[];
};

function invalid(): never {
  throw new Error(
    'Réponse native incompatible. Aucun résultat ni reprise accepté.',
  );
}
export function workspaceBytes(value: string): number {
  let size = 0;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return size;
}
function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    workspaceBytes(value) <= maximum &&
    !Array.from(value).some(character => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    })
  );
}
function object(value: unknown, required: string[], optional: string[] = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  const row = value as Record<string, unknown>;
  if (
    !required.every(key => Object.prototype.hasOwnProperty.call(row, key)) ||
    !Object.keys(row).every(key => [...required, ...optional].includes(key))
  )
    return invalid();
  return row;
}
function decode(json: string) {
  if (typeof json !== 'string' || workspaceBytes(json) > 24 * 1024)
    return invalid();
  return JSON.parse(json) as unknown;
}
export function workspaceUUID(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
function integer(value: unknown, minimum = 1): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= 1_000_000_000
  );
}
function date(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().replace('.000Z', 'Z') ===
      value.replace('.000Z', 'Z')
  );
}
function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  );
}
function publicURL(value: unknown): value is string {
  if (!text(value, 2048) || /[\s\\]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash &&
      (!parsed.port || parsed.port === '443') &&
      host.length <= 253 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
        host,
      ) &&
      host.split('.').every(label => label.length <= 63) &&
      /^[a-z]{2,}$/.test(host.split('.').at(-1)!) &&
      ![
        'local',
        'localhost',
        'internal',
        'invalid',
        'test',
        'example',
        'home.arpa',
        'localhost.localdomain',
        'lan',
        'home',
        'ts.net',
      ].some(suffix => host === suffix || host.endsWith(`.${suffix}`))
    );
  } catch {
    return false;
  }
}

export function parsePrivateServiceStatus(json: string): PrivateServiceStatus {
  const row = object(
    decode(json),
    ['schemaVersion', 'configured', 'revision', 'state'],
    ['origin'],
  );
  if (
    row.schemaVersion !== 1 ||
    typeof row.configured !== 'boolean' ||
    !workspaceUUID(row.revision) ||
    !['configured', 'not_configured', 'disconnect_failed'].includes(
      String(row.state),
    ) ||
    typeof row.state !== 'string' ||
    (row.state === 'configured') !== row.configured ||
    row.configured !== (typeof row.origin === 'string') ||
    (!row.configured && Object.prototype.hasOwnProperty.call(row, 'origin'))
  )
    return invalid();
  if (row.configured) {
    if (!text(row.origin, 2048)) return invalid();
    try {
      const url = new URL(row.origin);
      if (
        url.protocol !== 'https:' ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !['', '/'].includes(url.pathname)
      )
        return invalid();
    } catch {
      return invalid();
    }
  }
  return row as PrivateServiceStatus;
}
export function parsePrivateSearch(
  json: string,
  expected: string,
): PrivateSearch {
  const row = object(decode(json), [
    'schemaVersion',
    'requestId',
    'results',
    'degraded',
  ]);
  if (
    row.schemaVersion !== 1 ||
    !workspaceUUID(expected) ||
    row.requestId !== expected ||
    typeof row.degraded !== 'boolean' ||
    !Array.isArray(row.results) ||
    row.results.length > 10
  )
    return invalid();
  const ids = new Set<string>();
  for (const value of row.results) {
    const hit = object(value, ['id', 'title', 'url', 'snippet']);
    if (
      !identifier(hit.id) ||
      ids.has(hit.id) ||
      !text(hit.title, 256) ||
      !text(hit.snippet, 1024) ||
      !publicURL(hit.url)
    )
      return invalid();
    ids.add(hit.id);
  }
  return row as PrivateSearch;
}
export function parseResearchCapabilities(json: string): void {
  const row = object(decode(json), [
    'schemaVersion',
    'protocolVersion',
    'profile',
    'tools',
    'maximumSearches',
    'maximumPageReads',
    'maximumDurationSeconds',
  ]);
  if (
    row.schemaVersion !== 1 ||
    row.protocolVersion !== 1 ||
    row.profile !== 'research_v1' ||
    JSON.stringify(row.tools) !== JSON.stringify(['web_search', 'web_read']) ||
    row.maximumSearches !== 1 ||
    row.maximumPageReads !== 4 ||
    row.maximumDurationSeconds !== 120
  )
    return invalid();
}
export function parseResearchResult(
  json: string,
  expected: string,
): ResearchResult {
  const row = object(decode(json), [
    'schemaVersion',
    'requestId',
    'text',
    'sources',
    'degraded',
  ]);
  if (
    row.schemaVersion !== 1 ||
    !workspaceUUID(expected) ||
    row.requestId !== expected ||
    !text(row.text, 8192) ||
    !row.text.trim() ||
    /<\||\|>|<tool|<turn|<channel|<eos|<bos/.test(row.text) ||
    typeof row.degraded !== 'boolean' ||
    !Array.isArray(row.sources) ||
    row.sources.length > 4
  )
    return invalid();
  const ids = new Set<string>();
  for (const value of row.sources) {
    const source = object(value, ['id', 'title', 'url', 'readAt', 'truncated']);
    if (
      !identifier(source.id) ||
      ids.has(source.id) ||
      !text(source.title, 256) ||
      !publicURL(source.url) ||
      !date(source.readAt) ||
      typeof source.truncated !== 'boolean'
    )
      return invalid();
    ids.add(source.id);
  }
  const citations = [...row.text.matchAll(/\[source:([^\]]*)\]/g)];
  if (citations.length !== row.text.split('[source:').length - 1)
    return invalid();
  for (const match of citations) if (!ids.has(match[1])) return invalid();
  return row as ResearchResult;
}
export function parseDocumentStatus(json: string) {
  const row = object(decode(json), [
    'schemaVersion',
    'available',
    'import',
    'export',
    'readKinds',
  ]);
  if (
    row.schemaVersion !== 1 ||
    typeof row.available !== 'boolean' ||
    row.import !== true ||
    row.export !== true ||
    !Array.isArray(row.readKinds) ||
    row.readKinds.length !== 4 ||
    new Set(row.readKinds).size !== 4 ||
    !row.readKinds.every(value =>
      ['text', 'url', 'image', 'pdf'].includes(value),
    )
  )
    return invalid();
  return { available: row.available };
}
function item(value: unknown): InboxDocument {
  const row = object(
    value,
    ['schemaVersion', 'id', 'kind', 'source', 'byteCount', 'createdAt'],
    ['consumedAt'],
  );
  if (
    row.schemaVersion !== 1 ||
    !workspaceUUID(row.id) ||
    row.id !== row.id.toLowerCase() ||
    typeof row.kind !== 'string' ||
    !['text', 'url', 'image', 'pdf'].includes(row.kind) ||
    typeof row.source !== 'string' ||
    !['picker', 'share'].includes(row.source) ||
    !integer(row.byteCount) ||
    row.byteCount > 8 * 1024 * 1024 ||
    !date(row.createdAt) ||
    (['text', 'url'].includes(row.kind) && row.byteCount > 64 * 1024) ||
    (row.kind === 'url' && row.byteCount > 4096) ||
    (row.consumedAt !== undefined && !date(row.consumedAt))
  )
    return invalid();
  return row as InboxDocument;
}
export function parseDocumentInbox(json: string): InboxDocument[] {
  const row = object(decode(json), ['schemaVersion', 'items']);
  if (
    row.schemaVersion !== 1 ||
    !Array.isArray(row.items) ||
    row.items.length > 20
  )
    return invalid();
  const items = row.items.map(item);
  if (
    new Set(items.map(entry => entry.id)).size !== items.length ||
    items.reduce((sum, entry) => sum + entry.byteCount, 0) > 24 * 1024 * 1024
  )
    return invalid();
  return items;
}
export function parseDocumentImport(json: string): InboxDocument | null {
  const value = decode(json);
  const row = object(value, ['schemaVersion'], ['item', 'status']);
  if (row.schemaVersion !== 1) return invalid();
  if (row.status === 'cancelled' && Object.keys(row).length === 2) return null;
  if (Object.keys(row).length !== 2 || row.status !== undefined)
    return invalid();
  return item(row.item);
}
export function parseDocumentRead(
  json: string,
  expected: InboxDocument,
): DocumentRead {
  const row = object(decode(json), [
    'schemaVersion',
    'id',
    'kind',
    'text',
    'method',
    'truncated',
    'untrusted',
  ]);
  const method =
    expected.kind === 'pdf'
      ? 'pdf_text'
      : expected.kind === 'image'
      ? 'vision_ocr'
      : 'utf8';
  if (
    row.schemaVersion !== 1 ||
    row.id !== expected.id ||
    row.kind !== expected.kind ||
    !text(row.text, 8192) ||
    row.method !== method ||
    typeof row.truncated !== 'boolean' ||
    row.untrusted !== true
  )
    return invalid();
  return row as DocumentRead;
}
export function parseDocumentRemoval(json: string, expected: string): boolean {
  const row = object(decode(json), ['schemaVersion', 'id', 'removed']);
  if (
    row.schemaVersion !== 1 ||
    row.id !== expected ||
    typeof row.removed !== 'boolean'
  )
    return invalid();
  return row.removed;
}
export function parseExportReceipt(json: string): 'exported' | 'cancelled' {
  const row = object(decode(json), ['schemaVersion', 'status']);
  if (
    row.schemaVersion !== 1 ||
    (row.status !== 'exported' && row.status !== 'cancelled')
  )
    return invalid();
  return row.status;
}
export function parseWorkspaceAcknowledgement(
  json: string,
  field: 'cancelled' | 'opened',
): void {
  const row = object(decode(json), ['schemaVersion', field]);
  if (row.schemaVersion !== 1 || row[field] !== true) return invalid();
}
export function parseTaskCheckpoints(json: string): CheckpointSnapshot {
  const row = object(decode(json), ['schemaVersion', 'revision', 'tasks']);
  if (
    row.schemaVersion !== 1 ||
    !integer(row.revision, 0) ||
    !Array.isArray(row.tasks) ||
    row.tasks.length > 20
  )
    return invalid();
  const ids = new Set<string>();
  for (const value of row.tasks) {
    const task = object(
      value,
      ['taskId', 'kind', 'state', 'epoch', 'revision', 'updatedAt'],
      ['pauseReason'],
    );
    if (
      !workspaceUUID(task.taskId) ||
      task.taskId !== task.taskId.toLowerCase() ||
      ids.has(task.taskId) ||
      !['research', 'document'].includes(String(task.kind)) ||
      typeof task.kind !== 'string' ||
      ![
        'running',
        'paused',
        'completed',
        'cancelled',
        'outcome_unknown',
      ].includes(String(task.state)) ||
      typeof task.state !== 'string' ||
      !integer(task.epoch) ||
      !integer(task.revision) ||
      task.epoch > task.revision ||
      task.revision > row.revision ||
      !date(task.updatedAt) ||
      (task.state === 'paused') !== (task.pauseReason !== undefined) ||
      (task.pauseReason !== undefined &&
        task.pauseReason !== 'user' &&
        task.pauseReason !== 'interrupted')
    )
      return invalid();
    ids.add(task.taskId);
  }
  if (row.tasks.filter(value => value.state === 'running').length > 1)
    return invalid();
  return row as CheckpointSnapshot;
}
