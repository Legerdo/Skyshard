/*
 * Sound effect catalog (design "효과음 카탈로그", task 16.3, Req 37.2, 26.5): one synthesis recipe per `sfx_*` id,
 * built from filtered noise envelopes, oscillator tones with pitch sweeps and 2-operator FM tones. The recipes are
 * plain data (no Web Audio here); src/audio/sfxSynth.ts renders them and src/audio/audioEngine.ts plays them into
 * the recipe's sfx sub-group. A CC0 file with the same id in public/assets/manifest.json replaces a recipe
 * (task 16.4); a recipe exists for every id so a sound plays with or without files.
 *
 * Layer times are seconds from the voice start: `delay` before the layer starts, a linear `attack`, then an
 * exponential `decay` to silence. `loop` recipes (ambient beds, wind loops) hold each layer at its gain until the
 * voice is stopped. `vary` asks for a random pitch (±fraction) and gain (±dB) per play (the footsteps).
 */

import type { CharacterId, EliteId, EnemyId, ReactionId, SfxId } from '../data/ids';
import { REACTION_PRESENTATION } from '../data/reactions';
import type { SfxGroup } from './voicePool';

export type SfxWave = 'sine' | 'square' | 'sawtooth' | 'triangle';
export type SfxFilter = 'lowpass' | 'highpass' | 'bandpass';

interface LayerBase {
  /** Seconds after the voice start. */
  readonly delay?: number;
  /** Linear rise (s). */
  readonly attack: number;
  /** Exponential fall to silence after the attack (s); ignored by loop recipes. */
  readonly decay: number;
  readonly gain: number;
}

/** A slow wobble: of the filter frequency (Hz) for noise, of the pitch (cents) for tones. */
export interface SfxLfo {
  readonly rate: number;
  readonly depth: number;
}

export interface NoiseLayer extends LayerBase {
  readonly kind: 'noise';
  readonly filter: SfxFilter;
  readonly freq: number;
  /** Filter frequency at the end of attack + decay (exponential sweep). */
  readonly freqEnd?: number;
  readonly q?: number;
  readonly lfo?: SfxLfo;
}

export interface ToneLayer extends LayerBase {
  readonly kind: 'tone';
  readonly wave: SfxWave;
  readonly freq: number;
  /** Pitch at the end of attack + decay (exponential sweep). */
  readonly freqEnd?: number;
  readonly lfo?: SfxLfo;
}

/** 2-operator FM: a sine carrier at `freq` modulated by a sine at freq × `ratio`, depth `index` decaying with it. */
export interface FmLayer extends LayerBase {
  readonly kind: 'fm';
  readonly freq: number;
  readonly ratio: number;
  readonly index: number;
  readonly freqEnd?: number;
}

export type SfxLayer = NoiseLayer | ToneLayer | FmLayer;

export interface SfxRecipe {
  readonly group: SfxGroup;
  readonly layers: readonly SfxLayer[];
  /** Overall gain (default 1). */
  readonly gain?: number;
  /** Send to the sfx reverb (default 0.1). */
  readonly send?: number;
  /** Per-play variation: pitch ±fraction, gain ±dB. */
  readonly vary?: { readonly pitch: number; readonly gainDb: number };
  readonly loop?: boolean;
}

// ── Layer builders ──────────────────────────────────────────────────────────

type Extra<T> = Partial<Omit<T, 'kind' | 'attack' | 'decay' | 'gain'>>;

const noise = (filter: SfxFilter, freq: number, attack: number, decay: number, gain: number, extra: Extra<NoiseLayer> = {}): NoiseLayer => ({
  kind: 'noise', filter, freq, attack, decay, gain, ...extra,
});
const tone = (wave: SfxWave, freq: number, attack: number, decay: number, gain: number, extra: Extra<ToneLayer> = {}): ToneLayer => ({
  kind: 'tone', wave, freq, attack, decay, gain, ...extra,
});
const fm = (freq: number, ratio: number, index: number, attack: number, decay: number, gain: number, extra: Extra<FmLayer> = {}): FmLayer => ({
  kind: 'fm', freq, ratio, index, attack, decay, gain, ...extra,
});

const world = (layers: SfxLayer[], extra: Partial<SfxRecipe> = {}): SfxRecipe => ({ group: 'world', layers, ...extra });
const ui = (layers: SfxLayer[], extra: Partial<SfxRecipe> = {}): SfxRecipe => ({ group: 'ui', layers, send: 0.05, ...extra });
const ambient = (layers: SfxLayer[], extra: Partial<SfxRecipe> = {}): SfxRecipe => ({ group: 'ambient', layers, send: 0.3, ...extra });

