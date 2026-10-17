import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import NativeAssist from '../specs/NativeAssist';
import { errorMessage } from './protocol';
import { parseVoiceEvent, parseVoiceStatus } from './voice';
import type {
  VoiceEvent,
  VoiceInputDiagnostics,
  VoicePhase,
  VoiceStatus,
} from './voice';

/** Commands and text cross the bridge; microphone audio stays in Swift. */
export function useLocalVoice({
  onTranscript,
  onEvent,
  enabled,
}: {
  onTranscript: (text: string) => void;
  onEvent?: (event: VoiceEvent) => void;
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
  const monitoringRef = useRef(false);
  const epoch = useRef(0);
  const statusRevision = useRef(0);
  const current = useRef<
    | { id: string; kind: 'capture'; failed: boolean; hasFinalText: boolean }
    | { id: string; kind: 'speech'; failed: boolean }
    | null
  >(null);
  const lastSpeechCompletion = useRef<{
    id: string;
    epoch: number;
    success: boolean;
  } | null>(null);
  const lastCaptureCompletion = useRef<{
    id: string;
    epoch: number;
    success: boolean;
  } | null>(null);
  const stopping = useRef<Promise<boolean> | null>(null);
  const transcript = useRef(onTranscript);
  const eventListener = useRef(onEvent);
  visible.current = enabled;
  phaseRef.current = phase;
  transcript.current = onTranscript;
  eventListener.current = onEvent;

  const publishPhase = useCallback(
    (next: VoicePhase | 'stopping', monitoring = false) => {
      ++statusRevision.current;
      phaseRef.current = next;
      monitoringRef.current = next === 'speaking' && monitoring;
      setPhase(next);
      setStatus(previous =>
        previous
          ? {
              ...previous,
              phase: next === 'stopping' ? 'idle' : next,
              monitoring: next === 'speaking' && monitoring,
            }
          : previous,
      );
    },
    [],
  );

  const acceptStatus = useCallback(
    (next: VoiceStatus, revision: number): boolean => {
      const latest =
        revision === statusRevision.current ||
        // Permission callbacks can emit "requesting" while the original start
        // command is pending. Its successful ACK still advances that capture.
        (phaseRef.current === 'requesting' && next.phase === 'listening');
      // Events describe a newer runtime state than a previously issued bridge
      // command. Its ACK may update capabilities, but cannot re-arm monitoring.
      setStatus(
        latest
          ? next
          : {
              ...next,
              phase:
                phaseRef.current === 'stopping' ? 'idle' : phaseRef.current,
              monitoring: monitoringRef.current,
            },
      );
      if (latest) publishPhase(next.phase, next.monitoring === true);
      return latest;
    },
    [publishPhase],
  );

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
    lastSpeechCompletion.current = null;
    lastCaptureCompletion.current = null;
    if (!supported) return Promise.resolve(true);
    if (stopping.current) return stopping.current;
    if (mounted.current) publishPhase('stopping');
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
          publishPhase('idle');
        }
      });
    stopping.current = pending;
    return pending;
  }, [supported, publishPhase]);

  useEffect(() => {
    mounted.current = true;
    if (!supported) return;
    let live = true;
    const refresh = () => {
      const version = epoch.current;
      const revision = statusRevision.current;
      NativeAssist!
        .getVoiceStatus()
        .then(json => {
          if (!live) return;
          const next = parseVoiceStatus(json);
          const latest =
            version === epoch.current && revision === statusRevision.current;
          // Capability inspection can outlive the initial hidden-screen stop.
          // Keep its capabilities, but never restore obsolete runtime state.
          setStatus(
            latest
              ? next
              : {
                  ...next,
                  phase:
                    phaseRef.current === 'stopping' ? 'idle' : phaseRef.current,
                  monitoring: monitoringRef.current,
                  diagnostics: undefined,
                },
          );
          if (latest && !current.current) {
            rememberDiagnostics(next.diagnostics);
          }
        })
        .catch(e => {
          if (
            live &&
            version === epoch.current &&
            revision === statusRevision.current
          )
            setError(errorMessage(e));
        });
    };
    refresh(); // Capability inspection never requests microphone permissions.
    const subscription = NativeAssist!.onVoiceEvent(event => {
      if (!live || !visible.current || !foreground.current) return;
      const session = current.current;
      if (!session) return;
      const version = epoch.current;
      try {
        const payload: unknown = JSON.parse(event.json);
        if (
          !payload ||
          typeof payload !== 'object' ||
          (payload as { sessionId?: unknown }).sessionId !== session.id
        )
          return;
        const update = parseVoiceEvent(event.json);
        if (update.kind === 'interruption') {
          if (session.kind !== 'speech' || session.failed || stopping.current)
            return;
          // Native has already stopped playback and promoted the running ASR.
          // Adopt it before notifying the controller: its first words may be
          // queued immediately behind this event. Never cancel/restart audio.
          ++epoch.current;
          lastSpeechCompletion.current = null;
          lastCaptureCompletion.current = null;
          current.current = {
            id: update.captureSessionId,
            kind: 'capture',
            failed: false,
            hasFinalText: false,
          };
          setError('');
          setDiagnostics(null);
          publishPhase('listening');
          eventListener.current?.(update);
          return;
        }
        // Watcher energy is not a user turn until native promotes recognition.
        if (session.kind === 'speech' && update.kind === 'input') return;
        if (session.kind === 'capture') rememberDiagnostics(update.diagnostics);
        // A queued input observation cannot reopen a capture that is finishing.
        if (update.kind !== 'input') {
          if (update.kind === 'transcript' && session.kind === 'capture') {
            if (update.isFinal) session.hasFinalText = !!update.text!.trim();
            transcript.current(update.text!);
            if (version !== epoch.current) return;
          }
          if (update.kind === 'error') {
            session.failed = true;
            setError(update.message!);
          }
          publishPhase(
            update.phase,
            session.kind === 'speech' &&
              update.kind === 'state' &&
              update.monitoring === true,
          );
          if (update.phase === 'idle') {
            if (session.kind === 'speech') {
              lastSpeechCompletion.current = {
                id: session.id,
                epoch: version,
                success: !session.failed,
              };
            } else {
              lastCaptureCompletion.current = {
                id: session.id,
                epoch: version,
                success: !session.failed && session.hasFinalText,
              };
            }
            current.current = null;
            refresh();
          }
        }
        // The event was accepted for this session before an idle event clears
        // it. A callback-triggered cancellation still invalidates delivery.
        if (
          live &&
          mounted.current &&
          visible.current &&
          foreground.current &&
          version === epoch.current
        ) {
          eventListener.current?.(update);
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
  }, [supported, cancel, rememberDiagnostics, publishPhase]);

  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled, cancel]);

  const captureCompleted = useCallback(
    (id: string, version: number): boolean => {
      const completed = lastCaptureCompletion.current;
      return !!(
        completed?.id === id &&
        completed.epoch === version &&
        completed.success
      );
    },
    [],
  );

  const startListening = useCallback(async (): Promise<boolean> => {
    if (
      !supported ||
      !mounted.current ||
      !visible.current ||
      !foreground.current ||
      stopping.current ||
      current.current
    )
      return false;
    const version = ++epoch.current;
    lastSpeechCompletion.current = null;
    lastCaptureCompletion.current = null;
    const id = `capture-${Date.now()}-${version}`;
    current.current = {
      id,
      kind: 'capture',
      failed: false,
      hasFinalText: false,
    };
    setError('');
    setDiagnostics(null);
    publishPhase('requesting');
    const revision = statusRevision.current;
    try {
      const next = parseVoiceStatus(await NativeAssist!.startListening(id));
      if (!mounted.current || !visible.current || version !== epoch.current)
        return false;
      if (current.current?.kind !== 'capture' || current.current.id !== id) {
        // Retained native ASR may deliver a complete utterance before its start
        // ACK. Accept only its nonempty, error-free natural completion; never
        // restore the ACK's obsolete "listening" phase.
        return captureCompleted(id, version);
      }
      if (current.current.failed) return false;
      const latest = acceptStatus(next, revision);
      rememberDiagnostics(next.diagnostics);
      if (
        phaseRef.current !== 'listening' &&
        phaseRef.current !== 'requesting'
      ) {
        if (latest) current.current = null;
        return false;
      }
      return true;
    } catch (e) {
      if (mounted.current && version === epoch.current) {
        current.current = null;
        publishPhase('idle');
        setError(errorMessage(e));
      }
      return false;
    }
  }, [
    supported,
    rememberDiagnostics,
    publishPhase,
    acceptStatus,
    captureCompleted,
  ]);

  const finishListening = useCallback(async (): Promise<boolean> => {
    if (
      !supported ||
      !mounted.current ||
      current.current?.kind !== 'capture' ||
      stopping.current
    )
      return false;
    const version = epoch.current;
    const id = current.current.id;
    publishPhase('finishing');
    const revision = statusRevision.current;
    try {
      const next = parseVoiceStatus(await NativeAssist!.stopListening());
      if (!mounted.current || version !== epoch.current) return false;
      // A final transcript and its idle event can beat the command ACK. That
      // still means stop succeeded; do not revive the released capture with a
      // late "finishing" status or treat its natural completion as cancellation.
      if (current.current?.kind === 'capture' && current.current.id === id) {
        acceptStatus(next, revision);
        rememberDiagnostics(next.diagnostics);
      }
      return true;
    } catch (e) {
      if (mounted.current && version === epoch.current) {
        setError(errorMessage(e));
        await cancel();
      }
      return false;
    }
  }, [supported, cancel, rememberDiagnostics, publishPhase, acceptStatus]);

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
      lastSpeechCompletion.current = null;
      lastCaptureCompletion.current = null;
      current.current = { id: utteranceId, kind: 'speech', failed: false };
      setError('');
      setDiagnostics(null);
      publishPhase('speaking');
      const revision = statusRevision.current;
      try {
        const next = parseVoiceStatus(
          await NativeAssist!.speak(text, utteranceId),
        );
        if (!mounted.current || version !== epoch.current || !current.current)
          return;
        acceptStatus(next, revision);
      } catch (e) {
        if (mounted.current && version === epoch.current) {
          current.current = null;
          publishPhase('idle');
          setError(errorMessage(e));
        }
      }
    },
    [supported, publishPhase, acceptStatus],
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
      lastSpeechCompletion.current = null;
      lastCaptureCompletion.current = null;
      current.current = { id: utteranceId, kind: 'speech', failed: false };
      setError('');
      setDiagnostics(null);
      publishPhase('speaking');
      const revision = statusRevision.current;
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
        if (acceptStatus(next, revision) && next.phase === 'idle')
          current.current = null;
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
    [streamingSupported, cancel, publishPhase, acceptStatus],
  );

  const continueSpeech = useCallback(
    async (
      utteranceId: string,
      command: () => Promise<string>,
      permitCompleted = false,
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
      const revision = statusRevision.current;
      try {
        const next = parseVoiceStatus(await command());
        if (
          !mounted.current ||
          !visible.current ||
          !foreground.current ||
          version !== epoch.current
        )
          return false;
        if (
          current.current?.kind !== 'speech' ||
          current.current.id !== utteranceId
        ) {
          // Native idle can precede finishSpeech's bridge ACK. Only that final
          // command may accept a known natural completion; never resurrect its
          // stale "speaking" status or accept an error/cancelled generation.
          const completed = lastSpeechCompletion.current;
          return !!(
            permitCompleted &&
            completed?.id === utteranceId &&
            completed.epoch === version &&
            completed.success
          );
        }
        if (current.current.failed) return false;
        if (acceptStatus(next, revision) && next.phase === 'idle')
          current.current = null;
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
    [streamingSupported, cancel, acceptStatus],
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
      continueSpeech(
        utteranceId,
        () => NativeAssist!.finishSpeech(utteranceId),
        true,
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
