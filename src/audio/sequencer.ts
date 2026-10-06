/*
 * Lookahead music sequencer (design "절차적 음악 시퀀서", task 16.2): a TrackPlayer plays one TrackDef into its own
 * track gain on the music bus. Every scheduler pass (a 25 ms timer in the AudioEngine) books each 16th step that
 * starts before `ctx.currentTime + 0.12` s at its audio-clock time, track start + step × 60 / bpm / 4, so timer
 * jitter never reaches the beat and a pass up to ~95 ms late still drops no note. While the music bus is off the
 * steps are counted without making nodes, so switching it back on continues the track in place. A non-loop track
 * stops booking after `bars`. Crossfades are equal-power curves on the track gain (and its reverb send), started
 * from the gain's current level when a fade is interrupted.
 */

import {
  chordDegree, midiToHz, parsePattern, scaleMidi, stepSeconds,
  type LayerDef, type MusicMode, type MusicTrackId, type PatternNote, type PitchClass, type TrackDef,
} from '../data/music';
import { playNote } from './instruments';
import type { SynthKit } from './synthKit';

/** How far ahead of the audio clock steps are booked (s). */
export const LOOKAHEAD_SECONDS = 0.12;
/** Scheduler timer period (ms). */
export const SCHEDULER_INTERVAL_MS = 25;
/** A step found later than this behind the clock is counted but not played (no bunched notes after a stall). */
const LATE_TOLERANCE = 0.05;
/** A faded-out track is dropped this long after its fade (reverb and release tails). */
const TAIL_SECONDS = 3;
/** Samples of an equal-power fade curve. */
const CURVE_SAMPLES = 48;

export interface SequencerHost {
  readonly kit: SynthKit;
  /** Music bus input (the track gains join here). */
  readonly bus: AudioNode;
  /** The music bus's reverb input. */
  readonly reverb: AudioNode;
  /** Whether notes should be made (the music bus is on). */
  audible(): boolean;
}

export interface TrackPlayerOptions {
  readonly def: TrackDef;
  readonly key: PitchClass;
  readonly mode: MusicMode;
  /** Audio time of step 0. */
  readonly startTime: number;
  /** First step to book (a same-bpm switch continues at the previous track's step). */
  readonly nextStep?: number;
  /** A decoded CC0 file played instead of the sequencer (task 16.4). */
  readonly buffer?: AudioBuffer | null;
}

/**
 * Level `x` (0–1) of the way through an equal-power fade from `from` to `to` (0 or 1): sin rising toward 1,
 * cos falling toward 0, continued from any starting level.
 */
export function equalPowerLevel(from: number, to: number, x: number): number {
  const u = Math.min(1, Math.max(0, x));
  const f = Math.min(1, Math.max(0, from));
  if (to >= 1) {
    const theta0 = Math.asin(f);
    return Math.sin(theta0 + u * (Math.PI / 2 - theta0));
  }
  const theta0 = Math.acos(f);
  return Math.cos(theta0 + u * (Math.PI / 2 - theta0));
}

interface LayerState {
  readonly def: LayerDef;
  readonly cells: readonly (PatternNote | null)[];
  readonly input: GainNode;
  readonly send: GainNode;
}

interface Fade {
  readonly from: number;
  readonly to: 0 | 1;
  readonly t0: number;
  readonly dur: number;
}

export class TrackPlayer {
  readonly id: MusicTrackId;
  readonly def: TrackDef;
  readonly key: PitchClass;
  readonly mode: MusicMode;
  readonly startTime: number;
  /** Next step to book. */
  nextStep: number;
  /** Seconds per 16th step. */
  readonly stepDur: number;
  /** Fading out: books nothing after `fadeEnd`, dropped TAIL_SECONDS later. */
  fadingOut = false;
  fadeEnd = 0;
  /** A non-loop track booked its last bar. */
  finished = false;
  disposed = false;
  /** Notes made so far (steps × layers × voicing), for tests and the debug state. */
  notesMade = 0;
  private readonly host: SequencerHost;
  private readonly out: GainNode;
  private readonly wet: GainNode;
  private readonly layers: LayerState[] = [];
  private readonly source: AudioBufferSourceNode | null = null;
  private fade: Fade | null = null;
  private level = 0;