/** Short high noise ticks at `delays` (crackles, grains). */
const ticks = (freq: number, gain: number, delays: readonly number[]): NoiseLayer[] =>
  delays.map((delay) => noise('highpass', freq, 0.001, 0.015, gain, { delay }));
/** Bell notes (FM ratio 3.5) at `delays`. */
const bells = (freqs: readonly number[], step: number, decay: number, gain: number, start = 0): FmLayer[] =>
  freqs.map((f, i) => fm(f, 3.5, 1.6, 0.003, decay, gain, { delay: start + i * step }));
/** Plucked triangle notes at `delays`. */
const notes = (freqs: readonly number[], step: number, decay: number, gain: number, start = 0): ToneLayer[] =>
  freqs.map((f, i) => tone('triangle', f, 0.004, decay, gain, { delay: start + i * step }));

const STEP_VARY = { pitch: 0.05, gainDb: 2 } as const;

// ── Footsteps, movement ─────────────────────────────────────────────────────

/** The six footstep materials (Req 37.2). */
export type FootstepMaterial = 'grass' | 'dirt' | 'stone' | 'wood' | 'water' | 'crystal';
export const FOOTSTEP_MATERIALS: readonly FootstepMaterial[] = ['grass', 'dirt', 'stone', 'wood', 'water', 'crystal'];
export const footstepSfx = (m: FootstepMaterial): SfxId => `sfx_step_${m}`;

const MOVEMENT: Record<string, SfxRecipe> = {
  // Grass: high noise brushing.
  sfx_step_grass: world([noise('highpass', 3500, 0.006, 0.09, 0.3, { q: 0.7 }), noise('bandpass', 6000, 0.004, 0.05, 0.14, { delay: 0.02 })], { vary: STEP_VARY, send: 0.02 }),
  // Dirt: low dull thud.
  sfx_step_dirt: world([noise('lowpass', 600, 0.003, 0.08, 0.45), tone('sine', 90, 0.002, 0.06, 0.22, { freqEnd: 60 })], { vary: STEP_VARY, send: 0.02 }),
  // Stone: short click.
  sfx_step_stone: world([noise('bandpass', 2500, 0.001, 0.03, 0.38, { q: 2 }), tone('triangle', 900, 0.001, 0.025, 0.08, { freqEnd: 700 })], { vary: STEP_VARY, send: 0.08 }),
  // Wood: a knock resonating at 400 Hz.
  sfx_step_wood: world([tone('sine', 400, 0.002, 0.12, 0.3, { freqEnd: 360 }), noise('bandpass', 1200, 0.001, 0.04, 0.18, { q: 3 })], { vary: STEP_VARY, send: 0.05 }),
  // Water: splash noise and a rising blip.
  sfx_step_water: world([noise('bandpass', 1800, 0.01, 0.15, 0.32, { freqEnd: 900, q: 0.8 }), tone('sine', 500, 0.005, 0.06, 0.1, { freqEnd: 1100, delay: 0.03 })], { vary: STEP_VARY, send: 0.05 }),
  // Crystal: a high FM ring.
  sfx_step_crystal: world([fm(1800, 3.5, 1.5, 0.002, 0.25, 0.1), noise('highpass', 5000, 0.001, 0.03, 0.12)], { vary: STEP_VARY, send: 0.2 }),
  sfx_jump: world([noise('bandpass', 900, 0.01, 0.12, 0.22, { freqEnd: 2200, q: 1 }), tone('sine', 220, 0.005, 0.08, 0.06, { freqEnd: 330 })], { vary: { pitch: 0.04, gainDb: 1 } }),
  // Landing: the director scales its gain with the fall height.
  sfx_land: world([noise('lowpass', 500, 0.002, 0.15, 0.55), tone('sine', 110, 0.002, 0.15, 0.32, { freqEnd: 50 })], { vary: { pitch: 0.04, gainDb: 1 } }),
  sfx_climb_grab: world([noise('bandpass', 1500, 0.002, 0.05, 0.32, { q: 1.5 }), noise('lowpass', 400, 0.002, 0.08, 0.28, { delay: 0.02 })], { vary: { pitch: 0.06, gainDb: 1.5 } }),
  sfx_mantle: world([noise('bandpass', 900, 0.02, 0.2, 0.24, { q: 1 }), noise('lowpass', 350, 0.005, 0.1, 0.25, { delay: 0.18 })]),
  sfx_dodge: world([noise('bandpass', 600, 0.04, 0.2, 0.3, { freqEnd: 2500, q: 1.2 })], { vary: { pitch: 0.05, gainDb: 1 } }),
  sfx_glide_open: world([noise('bandpass', 400, 0.05, 0.25, 0.28, { freqEnd: 1400, q: 0.9 }), noise('highpass', 3000, 0.001, 0.05, 0.18)]),
  sfx_water_enter: world([
    noise('bandpass', 1200, 0.005, 0.35, 0.45, { freqEnd: 500, q: 0.7 }), noise('lowpass', 300, 0.005, 0.3, 0.35),
    tone('sine', 300, 0.005, 0.1, 0.12, { freqEnd: 900, delay: 0.05 }),
  ]),
};

