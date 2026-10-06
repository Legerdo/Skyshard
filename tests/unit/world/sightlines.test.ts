import { beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/core/types';
import type { LandmarkId } from '../../../src/data/ids';
import {
  LANDMARK_SILHOUETTES, SIGHTLINE_EYE_HEIGHT, SIGHTLINE_MAX_ANGLE_DEG, SIGHTLINES, silhouettePoint,
} from '../../../src/data/pois';
import { MAIN_REGION_IDS } from '../../../src/data/regions';
import { VISTA_LIST } from '../../../src/data/vistas';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import type { CollisionWorld } from '../../../src/physics/types';
import { buildTerrain, type TerrainField } from '../../../src/world/terrain';

// Task 20.3 (design "60 m 커버리지 검증" 3–4; Req 9.3, 9.8): sightlines and Vista views over the heightfield only (a
// CollisionWorld without colliders), from the eye height pos.y + 1.55 m.

const SEED = 20240601; // main.ts DEV_WORLD_SEED

let terrain: TerrainField;
let world: CollisionWorld;
beforeAll(() => {
  terrain = buildTerrain(SEED);
  world = createCollisionWorld(terrain);
});

/** Whether the straight line eye → point is not blocked by the terrain. */
function clear(eye: Readonly<Vec3>, point: Readonly<Vec3>): boolean {
  const d = { x: point.x - eye.x, y: point.y - eye.y, z: point.z - eye.z };
  const len = Math.hypot(d.x, d.y, d.z);
  const hit = world.raycast({ ...eye }, { x: d.x / len, y: d.y / len, z: d.z / len }, len);
  return hit === null;
}

/** Representative Landmark of each main Region: its first (main-path) Landmark. */
const REPRESENTATIVE: Readonly<Record<string, LandmarkId>> = {
  verdant: 'lm_elderbough', ember: 'lm_cinderspire', azure: 'lm_observatory',
};

describe('Sightlines (Req 9.8)', () => {
  it('lists sl_verdant, sl_ember and sl_azure, one per main Region', () => {
    expect(SIGHTLINES.map((s) => s.id).sort()).toEqual(['sl_azure', 'sl_ember', 'sl_verdant']);
    expect(SIGHTLINES.map((s) => s.region).sort()).toEqual([...MAIN_REGION_IDS].sort());
  });

  it.each(SIGHTLINES.map((s) => [s.id, s] as const))(
    '%s: the next Landmark silhouette centre is within 15° of the path direction and nothing blocks it',
    (_id, s) => {
      const ground = terrain.heightAt(s.pos.x, s.pos.z);
      // The sightline stands on the ground (its y is the terrain height there).
      expect(Math.abs(ground - s.pos.y)).toBeLessThan(0.5);
      const eye = { x: s.pos.x, y: s.pos.y + SIGHTLINE_EYE_HEIGHT, z: s.pos.z };
      const centre = silhouettePoint(s.target, 0.5);
      const fx = s.pathDir.x;
      const fz = s.pathDir.z;
      const fl = Math.hypot(fx, fz);
      const tx = centre.x - eye.x;
      const tz = centre.z - eye.z;
      const tl = Math.hypot(tx, tz);
      const angle = (Math.acos(Math.max(-1, Math.min(1, (fx * tx + fz * tz) / (fl * tl)))) * 180) / Math.PI;
      expect(angle).toBeLessThanOrEqual(SIGHTLINE_MAX_ANGLE_DEG);
      expect(clear(eye, centre)).toBe(true);
    },
  );
});

describe('Vista views (Req 9.3)', () => {
  const FRACTIONS = [0.5, 0.75, 1] as const;
  const seen = (eye: Vec3, id: LandmarkId): boolean => FRACTIONS.some((f) => clear(eye, silhouettePoint(id, f)));

  it.each(VISTA_LIST.map((v) => [v.id, v] as const))(
    '%s sees another main Region’s representative Landmark and lm_astral_sanctum (50 / 75 / 100 % of its height)',
    (_id, vista) => {
      const eye = { x: vista.x, y: vista.groundY + SIGHTLINE_EYE_HEIGHT, z: vista.z };
      const others = MAIN_REGION_IDS.filter((r) => r !== vista.region);
      const visible = others.filter((r) => seen(eye, REPRESENTATIVE[r] as LandmarkId));
      expect(visible.length, `${vista.id} sees no Landmark of ${others.join(' / ')}`).toBeGreaterThanOrEqual(1);
      expect(seen(eye, 'lm_astral_sanctum')).toBe(true);
    },
  );

  it('every Landmark has a silhouette with a positive height span', () => {
    for (const [id, s] of Object.entries(LANDMARK_SILHOUETTES)) expect(s.maxY - s.minY, id).toBeGreaterThan(0);
  });

  it('a ray into a hill is blocked (the check is not vacuous)', () => {
    const v = VISTA_LIST[0];
    if (v === undefined) throw new Error('no Vista');
    const eye = { x: v.x, y: terrain.heightAt(v.x, v.z) + 0.2, z: v.z };
    // Straight down into the ground under the stand point.
    expect(clear(eye, { x: v.x, y: eye.y - 50, z: v.z })).toBe(false);
  });
});
