import React from 'react';
import { Alert, AppState, AppStateStatus, Platform } from 'react-native';
import { act, fireEvent, renderAsync, screen, userEvent } from '@testing-library/react-native';
import { AssistantScreen } from '../App';
import NativeAssist from '../specs/NativeAssist';
import { legacyDeviceToolNames } from '../src/deviceToolProtocol';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('../specs/NativeAssist', () => ({ __esModule: true, default: {
  getStatus: jest.fn(), cancel: jest.fn(), reset: jest.fn(), onProgress: jest.fn(),
  getAgentCapabilities: jest.fn(), getDeviceToolCapabilities: jest.fn(),
  getToolHostCapabilities: jest.fn(), generateWithToolHost: jest.fn(), generate: jest.fn(),
  getToolOperations: jest.fn(), confirmToolAction: jest.fn(), onToolActivity: jest.fn(),
  getVoiceStatus: jest.fn(), onVoiceEvent: jest.fn(), cancelVoice: jest.fn(),
  startListening: jest.fn(), stopListening: jest.fn(), speak: jest.fn(),
  beginSpeech: jest.fn(), enqueueSpeech: jest.fn(), finishSpeech: jest.fn(),
} }));
const native = jest.mocked(NativeAssist!);
const toolsSwitch = 'Outils iOS dans la conversation';
const ready = '{"phase":"ready","contextCapacity":8192}';
const originalAppState = Object.getOwnPropertyDescriptor(AppState, 'currentState')!;
let lifecycle: (state: AppStateStatus) => void;
let activity: (event: { json: string }) => void;
let progress: (event: { json: string }) => void;
let voiceEvent: (event: { json: string }) => void;
const voiceState = '{"available":true,"recognitionAvailable":true,"synthesisAvailable":true,"locale":"fr-CA","phase":"idle"}';
function capabilities(versions = [2, 3]) {
  return JSON.stringify({ schemaVersion: 1, hostProtocolVersions: versions, policyVersion: 1,
    catalogRevision: 'device-v1-13', confirmation: 'all_accesses',
    tools: legacyDeviceToolNames.map(id => ({ id, version: 1,
      effect: ['calendar_create', 'reminder_create', 'notification_schedule'].includes(id) ? 'write' :
        ['photo_select', 'camera_capture', 'biometrics_authenticate'].includes(id) ? 'interactive' : 'read',
      execution: 'device', availability: 'available' })),
  });
}
function result(requestId: string, text: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ requestId, text, generatedTokens: 5, promptTokens: 30, elapsedMs: 200,
    finishReason: 'eos', aneExecution: 'unverified', ...extra });
}
beforeEach(() => {
  jest.useFakeTimers();
  for (const method of Object.values(native)) method.mockReset();
  jest.replaceProperty(Platform, 'OS', 'ios');
  Object.defineProperty(AppState, 'currentState', { configurable: true, writable: true, value: 'active' });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_name, listener) => {
    lifecycle = listener;
    return { remove: jest.fn() };
  });
  native.getStatus.mockResolvedValue(ready);
  native.cancel.mockResolvedValue(ready);
  native.reset.mockResolvedValue(ready);
  native.getVoiceStatus.mockResolvedValue(voiceState);
  native.cancelVoice.mockResolvedValue(voiceState);
  native.getAgentCapabilities.mockResolvedValue('{"schemaVersion":1,"calendarReadOnly":false,"protocolVersion":1}');
  native.getToolHostCapabilities.mockResolvedValue(capabilities());
  native.getToolOperations.mockResolvedValue('{"schemaVersion":1,"operations":[]}');
  native.onToolActivity.mockImplementation(listener => { activity = listener; return { remove: jest.fn() }; });
  native.onProgress.mockImplementation(listener => { progress = listener; return { remove: jest.fn() }; });
  native.onVoiceEvent.mockImplementation(listener => { voiceEvent = listener; return { remove: jest.fn() }; });
  native.generate.mockImplementation(async json => result(JSON.parse(json).requestId, 'Le lieu retenu est Québec.'));
  native.generateWithToolHost.mockImplementation(async json => result(JSON.parse(json).requestId, 'Le parc choisi est celui des Braves.',
    { agentTools: true, referenceContextEligible: true }));
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  Object.defineProperty(AppState, 'currentState', originalAppState);
});
async function openChat(tools = true) {
  const user = userEvent.setup();
  await renderAsync(<AssistantScreen />);
  await screen.findByRole('switch', { name: toolsSwitch, disabled: false });
  if (tools) await user.press(screen.getByRole('switch', { name: toolsSwitch }));
  return user;
}
async function send(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.clear(screen.getByLabelText('Message'));
  await user.type(screen.getByLabelText('Message'), text);
  await user.press(screen.getByRole('button', { name: 'Envoyer' }));
}
function lastRequest() {
  return JSON.parse(native.generateWithToolHost.mock.calls.at(-1)![0]);
}
function photoEvent(requestId: string, status: 'executing' | 'success') {
  activity({ json: JSON.stringify({ schemaVersion: 1, requestId, transaction: {
    id: 'photo-operation', revision: status === 'executing' ? 2 : 3,
    tool: 'photo_select', effect: 'interactive', status, title: 'Choisir une photo', preview: [],
    ...(status === 'success' ? { receipt: { operationId: 'photo-operation', tool: 'photo_select', status,
      completedAt: '2026-10-20T12:00:00Z', summary: [{ label: 'Résultat', value: 'Texte extrait' }] } } : {}),
  } }) });
}

