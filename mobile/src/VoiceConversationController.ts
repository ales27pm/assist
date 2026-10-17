import type { VoiceEvent, VoiceInputDiagnostics } from './voice';
import { VoiceTurnPolicy } from './voiceTurnPolicy';

export type ConversationVoicePhase =
  | 'starting'
  | 'listening'
  | 'finishing'
  | 'thinking'
  | 'speaking'
  | 'stopping'
  | 'paused'
  | 'error';

export type ConversationVoiceState = {
  phase: ConversationVoicePhase;
  transcript: string;
  reply: string;
  replyInterrupted?: boolean;
  error: string;
  diagnostics: VoiceInputDiagnostics | null;
};

type Commands = {
  startCapture: (isCurrent: () => boolean) => Promise<boolean>;
  finishCapture: () => Promise<void>;
  cancel: () => Promise<void>;
  /** Detach old speech scheduling and cancel only the model; capture is native-owned. */
  cancelResponse: () => Promise<void>;
  generate: (
    text: string,
    isCurrent: () => boolean,
  ) => Promise<{ text: string; spoken: boolean }>;
  changed: (state: ConversationVoiceState) => void;
  now?: () => number;
};

/** One foreground voice session. Final STT and drained TTS are separate gates. */
export class VoiceConversationController {
  private state: ConversationVoiceState = {
    phase: 'paused',
    transcript: '',
    reply: '',
    error: '',
    diagnostics: null,
  };
  private active = false;
  private version = 0;
  private policy = new VoiceTurnPolicy();
  private captureId: string | null = null;
  private finalText: string | null = null;
  private captureIdle = false;
  private finishRequested = false;
  private finishAcknowledged = false;
  private generating: Promise<void> | null = null;
  private cancelling: Promise<void> | null = null;
  private responseCancellation: Promise<void> | null = null;
  private generationDone = false;
  private speechStarted = false;
  private speechDrained = false;
  private speechId: string | null = null;
  private restarting = false;
  private retiredSessions = new Set<string>();

  constructor(private readonly commands: Commands) {}

  snapshot(): ConversationVoiceState {
    return this.state;
  }
  isActive(): boolean {
    return this.active;
  }
  private now(): number {
    const runtime = globalThis as typeof globalThis & {
      performance?: { now: () => number };
    };
    return this.commands.now?.() ?? runtime.performance?.now() ?? Date.now();
  }
  private current(version: number): boolean {
    return this.active && version === this.version;
  }
  private update(next: Partial<ConversationVoiceState>): void {
    this.state = { ...this.state, ...next };
    this.commands.changed(this.state);
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    const version = ++this.version;
    this.update({ phase: 'starting', error: '' });
    try {
      await this.cancelWork();
      if (this.current(version)) await this.listen(version);
    } catch {
      if (this.current(version))
        this.fail(
          'La voix n’a pas pu être arrêtée. Ferme le mode vocal puis réessaie.',
        );
    }
  }

  async pause(): Promise<void> {
    if (!this.active && this.state.phase === 'paused' && !this.generating && !this.cancelling) return;
    this.active = false;
    const version = ++this.version;
    this.retireSessions();
    this.update({ phase: 'stopping', replyInterrupted: this.state.replyInterrupted || ['thinking', 'speaking'].includes(this.state.phase) });
    try {
      await this.cancelWork();
      if (this.version === version) this.update({ phase: 'paused' });
    } catch {
      if (this.version === version)
        this.update({
          phase: 'error',
          error:
            'L’arrêt de la voix n’a pas été confirmé. Ferme le mode vocal puis réessaie.',
        });
    }
  }

  async interrupt(): Promise<void> {
    if (!this.active) return;
    const version = ++this.version;
    this.retireSessions();
    this.update({ phase: 'stopping', error: '', replyInterrupted: true });
    try {
      await this.cancelWork();
      if (this.current(version)) await this.listen(version);
    } catch {
      if (this.current(version))
        this.fail('L’interruption de la voix n’a pas été confirmée.');
    }
  }

  private async cancelWork(): Promise<void> {
    const pending = this.generating;
    const responseCancellation = this.responseCancellation;
    await this.cancelCommand();
    if (pending) await pending;
    if (responseCancellation) await responseCancellation;
  }

