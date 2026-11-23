/**
 * Mouth shapes for spoken replies, without touching the host's audio.
 *
 * The plugin never patches browser or app objects, so it cannot read the audio Hermes plays. Hosts
 * that offer a read-only voice source (`ctx.voice`) tell it what is playing and when; without one,
 * the mouth is guessed from the reply text. In order of preference:
 *
 * 1. Timed pieces (words or fragments): each piece's vowel and lip shapes are spread across the
 *    moment the listener hears it, and the mouth opens only as wide as the current loudness allows.
 * 2. Loudness alone (the host knows only the sentence, or nothing): openness follows the level.
 * 3. No voice source: the reply text is laid out at a typical text-to-speech pace. Hosts that speak
 *    with the Web Speech API are followed through the read-only `window.speechSynthesis.speaking` flag.
 */

/** Why the host's speech ended. */
export type VoiceEndReason = 'closed' | 'failed' | 'finished' | 'interrupted' | 'replaced' | 'stopped';

/**
 * A piece of spoken text. Times are `performance.now()` milliseconds at which the listener hears it,
 * with output latency already included; `endMs` may be `Infinity` while a sentence is still open.
 */
export interface SpokenPiece {
  readonly text: string;
  readonly kind: 'word' | 'fragment' | 'sentence';
  readonly startMs: number;
  readonly endMs: number;
  readonly charStart?: number;
  readonly charEnd?: number;
}

export interface SpokenSegment {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly pieces: readonly SpokenPiece[];
}

export interface VoiceTimeline {
  readonly segments: readonly SpokenSegment[];
}

export interface ReadonlyVoiceStore<T> {
  get(): T;
  subscribe(cb: (value: T) => void): () => void;
  listen(cb: (value: T) => void): () => void;
}

export interface PluginVoicePlayback {
  readonly status: 'idle' | 'preparing' | 'speaking';
  readonly source: 'chained' | 'live' | null;
  readonly messageId: string | null;
  readonly endReason: VoiceEndReason | null;
  readonly endDetail: string | null;
}

/** The host's read-only view of its own speech, as offered to plugins on `ctx.voice`. */
export interface PluginVoice {
  readonly playback: ReadonlyVoiceStore<PluginVoicePlayback>;
  readonly timeline: ReadonlyVoiceStore<VoiceTimeline>;
  /**
   * Loudness (0..1) of what is playing now, measured at the audio graph, so it runs ahead of the
   * listener by `outputLatencyMs()`; ordinary speech is about 0.1 to 0.3. 0 when idle.
   */
  level(): number;
  /** The host's output-latency estimate, already folded into the timeline times. */
  outputLatencyMs(): number;
}

/**
 * How far ahead of `performance.now()` the timeline is sampled, to make up for the time between
 * computing a frame and it appearing on screen.
 */
export const SPEECH_RENDER_LEAD_MS = 0;

export type Vowel = 'aa' | 'ih' | 'ou' | 'ee' | 'oh';

export interface SpeechSample {
  /** True while a reply is being spoken (or, without a voice source, estimated to be). */
  readonly speaking: boolean;
  /** True on the frame speech was cut off (interrupted, stopped, replaced): close the mouth at once. */
  readonly cut?: boolean;
  /** Overall mouth openness (0..1). */
  readonly level: number;
  /** Target weight per vowel shape (0..1). */
  readonly visemes: Readonly<Record<Vowel, number>>;
}

interface Segment {
  readonly end: number;
  readonly vowel: Vowel | null;
  readonly open: number;
}

const NONE: Readonly<Record<Vowel, number>> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
/** How wide each vowel opens the mouth. */
const OPEN: Readonly<Record<Vowel, number>> = { aa: 0.85, oh: 0.7, ou: 0.55, ee: 0.55, ih: 0.5 };
/** Letters spoken per second by the text-to-speech voices Hermes ships with. */
const LETTERS_PER_SECOND = 15.5;
/** Text-to-speech needs a moment to synthesize before any sound plays. */
const LEAD_IN_SEC = 0.7;
const MAX_SPEECH_SEC = 45;