test('enabling tools retains the completed ordinary goal in a separate bounded sidecar', async () => {
  const user = await openChat(false);
  await send(user, 'Je prépare une visite à Québec.');
  expect(await screen.findByText('Le lieu retenu est Québec.')).toBeOnTheScreen();
  await user.press(screen.getByRole('switch', { name: toolsSwitch }));
  await send(user, 'Trouve un parc dans cette ville.');
  expect(lastRequest()).toMatchObject({ hostProtocolVersion: 3, profile: 'device_context_v1',
    messages: [{ role: 'user', content: 'Trouve un parc dans cette ville.' }],
    referenceContext: { turns: [{ user: 'Je prépare une visite à Québec.', assistant: 'Le lieu retenu est Québec.' }], omittedTurns: 0 } });
  await send(user, 'Et son adresse ?');
  expect(lastRequest().referenceContext.turns).toHaveLength(2);
  expect(lastRequest().referenceContext.turns[1]).toEqual({ user: 'Trouve un parc dans cette ville.', assistant: 'Le parc choisi est celui des Braves.' });
  expect(lastRequest().messages).toEqual([{ role: 'user', content: 'Et son adresse ?' }]);
});

// These tests exercise request/context/consent transport with stubbed native
// answers. They do not evaluate Gemma's interpretation or tool selection.
test('a completed clarification without tool activity is carried alongside the next short answer', async () => {
  native.generateWithToolHost.mockImplementationOnce(async json => result(JSON.parse(json).requestId,
    'À quelle heure souhaites-tu cet appel ?', { agentTools: true, referenceContextEligible: true }));
  const user = await openChat();
  await send(user, 'Planifie un appel demain.');
  expect(await screen.findByText('À quelle heure souhaites-tu cet appel ?')).toBeOnTheScreen();
  const first = lastRequest();
  await send(user, 'Demain à 10 h.');
  const followup = lastRequest();
  expect(followup.requestId).not.toBe(first.requestId);
  expect(followup.messages).toEqual([{ role: 'user', content: 'Demain à 10 h.' }]);
  expect(followup.referenceContext).toEqual({ schemaVersion: 1, turns: [{
    user: 'Planifie un appel demain.', assistant: 'À quelle heure souhaites-tu cet appel ?',
  }], omittedTurns: 0 });
  expect(native.confirmToolAction).not.toHaveBeenCalled();
  expect(native.generate).not.toHaveBeenCalled();
});

test('a correction stays the current literal request and a fresh native proposal still needs a new tactile confirmation', async () => {
  native.generateWithToolHost
    .mockImplementationOnce(async json => result(JSON.parse(json).requestId, 'À quelle heure ?',
      { agentTools: true, referenceContextEligible: true }))
    .mockImplementationOnce(async json => result(JSON.parse(json).requestId, 'Quelle durée souhaites-tu ?',
      { agentTools: true, referenceContextEligible: true }));
  let finish!: (value: string) => void;
  native.generateWithToolHost.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  native.confirmToolAction.mockResolvedValue('{"schemaVersion":1,"accepted":true}');
  const user = await openChat();
  await send(user, 'Planifie un appel demain.');
  await send(user, 'À 10 h.');
  await send(user, 'Plutôt à 11 h, pendant 30 minutes.');
  const correction = lastRequest();
  expect(correction.messages).toEqual([{ role: 'user', content: 'Plutôt à 11 h, pendant 30 minutes.' }]);
  expect(correction.referenceContext.turns).toEqual([
    { user: 'Planifie un appel demain.', assistant: 'À quelle heure ?' },
    { user: 'À 10 h.', assistant: 'Quelle durée souhaites-tu ?' },
  ]);
  expect(new Set(native.generateWithToolHost.mock.calls.map(([json]) => JSON.parse(json).requestId)).size).toBe(3);
  expect(native.confirmToolAction).not.toHaveBeenCalled();
  await act(async () => activity({ json: JSON.stringify({ schemaVersion: 1, requestId: correction.requestId, transaction: {
    id: 'current-proposal', revision: 1, tool: 'calendar_create', effect: 'write', status: 'awaiting_confirmation',
    title: 'Créer un événement', preview: [{ label: 'Heure proposée', value: 'Demain à 11 h' }],
    confirmationToken: 'current-proposal-token',
  } }) }));
  expect(native.confirmToolAction).not.toHaveBeenCalled();
  await user.press(screen.getByRole('button', { name: 'Confirmer cette modification' }));
  expect(native.confirmToolAction).toHaveBeenCalledTimes(1);
  expect(native.confirmToolAction).toHaveBeenCalledWith('current-proposal', 'current-proposal-token');
  expect(JSON.stringify(correction.referenceContext)).not.toContain('current-proposal-token');
  await act(async () => finish(result(correction.requestId, 'Fin du contrôle de consentement simulé.',
    { agentTools: true, referenceContextEligible: false, finishReason: 'cancelled' })));
});