// ── Characters: attacks, abilities, switching (Req 23.7) ─────────────────────

export type CharacterSound = 'attack' | 'skill' | 'burst' | 'switch';
export const characterSfx = (id: CharacterId, sound: CharacterSound): SfxId => `sfx_${id}_${sound}`;

/** Each character's switch shimmer pitch. */
const SWITCH_HZ: Readonly<Record<CharacterId, number>> = { kairen: 523, isla: 659, wren: 784, talus: 392 };

const CHARACTERS: Record<string, SfxRecipe> = {
  // Kairen: blade wind and ember crackles.
  sfx_kairen_attack: world([noise('bandpass', 1200, 0.01, 0.12, 0.32, { freqEnd: 3500, q: 1.5 }), ...ticks(6000, 0.16, [0.06, 0.1])], { vary: { pitch: 0.05, gainDb: 1 } }),
  sfx_kairen_skill: world([noise('lowpass', 800, 0.03, 0.35, 0.42, { freqEnd: 3000 }), tone('sawtooth', 120, 0.01, 0.3, 0.1, { freqEnd: 60 }), ...ticks(5000, 0.16, [0.1, 0.16, 0.25, 0.32])]),
  sfx_kairen_burst: world([
    noise('lowpass', 400, 0.1, 0.8, 0.5, { freqEnd: 4000 }), tone('sawtooth', 80, 0.05, 0.8, 0.16, { freqEnd: 40 }),
    fm(220, 1.5, 4, 0.02, 0.6, 0.08), ...ticks(5000, 0.18, [0.2, 0.3, 0.45, 0.6, 0.7]),
  ], { send: 0.25 }),
  // Isla: bowstring and a water droplet.
  sfx_isla_attack: world([
    tone('triangle', 220, 0.001, 0.08, 0.22, { freqEnd: 180 }), noise('bandpass', 3000, 0.001, 0.04, 0.14, { q: 2 }),
    tone('sine', 900, 0.003, 0.06, 0.1, { freqEnd: 1600, delay: 0.05 }),
  ], { vary: { pitch: 0.04, gainDb: 1 } }),
  sfx_isla_skill: world([
    noise('bandpass', 1500, 0.02, 0.4, 0.32, { freqEnd: 600, q: 0.8 }), tone('sine', 600, 0.003, 0.12, 0.12, { freqEnd: 1400, delay: 0.05 }),
    tone('sine', 800, 0.003, 0.1, 0.09, { freqEnd: 1800, delay: 0.15 }),
  ], { send: 0.25 }),
  sfx_isla_burst: world([
    noise('lowpass', 2000, 0.2, 0.9, 0.45, { freqEnd: 500 }), fm(440, 2, 2, 0.05, 0.9, 0.1),
    tone('sine', 700, 0.003, 0.08, 0.1, { freqEnd: 1500, delay: 0.3 }), tone('sine', 900, 0.003, 0.08, 0.08, { freqEnd: 1900, delay: 0.5 }),
  ], { send: 0.35 }),
  // Wren: air cut by the wind.
  sfx_wren_attack: world([noise('bandpass', 2000, 0.02, 0.1, 0.32, { freqEnd: 5000, q: 3 }), noise('highpass', 7000, 0.005, 0.05, 0.08)], { vary: { pitch: 0.06, gainDb: 1 } }),
  sfx_wren_skill: world([noise('bandpass', 400, 0.1, 0.5, 0.42, { freqEnd: 2400, q: 1 }), noise('highpass', 5000, 0.08, 0.3, 0.06)], { send: 0.2 }),
  sfx_wren_burst: world([noise('bandpass', 300, 0.25, 1.2, 0.5, { freqEnd: 3000, q: 0.8 }), tone('sine', 180, 0.2, 1.0, 0.06, { freqEnd: 360 })], { send: 0.3 }),
  // Talus: a heavy blow and crumbling rock.
  sfx_talus_attack: world([
    tone('sine', 120, 0.002, 0.2, 0.45, { freqEnd: 45 }), noise('lowpass', 700, 0.002, 0.15, 0.4),
    noise('bandpass', 1800, 0.002, 0.12, 0.18, { q: 1, delay: 0.05 }),
  ], { vary: { pitch: 0.04, gainDb: 1 } }),
  sfx_talus_skill: world([tone('sine', 80, 0.005, 0.5, 0.55, { freqEnd: 35 }), noise('lowpass', 400, 0.01, 0.5, 0.45), ...ticks(2200, 0.12, [0.12, 0.2, 0.3])]),
  sfx_talus_burst: world([
    tone('sine', 60, 0.02, 1.0, 0.6, { freqEnd: 28 }), noise('lowpass', 300, 0.05, 1.0, 0.45, { freqEnd: 1200 }),
    noise('bandpass', 2000, 0.01, 0.4, 0.18, { delay: 0.2 }),
  ], { send: 0.25 }),
};
for (const [id, hz] of Object.entries(SWITCH_HZ)) {
  CHARACTERS[`sfx_${id}_switch`] = world([fm(hz, 2, 1.2, 0.005, 0.35, 0.12), noise('highpass', 5000, 0.05, 0.15, 0.06)], { send: 0.2 });
}

