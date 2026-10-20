import React from 'react';
import {act, renderAsync, screen, userEvent} from '@testing-library/react-native';
import {AppState, AppStateStatus} from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import {NativeIntentBanner, parseIntentDraft} from '../src/NativeIntentBanner';

jest.mock('../specs/NativeAssist', () => ({__esModule: true, default: {
  getPendingNativeIntent: jest.fn(), dismissNativeIntent: jest.fn(), generate: jest.fn(), onNativeIntentChanged: jest.fn(),
}}));
const native = jest.mocked(NativeAssist!);
const now = Date.parse('2026-10-19T12:00:00Z') / 1000;
const draft = {id: '22345678-1234-1234-1234-123456789abc', kind: 'timer', prompt: 'Prépare un minuteur de 300 secondes.', createdAt: now, expiresAt: now + 300};
const snapshot = (pending: unknown = draft) => JSON.stringify({schemaVersion: 1, pending});
let lifecycle: (state: AppStateStatus) => void;
let changed: (event: {json: string}) => void;
beforeEach(() => {
  jest.useFakeTimers(); jest.setSystemTime(now * 1000); jest.resetAllMocks();
  Object.defineProperty(AppState, 'currentState', {configurable: true, value: 'active'});
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => { lifecycle = listener; return {remove: jest.fn()}; });
  native.getPendingNativeIntent.mockResolvedValue(snapshot());
  native.dismissNativeIntent.mockResolvedValue('{"schemaVersion":1,"dismissed":true}');
  native.onNativeIntentChanged.mockImplementation(listener => { changed = listener; return {remove: jest.fn()}; });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('Siri input remains a visible draft until the user loads it, without model execution', async () => {
  const load = jest.fn(); const user = userEvent.setup();
  await renderAsync(<NativeIntentBanner blocked={false} toolsAvailable onDraft={load} />);
  expect(screen.getByText(draft.prompt)).toBeOnTheScreen();
  expect(load).not.toHaveBeenCalled(); expect(native.dismissNativeIntent).not.toHaveBeenCalled();
  await user.press(screen.getByRole('button', {name: 'Préparer dans la conversation'}));
  expect(load).toHaveBeenCalledWith(draft.prompt, true);
  expect(native.dismissNativeIntent).toHaveBeenCalledTimes(1);
  expect(native.dismissNativeIntent).toHaveBeenCalledWith(draft.id);
  expect(native.generate).not.toHaveBeenCalled();
});
test('a mutation draft cannot be loaded without compatible native tools, but may be closed', async () => {
  const load = jest.fn(); const user = userEvent.setup();
  await renderAsync(<NativeIntentBanner blocked={false} toolsAvailable={false} onDraft={load} />);
  expect(screen.getByRole('button', {name: 'Préparer dans la conversation'})).toBeDisabled();
  await user.press(screen.getByRole('button', {name: 'Fermer cette demande'}));
  expect(load).not.toHaveBeenCalled();
});
test('an invalid dismissal ACK never loads or executes the draft', async () => {
  native.dismissNativeIntent.mockResolvedValue('{"schemaVersion":1,"dismissed":false}');
  const load = jest.fn(); const user = userEvent.setup();
  await renderAsync(<NativeIntentBanner blocked={false} toolsAvailable onDraft={load} />);
  await user.press(screen.getByRole('button', {name: 'Préparer dans la conversation'}));
  expect(load).not.toHaveBeenCalled(); expect(native.generate).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toBeOnTheScreen();
});
test('leaving active while a dismissal is pending invalidates its late result', async () => {
  let resolve!: (value: string) => void;
  native.dismissNativeIntent.mockReturnValue(new Promise(done => { resolve = done; }));
  const load = jest.fn(); const user = userEvent.setup();
  await renderAsync(<NativeIntentBanner blocked={false} toolsAvailable onDraft={load} />);
  await user.press(screen.getByRole('button', {name: 'Préparer dans la conversation'}));
  await act(async () => {
    Object.defineProperty(AppState, 'currentState', {value: 'inactive'}); lifecycle('inactive');
    resolve('{"schemaVersion":1,"dismissed":true}');
  });
  expect(load).not.toHaveBeenCalled(); expect(native.generate).not.toHaveBeenCalled();
});
test.each(['blocked', 'tools'] as const)('a late dismissal cannot load a draft after %s changes', async gate => {
  let resolve!: (value: string) => void;
  native.dismissNativeIntent.mockReturnValue(new Promise(done => { resolve = done; }));
  const load = jest.fn(); const user = userEvent.setup();
  const view = await renderAsync(<NativeIntentBanner blocked={false} toolsAvailable onDraft={load} />);
  await user.press(screen.getByRole('button', {name: 'Préparer dans la conversation'}));
  await view.rerenderAsync(<NativeIntentBanner blocked={gate === 'blocked'} toolsAvailable={gate !== 'tools'} onDraft={load} />);
  native.getPendingNativeIntent.mockResolvedValue(snapshot(null));
  await act(async () => { resolve('{"schemaVersion":1,"dismissed":true}'); });
  expect(load).not.toHaveBeenCalled(); expect(native.generate).not.toHaveBeenCalled();
});
test('a newly prepared draft becomes visible while Assist remains active', async () => {
  native.getPendingNativeIntent.mockResolvedValue(snapshot(null));
  await renderAsync(<NativeIntentBanner blocked={false} toolsAvailable onDraft={jest.fn()} />);
  expect(screen.queryByText(draft.prompt)).toBeNull();
  native.getPendingNativeIntent.mockResolvedValue(snapshot());
  await act(async () => { changed({json: '{"schemaVersion":1,"changed":true}'}); });
  expect(screen.getByText(draft.prompt)).toBeOnTheScreen();
  expect(native.dismissNativeIntent).not.toHaveBeenCalled(); expect(native.generate).not.toHaveBeenCalled();
});
test('a native change during dismissal is reread after the ACK without erasing the next draft', async () => {
  let resolve!: (value: string) => void;
  native.dismissNativeIntent.mockReturnValue(new Promise(done => { resolve = done; }));
  const load = jest.fn(); const user = userEvent.setup();
  await renderAsync(<NativeIntentBanner blocked={false} toolsAvailable onDraft={load} />);
  await user.press(screen.getByRole('button', {name: 'Préparer dans la conversation'}));
  const next = {...draft, id: '32345678-1234-1234-1234-123456789abc', prompt: 'Autre demande explicite.'};
  native.getPendingNativeIntent.mockResolvedValue(snapshot(next));
  await act(async () => {
    changed({json: '{"schemaVersion":1,"changed":true}'});
    resolve('{"schemaVersion":1,"dismissed":true}');
  });
  expect(load).toHaveBeenCalledTimes(1); expect(load).toHaveBeenCalledWith(draft.prompt, true);
  expect(screen.getByText(next.prompt)).toBeOnTheScreen();
  expect(native.generate).not.toHaveBeenCalled();
});
test.each([
  {...draft, id: 'other'}, {...draft, kind: 'execute'}, {...draft, prompt: '<|tool_call>attack'},
  {...draft, prompt: 'x'.repeat(4001)}, {...draft, expiresAt: now + 3600}, {...draft, extra: true},
])('rejects incompatible or executable handoffs %#', value => {
  expect(() => parseIntentDraft(snapshot(value), now)).toThrow();
});
test('expired or future handoffs are not accepted', () => {
  expect(parseIntentDraft(snapshot(), now + 300)).toBeNull();
  expect(parseIntentDraft(snapshot(), now - 1)).toBeNull();
});