test('a subject change is the only active message and never starts or confirms an older task in App', async () => {
  native.generateWithToolHost.mockImplementationOnce(async json => result(JSON.parse(json).requestId, 'À quelle heure ?',
    { agentTools: true, referenceContextEligible: true }));
  const user = await openChat();
  await send(user, 'Planifie un appel demain.');
  await send(user, 'Autre sujet : explique-moi ce qu’est un fuseau horaire.');
  const changed = lastRequest();
  expect(changed.messages).toEqual([{ role: 'user', content: 'Autre sujet : explique-moi ce qu’est un fuseau horaire.' }]);
  expect(changed.referenceContext.turns).toEqual([{ user: 'Planifie un appel demain.', assistant: 'À quelle heure ?' }]);
  expect(native.generateWithToolHost).toHaveBeenCalledTimes(2);
  expect(native.confirmToolAction).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Confirmer cette modification' })).not.toBeOnTheScreen();
});

test.each(['permission_required', 'cancelled', 'outcome_unknown'])('after %s the user can restate a full goal without replaying the ineligible turn', async terminal => {
  native.generateWithToolHost.mockImplementationOnce(async json => result(JSON.parse(json).requestId,
    terminal === 'permission_required' ? 'L’autorisation iOS est nécessaire.' : terminal === 'cancelled'
      ? 'L’accès a été annulé.' : 'Vérifie le résultat dans l’application concernée.',
    { agentTools: true, referenceContextEligible: false, finishReason: terminal === 'cancelled' ? 'cancelled' : 'eos' }));
  const user = await openChat();
  await send(user, 'Planifie un appel demain.');
  await send(user, 'Planifie un appel demain à 10 h pendant 30 minutes.');
  const restated = lastRequest();
  expect(restated.messages).toEqual([{ role: 'user', content: 'Planifie un appel demain à 10 h pendant 30 minutes.' }]);
  expect(restated.referenceContext).toEqual({ schemaVersion: 1, turns: [], omittedTurns: 1 });
  expect(native.confirmToolAction).not.toHaveBeenCalled();
});

test.each(['permission_required', 'cancelled', 'outcome_unknown', 'failed_safe', 'javascript_stop'])('a clarification goal is retired after the short-answer task ends with %s', async terminal => {
  const question = 'À quelle heure souhaites-tu cet appel ?';
  const clarification = 'Quelle action souhaites-tu entreprendre ?';
  native.generateWithToolHost.mockImplementationOnce(async json => result(JSON.parse(json).requestId, question,
    { agentTools: true, referenceContextEligible: true }));
  let finish!: (value: string) => void;
  native.generateWithToolHost.mockImplementationOnce(async json => {
    const requestId = JSON.parse(json).requestId;
    if (terminal === 'javascript_stop') return new Promise(resolve => { finish = resolve; });
    if (terminal === 'failed_safe') {
      activity({ json: JSON.stringify({ schemaVersion: 1, requestId, transaction: {
        id: 'failed-proposal', revision: 3, tool: 'calendar_create', effect: 'write', status: 'failed_safe',
        title: 'Créer un événement', preview: [],
      } }) });
      throw new Error('Échec natif simulé avant finalisation.');
    }
    return result(requestId, 'Ce tour outil est interrompu ou indisponible.', { agentTools: true,
      referenceContextEligible: false, finishReason: terminal === 'cancelled' ? 'cancelled' : 'eos' });
  });
  native.generateWithToolHost.mockImplementationOnce(async json => result(JSON.parse(json).requestId, clarification,
    { agentTools: true, referenceContextEligible: true }));
  const user = await openChat();
  await send(user, 'Planifie un appel demain.');
  await send(user, 'Demain à 10 h.');
  const failedTask = lastRequest();
  // The barrier acts on settlement, without changing the request already sent.
  expect(failedTask.referenceContext.turns).toEqual([{ user: 'Planifie un appel demain.', assistant: question }]);
  if (terminal === 'javascript_stop') {
    await user.press(screen.getByRole('button', { name: 'Annuler la génération' }));
    await act(async () => finish(result(failedTask.requestId, 'EOS tardif ignoré.',
      { agentTools: true, referenceContextEligible: true })));
  }
  await send(user, 'À 10 h.');
  const shortFollowup = lastRequest();
  expect(shortFollowup.messages).toEqual([{ role: 'user', content: 'À 10 h.' }]);
  expect(shortFollowup.referenceContext).toEqual({ schemaVersion: 1, turns: [], omittedTurns: 2 });
  expect(JSON.stringify(shortFollowup)).not.toContain('Planifie un appel demain.');
  await send(user, 'Planifie un appel jeudi à 11 h pendant 30 minutes.');
  const restated = lastRequest();
  expect(restated.messages).toEqual([{ role: 'user', content: 'Planifie un appel jeudi à 11 h pendant 30 minutes.' }]);
  expect(restated.referenceContext).toEqual({ schemaVersion: 1,
    turns: [{ user: 'À 10 h.', assistant: clarification }], omittedTurns: 2 });
  expect(native.confirmToolAction).not.toHaveBeenCalled();
});

