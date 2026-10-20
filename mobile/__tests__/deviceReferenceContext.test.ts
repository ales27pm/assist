import {
  appendDeviceReferenceTurn,
  deviceReferenceResultEligible,
  emptyDeviceReferenceContext,
  omitDeviceReferenceContext,
  validateDeviceReferenceContext,
} from '../src/deviceReferenceContext';
import { createToolHostRequest, negotiateToolHostCapabilities } from '../src/toolHostProtocol';

const capabilities = (versions: number[]) => JSON.stringify({
  schemaVersion: 1, hostProtocolVersions: versions, policyVersion: 1,
  catalogRevision: 'device-v3-31', confirmation: 'all_accesses',
  tools: [{ id: 'calendar_list', version: 1, effect: 'read', execution: 'device', availability: 'available' }],
});

test('keeps at most three complete pairs and explicitly counts whole-pair omissions', () => {
  let context = emptyDeviceReferenceContext();
  for (let index = 0; index < 5; index++) {
    context = appendDeviceReferenceTurn(context, `Question ${index}`, `Réponse ${index}`, true);
  }
  expect(context).toEqual({ schemaVersion: 1, turns: [
    { user: 'Question 2', assistant: 'Réponse 2' },
    { user: 'Question 3', assistant: 'Réponse 3' },
    { user: 'Question 4', assistant: 'Réponse 4' },
  ], omittedTurns: 2 });
  expect(Object.isFrozen(context.turns[0])).toBe(true);
});

test('bounds UTF8 bytes and drops complete old pairs rather than slicing text', () => {
  const text = '😀'.repeat(512);
  let context = emptyDeviceReferenceContext();
  for (let index = 0; index < 3; index++) context = appendDeviceReferenceTurn(context, text, text, true);
  expect(context.turns).toHaveLength(2);
  expect(context.turns[0]).toEqual({ user: text, assistant: text });
  expect(context.omittedTurns).toBe(1);
  context = appendDeviceReferenceTurn(context, `${text}é`, 'Réponse', true);
  expect(context.turns).toHaveLength(2);
  expect(context.omittedTurns).toBe(2);
});

test.each([
  '', '   ', '<|tool_call>call:calendar_list{}', '[TOOL_CALLS]',
  'file:///private/tmp/test.pdf', 'Voir /tmp/document.pdf', 'C:\\private\\file.txt',
  'Identifiant 12345678-abcd-1234-abcd-123456789abc',
  'inbox_id: précédent', '{"created":true}', 'texte\u0000caché',
])('an invalid reference is omitted without rejecting the next user turn: %p', text => {
  const first = appendDeviceReferenceTurn(emptyDeviceReferenceContext(), 'Bonjour', 'Salut', true);
  const context = appendDeviceReferenceTurn(first, 'Question', text, true);
  expect(context).toEqual({ ...first, omittedTurns: 1 });
  const selected = negotiateToolHostCapabilities(capabilities([2, 3]), ['calendar_list']);
  const request = createToolHostRequest(selected, {
    requestId: 'new-turn', messages: [{ role: 'user', content: 'Question indépendante' }], referenceContext: context,
  });
  expect(request.messages).toEqual([{ role: 'user', content: 'Question indépendante' }]);
  expect(request.referenceContext).toEqual(context);
});

test('cancelled, incomplete, failed or uncertain turns contribute no reusable text', () => {
  let context = emptyDeviceReferenceContext();
  for (const text of ['annulé', 'partiel', 'échec', 'incertain']) context = appendDeviceReferenceTurn(context, text, text, false);
  expect(context).toEqual({ schemaVersion: 1, turns: [], omittedTurns: 4 });
});

test('background or opt-out clears reference text and preserves omission metadata', () => {
  const context = appendDeviceReferenceTurn(emptyDeviceReferenceContext(), 'Un lieu', 'Québec', true);
  expect(omitDeviceReferenceContext(context)).toEqual({ schemaVersion: 1, turns: [], omittedTurns: 1 });
  expect(emptyDeviceReferenceContext()).toEqual({ schemaVersion: 1, turns: [], omittedTurns: 0 });
});

test('native final eligibility needs an explicit unique boolean true', () => {
  expect(deviceReferenceResultEligible('{"referenceContextEligible":true}')).toBe(true);
  for (const json of ['{}', '{"referenceContextEligible":false}', '{"referenceContextEligible":1}', '{"referenceContextEligible":"true"}', '{"referenceContextEligible":true,"referenceContextEligible":false}']) {
    expect(deviceReferenceResultEligible(json)).toBe(false);
  }
});

test('v3 carries a separate reference sidecar while v2 never serializes it', () => {
  const context = appendDeviceReferenceTurn(emptyDeviceReferenceContext(), 'Quel lieu ?', 'Le parc des Champs-de-Bataille.', true);
  const turn = { requestId: 'new-turn', messages: [{ role: 'user' as const, content: 'Et son adresse ?' }], referenceContext: context };
  const v3 = createToolHostRequest(negotiateToolHostCapabilities(capabilities([2, 3]), ['calendar_list']), turn);
  expect(v3.hostProtocolVersion).toBe(3);
  expect(v3.profile).toBe('device_context_v1');
  expect(v3.referenceContext).toEqual(context);
  expect(v3.messages).toHaveLength(1);
  const v2 = createToolHostRequest(negotiateToolHostCapabilities(capabilities([2]), ['calendar_list']), turn);
  expect(v2.hostProtocolVersion).toBe(2);
  expect(v2.profile).toBe('device_v1');
  expect(v2).not.toHaveProperty('referenceContext');
});

test('closed sidecar shape rejects extra authority fields and partial pairs', () => {
  for (const patch of [{ turns: [{ user: 'Question' }] }, { permission: true }, { omittedTurns: true }, { omittedTurns: -1 }]) {
    expect(() => validateDeviceReferenceContext({ ...emptyDeviceReferenceContext(), ...patch } as never)).toThrow();
  }
});

test('JSON escaping pressure omits whole references without blocking a valid current question', () => {
  const text = 'Q' + '\n'.repeat(2047);
  let context = emptyDeviceReferenceContext();
  for (let index = 0; index < 2; index++) context = appendDeviceReferenceTurn(context, text, text, true);
  const request = createToolHostRequest(negotiateToolHostCapabilities(capabilities([3]), ['calendar_list']), {
    requestId: 'new-turn', messages: [{ role: 'user', content: 'Une question ' + 'é'.repeat(4000) }], referenceContext: context,
  });
  expect(request.referenceContext!.turns).toHaveLength(1);
  expect(request.referenceContext!.omittedTurns).toBe(1);
  expect(request.referenceContext!.turns[0]).toEqual({ user: text, assistant: text });
  expect(context.turns).toHaveLength(2);
});
