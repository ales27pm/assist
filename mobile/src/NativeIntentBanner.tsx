import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { ActionButton, SurfaceGroup } from './uiPrimitives';
import { useAppearance } from './appearance';
import { workspaceBytes, workspaceUUID } from './nativeWorkspaceProtocol';

type Draft = {id: string; kind: string; prompt: string; createdAt: number; expiresAt: number};
export function parseIntentDraft(json: string, now = Date.now() / 1000): Draft | null {
  if (workspaceBytes(json) > 8192) throw new Error('Demande Raccourcis incompatible.');
  const row = JSON.parse(json);
  if (!row || row.schemaVersion !== 1 || Object.keys(row).some(key => !['schemaVersion', 'pending'].includes(key))) throw new Error('Demande Raccourcis incompatible.');
  const draft = row.pending;
  if (draft == null) return null;
  if (!draft || Object.keys(draft).sort().join(',') !== 'createdAt,expiresAt,id,kind,prompt' || !workspaceUUID(draft.id) ||
    !['chat', 'timer', 'alarm', 'scan', 'translation', 'document'].includes(draft.kind) || typeof draft.prompt !== 'string' || !draft.prompt.trim() || workspaceBytes(draft.prompt) > 4000 || /<\||\|>|<tool|<channel|<turn/.test(draft.prompt) ||
    typeof draft.createdAt !== 'number' || !Number.isFinite(draft.createdAt) || typeof draft.expiresAt !== 'number' || !Number.isFinite(draft.expiresAt) || draft.expiresAt - draft.createdAt !== 300) throw new Error('Demande Raccourcis incompatible.');
  return now >= draft.expiresAt || now < draft.createdAt ? null : draft;
}

/** Siri/Shortcuts input is a draft, never a tool permit or automatic command. */
export function NativeIntentBanner({blocked, toolsAvailable, onDraft}: {blocked: boolean; toolsAvailable: boolean; onDraft: (prompt: string, needsTools: boolean) => void}) {
  const {theme: {colors}} = useAppearance();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const live = useRef(true);
  const pending = useRef(false);
  const refreshQueued = useRef(false);
  const current = useRef({blocked, toolsAvailable, onDraft});
  current.current = {blocked, toolsAvailable, onDraft};
  const available = typeof NativeAssist?.getPendingNativeIntent === 'function' && typeof NativeAssist?.dismissNativeIntent === 'function';
  const refresh = useCallback(async () => {
    if (!available || current.current.blocked || pending.current || AppState.currentState !== 'active') {
      refreshQueued.current = true;
      return;
    }
    refreshQueued.current = false;
    const ticket = ++epoch.current;
    try {
      const next = parseIntentDraft(await NativeAssist!.getPendingNativeIntent());
      if (live.current && ticket === epoch.current && !current.current.blocked && AppState.currentState === 'active') { setDraft(next); setError(''); }
    } catch { if (live.current && ticket === epoch.current) setError('La demande Raccourcis n’a pas pu être vérifiée. Aucune action lancée.'); }
  }, [available]);
  useEffect(() => {
    live.current = true;
    refresh();
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') refresh();
      else { ++epoch.current; setDraft(null); }
    });
    const changes = NativeAssist?.onNativeIntentChanged?.(event => {
      // The event is only a signal. Always reread the protected native store.
      try {
        if (workspaceBytes(event.json) > 128) return;
        const signal = JSON.parse(event.json);
        if (signal?.schemaVersion === 1 && signal.changed === true && Object.keys(signal).length === 2) refresh();
      } catch { /* An invalid signal carries no authority. */ }
    });
    return () => { live.current = false; sub.remove(); changes?.remove(); };
  }, [refresh]);
  useEffect(() => {
    // Invalidate an ACK or snapshot spanning a change in conversation state.
    ++epoch.current;
    if (!blocked) refresh();
  }, [blocked, toolsAvailable, refresh]);
  async function consume(load: boolean) {
    if (!draft || blocked || pending.current || AppState.currentState !== 'active' || (load && draft.kind !== 'chat' && !toolsAvailable)) return;
    const ticket = ++epoch.current;
    pending.current = true; setBusy(true);
    try {
      if (!parseIntentDraft(JSON.stringify({schemaVersion: 1, pending: draft}))) { setDraft(null); return; }
      const ack = JSON.parse(await NativeAssist!.dismissNativeIntent(draft.id));
      if (!ack || ack.schemaVersion !== 1 || ack.dismissed !== true || Object.keys(ack).length !== 2) throw new Error();
      if (!live.current || ticket !== epoch.current || AppState.currentState !== 'active') return;
      setDraft(null);
      if (load && !current.current.blocked && (draft.kind === 'chat' || current.current.toolsAvailable)) current.current.onDraft(draft.prompt, draft.kind !== 'chat');
    } catch { if (live.current && ticket === epoch.current) setError('La fermeture de cette demande n’a pas été confirmée. Aucun travail relancé.'); }
    finally {
      pending.current = false;
      if (live.current) {
        setBusy(false);
        if ((refreshQueued.current || ticket !== epoch.current) && AppState.currentState === 'active') refresh();
      }
    }
  }
  if (!available || (!draft && !error)) return null;
  return <SurfaceGroup title="Demande Siri, Raccourcis ou Spotlight">
    {draft && <>
      <Text style={{color: colors.text}}>{draft.prompt}</Text>
      <Text style={{color: colors.muted}}>Prépare un brouillon. Tu l’envoies puis confirmes les éventuelles actions dans la conversation.</Text>
      <ActionButton label="Préparer dans la conversation" disabled={blocked || busy || (draft.kind !== 'chat' && !toolsAvailable)} onPress={() => consume(true)} />
      <ActionButton label="Fermer cette demande" disabled={blocked || busy} onPress={() => consume(false)} />
    </>}
    {!!error && <View><Text role="alert" style={{color: colors.danger}}>{error}</Text></View>}
  </SurfaceGroup>;
}