test.each([undefined, false])('missing or false native eligibility excludes tool prose even without activity: %p', async eligible => {
  native.generateWithToolHost.mockImplementationOnce(async json => result(JSON.parse(json).requestId, 'Réponse non réutilisable.',
    { agentTools: true, ...(eligible === undefined ? {} : { referenceContextEligible: eligible }) }));
  const user = await openChat();
  await send(user, 'Première demande.');
  await send(user, 'Question indépendante.');
  expect(lastRequest().referenceContext).toEqual({ schemaVersion: 1, turns: [], omittedTurns: 1 });
});

test.each(['cancelled', 'max_tokens'])('incomplete native finish %s is excluded', async finishReason => {
  native.generateWithToolHost.mockImplementationOnce(async json => result(JSON.parse(json).requestId, 'Texte incomplet.',
    { agentTools: true, referenceContextEligible: true, finishReason }));
  const user = await openChat();
  await send(user, 'Première demande.');
  await send(user, 'Question indépendante.');
  expect(lastRequest().referenceContext.turns).toEqual([]);
  expect(lastRequest().referenceContext.omittedTurns).toBe(1);
});

test('a rejected native generation does not preserve a failed pair', async () => {
  native.generateWithToolHost.mockRejectedValueOnce(new Error('provider failed'));
  const user = await openChat();
  await send(user, 'Première demande.');
  await send(user, 'Question indépendante.');
  expect(lastRequest().referenceContext).toEqual({ schemaVersion: 1, turns: [], omittedTurns: 1 });
});

test('background clears reusable references before returning to the foreground', async () => {
  const user = await openChat();
  await send(user, 'Un parc à Québec.');
  await act(async () => lifecycle('background'));
  await act(async () => lifecycle('active'));
  await send(user, 'Question indépendante.');
  expect(lastRequest().referenceContext).toEqual({ schemaVersion: 1, turns: [], omittedTurns: 1 });
});

test('new conversation clears both reference content and omission metadata', async () => {
  const user = await openChat();
  await send(user, 'Un parc à Québec.');
  const alert = jest.spyOn(Alert, 'alert');
  await user.press(screen.getByRole('button', { name: 'Nouvelle conversation' }));
  const confirm = alert.mock.calls[0][2]!.find(button => button.text === 'Effacer et continuer')!;
  await act(async () => confirm.onPress!());
  await send(user, 'Nouvelle question.');
  expect(lastRequest().referenceContext).toEqual({ schemaVersion: 1, turns: [], omittedTurns: 0 });
});

test('v2 stays isolated and never receives reference context', async () => {
  native.getToolHostCapabilities.mockResolvedValue(capabilities([2]));
  const user = await openChat(false);
  await send(user, 'Je prépare une visite à Québec.');
  await user.press(screen.getByRole('switch', { name: toolsSwitch }));
  await send(user, 'Une autre question.');
  expect(lastRequest().hostProtocolVersion).toBe(2);
  expect(lastRequest()).not.toHaveProperty('referenceContext');
  expect(lastRequest().messages).toEqual([{ role: 'user', content: 'Une autre question.' }]);
});