  private cancelCommand(): Promise<void> {
    if (this.cancelling) return this.cancelling;
    const pending = Promise.resolve()
      .then(() => this.commands.cancel())
      .finally(() => {
        if (this.cancelling === pending) this.cancelling = null;
      });
    this.cancelling = pending;
    return pending;
  }

  private async listen(version: number): Promise<void> {
    if (!this.current(version)) return;
    this.retireSessions();
    this.captureId = null;
    this.finalText = null;
    this.captureIdle = false;
    this.finishRequested = false;
    this.finishAcknowledged = false;
    this.generationDone = false;
    this.speechStarted = false;
    this.speechDrained = false;
    this.speechId = null;
    this.restarting = false;
    this.policy.reset(this.now());
    this.update({
      phase: 'starting',
      transcript: '',
      error: '',
      diagnostics: null,
    });
    try {
      const accepted = await this.commands.startCapture(() =>
        this.current(version),
      );
      if (!this.current(version)) return;
      if (!accepted && ['starting', 'listening'].includes(this.state.phase)) {
        this.fail(
          'Le micro n’a pas pu démarrer. Vérifie ses autorisations, puis reprends.',
        );
      } else if (this.state.phase === 'starting') {
        this.policy.reset(this.now());
        this.update({ phase: 'listening' });
      }
    } catch (error) {
      if (this.current(version))
        this.fail(
          error instanceof Error
            ? error.message
            : 'Le micro est indisponible. Tu peux reprendre le mode vocal.',
        );
    }
  }

  event(event: VoiceEvent): void {
    if (!this.active || this.retiredSessions.has(event.sessionId)) return;
    if (event.kind === 'interruption') {
      this.adoptInterruption(event);
      return;
    }
    if (['starting', 'listening', 'finishing'].includes(this.state.phase)) {
      if (this.captureId && event.sessionId !== this.captureId) return;
      this.captureId ??= event.sessionId;
      if (event.kind === 'error') {
        this.fail(event.message!);
        return;
      }
      // Reset before the first partial, including a retained native capture.
      if (event.phase === 'listening' && this.state.phase === 'starting') {
        this.policy.reset(this.now());
        this.update({ phase: 'listening' });
      }
      if (event.diagnostics) {
        this.policy.input(event.diagnostics, this.now());
        this.update({ diagnostics: event.diagnostics });
      }
      if (event.kind === 'transcript') {
        this.policy.transcript(event.text!, this.now());
        this.update({ transcript: event.text! });
        if (event.isFinal) this.finalText = event.text!;
      }
      if (event.phase === 'idle') this.captureIdle = true;
      this.maybeGenerate();
      return;
    }
    if (!['thinking', 'speaking'].includes(this.state.phase)) return;
    if (event.sessionId === this.captureId) return;
    if (this.speechId && event.sessionId !== this.speechId) return;
    if (event.kind === 'error') {
      this.fail(event.message!);
      return;
    }
    if (event.phase === 'speaking') {
      this.speechId = event.sessionId;
      this.speechStarted = true;
      this.speechDrained = false;
      this.update({ phase: 'speaking' });
    } else if (event.phase === 'idle' && this.speechStarted) {
      this.speechDrained = true;
      this.maybeListenAgain();
    }
  }

  private adoptInterruption(event: Extract<VoiceEvent, { kind: 'interruption' }>): void {
    if (
      !['thinking', 'speaking'].includes(this.state.phase) ||
      !this.speechId || event.sessionId !== this.speechId ||
      this.retiredSessions.has(event.captureSessionId)
    ) return;
    const version = ++this.version;
    this.retireSessions();
    this.captureId = event.captureSessionId;
    this.finalText = null;
    this.captureIdle = false;
    this.finishRequested = false;
    this.finishAcknowledged = false;
    this.generationDone = false;
    this.speechStarted = false;
    this.speechDrained = false;
    this.speechId = null;
    this.restarting = false;
    this.policy.reset(this.now());
    // Block a synchronous final while cancelResponse invalidates JS scheduling.
    this.responseCancellation = Promise.resolve();
    this.update({ phase: 'listening', transcript: '', diagnostics: null, error: '', replyInterrupted: true });
    let cancellation: Promise<void>;
    try {
      // Its synchronous prefix must retire the old stream before another event.
      cancellation = this.commands.cancelResponse();
    } catch (error) {
      cancellation = Promise.reject(error);
    }
    const work = Promise.resolve(cancellation)
      .catch(() => {
        if (this.current(version))
          this.fail('L’ancienne réponse n’a pas pu être arrêtée. Reprends pour réessayer.');
      })
      .finally(() => {
        if (this.responseCancellation === work) this.responseCancellation = null;
        if (this.active) this.maybeGenerate();
      });
    this.responseCancellation = work;
  }