const DIGRAPHS: Readonly<Record<string, Vowel>> = {
  oo: 'ou', ee: 'ee', ea: 'ee', ai: 'ee', ay: 'ee', ey: 'ee', ie: 'ee',
  oa: 'oh', ou: 'oh', ow: 'oh', au: 'oh', aw: 'oh', oi: 'oh', oy: 'oh', ue: 'ou', ew: 'ou',
};
const SINGLE: Readonly<Record<string, Vowel>> = { a: 'aa', e: 'ee', i: 'ih', o: 'oh', u: 'ou', y: 'ee' };

/** Lay out one word as (vowel, relative duration, openness) steps. */
function wordSteps(word: string): Array<[Vowel | null, number, number]> {
  const steps: Array<[Vowel | null, number, number]> = [];
  let last: Vowel = 'aa';
  for (let i = 0; i < word.length; i++) {
    const c = word[i]!;
    const pair = word.slice(i, i + 2);
    if (DIGRAPHS[pair]) {
      last = DIGRAPHS[pair]!;
      steps.push([last, 1.4, OPEN[last]]);
      i++;
    } else if (SINGLE[c] && !(c === 'y' && i === 0)) {
      // A final "e" after a consonant is usually silent ("make", "phone"), except in short words ("the", "me").
      if (c === 'e' && i === word.length - 1 && word.length > 3 && !SINGLE[word[i - 1]!]) continue;
      last = SINGLE[c]!;
      steps.push([last, 1.1, OPEN[last]]);
    } else if (c >= '0' && c <= '9') {
      steps.push(['ee', 2.2, OPEN.ee]);
    } else if ('bmp'.includes(c)) {
      steps.push([null, 0.7, 0]); // lips meet
    } else if ('fv'.includes(c)) {
      steps.push(['ih', 0.6, 0.18]);
    } else if (c === 'w') {
      steps.push(['ou', 0.6, 0.3]);
    } else {
      steps.push([last, 0.5, 0.2]); // other consonants: the mouth narrows but stays in shape
    }
  }
  return steps;
}