test('double stop suppresses a late successful answer from the reference ledger', async () => {
  let resolve!: (value: string) => void;
  native.generateWithToolHost.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const user = await openChat();
  await send(user, 'Première demande.');
  const requestId = lastRequest().requestId;
  const stop = screen.getByRole('button', { name: 'Annuler la génération' });
  await act(async () => { fireEvent.press(stop); fireEvent.press(stop); });
  await act(async () => resolve(result(requestId, 'Réponse tardive.', { agentTools: true, referenceContextEligible: true })));
  await send(user, 'Question indépendante.');
  expect(lastRequest().referenceContext.turns).toEqual([]);
  expect(screen.queryByText('Réponse tardive.')).not.toBeOnTheScreen();
  expect(native.cancel).toHaveBeenCalled();
});

test('an ordinary reply arriving after Stop cannot become visible or seed newly enabled tools', async () => {
  let resolve!: (value: string) => void;
  native.generate.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const user = await openChat(false);
  await send(user, 'Demande interrompue.');
  const requestId = JSON.parse(native.generate.mock.calls[0][0]).requestId;
  await user.press(screen.getByRole('button', { name: 'Annuler la génération' }));
  await act(async () => progress({ json: result(requestId, 'Progression ordinaire tardive.') }));
  expect(screen.queryByText('Progression ordinaire tardive.')).not.toBeOnTheScreen();
  await act(async () => resolve(result(requestId, 'Réponse ordinaire tardive.')));
  expect(screen.queryByText('Réponse ordinaire tardive.')).not.toBeOnTheScreen();
  await user.press(screen.getByRole('switch', { name: toolsSwitch }));
  await send(user, 'Nouvelle demande.');
  expect(lastRequest().referenceContext.turns).toEqual([]);
});

test('explicit typed Stop keeps only its cancelled prefix in interrupted UI, never ordinary history or tool references', async () => {
  let finish!: (value: string) => void;
  let requestId = '';
  native.generate.mockImplementationOnce(json => {
    requestId = JSON.parse(json).requestId;
    return new Promise(resolve => { finish = resolve; });
  });
  native.cancel.mockImplementationOnce(async () => {
    finish(result(requestId, 'Préfixe interrompu 7319', { finishReason: 'cancelled' }));
    return ready;
  });
  const user = await openChat(false);
  await send(user, 'Demande arrêtée.');
  await user.press(screen.getByRole('button', { name: 'Annuler la génération' }));
  expect(await screen.findByText('Préfixe interrompu 7319')).toBeOnTheScreen();
  expect(screen.getByText('RÉPONSE INTERROMPUE')).toBeOnTheScreen();
  expect(screen.getByLabelText('Message')).toHaveDisplayValue('Demande arrêtée.');
  await send(user, 'Question indépendante.');
  expect(native.generate.mock.calls[1][0]).not.toContain('Préfixe interrompu 7319');
  await user.press(screen.getByRole('switch', { name: toolsSwitch }));
  await send(user, 'Encore une question.');
  expect(JSON.stringify(lastRequest().referenceContext)).not.toContain('Préfixe interrompu 7319');
  expect(lastRequest().referenceContext.omittedTurns).toBe(1);
  expect(native.speak).not.toHaveBeenCalled();
  expect(native.enqueueSpeech).not.toHaveBeenCalled();
});

test.each(['background', 'inactive', 'unmount'])('a cancelled prefix after typed Stop is discarded following %s', async transition => {
  let finish!: (value: string) => void;
  native.generate.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const user = await openChat(false);
  await send(user, 'Demande arrêtée.');
  const requestId = JSON.parse(native.generate.mock.calls[0][0]).requestId;
  await user.press(screen.getByRole('button', { name: 'Annuler la génération' }));
  if (transition === 'unmount') await screen.unmountAsync();
  else {
    await act(async () => lifecycle(transition as 'background' | 'inactive'));
    await act(async () => lifecycle('active'));
  }
  await act(async () => finish(result(requestId, 'Préfixe devenu caduc 7319', { finishReason: 'cancelled' })));
  const resumedUser = transition === 'unmount' ? await openChat(false) : user;
  expect(screen.queryByText('Préfixe devenu caduc 7319')).not.toBeOnTheScreen();
  await resumedUser.press(screen.getByRole('switch', { name: toolsSwitch }));
  await send(resumedUser, 'Question indépendante.');
  expect(lastRequest().referenceContext.turns).toEqual([]);
});