  progress(text: string): void {
    if (this.active && ['thinking', 'speaking'].includes(this.state.phase)) {
      this.update({ reply: text });
    }
  }

  expectSpeech(sessionId: string): void {
    if (this.active && this.state.phase === 'thinking')
      this.speechId = sessionId;
  }

  private retireSessions(): void {
    if (this.captureId) this.retiredSessions.add(this.captureId);
    if (this.speechId) this.retiredSessions.add(this.speechId);
    while (this.retiredSessions.size > 128) {
      this.retiredSessions.delete(this.retiredSessions.values().next().value!);
    }
  }

  tick(): void {
    if (
      !this.active ||
      this.state.phase !== 'listening' ||
      this.finishRequested
    )
      return;
    const decision = this.policy.decision(this.now());
    if (decision === 'no-speech') {
      this.fail('Je n’ai pas entendu de parole. Reprends quand tu es prêt.');
    } else if (decision === 'finish') {
      this.finishRequested = true;
      const version = this.version;
      this.update({ phase: 'finishing' });
      this.commands
        .finishCapture()
        .then(() => {
          if (!this.current(version)) return;
          this.finishAcknowledged = true;
          this.maybeGenerate();
        })
        .catch(() => {
          if (this.current(version))
            this.fail(
              'La transcription n’a pas pu se terminer. Reprends pour réessayer.',
            );
        });
    }
  }

  private maybeGenerate(): void {
    if (
      !this.active ||
      !['starting', 'listening', 'finishing'].includes(this.state.phase) ||
      !this.captureIdle ||
      this.finalText === null ||
      (this.finishRequested && !this.finishAcknowledged) ||
      this.generating || this.responseCancellation
    )
      return;
    const text = this.finalText.trim();
    if (!text) {
      this.fail('Aucune parole n’a été reconnue. Reprends pour réessayer.');
      return;
    }
    const version = this.version;
    this.update({ phase: 'thinking', reply: '', error: '', replyInterrupted: false });
    // Defer so synchronous native events cannot race the work ownership token.
    const work = Promise.resolve().then(async () => {
      try {
        if (!this.current(version)) return;
        const result = await this.commands.generate(text, () =>
          this.current(version),
        );
        if (!this.current(version)) return;
        this.generationDone = true;
        this.update({ reply: result.text });
        if (!result.spoken) this.speechDrained = true;
        // A successful spoken result guarantees native speech was scheduled.
        if (result.spoken && !this.speechStarted)
          this.update({ phase: 'speaking' });
      } catch (error) {
        if (this.current(version))
          this.fail(
            error instanceof Error
              ? error.message
              : 'La réponse locale a échoué.',
          );
      } finally {
        if (this.generating === work) this.generating = null;
      }
    });
    this.generating = work;
    work.then(() => {
      if (this.active) {
        // A promoted capture may finish while the old model is still settling.
        this.maybeGenerate();
        this.maybeListenAgain();
      }
    });
  }

  private maybeListenAgain(): void {
    if (
      !this.active ||
      !this.generationDone ||
      !this.speechDrained ||
      this.generating ||
      this.restarting
    )
      return;
    this.restarting = true;
    this.listen(this.version);
  }

  private fail(message: string): void {
    this.active = false;
    ++this.version;
    this.update({ phase: 'error', error: message });
    // Never await our own generating promise from its rejection handler.
    this.cancelCommand().catch(() => undefined);
  }
}
