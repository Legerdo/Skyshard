// Front guard of Mossback Brute (and Old Mossback, which keeps its base kind's guard): design "적 정의",
// "피해 공식"; Req 28.11. While the guard is up, a hit whose attacker stands inside the frontal sector is sampled
// with `frontGuard = true`, and computeDamage cuts Normal_Attack damage to ×0.3 (FRONT_GUARD_MUL). A hit carrying
// the break Element (Ember) or any Charged_Attack hit breaks the guard for a 3 s Stagger; the guard comes back when
// that Stagger ends. The runtime lives in src/enemies; these are the pure rules.
// The back weak spot of Rootbound Warden is the mirrored test (hitsFromBehind).
// Pure: no three.js / DOM / randomness.

import { DEG2RAD, dirFromYaw } from '../core/math';
import type { Vec3 } from '../core/types';
import type { ElementId } from '../data/ids';
import type { DamageKind } from './damage';

/** The guard fields the rules read (data/enemies FrontGuardDef). */
export interface FrontGuardRule {
  /** Frontal sector covered (deg), centred on the facing. */
  arcDeg: number;
  /** A hit carrying this Element breaks the guard. */
  breakElement: ElementId;
  /** Any Charged_Attack hit breaks the guard. */
  breakByCharged: boolean;
}

/** Slack on the sector edge so an attacker exactly on it counts as in front. */
const EDGE_EPS = 1e-9;

/**
 * Whether a hit travelling along `hitDir` (horizontal, attacker → target) reaches a target facing `yaw` from
 * inside its `arcDeg` frontal sector, i.e. the attacker lies within arcDeg / 2 of the facing (edge included).
 * A zero or non-finite direction or yaw is never guarded.
 */
export function guardCovers(yaw: number, hitDir: Readonly<Vec3>, arcDeg: number): boolean {
  const len = Math.hypot(hitDir.x, hitDir.z);
  if (!(len > 1e-9) || !Number.isFinite(yaw) || !Number.isFinite(arcDeg)) return false;
  const f = dirFromYaw(yaw);
  // The attacker sits at −hitDir from the target.
  const cos = -(hitDir.x * f.x + hitDir.z * f.z) / len;
  return cos >= Math.cos((Math.max(0, arcDeg) / 2) * DEG2RAD) - EDGE_EPS;
}

/**
 * Rootbound Warden's back weak spot (design "Elite" table, data/enemies `backWeakSpot`): whether a hit travelling along
 * `hitDir` (attacker → target) comes from inside the `arcDeg` sector behind a target facing `yaw`, i.e. the attacker
 * lies within arcDeg / 2 of the target's back (edge included). A zero or non-finite direction or yaw never is.
 */
export function hitsFromBehind(yaw: number, hitDir: Readonly<Vec3>, arcDeg: number): boolean {
  return guardCovers(yaw + Math.PI, hitDir, arcDeg);
}

/** A hit breaks the guard when it carries `breakElement` or, with `breakByCharged`, is a Charged_Attack hit. */
export function breaksGuard(
  rule: Readonly<FrontGuardRule>,
  hit: { readonly kind: DamageKind; readonly element: ElementId | null },
): boolean {
  return (hit.element !== null && hit.element === rule.breakElement) || (rule.breakByCharged && hit.kind === 'charged');
}