// ── Hits, Reactions ─────────────────────────────────────────────────────────

const HITS: Record<string, SfxRecipe> = {
  // The Active_Character is hit: a low blow and short noise.
  sfx_player_hit: world([tone('sine', 160, 0.001, 0.15, 0.45, { freqEnd: 70 }), noise('lowpass', 1500, 0.001, 0.08, 0.32)], { vary: { pitch: 0.05, gainDb: 1 } }),
  // Downed: a falling tone.
  sfx_downed: world([tone('triangle', 440, 0.01, 0.8, 0.22, { freqEnd: 110 }), tone('sine', 330, 0.01, 0.8, 0.14, { freqEnd: 82 })], { send: 0.3 }),
  // Perfect_Dodge: a slowing whoosh.
  sfx_perfect_dodge: world([noise('bandpass', 3000, 0.05, 0.6, 0.38, { freqEnd: 500, q: 1.5 }), fm(880, 3.5, 1, 0.01, 0.6, 0.08, { freqEnd: 440 })], { send: 0.35 }),
  sfx_hit_generic: world([noise('bandpass', 1500, 0.001, 0.06, 0.32, { q: 1 }), tone('sine', 200, 0.001, 0.06, 0.18, { freqEnd: 120 })], { vary: { pitch: 0.06, gainDb: 1.5 } }),
  sfx_hit_crit: world([fm(1200, 3.5, 2, 0.001, 0.18, 0.12), noise('highpass', 4000, 0.001, 0.04, 0.18)]),
  sfx_weak_spot: world([fm(700, 2.5, 3, 0.002, 0.4, 0.16), noise('bandpass', 900, 0.001, 0.2, 0.28)], { send: 0.2 }),
};

/** Each Reaction's own sound (Req 25.9, 37.2), keyed by REACTION_PRESENTATION[r].sfx. */
const REACTION_RECIPES: Readonly<Record<ReactionId, SfxRecipe>> = {
  // Hissing swell, then a boom.
  steamBurst: world([
    noise('highpass', 3000, 0.25, 0.3, 0.35), tone('sine', 90, 0.005, 0.4, 0.55, { freqEnd: 40, delay: 0.25 }),
    noise('lowpass', 800, 0.003, 0.4, 0.45, { delay: 0.25 }),
  ], { send: 0.25 }),
  // Low rumble and bubbling.
  lavaRift: world([
    noise('lowpass', 200, 0.1, 1.0, 0.55), tone('sine', 55, 0.1, 1.0, 0.28, { freqEnd: 40 }),
    ...[0.2, 0.35, 0.55, 0.7].map((delay) => tone('sine', 200, 0.003, 0.05, 0.09, { freqEnd: 420, delay })),
  ], { send: 0.2 }),
  // Squelching filter sweeps.
  mudBind: world([noise('bandpass', 250, 0.02, 0.35, 0.45, { freqEnd: 1400, q: 6 }), noise('bandpass', 900, 0.02, 0.3, 0.36, { freqEnd: 300, q: 5, delay: 0.2 })]),
  // A spreading flame whoosh.
  flameSpread: world([noise('bandpass', 500, 0.15, 0.6, 0.45, { freqEnd: 3000, q: 0.8 }), ...ticks(5000, 0.14, [0.1, 0.22, 0.31, 0.45])], { send: 0.2 }),
  // A soft hiss.
  mistSpread: world([noise('highpass', 4000, 0.3, 0.8, 0.26), noise('bandpass', 2500, 0.2, 0.6, 0.14, { q: 0.5 })], { send: 0.35 }),
  // Sand grains and a gust.
  sandGust: world([noise('bandpass', 400, 0.15, 0.6, 0.42, { freqEnd: 1800, q: 0.9 }), noise('highpass', 6000, 0.05, 0.6, 0.2), ...ticks(7000, 0.08, [0.1, 0.18, 0.27, 0.38, 0.5])]),
};