test.each(['foreign identity', 'duplicate keys', 'oversize'])('typed Stop cannot retain a cancelled prefix with %s', async malformed => {
  let finish!: (value: string) => void;
  native.generate.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const user = await openChat(false);
  await send(user, 'Demande arrêtée.');
  const requestId = JSON.parse(native.generate.mock.calls[0][0]).requestId;
  await user.press(screen.getByRole('button', { name: 'Annuler la génération' }));
  let value = result(malformed === 'foreign identity' ? 'foreign-request' : requestId,
    malformed === 'oversize' ? 'é'.repeat(70_000) : 'Préfixe invalide 7319', { finishReason: 'cancelled' });
  if (malformed === 'duplicate keys') value = value.replace('"requestId":', '"requestId":"foreign-request","requestId":');
  await act(async () => finish(value));
  expect(screen.queryByText('RÉPONSE INTERROMPUE')).not.toBeOnTheScreen();
  expect(screen.queryByText('Préfixe invalide 7319')).not.toBeOnTheScreen();
  await user.press(screen.getByRole('switch', { name: toolsSwitch }));
  await send(user, 'Question indépendante.');
  expect(lastRequest().referenceContext.turns).toEqual([]);
});

test('voice interruption never adopts a cancelled ordinary prefix as typed Stop UI', async () => {
  native.startListening.mockImplementation(async id => {
    voiceEvent({ json: JSON.stringify({ sessionId: id, kind: 'state', phase: 'listening' }) });
    return voiceState.replace('idle', 'listening');
  });
  let finish!: (value: string) => void;
  native.generate.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const user = await openChat(false);
  await user.press(screen.getByRole('button', { name: 'Mode vocal' }));
  const sessionId = native.startListening.mock.calls[0][0];
  await act(async () => voiceEvent({ json: JSON.stringify({ sessionId, kind: 'transcript', phase: 'idle',
    text: 'Question vocale.', isFinal: true }) }));
  const requestId = JSON.parse(native.generate.mock.calls[0][0]).requestId;
  await user.press(screen.getByRole('button', { name: 'Interrompre' }));
  await act(async () => finish(result(requestId, 'Préfixe vocal abandonné 7319', { finishReason: 'cancelled' })));
  expect(screen.queryByText('Préfixe vocal abandonné 7319')).not.toBeOnTheScreen();
  expect(native.speak).not.toHaveBeenCalled();
  await user.press(screen.getByRole('button', { name: 'Fermer le mode vocal' }));
  expect(screen.queryByText('Préfixe vocal abandonné 7319')).not.toBeOnTheScreen();
  await user.press(screen.getByRole('switch', { name: toolsSwitch }));
  await send(user, 'Question indépendante.');
  expect(lastRequest().referenceContext.turns).toEqual([]);
});

test.each(['stop', 'background', 'inactive'])('an ordinary rejection after %s cannot show an obsolete error', async interruption => {
  let reject!: (error: Error) => void;
  native.generate.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
  const user = await openChat(false);
  await send(user, 'Demande interrompue.');
  if (interruption === 'stop') await user.press(screen.getByRole('button', { name: 'Annuler la génération' }));
  else {
    await act(async () => lifecycle(interruption as 'background' | 'inactive'));
    await act(async () => lifecycle('active'));
  }
  await act(async () => reject(new Error('Échec tardif 7319')));
  expect(screen.queryByText('Échec tardif 7319')).not.toBeOnTheScreen();
  await user.press(screen.getByRole('switch', { name: toolsSwitch }));
  await send(user, 'Nouvelle demande.');
  expect(lastRequest().referenceContext.turns).toEqual([]);
});

test('a current ordinary rejection remains visible', async () => {
  native.generate.mockRejectedValueOnce(new Error('Échec courant 7319'));
  const user = await openChat(false);
  await send(user, 'Une demande courante.');
  expect(await screen.findByText('Échec courant 7319')).toBeOnTheScreen();
});

test('a native sheet result received while inactive waits for active before becoming visible and reusable', async () => {
  let resolve!: (value: string) => void;
  native.generateWithToolHost.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const user = await openChat();
  await send(user, 'Lis cette photo.');
  const requestId = lastRequest().requestId;
  await act(async () => photoEvent(requestId, 'executing'));
  await act(async () => lifecycle('inactive'));
  await act(async () => photoEvent(requestId, 'success'));
  await act(async () => resolve(result(requestId, 'Le texte extrait est Bonjour.', { agentTools: true, referenceContextEligible: true })));
  expect(screen.queryByText('Le texte extrait est Bonjour.')).not.toBeOnTheScreen();
  await act(async () => lifecycle('active'));
  expect(await screen.findByText('Le texte extrait est Bonjour.')).toBeOnTheScreen();
  await send(user, 'Traduis ce texte.');
  expect(lastRequest().referenceContext.turns).toEqual([{ user: 'Lis cette photo.', assistant: 'Le texte extrait est Bonjour.' }]);
  expect(native.cancel).not.toHaveBeenCalled();
});

