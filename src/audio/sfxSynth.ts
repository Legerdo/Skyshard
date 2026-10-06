/*
 * Renders an SfxRecipe (src/audio/sfxRecipes.ts) into Web Audio nodes: per layer a filtered noise source, an
 * oscillator tone or a 2-operator FM pair under its envelope, all into one destination. One-shot layers stop
 * themselves; a loop recipe's sources run until the caller stops them.
 */

import type { FmLayer, NoiseLayer, SfxLayer, SfxRecipe, ToneLayer } from './sfxRecipes';
import { noiseSource, percussive, SILENT, sweep, type SynthKit } from './synthKit';

export interface RenderedSfx {
  /** Every scheduled source (to stop a voice early). */
  readonly sources: AudioScheduledSourceNode[];
  /** Every node made, disconnected once the voice ends. */
  readonly nodes: AudioNode[];
  /** When the last one-shot layer is silent (Infinity for a loop). */
  readonly end: number;
}

/** Schedules `recipe` at audio time `t`, every frequency × `pitch`, into `dest`. */
export function renderRecipe(kit: SynthKit, recipe: SfxRecipe, t: number, pitch: number, dest: AudioNode): RenderedSfx {
  const out: { sources: AudioScheduledSourceNode[]; nodes: AudioNode[]; end: number } = { sources: [], nodes: [], end: t };
  const loop = recipe.loop === true;
  for (const layer of recipe.layers) {
    const start = t + (layer.delay ?? 0);
    const env = kit.ctx.createGain();
    env.gain.value = 0;
    env.connect(dest);
    out.nodes.push(env);
    let end: number;
    if (loop) {
      env.gain.setValueAtTime(0, start);
      env.gain.linearRampToValueAtTime(Math.max(layer.gain, SILENT), start + Math.max(layer.attack, 0.01));
      end = Infinity;
    } else {
      end = percussive(env.gain, start, layer.gain, layer.attack, layer.decay);
    }
    const stop = loop ? Infinity : end + 0.02;
    switch (layer.kind) {
      case 'noise':
        renderNoise(kit, layer, start, stop, end, pitch, env, out);
        break;
      case 'tone':
        renderTone(kit, layer, start, stop, end, pitch, env, out);
        break;
      case 'fm':
        renderFm(kit, layer, start, stop, end, pitch, env, out);
        break;
    }
    out.end = Math.max(out.end, end);
  }
  return out;
}

type Out = { sources: AudioScheduledSourceNode[]; nodes: AudioNode[] };

/** A sine LFO of `rate` Hz and `depth` into `target`. */
function lfo(kit: SynthKit, rate: number, depth: number, target: AudioParam, start: number, stop: number, out: Out): void {
  const osc = kit.ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = rate;
  const amount = kit.ctx.createGain();
  amount.gain.value = depth;
  osc.connect(amount);
  amount.connect(target);
  osc.start(start);
  if (Number.isFinite(stop)) osc.stop(stop);
  out.sources.push(osc);
  out.nodes.push(osc, amount);
}

function renderNoise(kit: SynthKit, l: NoiseLayer, start: number, stop: number, end: number, pitch: number, env: GainNode, out: Out): void {
  const filter = kit.ctx.createBiquadFilter();
  filter.type = l.filter;
  filter.Q.value = l.q ?? (l.filter === 'bandpass' ? 1 : 0.7);
  const f = Math.min(l.freq * pitch, 18000);
  sweep(filter.frequency, start, f, l.freqEnd === undefined ? undefined : Math.min(l.freqEnd * pitch, 18000), Number.isFinite(end) ? end : start);
  const src = noiseSource(kit, start, stop);
  src.connect(filter);
  filter.connect(env);
  if (l.lfo !== undefined) lfo(kit, l.lfo.rate, l.lfo.depth, filter.frequency, start, stop, out);
  out.sources.push(src);
  out.nodes.push(src, filter);
}

function renderTone(kit: SynthKit, l: ToneLayer, start: number, stop: number, end: number, pitch: number, env: GainNode, out: Out): void {
  const osc = kit.ctx.createOscillator();
  osc.type = l.wave;
  sweep(osc.frequency, start, l.freq * pitch, l.freqEnd === undefined ? undefined : l.freqEnd * pitch, Number.isFinite(end) ? end : start);
  osc.connect(env);
  if (l.lfo !== undefined) lfo(kit, l.lfo.rate, l.lfo.depth, osc.detune, start, stop, out);
  osc.start(start);
  if (Number.isFinite(stop)) osc.stop(stop);
  out.sources.push(osc);
  out.nodes.push(osc);
}

function renderFm(kit: SynthKit, l: FmLayer, start: number, stop: number, end: number, pitch: number, env: GainNode, out: Out): void {
  const { ctx } = kit;
  const f = l.freq * pitch;
  const fEnd = l.freqEnd === undefined ? undefined : l.freqEnd * pitch;
  const sweepEnd = Number.isFinite(end) ? end : start;
  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  sweep(carrier.frequency, start, f, fEnd, sweepEnd);
  const mod = ctx.createOscillator();
  mod.type = 'sine';
  sweep(mod.frequency, start, f * l.ratio, fEnd === undefined ? undefined : fEnd * l.ratio, sweepEnd);
  const index = ctx.createGain();
  index.gain.setValueAtTime(Math.max(f * l.index, SILENT), start);
  if (Number.isFinite(end)) index.gain.exponentialRampToValueAtTime(Math.max(f * l.index * 0.03, SILENT), end);
  mod.connect(index);
  index.connect(carrier.frequency);
  carrier.connect(env);
  carrier.start(start);
  mod.start(start);
  if (Number.isFinite(stop)) {
    carrier.stop(stop);
    mod.stop(stop);
  }
  out.sources.push(carrier, mod);
  out.nodes.push(carrier, mod, index);
}

/** The layer that ends last (its source's `ended` cleans the voice up). */
export function lastLayer(recipe: SfxRecipe): SfxLayer | null {
  let best: SfxLayer | null = null;
  let bestEnd = -Infinity;
  for (const l of recipe.layers) {
    const e = (l.delay ?? 0) + l.attack + l.decay;
    if (e > bestEnd) {
      bestEnd = e;
      best = l;
    }
  }
  return best;
}