// ── Enemies (Req 37.2, 26.5) ─────────────────────────────────────────────────

export type EnemyArchetype = 'plant' | 'brute' | 'beast' | 'shell' | 'wisp' | 'flyer' | 'construct';
export type EnemySound = 'alert' | 'windup' | 'hit' | 'death';
export const ENEMY_ARCHETYPES_LIST: readonly EnemyArchetype[] = ['plant', 'brute', 'beast', 'shell', 'wisp', 'flyer', 'construct'];

/** Sound family of each enemy and Elite. */
export const ENEMY_ARCHETYPES: Readonly<Record<EnemyId | EliteId, EnemyArchetype>> = {
  bramblekin: 'plant',
  thornspitter: 'plant',
  mossbackBrute: 'brute',
  cinderHound: 'beast',
  slagshell: 'shell',
  ashWisp: 'wisp',
  windcutter: 'flyer',
  aetherSentinel: 'construct',
  oldMossback: 'brute',
  emberjaw: 'beast',
  galeclaw: 'flyer',
  rootboundWarden: 'brute',
  cinderAlpha: 'beast',
  sentinelPrime: 'construct',
};

export const enemySfx = (kind: EnemyId | EliteId, sound: EnemySound): SfxId => `sfx_enemy_${ENEMY_ARCHETYPES[kind]}_${sound}`;

interface ArchetypeVoice {
  /** Voice pitch (Hz). */
  readonly base: number;
  readonly wave: SfxWave;
  /** Body noise centre (Hz). */
  readonly body: number;
  /** Metallic / airy FM colour instead of a plain tone. */
  readonly fm?: boolean;
}

const ARCHETYPE_VOICES: Readonly<Record<EnemyArchetype, ArchetypeVoice>> = {
  plant: { base: 330, wave: 'triangle', body: 2500 },
  brute: { base: 110, wave: 'sawtooth', body: 600 },
  beast: { base: 220, wave: 'sawtooth', body: 1500 },
  shell: { base: 160, wave: 'square', body: 900 },
  wisp: { base: 660, wave: 'sine', body: 4000, fm: true },
  flyer: { base: 880, wave: 'triangle', body: 3500 },
  construct: { base: 440, wave: 'sine', body: 2000, fm: true },
};

function voiceLayer(v: ArchetypeVoice, freq: number, attack: number, decay: number, gain: number, freqEnd: number, delay = 0): SfxLayer {
  return v.fm === true
    ? fm(freq, 3.5, 2, attack, decay, gain * 0.8, { freqEnd, delay })
    : tone(v.wave, freq, attack, decay, v.wave === 'sine' ? gain : gain * 0.5, { freqEnd, delay });
}

function archetypeRecipes(a: EnemyArchetype): Record<string, SfxRecipe> {
  const v = ARCHETYPE_VOICES[a];
  const vary = { pitch: 0.05, gainDb: 1.5 };
  return {
    // Alert: a call rising toward the party.
    [`sfx_enemy_${a}_alert`]: world([
      voiceLayer(v, v.base * 1.2, 0.02, 0.25, 0.22, v.base * 1.8), noise('bandpass', v.body, 0.02, 0.2, 0.14, { q: 1.5 }),
    ], { vary, send: 0.2 }),
    // Attack ready: a rising swell for the length of a Telegraph's warning.
    [`sfx_enemy_${a}_windup`]: world([
      voiceLayer(v, v.base, 0.35, 0.2, 0.2, v.base * 2), noise('bandpass', v.body * 0.6, 0.35, 0.15, 0.2, { freqEnd: v.body * 1.6, q: 1.2 }),
    ], { vary, send: 0.15 }),
    [`sfx_enemy_${a}_hit`]: world([
      noise('bandpass', v.body, 0.001, 0.08, 0.32, { q: 1 }), voiceLayer(v, v.base, 0.001, 0.08, 0.14, v.base * 0.7),
    ], { vary }),
    [`sfx_enemy_${a}_death`]: world([
      voiceLayer(v, v.base, 0.01, 0.6, 0.22, v.base * 0.3), noise('lowpass', v.body, 0.01, 0.5, 0.3, { freqEnd: v.body * 0.2 }),
    ], { vary, send: 0.25 }),
  };
}

