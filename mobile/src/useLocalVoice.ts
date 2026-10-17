import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { errorMessage } from './protocol';
import { parseVoiceEvent, parseVoiceStatus } from './voice';
import type { VoiceInputDiagnostics, VoicePhase, VoiceStatus } from './voice';

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
  const streamingSupported = !!(
    supported &&
    typeof NativeAssist?.beginSpeech === 'function' &&
    typeof NativeAssist?.enqueueSpeech === 'function' &&
    typeof NativeAssist?.finishSpeech === 'function'
  );
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [phase, setPhase] = useState<VoicePhase | 'stopping'>('idle');
  const [error, setError] = useState('');
  const [diagnostics, setDiagnostics] = useState<VoiceInputDiagnostics | null>(
    null,
  );
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

  const rememberDiagnostics = useCallback((next?: VoiceInputDiagnostics) => {
    if (!next) return;
    setDiagnostics(previous => {
      // A command response can arrive after a newer metering event.
      if (
        previous &&
        (next.elapsedMs < previous.elapsedMs ||
          next.bufferCount < previous.bufferCount ||
          next.frameCount < previous.frameCount)
      ) {
        return previous;
      }
      return next;
    });
  }, []);

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
      const version = epoch.current;
      NativeAssist!
        .getVoiceStatus()
        .then(json => {
          if (!live) return;
          const next = parseVoiceStatus(json);
          setStatus(next);
          if (version === epoch.current && !current.current) {
            rememberDiagnostics(next.diagnostics);
          }
        })
        .catch(e => {
          if (live) setError(errorMessage(e));
        });
    };
    refresh(); // Capability inspection never requests microphone permissions.
    const subscription = NativeAssist!.onVoiceEvent(event => {
      if (!live || !visible.current || !foreground.current) return;
      const session = current.current;
      if (!session) return;
      try {
        const payload: unknown = JSON.parse(event.json);
        if (
          !payload ||
          typeof payload !== 'object' ||
          (payload as { sessionId?: unknown }).sessionId !== session.id
        )
          return;
        const update = parseVoiceEvent(event.json);
        if (session.kind === 'capture') rememberDiagnostics(update.diagnostics);
        // A queued input observation cannot reopen a capture that is finishing.
        if (update.kind === 'input') return;
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
  }, [supported, cancel, rememberDiagnostics]);

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
    setDiagnostics(null);
    phaseRef.current = 'requesting';
    setPhase('requesting');
    try {
      const next = parseVoiceStatus(await NativeAssist!.startListening(id));
      if (!mounted.current || version !== epoch.current || !current.current)
        return;
      setStatus(next);
      rememberDiagnostics(next.diagnostics);
      setPhase(next.phase);
    } catch (e) {
      if (mounted.current && version === epoch.current) {
        current.current = null;
        setPhase('idle');
        setError(errorMessage(e));
      }
    }
  }, [supported, rememberDiagnostics]);

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
      rememberDiagnostics(next.diagnostics);
      setPhase(next.phase);
    } catch (e) {
      if (mounted.current && version === epoch.current) {
        setError(errorMessage(e));
        await cancel();
      }
    }
  }, [supported, cancel, rememberDiagnostics]);

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
      setDiagnostics(null);
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

  const beginSpeech = useCallback(
    async (utteranceId: string): Promise<boolean> => {
      if (
        !streamingSupported ||
        !utteranceId ||
        !visible.current ||
        !foreground.current ||
        stopping.current ||
        current.current
      )
        return false;
      const version = ++epoch.current;
      current.current = { id: utteranceId, kind: 'speech' };
      setError('');
      setDiagnostics(null);
      phaseRef.current = 'speaking';
      setPhase('speaking');
      try {
        const next = parseVoiceStatus(
          await NativeAssist!.beginSpeech(utteranceId),
        );
        if (
          !mounted.current ||
          version !== epoch.current ||
          current.current?.kind !== 'speech' ||
          current.current.id !== utteranceId
        )
          return false;
        setStatus(next);
        setPhase(next.phase);
        if (next.phase === 'idle') current.current = null;
        return true;
      } catch (e) {
        if (
          mounted.current &&
          version === epoch.current &&
          current.current?.kind === 'speech' &&
          current.current.id === utteranceId
        ) {
          setError(errorMessage(e));
          await cancel();
        }
        return false;
      }
    },
    [streamingSupported, cancel],
  );

  const continueSpeech = useCallback(
    async (
      utteranceId: string,
      command: () => Promise<string>,
    ): Promise<boolean> => {
      if (
        !streamingSupported ||
        !visible.current ||
        !foreground.current ||
        stopping.current ||
        current.current?.kind !== 'speech' ||
        current.current.id !== utteranceId
      )
        return false;
      const version = epoch.current;
      try {
        const next = parseVoiceStatus(await command());
        if (
          !mounted.current ||
          version !== epoch.current ||
          current.current?.kind !== 'speech' ||
          current.current.id !== utteranceId
        )
          return false;
        setStatus(next);
        setPhase(next.phase);
        if (next.phase === 'idle') current.current = null;
        return true;
      } catch (e) {
        // A late failed promise must never stop a newer capture or response.
        if (
          mounted.current &&
          version === epoch.current &&
          current.current?.kind === 'speech' &&
          current.current.id === utteranceId
        ) {
          setError(errorMessage(e));
          await cancel();
        }
        return false;
      }
    },
    [streamingSupported, cancel],
  );

  const enqueueSpeech = useCallback(
    async (text: string, utteranceId: string) => {
      if (!text.trim()) return false;
      return continueSpeech(utteranceId, () =>
        NativeAssist!.enqueueSpeech(text, utteranceId),
      );
    },
    [continueSpeech],
  );

  const finishSpeech = useCallback(
    (utteranceId: string) =>
      continueSpeech(utteranceId, () =>
        NativeAssist!.finishSpeech(utteranceId),
      ),
    [continueSpeech],
  );

  return {
    supported,
    streamingSupported,
    status,
    phase,
    error,
    diagnostics,
    startListening,
    finishListening,
    cancel,
    speak,
    beginSpeech,
    enqueueSpeech,
    finishSpeech,
    captureBusy: ['requesting', 'listening', 'finishing', 'stopping'].includes(
      phase,
    ),
  };
}
