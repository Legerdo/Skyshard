/*
 * Interaction target selection (design.md "Dialogue_System" prompt rule, event `interact`; Req 14.3, 4.9):
 * the Active_Character is offered the nearest available target within 2.5 m.
 *
 * A target is a horizontal segment a → b (a point when a = b) thickened by `radius`, standing `height`
 * tall from the segment's height: an NPC or plinth is a point with its body radius, a gate wall is the
 * segment along its length. The distance is measured horizontally from the character's feet to the
 * target's surface (0 when touching or inside), and the feet must be within
 * INTERACT_VERTICAL_TOLERANCE of the target's vertical span, so a target on a ledge above or below
 * is not offered. Ties go to the smaller id, so the choice never depends on registration order.
 *
 * Pure: no three.js, DOM or Math.random.
 */

import type { Vec3 } from '../core/types';

/** Reach of the interaction prompt (m, Req 14.3). */
export const INTERACT_RANGE = 2.5;

/** How far the feet may be below or above a target's vertical span (m). */
export const INTERACT_VERTICAL_TOLERANCE = 1;

export interface InteractCandidate {
  readonly id: string;
  readonly a: Readonly<Vec3>;
  readonly b: Readonly<Vec3>;
  /** Horizontal thickness around the segment (m, ≥ 0). */
  readonly radius: number;
  /** Height of the target above the segment (m, ≥ 0). */
  readonly height: number;
}

/**
 * Horizontal distance from `feet` to the target's surface (≥ 0), or null when the feet are outside the
 * target's vertical span plus the tolerance, or any input is not finite.
 */
export function interactDistance(c: InteractCandidate, feet: Readonly<Vec3>): number | null {
  const abx = c.b.x - c.a.x;
  const abz = c.b.z - c.a.z;
  const len2 = abx * abx + abz * abz;
  const raw = len2 > 0 ? ((feet.x - c.a.x) * abx + (feet.z - c.a.z) * abz) / len2 : 0;
  const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  const px = c.a.x + abx * t;
  const pz = c.a.z + abz * t;
  const py = c.a.y + (c.b.y - c.a.y) * t;
  const below = py - feet.y;
  const above = feet.y - (py + Math.max(0, c.height));
  if (below > INTERACT_VERTICAL_TOLERANCE || above > INTERACT_VERTICAL_TOLERANCE) return null;
  const d = Math.max(0, Math.hypot(feet.x - px, feet.z - pz) - Math.max(0, c.radius));
  return Number.isFinite(d) ? d : null;
}

/** The nearest candidate within `range` of `feet` (ties: the smaller id), or null when none is in reach. */
export function selectInteractTarget<T extends InteractCandidate>(
  candidates: Iterable<T>,
  feet: Readonly<Vec3>,
  range: number = INTERACT_RANGE,
): T | null {
  let best: T | null = null;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = interactDistance(c, feet);
    if (d === null || d > range) continue;
    if (d < bestDistance || (d === bestDistance && best !== null && c.id < best.id)) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}