test.each(['background', 'stop'])('a sheet result pending foreground is retired by %s and never revived', async interruption => {
  let resolve!: (value: string) => void;
  native.generateWithToolHost.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const user = await openChat();
  await send(user, 'Lis cette photo.');
  const requestId = lastRequest().requestId;
  await act(async () => photoEvent(requestId, 'executing'));
  await act(async () => lifecycle('inactive'));
  await act(async () => photoEvent(requestId, 'success'));
  await act(async () => resolve(result(requestId, 'Texte devenu caduc.', { agentTools: true, referenceContextEligible: true })));
  if (interruption === 'background') await act(async () => lifecycle('background'));
  else await user.press(screen.getByRole('button', { name: 'Annuler la génération' }));
  await act(async () => lifecycle('active'));
  expect(screen.queryByText('Texte devenu caduc.')).not.toBeOnTheScreen();
  await send(user, 'Question indépendante.');
  expect(lastRequest().referenceContext.turns).toEqual([]);
  expect(native.generateWithToolHost).toHaveBeenCalledTimes(2);
  expect(native.cancel).toHaveBeenCalledTimes(1);
});

test('inactive without an owned native sheet cancels the task and ignores its later final answer', async () => {
  let resolve!: (value: string) => void;
  native.generateWithToolHost.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const user = await openChat();
  await send(user, 'Consulte mes événements.');
  const requestId = lastRequest().requestId;
  await act(async () => lifecycle('inactive'));
  await act(async () => lifecycle('active'));
  await act(async () => resolve(result(requestId, 'Réponse devenue caduque.', { agentTools: true, referenceContextEligible: true })));
  expect(screen.queryByText('Réponse devenue caduque.')).not.toBeOnTheScreen();
  await send(user, 'Question indépendante.');
  expect(lastRequest().referenceContext.turns).toEqual([]);
  expect(native.cancel).toHaveBeenCalledTimes(1);
});

test('opting out removes tool references from ordinary input and a later tool opt-in', async () => {
  native.generateWithToolHost.mockImplementationOnce(async json => result(JSON.parse(json).requestId, 'PRIVATE_REFERENCE_7319',
    { agentTools: true, referenceContextEligible: true }));
  const user = await openChat();
  await send(user, 'Un renseignement privé.');
  await user.press(screen.getByRole('switch', { name: toolsSwitch }));
  await send(user, 'Bonjour.');
  expect(JSON.stringify(native.generate.mock.calls)).not.toContain('PRIVATE_REFERENCE_7319');
  expect(JSON.stringify(native.generate.mock.calls)).not.toContain('Un renseignement privé.');
  await user.press(screen.getByRole('switch', { name: toolsSwitch }));
  await send(user, 'Question indépendante.');
  expect(lastRequest().referenceContext.turns).toEqual([{ user: 'Bonjour.', assistant: 'Le lieu retenu est Québec.' }]);
  expect(lastRequest().referenceContext.omittedTurns).toBe(1);
});

test.each(['wrong request', 'duplicate request', 'duplicate text'])('a %s result never becomes reference context', async malformed => {
  native.generateWithToolHost.mockImplementationOnce(async json => {
    const requestId = JSON.parse(json).requestId;
    let value = result(malformed === 'wrong request' ? 'foreign-request' : requestId, 'Réponse malformée.',
      { agentTools: true, referenceContextEligible: true });
    if (malformed === 'duplicate request') value = value.replace('"requestId":', '"requestId":"foreign-request","requestId":');
    if (malformed === 'duplicate text') value = value.replace('"text":', '"text":"Contenu ambigu","text":');
    return value;
  });
  const user = await openChat();
  await send(user, 'Première demande.');
  expect(screen.queryByText('Réponse malformée.')).not.toBeOnTheScreen();
  await send(user, 'Question indépendante.');
  expect(lastRequest().referenceContext.turns).toEqual([]);
});