  constructor(host: SequencerHost, o: TrackPlayerOptions) {
    this.host = host;
    this.def = o.def;
    this.id = o.def.id;
    this.key = o.key;
    this.mode = o.mode;
    this.startTime = o.startTime;
    this.nextStep = o.nextStep ?? 0;
    this.stepDur = stepSeconds(o.def.bpm);
    const { ctx } = host.kit;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0;
    this.out.connect(host.bus);
    this.wet.connect(host.reverb);
    if (o.buffer != null) {
      const src = ctx.createBufferSource();
      src.buffer = o.buffer;
      src.loop = o.def.loop;
      src.connect(this.out);
      src.start(Math.max(o.startTime, ctx.currentTime));
      this.source = src;
      return;
    }
    for (const def of o.def.layers) {
      const input = ctx.createGain();
      input.gain.value = def.gain;
      const send = ctx.createGain();
      send.gain.value = def.send;
      input.connect(this.out);
      input.connect(send);
      send.connect(this.wet);
      this.layers.push({ def, cells: parsePattern(def.pattern, def.instrument === 'perc'), input, send });
    }
  }

  /** Whether a CC0 file plays instead of the sequencer. */
  get fromFile(): boolean {
    return this.source !== null;
  }

  /** Track gain at audio time `t` (0–1). */
  levelAt(t: number): number {
    const f = this.fade;
    if (f === null) return this.level;
    if (f.dur <= 0) return f.to;
    return equalPowerLevel(f.from, f.to, (t - f.t0) / f.dur);
  }

  /** Fades the track in to full over `dur` s from its current level. */
  fadeIn(now: number, dur: number): void {
    this.fadingOut = false;
    this.fadeTo(1, now, dur);
  }

  /** Fades the track out over `dur` s; it books nothing after that and is dropped after its tails. */
  fadeOut(now: number, dur: number): void {
    if (this.fadingOut) return;
    this.fadingOut = true;
    this.fadeEnd = now + Math.max(0, dur);
    this.fadeTo(0, now, dur);
    if (this.source !== null) this.source.stop(this.fadeEnd + 0.05);
  }

  private fadeTo(to: 0 | 1, now: number, dur: number): void {
    const from = this.levelAt(now);
    const params = [this.out.gain, this.wet.gain];
    if (dur <= 0 || Math.abs(from - to) < 1e-4) {
      for (const p of params) {
        p.cancelScheduledValues(now);
        p.setValueAtTime(to, now);
      }
      this.fade = null;
      this.level = to;
      return;
    }
    const curve = new Float32Array(CURVE_SAMPLES);
    for (let i = 0; i < CURVE_SAMPLES; i++) curve[i] = equalPowerLevel(from, to, i / (CURVE_SAMPLES - 1));
    for (const p of params) {
      p.cancelScheduledValues(now);
      p.setValueAtTime(from, now);
      try {
        p.setValueCurveAtTime(curve, now, dur);
      } catch {
        p.linearRampToValueAtTime(to, now + dur);
      }
    }
    this.fade = { from, to, t0: now, dur };
    this.level = to;
  }

  /** Books every step starting before `horizon` (audio time); `now` is ctx.currentTime. */
  schedule(now: number, horizon: number): void {
    if (this.disposed || this.finished || this.source !== null) return;
    const total = this.def.bars * 16;
    for (;;) {
      const t = this.startTime + this.nextStep * this.stepDur;
      if (t >= horizon) break;
      if (!this.def.loop && this.nextStep >= total) {
        this.finished = true;
        break;
      }
      if (this.fadingOut && t >= this.fadeEnd) break;
      if (t >= now - LATE_TOLERANCE && this.host.audible()) this.playStep(this.nextStep, Math.max(t, now));
      this.nextStep++;
    }
  }

  /** Audio time of step `n`. */
  stepTime(n: number): number {
    return this.startTime + n * this.stepDur;
  }

  private playStep(step: number, t: number): void {
    const def = this.def;
    const bar = Math.floor(step / 16) % def.bars;
    const root = chordDegree(def.chords[bar % def.chords.length] ?? 'I') ?? 0;
    for (const layer of this.layers) {
      const cell = layer.cells[step % layer.cells.length];
      if (cell == null) continue;
      const l = layer.def;
      const dur = cell.length * this.stepDur;
      if (l.instrument === 'perc') {
        playNote(this.host.kit, { instrument: 'perc', drum: l.drum, freq: 0, t, dur, vel: cell.accent ? 1 : 0.75 }, layer.input);
        this.notesMade++;
        continue;
      }
      for (const v of l.voicing ?? [0]) {
        const midi = scaleMidi(this.key, this.mode, l.octave, root + cell.step + v);
        playNote(this.host.kit, { instrument: l.instrument, formant: l.formant, freq: midiToHz(midi), t, dur, vel: 0.8 }, layer.input);
        this.notesMade++;
      }
    }
  }

  /** A faded-out track whose tails are over. */
  expired(now: number): boolean {
    return this.fadingOut && now > this.fadeEnd + TAIL_SECONDS;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.source?.stop();
    } catch {
      // Already stopped.
    }
    for (const n of [this.source, this.out, this.wet, ...this.layers.flatMap((l) => [l.input, l.send])]) {
      try {
        n?.disconnect();
      } catch {
        // Already disconnected.
      }
    }
  }
}
