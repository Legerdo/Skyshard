/*
 * Shared Web Audio helpers of the synthesizers: the kit every note is made with (context, the shared seeded noise
 * buffer, a seeded random stream), envelope scheduling and the disconnect-on-`ended` cleanup (design "합성 악기": a
 * note's nodes are created per note, `start` / `stop` are scheduled, and they are disconnected when it ends).
 */

import type { Rng } from '../core/rng';

export interface SynthKit {
  readonly ctx: BaseAudioContext;
  /** Seeded white noise (mono, a few seconds), shared by every noise voice. */
  readonly noise: AudioBuffer;
  /** Seeded draws for noise offsets and per-play variation (never Math.random). */
  readonly rng: Rng;
}

/** Smallest level an exponential ramp may reach (a ramp to 0 is not allowed). */
export const SILENT = 0.0001;

/** A looping noise source starting at a random offset, stopped at `stop` (Infinity: stopped by the caller). */
export function noiseSource(kit: SynthKit, start: number, stop: number): AudioBufferSourceNode {
  const src = kit.ctx.createBufferSource();
  src.buffer = kit.noise;
  src.loop = true;
  const span = Math.max(0, kit.noise.duration - 0.25);
  src.start(start, span > 0 ? kit.rng.range(0, span) : 0);
  if (Number.isFinite(stop)) src.stop(stop);
  return src;
}

/**
 * Linear attack to `peak`, held until `holdUntil`, then an exponential release: the level falls toward 0 with time
 * constant release / 4 (about −35 dB after `release`). Returns when the release is inaudible.
 */
export function adsr(param: AudioParam, t: number, peak: number, attack: number, holdUntil: number, release: number): number {
  const top = Math.max(peak, SILENT);
  const peakAt = t + Math.max(attack, 0.001);
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(top, peakAt);
  const releaseAt = Math.max(holdUntil, peakAt);
  if (releaseAt > peakAt) param.setValueAtTime(top, releaseAt);
  param.setTargetAtTime(0, releaseAt, Math.max(release, 0.005) / 4);
  return releaseAt + release;
}

/** Linear attack to `peak`, then an exponential decay reaching silence `decay` s later. Returns the end time. */
export function percussive(param: AudioParam, t: number, peak: number, attack: number, decay: number): number {
  const top = Math.max(peak, SILENT * 2);
  const peakAt = t + Math.max(attack, 0.001);
  const end = peakAt + Math.max(decay, 0.005);
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(top, peakAt);
  param.exponentialRampToValueAtTime(SILENT, end);
  return end;
}

/** Exponential sweep of a frequency param from `from` to `to` over [t, end] (both clamped above 0). */
export function sweep(param: AudioParam, t: number, from: number, to: number | undefined, end: number): void {
  param.setValueAtTime(Math.max(from, 0.01), t);
  if (to !== undefined && to !== from && end > t) param.exponentialRampToValueAtTime(Math.max(to, 0.01), end);
}

/** Disconnects `nodes` once `last` (the source that stops last) has ended. */
export function disconnectOnEnded(last: AudioScheduledSourceNode, nodes: readonly AudioNode[]): void {
  last.onended = () => {
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        // Already disconnected.
      }
    }
  };
}

/** Seeded mono white noise of `seconds` at the context's rate. */
export function createNoiseBuffer(ctx: BaseAudioContext, rng: Rng, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = rng.next() * 2 - 1;
  return buffer;
}

/**
 * The shared reverb impulse (design "공유 reverb"): stereo seeded white noise under an exponential decay reaching
 * −60 dB at `rt60`, `seconds` long.
 */
export function createImpulseBuffer(ctx: BaseAudioContext, rng: Rng, seconds: number, rt60: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.round(rate * seconds));
  const buffer = ctx.createBuffer(2, length, rate);
  // e^(−k·rt60) = 10^(−3): amplitude 60 dB down at rt60.
  const k = (3 * Math.LN10) / rt60;
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) data[i] = (rng.next() * 2 - 1) * Math.exp((-k * i) / rate);
  }
  return buffer;
}

/** dB → linear gain. */
export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}