const ENEMIES: Record<string, SfxRecipe> = Object.assign({}, ...ENEMY_ARCHETYPES_LIST.map(archetypeRecipes)) as Record<string, SfxRecipe>;

const BOSS: Record<string, SfxRecipe> = {
  sfx_boss_roar: world([
    tone('sawtooth', 90, 0.1, 1.2, 0.2, { freqEnd: 60 }), noise('lowpass', 900, 0.1, 1.2, 0.45), fm(180, 3.5, 3, 0.1, 1.0, 0.1),
  ], { send: 0.35 }),
  sfx_boss_windup: world([fm(330, 3.5, 2, 0.2, 0.5, 0.13, { freqEnd: 660 }), noise('highpass', 3000, 0.3, 0.3, 0.18)], { send: 0.3 }),
  sfx_boss_hit: world([fm(520, 3.5, 2, 0.001, 0.25, 0.13), noise('bandpass', 2000, 0.001, 0.08, 0.28)], { vary: { pitch: 0.05, gainDb: 1 } }),
  sfx_boss_shell_break: world([noise('highpass', 2500, 0.001, 0.6, 0.45), fm(1400, 3.5, 4, 0.001, 0.8, 0.13), ...bells([2093, 2637, 3136], 0.07, 0.5, 0.05, 0.1)], { send: 0.4 }),
};

// ── UI, rewards and progress ────────────────────────────────────────────────

const UI: Record<string, SfxRecipe> = {
  sfx_ui_move: ui([tone('sine', 1100, 0.002, 0.035, 0.07)]),
  sfx_ui_confirm: ui([tone('sine', 880, 0.002, 0.06, 0.1), tone('sine', 1320, 0.002, 0.08, 0.08, { delay: 0.05 })]),
  sfx_ui_cancel: ui([tone('sine', 660, 0.002, 0.08, 0.09, { freqEnd: 440 })]),
  // Refused (Skill on cooldown, Burst without Energy, Req 24.5).
  sfx_ui_refuse: ui([tone('square', 180, 0.002, 0.07, 0.06), tone('square', 150, 0.002, 0.07, 0.06, { delay: 0.08 })]),
  sfx_ui_open: ui([tone('sine', 520, 0.01, 0.12, 0.09, { freqEnd: 880 }), noise('highpass', 4000, 0.02, 0.08, 0.035)]),
  sfx_ui_close: ui([tone('sine', 880, 0.005, 0.1, 0.08, { freqEnd: 520 })]),
  // Burst ready (Req 32.7).
  sfx_burst_ready: ui([fm(1046, 2, 1, 0.003, 0.5, 0.1), fm(1568, 2, 1, 0.003, 0.5, 0.08, { delay: 0.08 })], { send: 0.2 }),
};

const PROGRESS: Record<string, SfxRecipe> = {
  // Common and fine Chests share one sound; the glowing Chest has its own (Req 10.6).
  sfx_chest_open: world([noise('lowpass', 900, 0.01, 0.2, 0.26), ...notes([523, 784], 0.1, 0.35, 0.09, 0.15)], { send: 0.2 }),
  sfx_chest_glowing: world([
    noise('lowpass', 900, 0.01, 0.2, 0.26), ...bells([523, 659, 784, 1046], 0.1, 0.8, 0.08, 0.15),
    noise('highpass', 6000, 0.3, 0.6, 0.05, { delay: 0.2 }),
  ], { send: 0.35 }),
  sfx_discovery: ui(bells([659, 988, 1319], 0.15, 1.1, 0.09), { send: 0.4 }),
  // Hidden place (Req 9.6, task 20.1): its own low shimmer and a rising minor bell line, apart from sfx_discovery.
  sfx_hidden_place: ui([
    tone('sine', 131, 0.3, 1.6, 0.12), ...bells([440, 523, 659, 880], 0.18, 1.2, 0.07), noise('highpass', 6000, 0.4, 0.9, 0.03),
  ], { send: 0.55 }),
  sfx_level_up: ui(notes([523, 659, 784, 1046, 1319], 0.07, 0.35, 0.09), { send: 0.3 }),
  // Skyshard: a bell chord and sparkles.
  sfx_skyshard: ui([
    fm(523, 3.5, 2, 0.003, 2.0, 0.08), fm(659, 3.5, 2, 0.003, 2.0, 0.07), fm(784, 3.5, 2, 0.003, 2.0, 0.07),
    noise('highpass', 7000, 0.2, 1.0, 0.06), ...bells([2093, 2637, 3136, 4186], 0.09, 0.6, 0.03, 0.2),
  ], { send: 0.5 }),
  sfx_barrier_break: world([noise('highpass', 2000, 0.001, 0.8, 0.42), tone('sine', 100, 0.002, 0.8, 0.35, { freqEnd: 40 }), fm(1200, 3.5, 3, 0.001, 1.0, 0.1)], { send: 0.4 }),
  sfx_puzzle_step: ui([fm(784, 2, 1, 0.003, 0.3, 0.1)], { send: 0.2 }),
  sfx_puzzle_solved: ui(bells([523, 784, 1046], 0.1, 0.7, 0.09), { send: 0.35 }),
  sfx_puzzle_fail: ui([tone('triangle', 311, 0.005, 0.3, 0.1, { freqEnd: 233 }), tone('triangle', 233, 0.005, 0.35, 0.09, { freqEnd: 175, delay: 0.15 })]),
  sfx_waystone: ui([fm(392, 3.5, 2, 0.05, 1.5, 0.12), tone('sine', 196, 0.3, 1.0, 0.07, { freqEnd: 392 }), noise('highpass', 5000, 0.4, 0.8, 0.04)], { send: 0.45 }),
  sfx_checkpoint: ui([fm(880, 2, 1, 0.003, 0.4, 0.09), fm(1320, 2, 1, 0.003, 0.4, 0.07, { delay: 0.08 })], { send: 0.3 }),
  sfx_pickup: ui([tone('sine', 988, 0.003, 0.1, 0.07, { freqEnd: 1319 })]),
  sfx_altar: ui([tone('sine', 65, 0.5, 2.5, 0.25), fm(262, 3.5, 2, 0.2, 2.5, 0.1), ...bells([392, 523, 784], 0.25, 2.0, 0.06, 0.4)], { send: 0.6 }),
  sfx_quest_complete: ui([...notes([587, 740, 880], 0.09, 0.4, 0.09), fm(1175, 3.5, 1.5, 0.003, 1.0, 0.06, { delay: 0.27 })], { send: 0.3 }),
  sfx_defeat: ui(notes([392, 311, 262], 0.22, 0.7, 0.1), { send: 0.4 }),
};

