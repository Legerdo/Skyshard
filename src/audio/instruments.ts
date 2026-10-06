/*
 * The six synthesized instruments of the music (design "합성 악기", task 16.2):
 * - pad: three saws detuned −7 / 0 / +7 cents → lowpass 1.2 kHz, 0.8 s attack (the choir variant adds vowel formants),
 * - pluck: triangle with a 0.25 s exponential decay,
 * - lead ("airy"): sine with a 5 Hz ±15 cent vibrato plus band-passed breath noise,
 * - bell: 2-operator FM at the inharmonic ratio 3.5, the modulation index decaying with the sound,
 * - bass: square → lowpass 400 Hz,
 * - percussion: noise hat (30–50 ms) and snare (120 ms), a 150 → 45 Hz sine-sweep kick and a 110 → 70 Hz low tom.
 * Every note builds fresh nodes, schedules its `start` / `stop` on the audio clock and disconnects on `ended`.
 */

import type { Drum, Instrument } from '../data/music';
import { adsr, disconnectOnEnded, noiseSource, percussive, SILENT, sweep, type SynthKit } from './synthKit';

export interface NoteSpec {
  readonly instrument: Instrument;
  readonly drum?: Drum;
  readonly formant?: boolean;
  /** Hz (ignored by drums). */
  readonly freq: number;
  /** Audio-clock start (s). */
  readonly t: number;
  /** Held length (s). */
  readonly dur: number;
  /** 0–1 velocity. */
  readonly vel: number;
}

/** Plays one note into `dest`. */
export function playNote(kit: SynthKit, n: NoteSpec, dest: AudioNode): void {
  switch (n.instrument) {
    case 'pad':
      return pad(kit, n, dest);
    case 'pluck':
      return pluck(kit, n, dest);
    case 'lead':
      return lead(kit, n, dest);
    case 'bell':
      return bell(kit, n, dest);
    case 'bass':
      return bass(kit, n, dest);
    case 'perc':
      return perc(kit, n, dest);
  }
}

const PAD_DETUNE_CENTS = [-7, 0, 7] as const;

function pad(kit: SynthKit, n: NoteSpec, dest: AudioNode): void {
  const { ctx } = kit;
  const env = ctx.createGain();
  env.gain.value = 0;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = n.formant === true ? 2600 : 1200;
  lp.Q.value = 0.5;
  const nodes: AudioNode[] = [env, lp];
  let tail: AudioNode = lp;
  if (n.formant === true) {
    // Vowel "a": peaks near 800 Hz and 1.15 kHz over the saw's harmonics (the Observatory choir).
    for (const [f, q, g] of [[800, 5, 9], [1150, 6, 7]] as const) {
      const peak = ctx.createBiquadFilter();
      peak.type = 'peaking';
      peak.frequency.value = f;
      peak.Q.value = q;
      peak.gain.value = g;
      tail.connect(peak);
      tail = peak;
      nodes.push(peak);
    }
  }
  tail.connect(env);
  env.connect(dest);
  const attack = Math.min(0.8, Math.max(0.05, n.dur * 0.5));
  const end = adsr(env.gain, n.t, n.vel / 3, attack, n.t + n.dur, 0.7);
  let last: OscillatorNode | null = null;
  for (const cents of PAD_DETUNE_CENTS) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = n.freq;
    osc.detune.value = cents;
    osc.connect(lp);
    osc.start(n.t);
    osc.stop(end);
    nodes.push(osc);
    last = osc;
  }
  if (last !== null) disconnectOnEnded(last, nodes);
}

/** Pluck decay (s). */
const PLUCK_DECAY = 0.25;

function pluck(kit: SynthKit, n: NoteSpec, dest: AudioNode): void {
  const { ctx } = kit;
  const env = ctx.createGain();
  env.gain.value = 0;
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = n.freq;
  osc.connect(env);
  env.connect(dest);
  const end = percussive(env.gain, n.t, n.vel, 0.004, PLUCK_DECAY);
  osc.start(n.t);
  osc.stop(end + 0.02);
  disconnectOnEnded(osc, [osc, env]);
}

