/*
 * Where the Blight grows (design.md "Blight"; Req 4.7, 18.1). Pure and deterministic from the terrain seed (no
 * three.js, no Math.random): seeded sites scattered over each ground Region (Verdant, Ember, Azure and the crater;
 * the floating Sanctum has no ground) plus sites along both sides of the Blight veils, where the corruption is
 * thickest. Each site is a ground patch (the purple mask on the terrain) with a cluster of crystals and a few thorn
 * vines on it.
 *
 * Every Blight decoration stays below MIN_BLOCKING_PROP_HEIGHT, so none gets a collider (the decor rule of
 * src/physics/decor.ts: characters walk through it like grass) and the patches lie only on ground no steeper than
 * BLIGHT_MAX_SLOPE_DEG: no Blight surface can be attached to by the climbing queries, while the Blight walls and veils
 * (src/world/gateSystem.ts) are colliders with `climbable: false` (Req 18.1).
 */
import { createRng, type Rng } from '../core/rng';
import { BARRIERS, wallPieces } from '../data/barriers';
import type { RegionId } from '../data/ids';
import { RESONANCE_ALTAR } from '../data/starlitStair';
import { VILLAGE_CENTER } from '../data/village';
import { boundsContain, LOCATIONS, PLAY_RADIUS, REGIONS, type RegionBounds } from '../data/worldLayout';
import { MIN_BLOCKING_PROP_HEIGHT } from '../physics/decor';
import { dominantRegionAt, type TerrainField } from '../world/terrain';

/** Tallest Blight decoration (m): under the blocking-prop height, so no collider exists to climb. */
export const BLIGHT_MAX_DECOR_HEIGHT = Math.min(0.95, MIN_BLOCKING_PROP_HEIGHT - 0.05);
/** Patches only on ground at most this steep (walkable, never a climbing face). */
export const BLIGHT_MAX_SLOPE_DEG = 32;
/** Scattered sites per Region. */
export const BLIGHT_SITE_COUNTS: Readonly<Record<RegionId, number>> = { verdant: 22, ember: 26, azure: 26, crater: 30, sanctum: 0 };
/** Veil-side sites: one each side every this many metres of veil. */
const VEIL_SITE_SPACING = 55;
const MIN_SITE_GAP = 20;
const LOCATION_KEEP_OUT = 14;
const VILLAGE_KEEP_OUT = 78;
const ALTAR_KEEP_OUT = 20;

export interface BlightCrystal {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly height: number;
  readonly radius: number;
  readonly yaw: number;
  readonly tiltX: number;
  readonly tiltZ: number;
}

export interface BlightVine {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Uniform scale of the unit arch (1 m long, 0.3 m high). */
  readonly scale: number;
  readonly yaw: number;
}

export interface BlightSite {
  readonly region: RegionId;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Patch radius (m). */
  readonly radius: number;
  readonly seed: number;
  readonly crystals: readonly BlightCrystal[];
  readonly vines: readonly BlightVine[];
}

/** The terrain queries the layout needs (a TerrainField satisfies it). */
export type BlightTerrain = Pick<TerrainField, 'seed' | 'heightAt' | 'slopeDeg' | 'waterDepthAt' | 'insideBoundary'>;

/** Arch height of the unit vine (m at scale 1; its thorns reach ≈ 0.12 m higher). */
export const VINE_ARCH_HEIGHT = 0.3;
/** Largest vine scale: the scaled vine with its thorns stays under MIN_BLOCKING_PROP_HEIGHT. */
export const VINE_MAX_SCALE = 2;

const KEEP_OUTS: readonly { x: number; z: number; r: number }[] = [
  ...Object.values(LOCATIONS).map((l) => ({ x: l.x, z: l.z, r: LOCATION_KEEP_OUT })),
  { x: VILLAGE_CENTER.x, z: VILLAGE_CENTER.z, r: VILLAGE_KEEP_OUT },
  { x: RESONANCE_ALTAR.pos.x, z: RESONANCE_ALTAR.pos.z, r: ALTAR_KEEP_OUT },
];

