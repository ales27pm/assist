export type VoiceTurnDecision = 'wait' | 'finish' | 'no-speech';

export type VoiceTurnInput = Readonly<{
  frameCount: number;
  measured: boolean;
  level: number;
}>;

// Prototype settings, in milliseconds. These are interaction heuristics to
// qualify on real microphones and Quebec French speakers, not measured VAD or
// linguistic end-of-turn detection. A peak can be background noise; soft speech
// can fall below the threshold. The caller still owns stop/finalize/send.
const NORMAL_PAUSE_MS = 900;
const HESITATION_PAUSE_MS = 1_800;
const INCOMPLETE_PAUSE_MS = 2_200;
const UNMEASURED_PAUSE_MS = 2_200;
const NO_SPEECH_MS = 15_000;
const MIN_CAPTURE_MS = 600;
const INPUT_FRESH_MS = 650; // Allows small jitter around the 5 Hz observations.
const SOUND_LEVEL = 0.025;

function timestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function normalized(text: string): string {
  return text.trim().replace(/\s+/gu, ' ');
}

function pauseFor(text: string): number {
  const ending = text
    .toLowerCase()
    .replace(/’/gu, "'")
    .replace(/[.!?,;:…\s]+$/gu, '');
  if (
    /(?:^|\s)(?:et|mais|ou|donc|car|que|si|quand|comme|pour|avec|sans|de|du|des|à|au|aux|en|le|la|les|un|une|mon|ma|mes|ton|ta|tes|son|sa|ses|sur|dans|pis|puis|faque)$/u.test(
      ending,
    )
  ) {
    return INCOMPLETE_PAUSE_MS;
  }
  if (
    /(?:^|\s)(?:euh+|heu+|hum+|attends(?: un peu| deux secondes| une seconde)?|je pense|dans le fond)$/u.test(
      ending,
    )
  ) {
    return HESITATION_PAUSE_MS;
  }
  return NORMAL_PAUSE_MS;
}

/**
 * Deterministic local turn suggestions from text and aggregate input metrics.
 *
 * No audio, inference, permissions, timers, network or automatic send lives here.
 * Call reset once per capture, then feed observations using one monotonic clock.
 * A nonempty transcript is required for `finish`; input energy alone can never
 * create a message. Final text must still come from native recognition after
 * the caller stops capture. Missing/unmeasurable input uses a longer text-only
 * fallback, so this policy cannot guarantee silence without usable observations.
 */
export class VoiceTurnPolicy {
  private startedAt: number | null = null;
  private lastTime = 0;
  private text = '';
  private textChangedAt: number | null = null;
  private frameCount = 0;
  private lastInputAt: number | null = null;
  private quietSince: number | null = null;
  private lastSoundAt: number | null = null;

  reset(nowMs: number): void {
    this.startedAt = timestamp(nowMs) ? nowMs : null;
    this.lastTime = this.startedAt ?? 0;
    this.text = '';
    this.textChangedAt = null;
    this.frameCount = 0;
    this.lastInputAt = null;
    this.quietSince = null;
    this.lastSoundAt = null;
  }

  private acceptTime(nowMs: number): boolean {
    if (this.startedAt === null || !timestamp(nowMs) || nowMs < this.lastTime) {
      return false;
    }
    this.lastTime = nowMs;
    return true;
  }

  transcript(text: string, nowMs: number): void {
    if (typeof text !== 'string' || !this.acceptTime(nowMs)) return;
    const next = normalized(text);
    if (next === this.text) return;
    this.text = next;
    this.textChangedAt = next ? nowMs : null;
  }

  input(value: VoiceTurnInput, nowMs: number): void {
    // A repeated/stale aggregate snapshot is not a new microphone observation.
    // Reject it before accepting its timestamp, including a late future stamp.
    if (
      !Number.isSafeInteger(value.frameCount) ||
      value.frameCount <= this.frameCount ||
      typeof value.measured !== 'boolean' ||
      !Number.isFinite(value.level) ||
      value.level < 0 ||
      value.level > 1 ||
      !this.acceptTime(nowMs)
    )
      return;
    this.frameCount = value.frameCount;
    const previousInputAt = this.lastInputAt;
    this.lastInputAt = value.measured ? nowMs : null;
    if (!value.measured) {
      this.quietSince = null;
    } else if (value.level >= SOUND_LEVEL) {
      this.lastSoundAt = nowMs;
      this.quietSince = null;
    } else if (
      this.quietSince === null ||
      previousInputAt === null ||
      nowMs - previousInputAt > INPUT_FRESH_MS
    ) {
      this.quietSince = nowMs;
    }
  }

  decision(nowMs: number): VoiceTurnDecision {
    if (!this.acceptTime(nowMs) || this.startedAt === null) return 'wait';
    const sinceSound =
      this.lastSoundAt === null
        ? Number.POSITIVE_INFINITY
        : nowMs - this.lastSoundAt;
    if (!this.text || this.textChangedAt === null) {
      return nowMs - this.startedAt >= NO_SPEECH_MS &&
        sinceSound >= NORMAL_PAUSE_MS
        ? 'no-speech'
        : 'wait';
    }
    if (nowMs - this.startedAt < MIN_CAPTURE_MS) return 'wait';
    const pause = pauseFor(this.text);
    if (sinceSound < pause || nowMs - this.textChangedAt < pause) return 'wait';
    const measured =
      this.lastInputAt !== null && nowMs - this.lastInputAt <= INPUT_FRESH_MS;
    if (measured) {
      return this.quietSince !== null && nowMs - this.quietSince >= pause
        ? 'finish'
        : 'wait';
    }
    return nowMs - this.textChangedAt >= Math.max(pause, UNMEASURED_PAUSE_MS) &&
      sinceSound >= Math.max(pause, UNMEASURED_PAUSE_MS)
      ? 'finish'
      : 'wait';
  }
}
