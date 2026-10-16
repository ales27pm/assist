import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { errorMessage } from './protocol';
import { parseVoiceEvent, parseVoiceStatus } from './voice';
import type { VoicePhase, VoiceStatus } from './voice';

/** Commands and text cross the bridge; microphone audio stays in Swift. */
export function useLocalVoice({
  onTranscript,
  enabled,
}: {
  onTranscript: (text: string) => void;
  enabled: boolean;
}) {
  const supported = !!(
    NativeAssist &&
    typeof NativeAssist.getVoiceStatus === 'function' &&
    typeof NativeAssist.startListening === 'function' &&
    typeof NativeAssist.stopListening === 'function' &&
    typeof NativeAssist.cancelVoice === 'function' &&
    typeof NativeAssist.speak === 'function' &&
    typeof NativeAssist.onVoiceEvent === 'function'
  );
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [phase, setPhase] = useState<VoicePhase | 'stopping'>('idle');
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const visible = useRef(enabled);
  const foreground = useRef(AppState.currentState === 'active');
  const phaseRef = useRef(phase);
  const epoch = useRef(0);
  const current = useRef<{ id: string; kind: 'capture' | 'speech' } | null>(
    null,
  );
  const stopping = useRef<Promise<boolean> | null>(null);
  const transcript = useRef(onTranscript);
  visible.current = enabled;
  phaseRef.current = phase;
  transcript.current = onTranscript;

  const cancel = useCallback((): Promise<boolean> => {
    // Invalidate before crossing the bridge, including pending permission requests.
    const version = ++epoch.current;
    current.current = null;
    if (!supported) return Promise.resolve(true);
    if (stopping.current) return stopping.current;
    if (mounted.current) setPhase('stopping');
    const pending = NativeAssist!
      .cancelVoice()
      .then(() => true)
      .catch(e => {
        if (mounted.current) setError(errorMessage(e));
        return false;
      })
      .finally(() => {
        stopping.current = null;
        // A second cancel can invalidate the first; both still stop the same audio.
        if (mounted.current && !current.current && epoch.current >= version) {
          setPhase('idle');
        }
      });
    stopping.current = pending;
    return pending;
  }, [supported]);

  useEffect(() => {
    mounted.current = true;
    if (!supported) return;
    let live = true;
    const refresh = () => {
      NativeAssist!
        .getVoiceStatus()
        .then(json => {
          if (live) setStatus(parseVoiceStatus(json));
        })
        .catch(e => {
          if (live) setError(errorMessage(e));
        });
    };
    refresh(); // Capability inspection never requests microphone permissions.
    const subscription = NativeAssist!.onVoiceEvent(event => {
      if (!live || !visible.current || !foreground.current) return;
      try {
        const update = parseVoiceEvent(event.json);
        const session = current.current;
        if (!session || session.id !== update.sessionId) return;
        if (update.kind === 'transcript' && session.kind === 'capture') {
          transcript.current(update.text!);
        }
        if (update.kind === 'error') setError(update.message!);
        setPhase(update.phase);
        if (update.phase === 'idle') {
          current.current = null;
          refresh();
        }
      } catch (e) {
        setError(errorMessage(e));
      }
    });
    const lifecycle = AppState.addEventListener('change', next => {
      foreground.current = next === 'active';
      // Privacy prompts temporarily make iOS inactive. Native waits for active
      // before opening the mic; a real background always cancels the request.
      if (
        next === 'background' ||
        (next !== 'active' && phaseRef.current !== 'requesting')
      ) {
        cancel();
      } else if (next === 'active') {
        refresh();
      }
    });
    return () => {
      live = false;
      mounted.current = false;
      subscription.remove();
      lifecycle.remove();
      cancel();
    };
  }, [supported, cancel]);

  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled, cancel]);

  const startListening = useCallback(async () => {
    if (
      !supported ||
      !visible.current ||
      !foreground.current ||
      stopping.current ||
      current.current
    )
      return;
    const version = ++epoch.current;
    const id = `capture-${Date.now()}-${version}`;
    current.current = { id, kind: 'capture' };
    setError('');
    phaseRef.current = 'requesting';
    setPhase('requesting');
    try {
      const next = parseVoiceStatus(await NativeAssist!.startListening(id));
      if (!mounted.current || version !== epoch.current || !current.current)
        return;
      setStatus(next);
      setPhase(next.phase);
    } catch (e) {
      if (mounted.current && version === epoch.current) {
        current.current = null;
        setPhase('idle');
        setError(errorMessage(e));
      }
    }
  }, [supported]);

  const finishListening = useCallback(async () => {
    if (!supported || current.current?.kind !== 'capture' || stopping.current)
      return;
    const version = epoch.current;
    setPhase('finishing');
    try {
      const next = parseVoiceStatus(await NativeAssist!.stopListening());
      if (!mounted.current || version !== epoch.current || !current.current)
        return;
      setStatus(next);
      setPhase(next.phase);
    } catch (e) {
      if (mounted.current && version === epoch.current) {
        setError(errorMessage(e));
        await cancel();
      }
    }
  }, [supported, cancel]);

  const speak = useCallback(
    async (text: string, utteranceId: string) => {
      if (
        !supported ||
        !text.trim() ||
        !utteranceId ||
        !visible.current ||
        !foreground.current ||
        stopping.current ||
        current.current
      )
        return;
      const version = ++epoch.current;
      current.current = { id: utteranceId, kind: 'speech' };
      setError('');
      setPhase('speaking');
      try {
        const next = parseVoiceStatus(
          await NativeAssist!.speak(text, utteranceId),
        );
        if (!mounted.current || version !== epoch.current || !current.current)
          return;
        setStatus(next);
        setPhase(next.phase);
      } catch (e) {
        if (mounted.current && version === epoch.current) {
          current.current = null;
          setPhase('idle');
          setError(errorMessage(e));
        }
      }
    },
    [supported],
  );

  return {
    supported,
    status,
    phase,
    error,
    startListening,
    finishListening,
    cancel,
    speak,
    captureBusy: ['requesting', 'listening', 'finishing', 'stopping'].includes(
      phase,
    ),
  };
}