/** Build the viseme timeline (seconds from the first sound) for a reply. */
export function buildTimeline(text: string): Segment[] {
  const tokens = text.toLowerCase().match(/[a-z0-9']+|[.,!?;:—–-]+|\n+/g) ?? [];
  const segments: Segment[] = [];
  let t = 0;
  const push = (duration: number, vowel: Vowel | null, open: number): void => {
    t += duration;
    segments.push({ end: t, vowel, open });
  };
  for (const token of tokens) {
    if (t > MAX_SPEECH_SEC) break;
    if (/^[a-z0-9']/.test(token)) {
      const word = token.replace(/'/g, '');
      const steps = wordSteps(word);
      const units = steps.reduce((sum, s) => sum + s[1], 0);
      if (units <= 0) continue;
      // Each word takes as long as its letters, shared out among its sounds.
      const wordSec = Math.max(0.12, word.length / LETTERS_PER_SECOND);
      for (const [vowel, weight, open] of steps) push((wordSec * weight) / units, vowel, open);
      push(0.03, null, 0.08);
    } else {
      push(/[.!?\n]/.test(token) ? 0.6 : 0.14, null, 0);
    }
  }
  return segments;
}

export interface SpeechCadence {
  /** Start mouthing a reply; an empty string leaves the current one to finish. Unused with a voice source. */
  noteReply(spoken: string): void;
  sample(dtSec: number): SpeechSample;
  /** Stop listening to the host's voice source. */
  dispose(): void;
}

export interface SpeechCadenceOptions {
  /** The host's voice source; without one the mouth is guessed from the reply text. */
  readonly voice?: PluginVoice | null;
  /** Clock on the same scale as the voice timeline. Defaults to `performance.now()`. */
  readonly now?: () => number;
}

const SILENT: SpeechSample = { speaking: false, level: 0, visemes: NONE };
/** Loudness below this is treated as silence. */
const LEVEL_FLOOR = 0.04;
/** Loudness at and above this opens the mouth fully; ordinary speech reaches about 0.1 to 0.3. */
const LEVEL_FULL = 0.25;
/** How much loudness history is kept beyond the output latency, for frame gaps. */
const LEVEL_HISTORY_MS = 250;

/** Mouth openness allowed by the current loudness (0..1). */
function levelGain(level: number): number {
  if (!Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(1, (level - LEVEL_FLOOR) / (LEVEL_FULL - LEVEL_FLOOR)));
}

function isTimed(piece: SpokenPiece): boolean {
  return piece.kind !== 'sentence' && Number.isFinite(piece.startMs);
}

/** The shape steps of a timed piece, spread across the time it is heard. */
interface PieceLayout {
  readonly piece: SpokenPiece;
  readonly steps: Segment[];
  readonly endMs: number;
}

function layoutPiece(piece: SpokenPiece): PieceLayout {
  const steps = buildTimeline(piece.text);
  const naturalSec = steps.length > 0 ? steps[steps.length - 1]!.end : 0;
  // An open-ended piece is given the time its letters would take at a typical pace.
  const endMs = Number.isFinite(piece.endMs) ? piece.endMs : piece.startMs + naturalSec * 1000;
  return { piece, steps, endMs };
}

function sampleLayout(layout: PieceLayout, atMs: number): Segment | null {
  const { piece, steps, endMs } = layout;
  if (steps.length === 0 || endMs <= piece.startMs) return null;
  const total = steps[steps.length - 1]!.end;
  const at = ((atMs - piece.startMs) / (endMs - piece.startMs)) * total;
  return steps.find((step) => step.end > at) ?? null;
}

/**
 * Recent loudness readings, so the level can be read when the listener hears it rather than when
 * the audio graph produced it.
 */
function createLevelHistory() {
  const readings: Array<{ readonly atMs: number; readonly level: number }> = [];
  return {
    /** Add a reading, keeping enough history to look `keepMs` back from it. */
    record(atMs: number, level: number, keepMs: number): void {
      readings.push({ atMs, level: Number.isFinite(level) ? level : 0 });
      // Keep one reading at or before the oldest time still needed, and drop the rest.
      while (readings.length > 1 && readings[1]!.atMs <= atMs - keepMs) readings.shift();
    },
    /** The latest reading taken at or before `atMs`; 0 if none is that old. */
    at(atMs: number): number {
      for (let i = readings.length - 1; i >= 0; i--) {
        if (readings[i]!.atMs <= atMs) return readings[i]!.level;
      }
      return 0;
    },
  };
}

function createVoiceCadence(voice: PluginVoice, now: () => number): SpeechCadence {
  let layout: PieceLayout | null = null;
  let clockSec = 0;
  const levels = createLevelHistory();
  // Every playback change is seen here, including ones that come and go between two frames.
  let lastStatus = voice.playback.get().status;
  let pendingCut = false;
  const stopListening = voice.playback.listen((playback) => {
    if (lastStatus === 'speaking' && playback.status !== 'speaking' && playback.endReason !== 'finished') {
      pendingCut = true;
    }
    lastStatus = playback.status;
  });

  function timedSample(segments: readonly SpokenSegment[], atMs: number, gain: number): SpeechSample | null {
    let anyTimed = false;
    for (const segment of segments) {
      const timed = segment.pieces.some(isTimed);
      anyTimed ||= timed;
      const inSegment = atMs >= segment.startMs && atMs < segment.endMs;
      if (inSegment && !timed) return null; // this stretch only has sentence timing
      if (!timed) continue;
      for (const piece of segment.pieces) {
        if (!isTimed(piece) || atMs < piece.startMs || atMs >= piece.endMs) continue;
        const current = layout?.piece === piece ? layout : layoutPiece(piece);
        if (atMs >= current.endMs) continue;
        layout = current;
        const step = sampleLayout(current, atMs);
        if (!step) continue;
        const open = step.open * gain;
        return { speaking: true, level: open, visemes: step.vowel ? { ...NONE, [step.vowel]: open } : NONE };
      }
    }
    // Between timed pieces the voice is silent.
    return anyTimed ? { speaking: true, level: 0, visemes: NONE } : null;
  }

  return {
    noteReply(): void {
      // The host says what is being spoken; reply text is not needed.
    },

    sample(dtSec: number): SpeechSample {
      clockSec += Math.max(0, Math.min(0.1, dtSec));
      const nowMs = now();
      const reportedLatencyMs = voice.outputLatencyMs();
      const latencyMs = Number.isFinite(reportedLatencyMs) && reportedLatencyMs > 0 ? reportedLatencyMs : 0;
      levels.record(nowMs, voice.level(), latencyMs + LEVEL_HISTORY_MS);
      if (pendingCut) {
        pendingCut = false;
        layout = null;
        return { ...SILENT, cut: true };
      }
      if (voice.playback.get().status !== 'speaking') {
        layout = null;
        return SILENT;
      }
      const atMs = nowMs + SPEECH_RENDER_LEAD_MS;
      // The level is measured ahead of the listener; read it as it is being heard.
      const gain = levelGain(levels.at(atMs - latencyMs));
      const timed = timedSample(voice.timeline.get().segments, atMs, gain);
      if (timed) return timed;
      // Loudness only: openness follows the level through a plain rotation of vowel shapes.
      const open = 0.85 * gain;
      const vowel: Vowel = (['aa', 'oh', 'ee', 'ih', 'ou'] as const)[Math.floor(clockSec * 4) % 5]!;
      return { speaking: true, level: open, visemes: open > 0 ? { ...NONE, [vowel]: open } : NONE };
    },

    dispose(): void {
      stopListening();
    },
  };
}

export function createSpeechCadence(options: SpeechCadenceOptions = {}): SpeechCadence {
  if (options.voice) {
    const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    return createVoiceCadence(options.voice, now);
  }
  return createTextCadence();
}

function createTextCadence(): SpeechCadence {
  let clock = 0;
  let start = -1;
  let timeline: Segment[] = [];
  let index = 0;

  return {
    noteReply(spoken: string): void {
      const next = buildTimeline(spoken);
      if (next.length === 0) return;
      timeline = next;
      index = 0;
      start = clock + LEAD_IN_SEC;
    },

    dispose(): void {},

    sample(dtSec: number): SpeechSample {
      clock += Math.max(0, Math.min(0.1, dtSec));
      const at = clock - start;
      if (start >= 0 && at >= 0 && timeline.length > 0) {
        while (index < timeline.length && timeline[index]!.end <= at) index++;
        const seg = timeline[index];
        if (seg) {
          const visemes = seg.vowel ? { ...NONE, [seg.vowel]: seg.open } : NONE;
          return { speaking: true, level: seg.open, visemes };
        }
        timeline = [];
      }
      const webSpeech =
        typeof window !== 'undefined' &&
        Boolean(window.speechSynthesis?.speaking) &&
        !window.speechSynthesis.paused;
      if (!webSpeech) return { speaking: false, level: 0, visemes: NONE };
      // No text to follow here: fall back to a plain syllable rhythm.
      const level = Math.max(0.1, 0.5 + 0.32 * Math.sin(clock * Math.PI * 2 * 5.2) + 0.2 * Math.sin(clock * Math.PI * 2 * 8.3));
      const vowel: Vowel = (['aa', 'oh', 'ee', 'ih', 'ou'] as const)[Math.floor(clock * 4) % 5]!;
      return { speaking: true, level: Math.min(0.9, level), visemes: { ...NONE, [vowel]: Math.min(0.9, level) } };
    },
  };
}

export interface MouthState {
  /** True while the mouth is talking or still closing. */
  readonly talking: boolean;
  /** Overall mouth openness (0..1). */
  readonly level: number;
  readonly visemes: Readonly<Record<Vowel, number>>;
}

export interface Mouth {
  /** Move the mouth toward a speech sample; `speaking` samples are followed quickly, silence eases shut. */
  update(sample: SpeechSample, dtSec: number): MouthState;
}

const VOWELS = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;

/** Smooths speech samples into the mouth's rendered openness and vowel weights. */
export function createMouth(): Mouth {
  let level = 0;
  const visemes: Record<Vowel, number> = { ...NONE };
  const snapshot = (talking: boolean): MouthState => ({ talking, level, visemes: { ...visemes } });

  return {
    update(sample: SpeechSample, dt: number): MouthState {
      if (sample.cut) {
        level = 0;
        for (const v of VOWELS) visemes[v] = 0;
        return snapshot(false);
      }
      if (sample.speaking) {
        const alpha = Math.min(1, Math.max(0.2, dt * 28));
        level += (sample.level - level) * alpha;
        const shape = Math.min(1, dt * 26);
        for (const v of VOWELS) visemes[v] += (sample.visemes[v] - visemes[v]) * shape;
        return snapshot(true);
      }
      level = Math.max(0, level - dt * 10);
      for (const v of VOWELS) visemes[v] = Math.max(0, visemes[v] - dt * 10);
      return snapshot(level > 0.02);
    },
  };
}
