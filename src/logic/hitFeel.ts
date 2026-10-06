// Hit feel rules (design "공격·피격·Stagger" Hit_Stop, "흔들림과 impulse"; Req 26.3, 26.4). One table for every
// source of Hit_Stop and camera impulse, read by the simulation (the Hit_Stop request through GameLoop.setTimeScale)
// and by the presentation (the camera trauma), so both sides agree:
// - Charged_Attack final hit: Hit_Stop 60 ms, trauma 0.35.
// - Burst: Hit_Stop 80 ms on its first landing hit of a cast; trauma 0.5 when it is cast ('burst:cast').
// - Explosive Reactions (effect kind 'burst': steamBurst): the Reaction's own Hit_Stop (70 ms), trauma 0.4.
// - Element_Shield break: Hit_Stop 70 ms, trauma 0.4; Caelith's Starshell break: 80 ms, trauma 0.4.
// - Normal_Attack hits (and every other hit) never stop the simulation or shake the camera.
// Every Hit_Stop lies in [HIT_STOP_MIN, HIT_STOP_MAX] of real time. A positioned impulse fades with its distance from
// the Active_Character: full up to 15 m, linearly to 0 at 30 m. Pure: no three.js / DOM.

import { CHARACTERS } from '../data/characters';
import { CHARACTER_IDS, type AttackId, type ReactionId } from '../data/ids';
import { REACTION_DEFS } from '../data/reactions';
import type { DamageKind } from './damage';

/** Real-time Hit_Stop range (s, Req 26.3: 50–90 ms). */
export const HIT_STOP_MIN = 0.05;
export const HIT_STOP_MAX = 0.09;

/** Impulses fade from this distance (m) to zero at TRAUMA_FALLOFF_FAR. */
export const TRAUMA_FALLOFF_NEAR = 15;
export const TRAUMA_FALLOFF_FAR = 30;

export type HitFeelSource =
  | 'normalHit'
  | 'chargedFinal'
  | 'burstHit'
  | 'burstCast'
  | 'explosiveReaction'
  | 'shieldBreak'
  | 'starshellBreak';

/** Hit_Stop (real s, 0 = none) and camera trauma (0..1, 0 = none) of one source. */
export interface HitFeel {
  readonly hitStop: number;
  readonly trauma: number;
}

export const NO_HIT_FEEL: HitFeel = { hitStop: 0, trauma: 0 };

const steam = REACTION_DEFS.steamBurst.effect;
const STEAM_HIT_STOP = steam.kind === 'burst' ? steam.hitStop : 0.07;

export const HIT_FEEL: Readonly<Record<HitFeelSource, HitFeel>> = {
  normalHit: NO_HIT_FEEL,
  chargedFinal: { hitStop: 0.06, trauma: 0.35 },
  burstHit: { hitStop: 0.08, trauma: 0 },
  burstCast: { hitStop: 0, trauma: 0.5 },
  explosiveReaction: { hitStop: STEAM_HIT_STOP, trauma: 0.4 },
  shieldBreak: { hitStop: 0.07, trauma: 0.4 },
  starshellBreak: { hitStop: 0.08, trauma: 0.4 },
};

/** Last HitEvent index of every character's Charged_Attack, by attack id. */
const CHARGED_FINAL: ReadonlyMap<AttackId, number> = new Map(
  CHARACTER_IDS.map((id): [AttackId, number] => [CHARACTERS[id].charged.id, CHARACTERS[id].charged.hits.length - 1]),
);

/** HitEvent `hitIndex` of `attackId` is the last hit of a Charged_Attack. */
export function isChargedFinalHit(attackId: AttackId, hitIndex: number): boolean {
  return CHARGED_FINAL.get(attackId) === hitIndex;
}

/** The Reaction is explosive (effect kind 'burst'): it stops the simulation and shakes the camera. */
export function isExplosiveReaction(reaction: ReactionId): boolean {
  return REACTION_DEFS[reaction].effect.kind === 'burst';
}

/** Source of a party hit: Charged final, Burst, or a plain hit (Normal_Attack, Skill, Reaction damage, ...). */
export function hitSourceOf(kind: DamageKind, attackId: AttackId, hitIndex: number): HitFeelSource {
  if (kind === 'charged' && isChargedFinalHit(attackId, hitIndex)) return 'chargedFinal';
  if (kind === 'burst') return 'burstHit';
  return 'normalHit';
}

/** Hit feel of a party hit. */
export function hitFeelOfHit(kind: DamageKind, attackId: AttackId, hitIndex: number): HitFeel {
  return HIT_FEEL[hitSourceOf(kind, attackId, hitIndex)];
}

/** Hit feel of a Reaction: explosive ones use their own Hit_Stop (data) and the explosive trauma; the rest none. */
export function reactionHitFeel(reaction: ReactionId): HitFeel {
  const effect = REACTION_DEFS[reaction].effect;
  if (effect.kind !== 'burst') return NO_HIT_FEEL;
  return { hitStop: effect.hitStop, trauma: HIT_FEEL.explosiveReaction.trauma };
}

/** Impulse scale at `distance` m from the Active_Character: 1 up to 15 m, 0 from 30 m, linear between. */
export function traumaFalloff(distance: number): number {
  if (!(distance > TRAUMA_FALLOFF_NEAR)) return Number.isNaN(distance) ? 0 : 1;
  if (distance >= TRAUMA_FALLOFF_FAR) return 0;
  return (TRAUMA_FALLOFF_FAR - distance) / (TRAUMA_FALLOFF_FAR - TRAUMA_FALLOFF_NEAR);
}

/** `trauma` of a source at `distance` m (no position: pass 0). */
export function traumaAt(trauma: number, distance: number): number {
  return trauma > 0 ? trauma * traumaFalloff(distance) : 0;
}