function lead(kit: SynthKit, n: NoteSpec, dest: AudioNode): void {
  const { ctx } = kit;
  const env = ctx.createGain();
  env.gain.value = 0;
  env.connect(dest);
  const end = adsr(env.gain, n.t, n.vel, 0.08, n.t + n.dur, 0.3);
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = n.freq;
  // 5 Hz vibrato of ±15 cents.
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 5;
  const depth = ctx.createGain();
  depth.gain.value = 15;
  lfo.connect(depth);
  depth.connect(osc.detune);
  osc.connect(env);
  // Breath: band-passed noise a little above the note.
  const breath = noiseSource(kit, n.t, end);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = Math.min(8000, n.freq * 2);
  bp.Q.value = 1.2;
  const breathGain = ctx.createGain();
  breathGain.gain.value = 0.18;
  breath.connect(bp);
  bp.connect(breathGain);
  breathGain.connect(env);
  osc.start(n.t);
  lfo.start(n.t);
  osc.stop(end);
  lfo.stop(end);
  disconnectOnEnded(osc, [osc, lfo, depth, breath, bp, breathGain, env]);
}

/** Bell ring (s) and FM ratio. */
const BELL_DECAY = 1.8;
const BELL_RATIO = 3.5;
const BELL_INDEX = 2.2;

function bell(kit: SynthKit, n: NoteSpec, dest: AudioNode): void {
  const { ctx } = kit;
  const env = ctx.createGain();
  env.gain.value = 0;
  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.value = n.freq;
  const mod = ctx.createOscillator();
  mod.type = 'sine';
  mod.frequency.value = n.freq * BELL_RATIO;
  const index = ctx.createGain();
  // The modulation index decays with the sound: bright strike, pure tail.
  index.gain.setValueAtTime(n.freq * BELL_INDEX, n.t);
  index.gain.exponentialRampToValueAtTime(Math.max(n.freq * 0.05, SILENT), n.t + BELL_DECAY);
  mod.connect(index);
  index.connect(carrier.frequency);
  carrier.connect(env);
  env.connect(dest);
  const end = percussive(env.gain, n.t, n.vel, 0.003, BELL_DECAY);
  carrier.start(n.t);
  mod.start(n.t);
  carrier.stop(end);
  mod.stop(end);
  disconnectOnEnded(carrier, [carrier, mod, index, env]);
}

function bass(kit: SynthKit, n: NoteSpec, dest: AudioNode): void {
  const { ctx } = kit;
  const env = ctx.createGain();
  env.gain.value = 0;
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = n.freq;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 400;
  lp.Q.value = 1;
  osc.connect(lp);
  lp.connect(env);
  env.connect(dest);
  const end = adsr(env.gain, n.t, n.vel * 0.6, 0.01, n.t + Math.max(0.05, n.dur - 0.03), 0.1);
  osc.start(n.t);
  osc.stop(end);
  disconnectOnEnded(osc, [osc, lp, env]);
}

function perc(kit: SynthKit, n: NoteSpec, dest: AudioNode): void {
  const { ctx } = kit;
  const env = ctx.createGain();
  env.gain.value = 0;
  env.connect(dest);
  switch (n.drum ?? 'kick') {
    case 'kick': {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      sweep(osc.frequency, n.t, 150, 45, n.t + 0.12);
      osc.connect(env);
      const end = percussive(env.gain, n.t, n.vel, 0.002, 0.35);
      osc.start(n.t);
      osc.stop(end);
      disconnectOnEnded(osc, [osc, env]);
      return;
    }
    case 'tom': {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      sweep(osc.frequency, n.t, 110, 70, n.t + 0.2);
      osc.connect(env);
      const end = percussive(env.gain, n.t, n.vel, 0.003, 0.4);
      osc.start(n.t);
      osc.stop(end);
      disconnectOnEnded(osc, [osc, env]);
      return;
    }
    case 'snare':
    case 'hat': {
      const snare = n.drum === 'snare';
      const decay = snare ? 0.12 : 0.04;
      const filter = ctx.createBiquadFilter();
      filter.type = snare ? 'bandpass' : 'highpass';
      filter.frequency.value = snare ? 1800 : 7000;
      filter.Q.value = snare ? 0.7 : 0.5;
      const end = percussive(env.gain, n.t, n.vel * (snare ? 0.8 : 0.5), 0.001, decay);
      const src = noiseSource(kit, n.t, end + 0.01);
      src.connect(filter);
      filter.connect(env);
      const nodes: AudioNode[] = [src, filter, env];
      if (snare) {
        // The snare's body: a short 180 Hz triangle.
        const body = ctx.createOscillator();
        body.type = 'triangle';
        body.frequency.value = 180;
        const bodyGain = ctx.createGain();
        bodyGain.gain.value = 0;
        percussive(bodyGain.gain, n.t, n.vel * 0.3, 0.001, 0.06);
        body.connect(bodyGain);
        bodyGain.connect(dest);
        body.start(n.t);
        body.stop(n.t + 0.08);
        nodes.push(body, bodyGain);
      }
      disconnectOnEnded(src, nodes);
      return;
    }
  }
}