/** A uniform point in the bounds' bounding box (the caller rejects points outside the polygon). */
function samplePoint(b: RegionBounds, rng: Rng): { x: number; z: number } {
  if (b.kind === 'circle') {
    const a = rng.range(0, Math.PI * 2);
    const r = b.radius * Math.sqrt(rng.next());
    return { x: b.center.x + Math.cos(a) * r, z: b.center.z + Math.sin(a) * r };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of b.points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  return { x: rng.range(minX, maxX), z: rng.range(minZ, maxZ) };
}

/** Whether a patch of `radius` centred on (x, z) may grow there. */
function siteAllowed(t: BlightTerrain, x: number, z: number, radius: number, taken: readonly { x: number; z: number }[]): boolean {
  if (Math.hypot(x, z) > PLAY_RADIUS - radius - 6) return false;
  for (const k of KEEP_OUTS) if (Math.hypot(x - k.x, z - k.z) < k.r + radius) return false;
  for (const s of taken) if (Math.hypot(x - s.x, z - s.z) < MIN_SITE_GAP) return false;
  const probes = [[0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius]] as const;
  for (const [dx, dz] of probes) {
    const px = x + dx;
    const pz = z + dz;
    if (!t.insideBoundary(px, pz) || t.waterDepthAt(px, pz) > 0 || t.slopeDeg(px, pz) > BLIGHT_MAX_SLOPE_DEG) return false;
  }
  return true;
}

function buildSite(t: BlightTerrain, region: RegionId, x: number, z: number, radius: number, seed: number): BlightSite {
  const rng = createRng(seed);
  const crystals: BlightCrystal[] = [];
  const count = rng.int(3, 6);
  for (let i = 0; i < count; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = i === 0 ? rng.range(0, 0.4) : rng.range(0.3, radius * 0.45);
    const cx = x + Math.cos(a) * r;
    const cz = z + Math.sin(a) * r;
    const height = i === 0 ? rng.range(0.7, BLIGHT_MAX_DECOR_HEIGHT) : rng.range(0.32, 0.8);
    crystals.push({
      x: cx, y: t.heightAt(cx, cz) - 0.06, z: cz, height, radius: height * rng.range(0.16, 0.24), yaw: rng.range(0, Math.PI * 2),
      // Lean outward from the cluster centre.
      tiltX: Math.sin(a) * rng.range(0.05, 0.45), tiltZ: -Math.cos(a) * rng.range(0.05, 0.45),
    });
  }
  const vines: BlightVine[] = [];
  const vineCount = rng.int(2, 4);
  for (let i = 0; i < vineCount; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(radius * 0.2, radius * 0.75);
    const vx = x + Math.cos(a) * r;
    const vz = z + Math.sin(a) * r;
    vines.push({ x: vx, y: t.heightAt(vx, vz) - 0.03, z: vz, scale: rng.range(1.1, VINE_MAX_SCALE), yaw: rng.range(0, Math.PI * 2) });
  }
  return { region, x, y: t.heightAt(x, z), z, radius, seed, crystals, vines };
}

/** The ground Region at (x, z) (the Sanctum floats; its ground is the crater's). */
function regionAt(x: number, z: number): RegionId {
  return dominantRegionAt(x, z);
}

/** Every Blight site of the world for `terrain` (deterministic in its seed). */
export function blightLayout(terrain: BlightTerrain): BlightSite[] {
  const sites: BlightSite[] = [];
  const base = (terrain.seed ^ 0xb116b7) >>> 0;
  // Veil sides first: the thickest corruption, where it presses against the locked Regions.
  const veilRng = createRng(base ^ 0x5eed);
  for (const id of ['veil_ember', 'veil_azure'] as const) {
    const def = BARRIERS[id];
    if (def.kind !== 'veil') continue;
    for (const piece of wallPieces(def)) {
      if (piece.bottomY > 0) continue; // lintels over the gates
      const dx = piece.b.x - piece.a.x;
      const dz = piece.b.z - piece.a.z;
      const len = Math.hypot(dx, dz);
      if (!(len > 1)) continue;
      const ux = dx / len;
      const uz = dz / len;
      for (let s = VEIL_SITE_SPACING / 2; s < len; s += VEIL_SITE_SPACING) {
        for (const side of [-1, 1]) {
          const off = veilRng.range(7, 16);
          const radius = veilRng.range(4, 8);
          const x = piece.a.x + ux * s - uz * off * side;
          const z = piece.a.z + uz * s + ux * off * side;
          const seed = veilRng.int(1, 0x7fffffff);
          if (!siteAllowed(terrain, x, z, radius, sites)) continue;
          sites.push(buildSite(terrain, regionAt(x, z), x, z, radius, seed));
        }
      }
    }
  }
  // Scattered sites per Region.
  for (const region of ['verdant', 'ember', 'azure', 'crater'] as const) {
    const rng = createRng((base + region.length * 7919 + region.charCodeAt(0) * 104729) >>> 0);
    const bounds = REGIONS[region].bounds;
    const want = BLIGHT_SITE_COUNTS[region];
    let placed = 0;
    for (let attempt = 0; attempt < want * 60 && placed < want; attempt++) {
      const p = samplePoint(bounds, rng);
      const radius = rng.range(4, 9);
      const seed = rng.int(1, 0x7fffffff);
      if (!boundsContain(bounds, p.x, p.z) || regionAt(p.x, p.z) !== region) continue;
      if (!siteAllowed(terrain, p.x, p.z, radius, sites)) continue;
      sites.push(buildSite(terrain, region, p.x, p.z, radius, seed));
      placed++;
    }
  }
  return sites;
}