// ── Loops: air volumes, glide wind, ambient beds and their intermittent sounds ─

const LOOPS: Record<string, SfxRecipe> = {
  // Updraft column (Req 19.8): a rising breathy whoosh.
  sfx_updraft_loop: world([noise('bandpass', 700, 0.5, 0, 0.3, { q: 0.7, lfo: { rate: 0.3, depth: 250 } }), noise('highpass', 3000, 0.5, 0, 0.05)], { loop: true, send: 0.15 }),
  // Wind_Zone: a steadier broad wind.
  sfx_wind_zone_loop: world([noise('bandpass', 1100, 0.5, 0, 0.3, { q: 0.6, lfo: { rate: 0.2, depth: 500 } }), noise('lowpass', 300, 0.5, 0, 0.16)], { loop: true, send: 0.15 }),
  // Glide wind (Req 19.10): the engine drives its gain and lowpass cutoff (500 Hz → 4 kHz) from setGlideWind.
  sfx_glide_wind: world([noise('lowpass', 1500, 0.1, 0, 0.5)], { loop: true, send: 0 }),
  // Region beds (design "환경음").
  sfx_amb_verdant: ambient([noise('lowpass', 420, 1, 0, 0.07, { lfo: { rate: 0.1, depth: 120 } }), tone('sine', 4700, 1, 0, 0.004, { lfo: { rate: 11, depth: 40 } })], { loop: true }),
  sfx_amb_ember: ambient([noise('lowpass', 140, 1, 0, 0.14), noise('bandpass', 900, 1, 0, 0.025, { q: 0.5, lfo: { rate: 0.12, depth: 300 } })], { loop: true }),
  sfx_amb_azure: ambient([noise('bandpass', 1500, 1, 0, 0.08, { q: 0.4, lfo: { rate: 0.15, depth: 800 } }), noise('highpass', 5000, 1, 0, 0.012)], { loop: true }),
  sfx_amb_crater: ambient([tone('sine', 55, 1, 0, 0.06), tone('sine', 82.5, 1, 0, 0.035, { lfo: { rate: 0.2, depth: 6 } }), noise('lowpass', 200, 1, 0, 0.05)], { loop: true }),
  sfx_amb_sanctum: ambient([tone('sine', 65.4, 1, 0, 0.055), fm(130.8, 3.5, 0.5, 1, 0, 0.02), noise('lowpass', 250, 1, 0, 0.035)], { loop: true }),
  // Inside buildings and caves: only a low room tone.
  sfx_amb_interior: ambient([noise('lowpass', 180, 1, 0, 0.08), tone('sine', 60, 1, 0, 0.02)], { loop: true, send: 0.1 }),
  sfx_amb_bird: ambient([
    tone('sine', 2600, 0.005, 0.08, 0.04, { freqEnd: 3400 }), tone('sine', 3000, 0.005, 0.08, 0.035, { freqEnd: 2400, delay: 0.1 }),
    tone('sine', 2800, 0.005, 0.06, 0.03, { freqEnd: 3600, delay: 0.2 }),
  ], { vary: { pitch: 0.12, gainDb: 3 } }),
  sfx_amb_cricket: ambient([0, 0.05, 0.1, 0.15].map((delay) => tone('sine', 4600, 0.002, 0.02, 0.02, { delay })) as SfxLayer[], { vary: { pitch: 0.05, gainDb: 3 } }),
  sfx_amb_crackle: ambient(ticks(3000, 0.12, [0, 0.04, 0.09, 0.2]), { vary: { pitch: 0.2, gainDb: 3 } }),
  sfx_amb_rumble: ambient([noise('lowpass', 120, 0.4, 1.5, 0.18)], { vary: { pitch: 0.1, gainDb: 2 } }),
  sfx_amb_chime: ambient(bells([1760, 2349], 0.12, 1.5, 0.04), { vary: { pitch: 0.06, gainDb: 3 }, send: 0.5 }),
  sfx_amb_crystal: ambient([fm(1047, 3.5, 0.8, 0.3, 2.0, 0.035)], { vary: { pitch: 0.15, gainDb: 3 }, send: 0.6 }),
  sfx_amb_drip: ambient([tone('sine', 900, 0.001, 0.05, 0.05, { freqEnd: 1800 })], { vary: { pitch: 0.2, gainDb: 3 }, send: 0.6 }),
  // Base of the speakers' voice blips (the engine plays it at each speaker's pitch).
  sfx_voice_blip: { group: 'voice', layers: [tone('triangle', 440, 0.005, 0.05, 0.12)], send: 0.05 },
};

