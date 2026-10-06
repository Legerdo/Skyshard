/*
 * Ambient beds (design "환경음", task 16.3, Req 37.2): per Region a looped bed in the sfx `ambient` group and the
 * sparse sounds laid over it at seeded 1–4 s intervals. `'interior'` (buildings, caves) keeps only a low room tone
 * and drips. Pure data: the AudioEngine plays it.
 */

import type { RegionId, SfxId } from '../data/ids';

export type AmbientId = RegionId | 'interior';

export interface AmbientDef {
  /** Looped bed recipe. */
  readonly bed: SfxId;
  /** Sparse sounds, one picked at random each time. */
  readonly intermittent: readonly SfxId[];
  /** Gain of the intermittent sounds (their pan is random within ±0.7). */
  readonly intermittentGain: number;
}

/** Bed crossfade (s). */
export const AMBIENT_FADE_SECONDS = 2;
/** Seconds between intermittent sounds, drawn uniformly. */
export const INTERMITTENT_MIN_SECONDS = 1;
export const INTERMITTENT_MAX_SECONDS = 4;

export const AMBIENT_DEFS: Readonly<Record<AmbientId, AmbientDef>> = {
  // Birdsong and insects.
  verdant: { bed: 'sfx_amb_verdant', intermittent: ['sfx_amb_bird', 'sfx_amb_bird', 'sfx_amb_cricket'], intermittentGain: 1 },
  // Crackling embers and a low rumble.
  ember: { bed: 'sfx_amb_ember', intermittent: ['sfx_amb_crackle', 'sfx_amb_crackle', 'sfx_amb_rumble'], intermittentGain: 1 },
  // High wind and wind chimes.
  azure: { bed: 'sfx_amb_azure', intermittent: ['sfx_amb_chime'], intermittentGain: 1 },
  // Low drone and crystal resonance.
  crater: { bed: 'sfx_amb_crater', intermittent: ['sfx_amb_crystal'], intermittentGain: 1 },
  sanctum: { bed: 'sfx_amb_sanctum', intermittent: ['sfx_amb_crystal', 'sfx_amb_chime'], intermittentGain: 0.8 },
  interior: { bed: 'sfx_amb_interior', intermittent: ['sfx_amb_drip'], intermittentGain: 0.8 },
};
