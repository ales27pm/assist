import {
  parseDeviceToolActivity,
  parseToolOperations,
  toolOperationLabel,
} from '../src/deviceToolProtocol';

const known = {
  operationId: 'known-1',
  tool: 'reminder_create',
  status: 'success',
  completedAt: '2026-10-19T12:00:00Z',
  summary: [{ label: 'Résultat', value: 'success' }],
};
const unknown = {
  ...known,
  operationId: 'future-1',
  tool: 'future_alarm_create',
  status: 'outcome_unknown',
  summary: [{ label: 'Ne pas afficher', value: 'Contenu futur non approuvé' }],
};
const journal = (operations: unknown[]) =>
  JSON.stringify({ schemaVersion: 1, operations });

test('a rollback preserves both known receipts and unknown uncertain operations', () => {
  const operations = parseToolOperations(journal([known, unknown]));
  expect(operations).toHaveLength(2);
  expect(operations[0]).toEqual(known);
  expect(operations[1]).toEqual({
    operationId: 'future-1',
    tool: null,
    unknownToolName: 'future_alarm_create',
    status: 'outcome_unknown',
    completedAt: known.completedAt,
    summary: [
      {
        label: 'Vérification requise',
        value:
          'Une opération d’une autre version reste incertaine. Vérifie dans l’app concernée. Aucun nouvel essai automatique.',
      },
    ],
  });
  expect(toolOperationLabel(operations[0])).toBe('Créer un rappel');
  expect(toolOperationLabel(operations[1])).toBe('Opération d’une autre version');
  expect(JSON.stringify(operations[1])).not.toContain('Contenu futur');
  expect(operations[1]).not.toHaveProperty('confirmationToken');
});

test('an unknown successful receipt is informational, never promoted to a known tool', () => {
  const [operation] = parseToolOperations(
    journal([{ ...unknown, status: 'success' }]),
  );
  expect(operation.tool).toBeNull();
  expect(operation.status).toBe('success');
  expect(operation.summary[0].label).toBe('Résultat archivé');
});

test.each([
  { tool: 'https://private.invalid/' },
  { tool: '<|tool_call>alarm' },
  { tool: 'x'.repeat(65) },
  { tool: '' },
  { tool: null },
  { status: 'executing' },
  { status: 'permission_required' },
  { status: ['outcome_unknown'] },
  { completedAt: '2026-02-30T12:00:00Z' },
  { operationId: '' },
  { summary: [{ label: 'x', value: '<|tool_call>' }] },
  { summary: Array.from({ length: 11 }, () => ({ label: 'x', value: 'y' })) },
  { confirmationToken: 'no-authority-from-journal' },
])('rejects malformed unknown recovery metadata %#', patch => {
  expect(() => parseToolOperations(journal([{ ...unknown, ...patch }]))).toThrow();
});

test('unknown entries do not relax journal uniqueness, version or byte limits', () => {
  expect(() => parseToolOperations(journal([unknown, unknown]))).toThrow();
  expect(() =>
    parseToolOperations(JSON.stringify({ schemaVersion: 2, operations: [unknown] })),
  ).toThrow();
  expect(() =>
    parseToolOperations(
      journal([{ ...unknown, summary: [{ label: 'x', value: 'é'.repeat(17000) }] }]),
    ),
  ).toThrow();
});

test('recovery support never accepts unknown live activity or an executable receipt', () => {
  expect(() =>
    parseDeviceToolActivity(
      JSON.stringify({
        schemaVersion: 1,
        requestId: 'request-1',
        transaction: {
          id: 'future-1',
          revision: 1,
          tool: unknown.tool,
          effect: 'write',
          title: 'Ne doit pas être exécutable',
          status: 'awaiting_confirmation',
          preview: [],
          confirmationToken: 'token-1',
        },
      }),
    ),
  ).toThrow();
});
