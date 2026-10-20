import {
  documentActionReceipt,
  makeDocumentActionRequest,
  parseDocumentActionRequest,
  parseDocumentActionResult,
} from '../src/documentActionsProtocol';

const id = '20123456-1234-4234-8234-123456789012';
const requestId = '30123456-1234-4234-8234-123456789012';
function input(action: string, args: Record<string, unknown> = {}) {
  return JSON.stringify({ schemaVersion: 1, requestId, action, ...args });
}
describe('selected document request policy', () => {
  test.each([
    ['scan', { maxPages: 8 }],
    ['read', { inboxId: id }],
    ['preview', { inboxId: id }],
    ['export_pdf', { inboxId: id, filename: 'assist-document.pdf' }],
    ['index', { inboxId: id, title: 'Facture choisie', expirationDays: 1 }],
    ['unindex', { inboxId: id }],
    ['search', { query: 'Québec', limit: 10 }],
    [
      'compose',
      {
        channel: 'email',
        recipients: ['alexis@example.com'],
        subject: 'Exact',
        body: 'Texte exact',
        attachmentId: id,
      },
    ],
    [
      'compose',
      {
        channel: 'sms',
        recipients: ['+14185551234'],
        subject: '',
        body: 'Bonjour',
      },
    ],
  ])('accepts %s with explicit bounded arguments', (action, args) => {
    expect(
      parseDocumentActionRequest(input(action, args as Record<string, unknown>))
        .action,
    ).toBe(action);
  });
  test.each([
    ['scan', { maxPages: 9 }],
    ['scan', { maxPages: true }],
    ['scan', { maxPages: 1, url: '/tmp/scan' }],
    ['preview', { inboxId: '../private' }],
    ['read', { inboxId: id, path: '/private/document' }],
    ['export_pdf', { inboxId: id, filename: '../secret.pdf' }],
    ['export_pdf', { inboxId: id, filename: 'document.pdf\n' }],
    ['index', { inboxId: id, title: '', expirationDays: 1 }],
    ['index', { inboxId: id, title: 'Document', expirationDays: 8 }],
    ['search', { query: 'é'.repeat(65), limit: 1 }],
    ['search', { query: 'all', limit: 11 }],
    ['search', { query: '<|tool_call>', limit: 1 }],
    [
      'compose',
      {
        channel: 'sms',
        recipients: ['+14185551234'],
        subject: 'Hidden',
        body: '',
      },
    ],
    [
      'compose',
      {
        channel: 'email',
        recipients: ['a@example.com\r\nBcc:h@evil.org'],
        subject: '',
        body: '',
      },
    ],
    [
      'compose',
      {
        channel: 'email',
        recipients: ['a@example.com', 'A@example.com'],
        subject: '',
        body: '',
      },
    ],
    [
      'compose',
      {
        channel: 'email',
        recipients: ['a@example.com'],
        subject: '',
        body: 'é'.repeat(4097),
      },
    ],
    [
      'compose',
      {
        channel: 'email',
        recipients: ['.a@example.com'],
        subject: '',
        body: '',
      },
    ],
    [
      'compose',
      {
        channel: 'email',
        recipients: ['a@example.com'],
        subject: '',
        body: '',
        attachmentURL: 'file:///secret',
      },
    ],
  ])('rejects unsafe %s request %#', (action, args) => {
    expect(() =>
      parseDocumentActionRequest(
        input(action, args as Record<string, unknown>),
      ),
    ).toThrow();
  });
  test('generates correlation UUID and keeps exact text', () => {
    const result = makeDocumentActionRequest('compose', {
      channel: 'email',
      recipients: ['a@example.com'],
      subject: '  Exact  ',
      body: '  Message\n',
    });
    expect(result.subject).toBe('  Exact  ');
    expect(result.body).toBe('  Message\n');
    expect(result.requestId).toMatch(/^[a-f0-9-]{36}$/);
  });
});
describe('document receipts reject spoofed or unsafe output', () => {
  const request = parseDocumentActionRequest(input('read', { inboxId: id }));
  const receipt = {
    schemaVersion: 1,
    requestId,
    action: 'read',
    status: 'read',
    inboxId: id,
    kind: 'pdf',
    text: 'Facture',
    method: 'pdf_text',
    truncated: false,
    untrusted: true,
    documentState: 'text',
  };
  test('accepts bounded untrusted selected text', () => {
    expect(
      parseDocumentActionResult(JSON.stringify(receipt), request).text,
    ).toBe('Facture');
  });
  test.each([
    { requestId: id },
    { inboxId: requestId },
    { untrusted: false },
    { path: '/tmp/secret' },
    { text: '<|tool_call>secret' },
    { text: 'é'.repeat(4097) },
    { documentState: 'no_text' },
    { documentState: 'protected_pdf' },
    { truncated: 'false' },
  ])('rejects altered receipt %#', changes => {
    expect(() =>
      parseDocumentActionResult(
        JSON.stringify({ ...receipt, ...changes }),
        request,
      ),
    ).toThrow();
  });
  test('makes encrypted and no-text PDFs explicit', () => {
    for (const documentState of ['protected_pdf', 'no_text']) {
      const result = parseDocumentActionResult(
        JSON.stringify({ ...receipt, text: '', documentState }),
        request,
      );
      expect(documentActionReceipt(result)).toMatch(/Aucun texte extrait/);
    }
  });
  test.each([
    ['text', 'utf8'],
    ['url', 'utf8'],
    ['image', 'vision_ocr'],
    ['pdf', 'pdf_text'],
  ])(
    'binds the %s extraction method to its native format',
    (kind, expected) => {
      for (const method of ['utf8', 'vision_ocr', 'pdf_text']) {
        const parse = () =>
          parseDocumentActionResult(
            JSON.stringify({ ...receipt, kind, method }),
            request,
          );
        if (method === expected) expect(parse().status).toBe('read');
        else expect(parse).toThrow();
      }
    },
  );
  test('index expiry is within the exact requested duration and permits earlier inbox expiry', () => {
    const now = Date.parse('2026-10-20T00:00:00Z');
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const index = parseDocumentActionRequest(
        input('index', { inboxId: id, title: 'Test', expirationDays: 1 }),
      );
      const parse = (expiresAt: string) =>
        parseDocumentActionResult(
          JSON.stringify({
            schemaVersion: 1,
            requestId,
            action: 'index',
            status: 'indexed',
            inboxId: id,
            expiresAt,
          }),
          index,
        );
      for (const expiry of ['2026-10-20T01:00:00Z', '2026-10-21T00:00:00Z'])
        expect(parse(expiry).status).toBe('indexed');
      for (const expiry of [
        '2026-10-20T00:00:00Z',
        '2026-10-19T23:59:59Z',
        '2026-10-21T00:00:01Z',
        '2099-01-01T00:00:00Z',
      ])
        expect(() => parse(expiry)).toThrow();
    } finally {
      clock.mockRestore();
    }
  });
  test('never calls an Apple compose receipt delivery proof', () => {
    const compose = parseDocumentActionRequest(
      input('compose', {
        channel: 'email',
        recipients: ['a@example.com'],
        subject: 'Objet',
        body: 'Texte',
      }),
    );
    const result = {
      schemaVersion: 1,
      requestId,
      action: 'compose',
      status: 'queued_by_user',
      channel: 'email',
      deliveryVerified: false,
    };
    expect(
      documentActionReceipt(
        parseDocumentActionResult(JSON.stringify(result), compose),
      ),
    ).toContain('Livraison et lecture non vérifiées');
    expect(() =>
      parseDocumentActionResult(
        JSON.stringify({ ...result, deliveryVerified: true }),
        compose,
      ),
    ).toThrow();
  });
  test('search results contain unique owned IDs and bounded titles only', () => {
    const search = parseDocumentActionRequest(
      input('search', { query: 'Facture', limit: 1 }),
    );
    const result = {
      schemaVersion: 1,
      requestId,
      action: 'search',
      status: 'results',
      results: [{ inboxId: id, title: 'Facture' }],
      truncated: false,
      untrusted: true,
    };
    expect(
      parseDocumentActionResult(JSON.stringify(result), search).results,
    ).toHaveLength(1);
    expect(() =>
      parseDocumentActionResult(
        JSON.stringify({
          ...result,
          results: [{ inboxId: id, title: 'Facture', path: '/tmp/path' }],
        }),
        search,
      ),
    ).toThrow();
  });
});
