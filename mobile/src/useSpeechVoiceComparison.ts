import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { errorMessage } from './protocol';
import {
  blindVoiceOrder,
  parseSpeechVoiceCatalog,
  parseSpeechVoicePreviewResult,
  parseSpeechVoiceStopResult,
} from './speechVoices';
import type { SpeechVoice, SpeechVoiceCatalog } from './speechVoices';

let previewSequence = 0;
const unsupportedMessage =
  'Le comparatif de voix n’est pas disponible dans cette version d’Assist.';
type Preview = {
  id: string;
  cancelled: boolean;
  terminalConfirmed: boolean;
  stopping: Promise<boolean> | null;
};

/** Mounted only for the comparison. Every stop addresses its own preview. */
export function useSpeechVoiceComparison() {
  const supported = !!(
    NativeAssist &&
    typeof NativeAssist.getSpeechVoices === 'function' &&
    typeof NativeAssist.setSpeechVoice === 'function' &&
    typeof NativeAssist.previewSpeechVoice === 'function' &&
    typeof NativeAssist.stopSpeechVoicePreview === 'function'
  );
  const [catalog, setCatalog] = useState<SpeechVoiceCatalog | null>(null);
  const [candidates, setCandidates] = useState<SpeechVoice[]>([]);
  const [loading, setLoading] = useState(supported);
  const [error, setError] = useState(supported ? '' : unsupportedMessage);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(true);
  const foreground = useRef(AppState.currentState === 'active');
  const lifetime = useRef(0);
  const catalogVersion = useRef(0);
  const currentCatalog = useRef<SpeechVoiceCatalog | null>(null);
  const order = useRef<{ inventory: string; ids: string[] } | null>(null);
  const preview = useRef<Preview | null>(null);
  const savingRef = useRef(false);
  const invalidatePending = useCallback(() => {
    ++lifetime.current;
    ++catalogVersion.current;
  }, []);

  const commitCatalog = useCallback((next: SpeechVoiceCatalog) => {
    const inventory = JSON.stringify(next.voices.map(voice => voice.id).sort());
    if (order.current?.inventory !== inventory) {
      order.current = {
        inventory,
        ids: blindVoiceOrder(next.voices).map(voice => voice.id),
      };
    }
    const byId = new Map(next.voices.map(voice => [voice.id, voice]));
    currentCatalog.current = next;
    setCatalog(next);
    setCandidates(order.current.ids.map(id => byId.get(id)!));
  }, []);

  const stopPreview = useCallback((owned: Preview): Promise<boolean> => {
    if (owned.stopping) return owned.stopping;
    owned.cancelled = true;
    const stopped = Promise.resolve()
      .then(() => NativeAssist!.stopSpeechVoicePreview(owned.id))
      .then(json => {
        const result = parseSpeechVoiceStopResult(json);
        // A preview may finish naturally just before its targeted stop arrives.
        if (
          result.sessionId !== owned.id ||
          (!result.stopped && !owned.terminalConfirmed)
        )
          throw new Error('L’arrêt de cet aperçu n’a pas été confirmé.');
        if (preview.current === owned) {
          preview.current = null;
          if (mounted.current) setPlayingId(null);
        }
        return true;
      })
      .catch(e => {
        if (mounted.current && preview.current === owned)
          setError(errorMessage(e));
        return false;
      })
      .finally(() => {
        if (owned.stopping === stopped) owned.stopping = null;
      });
    owned.stopping = stopped;
    return stopped;
  }, []);

  const stop = useCallback(
    (): Promise<boolean> =>
      preview.current ? stopPreview(preview.current) : Promise.resolve(true),
    [stopPreview],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (!supported || !mounted.current || savingRef.current) return;
    if (!foreground.current) {
      setLoading(false);
      return;
    }
    const version = ++catalogVersion.current;
    const activeLifetime = lifetime.current;
    setLoading(true);
    setError('');
    try {
      const next = parseSpeechVoiceCatalog(
        await NativeAssist!.getSpeechVoices(),
      );
      if (
        mounted.current &&
        foreground.current &&
        activeLifetime === lifetime.current &&
        version === catalogVersion.current
      )
        commitCatalog(next);
    } catch (e) {
      if (mounted.current && version === catalogVersion.current)
        setError(errorMessage(e));
    } finally {
      if (mounted.current && version === catalogVersion.current)
        setLoading(false);
    }
  }, [supported, commitCatalog]);

  useEffect(() => {
    mounted.current = true;
    if (!supported)
      return () => {
        mounted.current = false;
      };
    refresh();
    const listener = AppState.addEventListener('change', state => {
      foreground.current = state === 'active';
      if (state !== 'active') {
        invalidatePending();
        setLoading(false);
        if (preview.current) stopPreview(preview.current);
      } else refresh();
    });
    return () => {
      mounted.current = false;
      invalidatePending();
      listener.remove();
      if (preview.current) stopPreview(preview.current);
    };
  }, [supported, refresh, stopPreview, invalidatePending]);

  const play = useCallback(
    async (voiceId: string, segments: string[]): Promise<boolean> => {
      if (
        !supported ||
        !mounted.current ||
        !foreground.current ||
        preview.current ||
        savingRef.current
      )
        return false;
      if (
        !currentCatalog.current?.voices.some(voice => voice.id === voiceId) ||
        !Array.isArray(segments) ||
        !segments.length ||
        segments.some(text => typeof text !== 'string' || !text.trim())
      ) {
        setError('Choisis une voix disponible et un texte à écouter.');
        return false;
      }
      const owned: Preview = {
        id: `voice-preview-${Date.now()}-${++previewSequence}`,
        cancelled: false,
        terminalConfirmed: false,
        stopping: null,
      };
      const activeLifetime = lifetime.current;
      preview.current = owned;
      setPlayingId(voiceId);
      setError('');
      let json: string;
      try {
        json = await NativeAssist!.previewSpeechVoice(
          voiceId,
          JSON.stringify(segments),
          owned.id,
        );
      } catch (e) {
        // Native rejects only after declining playback or stopping its audio.
        owned.terminalConfirmed = true;
        if (preview.current === owned) {
          preview.current = null;
          if (mounted.current) {
            setPlayingId(null);
            if (
              foreground.current &&
              activeLifetime === lifetime.current &&
              !owned.cancelled
            )
              setError(errorMessage(e));
          }
        }
        return false;
      }
      try {
        const result = parseSpeechVoicePreviewResult(json);
        if (result.sessionId !== owned.id)
          throw new Error(
            'La réponse de lecture ne correspond pas à cet aperçu.',
          );
        owned.terminalConfirmed = true;
        const wasCurrent = preview.current === owned;
        if (wasCurrent) {
          preview.current = null;
          if (mounted.current) setPlayingId(null);
        }
        if (
          !mounted.current ||
          !foreground.current ||
          activeLifetime !== lifetime.current ||
          !wasCurrent ||
          owned.cancelled
        )
          return false;
        if (result.outcome === 'cancelled')
          setError('L’aperçu a été interrompu.');
        return result.outcome === 'completed';
      } catch (e) {
        if (mounted.current && preview.current === owned && !owned.cancelled) {
          setError(errorMessage(e));
          await stopPreview(owned);
        }
        return false;
      }
    },
    [supported, stopPreview],
  );

  const chooseVoice = useCallback(
    async (id: string): Promise<boolean> => {
      if (
        !supported ||
        !mounted.current ||
        !foreground.current ||
        savingRef.current
      )
        return false;
      if (
        id &&
        !currentCatalog.current?.voices.some(voice => voice.id === id)
      ) {
        setError('Cette voix n’est plus disponible. Actualise la liste.');
        return false;
      }
      savingRef.current = true;
      ++catalogVersion.current;
      const activeLifetime = lifetime.current;
      setSaving(true);
      setLoading(false);
      setError('');
      try {
        if (!(await stop())) return false;
        if (
          !mounted.current ||
          !foreground.current ||
          activeLifetime !== lifetime.current
        )
          return false;
        const next = parseSpeechVoiceCatalog(
          await NativeAssist!.setSpeechVoice(id),
        );
        if (next.selectedVoiceId !== id)
          throw new Error('Le choix de voix n’a pas été enregistré.');
        if (
          !mounted.current ||
          !foreground.current ||
          activeLifetime !== lifetime.current
        )
          return false;
        commitCatalog(next);
        return true;
      } catch (e) {
        if (mounted.current && activeLifetime === lifetime.current)
          setError(errorMessage(e));
        return false;
      } finally {
        savingRef.current = false;
        if (mounted.current) {
          setSaving(false);
          // The native write may have committed during an inactive interval.
          // Read its authoritative state; never apply the expired ACK or replay audio.
          if (foreground.current && activeLifetime !== lifetime.current) refresh();
        }
      }
    },
    [supported, stop, commitCatalog, refresh],
  );

  return {
    supported,
    catalog,
    candidates,
    loading,
    error,
    playingId,
    saving,
    refresh,
    play,
    stop,
    chooseVoice,
  };
}