test.each(['chat', 'voice'])('a first confirmed write remains visible after cancelling the next access in %s, without speech or reusable success', async mode => {
  const cancelledText = 'L’événement a été créé dans le calendrier confirmé.\n\nL’accès suivant a été annulé. Les actions déjà confirmées ci-dessus ne sont pas annulées. Aucun nouvel essai automatique.';
  native.getVoiceStatus.mockResolvedValue(voiceState);
  native.cancelVoice.mockResolvedValue(voiceState);
  native.startListening.mockImplementation(async id => {
    voiceEvent({ json: JSON.stringify({ sessionId: id, kind: 'state', phase: 'listening' }) });
    return voiceState.replace('idle', 'listening');
  });
  native.generateWithToolHost.mockImplementationOnce(async json => {
    const requestId = JSON.parse(json).requestId;
    activity({ json: JSON.stringify({ schemaVersion: 1, requestId, transaction: {
      id: 'confirmed-write', revision: 3, tool: 'calendar_create', effect: 'write', status: 'success',
      title: 'Créer un événement', preview: [], receipt: { operationId: 'confirmed-write', tool: 'calendar_create', status: 'success',
        completedAt: '2026-10-20T12:00:00Z', summary: [{ label: 'Résultat', value: 'Événement confirmé' }] },
    } }) });
    activity({ json: JSON.stringify({ schemaVersion: 1, requestId, transaction: {
      id: 'cancelled-photo', revision: 3, tool: 'photo_select', effect: 'interactive', status: 'cancelled',
      title: 'Choisir une photo', preview: [],
    } }) });
    return result(requestId, cancelledText, { agentTools: true, referenceContextEligible: false, finishReason: 'cancelled' });
  });
  const user = await openChat();
  if (mode === 'voice') {
    await user.press(screen.getByRole('button', { name: 'Mode vocal' }));
    const sessionId = native.startListening.mock.calls[0][0];
    await act(async () => voiceEvent({ json: JSON.stringify({ sessionId, kind: 'transcript', phase: 'idle',
      text: 'Crée un événement puis lis une photo.', isFinal: true }) }));
    expect(await screen.findByText('En pause')).toBeOnTheScreen();
  } else await send(user, 'Crée un événement puis lis une photo.');
  expect(screen.getByText('Résultat : Événement confirmé')).toBeOnTheScreen();
  expect(screen.getByText(cancelledText)).toBeOnTheScreen();
  expect(native.generateWithToolHost).toHaveBeenCalledTimes(1);
  expect(native.speak).not.toHaveBeenCalled();
  expect(native.beginSpeech).not.toHaveBeenCalled();
  expect(native.enqueueSpeech).not.toHaveBeenCalled();
  if (mode === 'voice') await user.press(screen.getByRole('button', { name: 'Fermer le mode vocal' }));
  await send(user, 'Question indépendante.');
  expect(lastRequest().referenceContext).toEqual({ schemaVersion: 1, turns: [], omittedTurns: 1 });
});

test('an ordinary cancelled payload cannot label itself a trusted tool interruption in voice', async () => {
  native.startListening.mockImplementation(async id => {
    voiceEvent({ json: JSON.stringify({ sessionId: id, kind: 'state', phase: 'listening' }) });
    return voiceState.replace('idle', 'listening');
  });
  native.generate.mockImplementationOnce(async json => result(JSON.parse(json).requestId, 'Texte ordinaire annulé.',
    { finishReason: 'cancelled', deviceTools: true }));
  const user = await openChat(false);
  await user.press(screen.getByRole('button', { name: 'Mode vocal' }));
  const sessionId = native.startListening.mock.calls[0][0];
  await act(async () => voiceEvent({ json: JSON.stringify({ sessionId, kind: 'transcript', phase: 'idle',
    text: 'Une question ordinaire.', isFinal: true }) }));
  expect(await screen.findByText('En pause')).toBeOnTheScreen();
  expect(screen.queryByText('Texte ordinaire annulé.')).not.toBeOnTheScreen();
  expect(screen.queryByText('Accès interrompu')).not.toBeOnTheScreen();
  expect(native.generateWithToolHost).not.toHaveBeenCalled();
  expect(native.speak).not.toHaveBeenCalled();
});

test.each(['outcome_unknown', 'failed_safe', 'cancelled', 'awaiting_permission'])('a %s activity excludes prose even if native eligibility were incorrectly true', async status => {
  native.generateWithToolHost.mockImplementationOnce(async json => {
    const requestId = JSON.parse(json).requestId;
    activity({ json: JSON.stringify({ schemaVersion: 1, requestId, transaction: {
      id: 'uncertain-operation', revision: 3, tool: 'calendar_create', effect: 'write', status,
      title: 'Créer un événement', preview: [],
      ...(status === 'awaiting_permission' ? { capability: 'calendar' } : {}),
      ...(status === 'outcome_unknown' ? { receipt: { operationId: 'uncertain-operation', tool: 'calendar_create',
        status, completedAt: '2026-10-20T12:00:00Z', summary: [{ label: 'Résultat', value: 'Vérification manuelle requise' }] } } : {}),
    } }) });
    return result(requestId, 'Réponse incertaine.', { agentTools: true, referenceContextEligible: true });
  });
  const user = await openChat();
  await send(user, 'Première demande.');
  if (status === 'outcome_unknown') expect(screen.getAllByText(/L’action a peut-être eu lieu/).length).toBeGreaterThan(0);
  await send(user, 'Question indépendante.');
  expect(lastRequest().referenceContext.turns).toEqual([]);
});