const REACTIONS: Record<string, SfxRecipe> = {};
for (const [reaction, recipe] of Object.entries(REACTION_RECIPES) as [ReactionId, SfxRecipe][]) {
  REACTIONS[REACTION_PRESENTATION[reaction].sfx] = recipe;
}

/** Every recipe by id. */
export const SFX_RECIPES: Readonly<Record<SfxId, SfxRecipe>> = {
  ...MOVEMENT, ...CHARACTERS, ...HITS, ...REACTIONS, ...ENEMIES, ...BOSS, ...UI, ...PROGRESS, ...LOOPS,
} as Record<SfxId, SfxRecipe>;

/** The recipe of `id`, or null. */
export function sfxRecipe(id: string): SfxRecipe | null {
  return Object.prototype.hasOwnProperty.call(SFX_RECIPES, id) ? (SFX_RECIPES as Record<string, SfxRecipe>)[id] ?? null : null;
}

/** Seconds from the start of a one-shot recipe to the end of its last layer. */
export function recipeLength(r: SfxRecipe): number {
  let end = 0;
  for (const l of r.layers) end = Math.max(end, (l.delay ?? 0) + l.attack + l.decay);
  return end;
}

// ── Voice blips (Req 37.7) ──────────────────────────────────────────────────

/** A blip's whole length (s) at most. */
export const VOICE_BLIP_MAX_SECONDS = 0.3;
/** Semitone steps a blip's syllables pick from around the speaker's pitch. */
const BLIP_INTERVALS = [0, 2, 3, 5, 7, -2] as const;
const BLIP_GAP = 0.01;

/**
 * The blip of one dialogue window: 3–4 short syllables around the speaker's pitch `hz`, drawn from `draw` (a seeded
 * stream, e.g. from the dialogue id and line), ≤ 0.3 s in all, in the sfx `voice` group.
 */
export function voiceBlipRecipe(hz: number, draw: { int(a: number, b: number): number; pick<T>(arr: readonly T[]): T }): SfxRecipe {
  const base = SFX_RECIPES.sfx_voice_blip;
  const wave = base?.layers[0]?.kind === 'tone' ? base.layers[0].wave : 'triangle';
  const count = draw.int(3, 4);
  const syllable = (VOICE_BLIP_MAX_SECONDS - BLIP_GAP * (count - 1)) / count - 0.002;
  const layers: SfxLayer[] = [];
  for (let i = 0; i < count; i++) {
    const semis = i === 0 ? 0 : draw.pick(BLIP_INTERVALS);
    layers.push(tone(wave, hz * 2 ** (semis / 12), 0.006, syllable - 0.006, 0.11, { delay: i * (syllable + BLIP_GAP) }));
  }
  return { group: 'voice', layers, send: 0.05 };
}
