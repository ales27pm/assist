export type ResponseSpeechStreamOptions = {
  begin: () => Promise<boolean>;
  enqueue: (chunk: string) => Promise<boolean>;
  finish: () => Promise<boolean>;
  onError?: (error: Error) => void;
};

const MAX_CHUNK_LENGTH = 180;

/** Return a raw-text boundary; preserve its whitespace for prefix validation. */
function nextBoundary(text: string): number | null {
  const punctuation = /[.!?]+(?=\s)/.exec(text.slice(0, MAX_CHUNK_LENGTH + 1));
  const sentenceEnd = punctuation
    ? punctuation.index + punctuation[0].length
    : null;
  let end: number;
  if (sentenceEnd !== null && sentenceEnd <= MAX_CHUNK_LENGTH) {
    end = sentenceEnd;
  } else if (text.length >= MAX_CHUNK_LENGTH) {
    end = 0;
    for (let index = 1; index <= MAX_CHUNK_LENGTH && index < text.length; index++) {
      if (/\s/.test(text[index])) end = index;
    }
    // A single unbroken token must not hold the entire answer in memory/audio.
    if (!end) {
      end = MAX_CHUNK_LENGTH;
      const before = text.charCodeAt(end - 1);
      const after = text.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
        end -= 1;
      }
    }
  } else {
    return null;
  }
  while (end < text.length && /\s/.test(text[end])) end += 1;
  return end;
}

/**
 * One response's cumulative text -> ordered native scheduling commands.
 * A queued prefix is already irreversible: never replay it after text changes.
 * The native caller owns stopping audio/commands that have already started.
 */
export class ResponseSpeechStream {
  private active = true;
  private closed = false;
  private consumed = '';
  private sent = 0;
  private begun = false;
  private commands: Promise<void> | null = null;
  private finished: Promise<void> | null = null;

  constructor(private readonly options: ResponseSpeechStreamOptions) {
    // Defer even begin, so cancel() in the construction turn prevents it.
    this.scheduleDrain();
  }

  push(cumulativeText: string): void {
    if (!this.active || this.closed) return;
    if (!cumulativeText.startsWith(this.consumed)) {
      this.fail(new Error('Le texte déjà prévu pour la lecture a changé.'));
      return;
    }
    let remaining = cumulativeText.slice(this.consumed.length);
    let consumedEnd = this.consumed.length;
    let boundary = nextBoundary(remaining);
    while (boundary !== null) {
      consumedEnd += boundary;
      remaining = remaining.slice(boundary);
      boundary = nextBoundary(remaining);
    }
    // Keep one validated text prefix rather than queued closures and promises
    // for every phrase while native startup or a previous enqueue is pending.
    if (consumedEnd > this.consumed.length) {
      this.consumed = cumulativeText.slice(0, consumedEnd);
    }
    if (this.sent < this.consumed.length) this.scheduleDrain();
  }

  finish(cumulativeText: string): Promise<void> {
    if (this.finished) return this.finished;
    if (!this.closed && this.active) {
      this.push(cumulativeText);
      this.closed = true;
      if (this.active) {
        this.consumed = cumulativeText;
        this.scheduleDrain();
      }
    }
    // This drains scheduling promises, never waits for audio playback to end.
    this.finished = this.commands ?? Promise.resolve();
    return this.finished;
  }

  cancel(): void {
    this.active = false;
    this.closed = true;
    this.consumed = '';
  }

  private nextChunk(): string {
    const remaining = this.consumed.slice(this.sent);
    const boundary = nextBoundary(remaining) ?? remaining.length;
    this.sent += boundary;
    return remaining.slice(0, boundary).trim();
  }

  private scheduleDrain(): void {
    if (this.commands || !this.active) return;
    // Defer the first command so cancellation in this turn still prevents it.
    this.commands = Promise.resolve().then(() => this.drain());
  }

  private async drain(): Promise<void> {
    try {
      if (!this.active) return;
      if (!this.begun) {
        this.begun = true;
        await this.execute(this.options.begin, 'Le démarrage de la lecture a échoué.');
      }
      while (this.active && this.sent < this.consumed.length) {
        const chunk = this.nextChunk();
        if (chunk) {
          await this.execute(
            () => this.options.enqueue(chunk),
            'Un segment de lecture a échoué.',
          );
        }
      }
      if (this.active && this.closed) {
        await this.execute(this.options.finish, 'La fin de la lecture a échoué.');
      }
    } finally {
      // No await between noticing an empty queue and clearing its ownership:
      // a later push/finish can always start the next drain.
      this.commands = null;
    }
  }

  private async execute(command: () => Promise<boolean>, message: string): Promise<void> {
    try {
      const accepted = await command();
      if (this.active && !accepted) this.fail(new Error(message));
    } catch (error) {
      if (this.active) this.fail(error instanceof Error ? error : new Error(message));
    }
  }

  private fail(error: Error): void {
    if (!this.active) return;
    this.cancel();
    try {
      const observed = this.options.onError?.(error);
      // Also contain an async observer supplied by JavaScript despite void's
      // callback type; its rejection must not escape as an unhandled promise.
      Promise.resolve(observed).catch(() => undefined);
    } catch {
      // A UI/error observer must never reject the LLM's generation flow.
    }
  }
}
