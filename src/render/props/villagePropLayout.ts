/*
 * Where Thistlewick's small props stand (design.md "식생·바위·소품": fences, crates, lanterns, carts): barrels and crate
 * stacks behind the houses, Elder Maren's woodpile, a hand cart and a fence at Hobb's field, crates at the camp_durga
 * forge. Every spot keeps clear of the dirt paths, so none stands on a walking line. The vegetation keep-outs read
 * this layout too. Pure: data and the terrain's path distance, no three.js / DOM.
 */
import { DURGA_CAMP_PROPS, HOBB_FIELD, VILLAGE_BUILDINGS, type VillageBuildingDef } from '../../data/village';
import { distanceToPath, PATH_HALF_WIDTH } from '../../world/terrain';

export type VillagePropKind = 'barrel' | 'crate' | 'woodpile' | 'cart' | 'fencePost' | 'fenceRail';

export interface VillagePropSpot {
  readonly kind: VillagePropKind;
  readonly x: number;
  readonly z: number;
  /** Facing (rad, three.js rotation.y). */
  readonly yaw: number;
  /** Footprint radius (m), for keep-outs. */
  readonly radius: number;
  /** Rails: length (m) along x. */
  readonly length?: number;
}

/** Props keep this far beyond the dirt path's half width (m). */
export const PROP_PATH_CLEARANCE = 1.2;

/** Building-local (vx, vz) → world (the buildingFootprint convention: rotation.y = yaw). */
function local(def: VillageBuildingDef, vx: number, vz: number): { x: number; z: number } {
  const c = Math.cos(def.yaw);
  const s = Math.sin(def.yaw);
  return { x: def.center.x + vx * c + vz * s, z: def.center.z - vx * s + vz * c };
}

let cached: readonly VillagePropSpot[] | null = null;

/** Every prop spot of the village and the camps, clear of the paths. */
export function villagePropSpots(): readonly VillagePropSpot[] {
  if (cached !== null) return cached;
  const out: VillagePropSpot[] = [];
  const push = (spot: VillagePropSpot): boolean => {
    if (distanceToPath(spot.x, spot.z) < PATH_HALF_WIDTH + PROP_PATH_CLEARANCE + spot.radius) return false;
    out.push(spot);
    return true;
  };
  for (const def of VILLAGE_BUILDINGS) {
    if (def.kind !== 'house' && def.kind !== 'marenHouse') continue;
    const back = -(def.half.z + 0.55);
    const w = def.half.x;
    push({ kind: 'barrel', ...local(def, -0.55 * w, back), yaw: def.yaw, radius: 0.4 });
    push({ kind: 'barrel', ...local(def, -0.55 * w + 0.78, back + 0.05), yaw: def.yaw + 0.7, radius: 0.4 });
    push({ kind: 'crate', ...local(def, 0.5 * w, back), yaw: def.yaw + 0.15, radius: 0.6 });
    if (def.kind === 'marenHouse') push({ kind: 'woodpile', ...local(def, def.half.x + 0.7, -0.3 * def.half.z), yaw: def.yaw + Math.PI / 2, radius: 1.1 });
  }
  const f = HOBB_FIELD;
  push({ kind: 'cart', x: f.center.x - f.halfX - 2.6, z: f.center.z + f.halfZ - 2.5, yaw: 0.35, radius: 1.5 });
  // A fence along the field's south edge: posts every 2.5 m, rails between neighbours that both stand.
  const fz = f.center.z + f.halfZ + 0.9;
  let prev: VillagePropSpot | null = null;
  for (let x = f.center.x - f.halfX; x <= f.center.x + f.halfX + 1e-6; x += 2.5) {
    const post: VillagePropSpot = { kind: 'fencePost', x, z: fz, yaw: 0, radius: 0.15 };
    const stood = push(post);
    if (stood && prev !== null) push({ kind: 'fenceRail', x: (prev.x + x) / 2, z: fz, yaw: 0, radius: 0.15, length: x - prev.x });
    prev = stood ? post : null;
  }
  const forge = DURGA_CAMP_PROPS.forge;
  push({ kind: 'crate', x: forge.x - 2.2, z: forge.z + 1.6, yaw: 0.4, radius: 0.6 });
  push({ kind: 'barrel', x: forge.x + 2.0, z: forge.z + 1.2, yaw: 0, radius: 0.4 });
  cached = out;
  return out;
}
