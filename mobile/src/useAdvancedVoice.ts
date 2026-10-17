import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { errorMessage } from './protocol';
import { parseAdvancedVoiceState } from './advancedVoice';
import type {
  AdvancedVoiceBackend,
  AdvancedVoiceState,
  AdvancedVoiceVariant,
} from './advancedVoice';

type Operation = 'pack' | 'backend';
const unsupported =
  'La voix locale avancée nécessite une version compatible d’Assist sur iPhone.';

/** Explicit Files imports only. This hook never captures, plays or downloads audio. */
export function useAdvancedVoice() {
  const supported = !!(
    NativeAssist &&
    typeof NativeAssist.getAdvancedVoiceState === 'function' &&
    typeof NativeAssist.importAdvancedVoicePack === 'function' &&
    typeof NativeAssist.setAdvancedVoiceBackend === 'function'
  );
  const [state, setState] = useState<AdvancedVoiceState | null>(null);
  const [loading, setLoading] = useState(supported);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [error, setError] = useState(supported ? '' : unsupported);
  const mounted = useRef(true);
  const foreground = useRef(AppState.currentState === 'active');
  const version = useRef(0);
  const lifetime = useRef(0);
  const pending = useRef(false);
  const latest = useRef<AdvancedVoiceState | null>(null);
  const invalidate = useCallback(() => {
    ++version.current;
    ++lifetime.current;
  }, []);
  const commit = useCallback((next: AdvancedVoiceState) => {
    if (latest.current && next.revision < latest.current.revision) return false;
    latest.current = next;
    setState(next);
    return true;
  }, []);

  const refresh = useCallback(async () => {
    if (
      !supported ||
      !mounted.current ||
      !foreground.current ||
      pending.current
    )
      return;
    const captured = ++version.current;
    setLoading(true);
    setError('');
    try {
      const next = parseAdvancedVoiceState(
        await NativeAssist!.getAdvancedVoiceState(),
      );
      if (mounted.current && foreground.current && captured === version.current)
        commit(next);
    } catch (e) {
      if (mounted.current && captured === version.current)
        setError(errorMessage(e));
    } finally {
      if (mounted.current && captured === version.current) setLoading(false);
    }
  }, [supported, commit]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const subscription = AppState.addEventListener('change', status => {
      foreground.current = status === 'active';
      if (status === 'active') refresh();
      else {
        invalidate();
        setLoading(false);
      }
    });
    return () => {
      mounted.current = false;
      invalidate();
      subscription.remove();
    };
  }, [refresh, invalidate]);

  const perform = useCallback(
    async (
      kind: Operation,
      action: () => Promise<string>,
      matches?: (next: AdvancedVoiceState) => boolean,
    ) => {
      if (
        !supported ||
        !mounted.current ||
        !foreground.current ||
        pending.current
      )
        return false;
      pending.current = true;
      const captured = ++version.current;
      const activeLifetime = lifetime.current;
      setOperation(kind);
      setLoading(false);
      setError('');
      try {
        const next = parseAdvancedVoiceState(await action());
        if (
          !mounted.current ||
          !foreground.current ||
          captured !== version.current ||
          activeLifetime !== lifetime.current
        )
          return false;
        if (matches && !matches(next))
          throw new Error('Le choix de voix n’a pas été enregistré.');
        if (!commit(next))
          throw new Error('L’état reçu est ancien. Actualise la voix locale.');
        return true;
      } catch (e) {
        if (mounted.current && activeLifetime === lifetime.current)
          setError(errorMessage(e));
        return false;
      } finally {
        pending.current = false;
        if (mounted.current) {
          setOperation(null);
          // A Files provider can interrupt the app lifecycle. Read the committed
          // native result again after returning instead of applying an old ACK.
          if (foreground.current && activeLifetime !== lifetime.current)
            refresh();
        }
      }
    },
    [supported, commit, refresh],
  );

  const importPack = useCallback(
    () => perform('pack', () => NativeAssist!.importAdvancedVoicePack()),
    [perform],
  );
  const setBackend = useCallback(
    (backend: AdvancedVoiceBackend, variant: AdvancedVoiceVariant) =>
      perform(
        'backend',
        () => NativeAssist!.setAdvancedVoiceBackend(backend, variant),
        next =>
          next.selectedBackend === backend && next.selectedVariant === variant,
      ),
    [perform],
  );
  return {
    supported,
    state,
    loading,
    busy: operation !== null,
    operation,
    error,
    refresh,
    importPack,
    setBackend,
  };
}
