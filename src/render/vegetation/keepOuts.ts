/*
 * Where vegetation must not grow (design.md "식생·바위·소품"; Req 39.4): the village's buildings and fixtures (the
 * `plaza_step` included), the plaza, Hobb's field, the flower beds, lanterns, tents and the camps' props, every POI and
 * POI structure, the Waystones, the Challenge_Areas, the Blight walls, and — for the tall kinds only — the key
 * location pads and the Landmark footprints. Each shape blocks a set of kinds (bit mask); the placer grows every
 * shape by the kind's `keepOutMargin`. Paths, water, slope and the Sanctum sight axis are checked by the placer.
 *
 * Pure: data and plain geometry, no three.js / DOM.
 */
import { BARRIERS, wallPieces } from '../../data/barriers';
import { CHALLENGE_AREA_IDS } from '../../data/ids';
import { POIS, POI_STRUCTURES } from '../../data/pois';
import {
  DURGA_CAMP_PROPS, FESTIVAL_TENTS, FLOWER_BEDS, HEARTH_POS, HOBB_FIELD, ORIEL_CAMP_PROPS, PLAZA_RADIUS, STREET_LANTERNS,
  VILLAGE_BUILDINGS, VILLAGE_CENTER,
} from '../../data/village';
import type { VegetationKind } from '../../data/vegetation';
import { AREA_VOLUMES } from '../../data/volumes';
import { WAYSTONE_LIST, WAYSTONE_STONE } from '../../data/waystones';
import { LOCATIONS, LOCATION_IDS } from '../../data/worldLayout';
import { LOCATION_TERRAIN_ROLES } from '../../world/terrain';
import { villagePropSpots } from '../props/villagePropLayout';

export const KIND_BIT: Readonly<Record<VegetationKind, number>> = { grass: 1, flower: 2, bush: 4, rock: 8, tree: 16 };
/** Nothing grows there. */
export const BLOCK_ALL = 31;
/** Only grass and flowers grow there. */
export const BLOCK_TALL = KIND_BIT.bush | KIND_BIT.rock | KIND_BIT.tree;

export type KeepOut =
  | { readonly kind: 'circle'; readonly x: number; readonly z: number; readonly r: number; readonly mask: number; readonly id: string }
  /** Oriented rectangle: half extents along its own axes, turned by a core/math yaw (cos / sin kept). */
  | { readonly kind: 'rect'; readonly x: number; readonly z: number; readonly hx: number; readonly hz: number; readonly c: number; readonly s: number; readonly mask: number; readonly id: string }
  | { readonly kind: 'segment'; readonly ax: number; readonly az: number; readonly bx: number; readonly bz: number; readonly r: number; readonly mask: number; readonly id: string };

/** Horizontal distance from (x, z) to the shape's outline, ≤ 0 inside. */
export function keepOutDistance(k: KeepOut, x: number, z: number): number {
  switch (k.kind) {
    case 'circle':
      return Math.hypot(x - k.x, z - k.z) - k.r;
    case 'rect': {
      const dx = x - k.x;
      const dz = z - k.z;
      // World → local (the inverse of wx = vx·cos + vz·sin, wz = −vx·sin + vz·cos).
      const lx = Math.abs(dx * k.c - dz * k.s) - k.hx;
      const lz = Math.abs(dx * k.s + dz * k.c) - k.hz;
      if (lx <= 0 && lz <= 0) return Math.max(lx, lz);
      return Math.hypot(Math.max(lx, 0), Math.max(lz, 0));
    }
    case 'segment': {
      const vx = k.bx - k.ax;
      const vz = k.bz - k.az;
      const len2 = vx * vx + vz * vz;
      const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - k.ax) * vx + (z - k.az) * vz) / len2)) : 0;
      return Math.hypot(x - (k.ax + vx * t), z - (k.az + vz * t)) - k.r;
    }
  }
}

/** Axis-aligned extent of the shape. */
export function keepOutBounds(k: KeepOut): { minX: number; maxX: number; minZ: number; maxZ: number } {
  switch (k.kind) {
    case 'circle':
      return { minX: k.x - k.r, maxX: k.x + k.r, minZ: k.z - k.r, maxZ: k.z + k.r };
    case 'rect': {
      const ex = Math.abs(k.c) * k.hx + Math.abs(k.s) * k.hz;
      const ez = Math.abs(k.s) * k.hx + Math.abs(k.c) * k.hz;
      return { minX: k.x - ex, maxX: k.x + ex, minZ: k.z - ez, maxZ: k.z + ez };
    }
    case 'segment':
      return {
        minX: Math.min(k.ax, k.bx) - k.r, maxX: Math.max(k.ax, k.bx) + k.r, minZ: Math.min(k.az, k.bz) - k.r, maxZ: Math.max(k.az, k.bz) + k.r,
      };
  }
}

const circle = (id: string, x: number, z: number, r: number, mask = BLOCK_ALL): KeepOut => ({ kind: 'circle', id, x, z, r, mask });
const rect = (id: string, x: number, z: number, hx: number, hz: number, yaw: number, mask = BLOCK_ALL): KeepOut => ({
  kind: 'rect', id, x, z, hx, hz, c: Math.cos(yaw), s: Math.sin(yaw), mask,
});

/** Every keep-out shape of the world (static layout data). */
export function worldKeepOuts(): KeepOut[] {
  const out: KeepOut[] = [];
  // Thistlewick: buildings (plaza_step included), plaza, Hearth, field, beds, lanterns, festival tents.
  for (const b of VILLAGE_BUILDINGS) out.push(rect(b.id, b.center.x, b.center.z, b.half.x, b.half.z, b.yaw));
  out.push(circle('plaza', VILLAGE_CENTER.x, VILLAGE_CENTER.z, PLAZA_RADIUS + 0.5));
  out.push(circle('hearth', HEARTH_POS.x, HEARTH_POS.z, 1.2));
  out.push(rect('hobb_field', HOBB_FIELD.center.x, HOBB_FIELD.center.z, HOBB_FIELD.halfX + 0.5, HOBB_FIELD.halfZ + 0.5, 0));
  FLOWER_BEDS.forEach((p, i) => out.push(rect(`bed_${i}`, p.x, p.z, 1.2, 0.65, 0)));
  STREET_LANTERNS.forEach((p, i) => out.push(circle(`lantern_${i}`, p.x, p.z, 0.4)));
  FESTIVAL_TENTS.forEach((p, i) => out.push(circle(`tent_${i}`, p.x, p.z, 1.8)));
  for (const [name, p] of Object.entries({ ...DURGA_CAMP_PROPS, ...ORIEL_CAMP_PROPS })) out.push(circle(`camp_${name}`, p.x, p.z, 2.5));
  villagePropSpots().forEach((p, i) => out.push(
    p.kind === 'fenceRail' ? rect(`prop_${i}`, p.x, p.z, (p.length ?? 2.5) / 2, 0.1, 0) : circle(`prop_${i}`, p.x, p.z, p.radius),
  ));
  // POIs and their solid structures.
  for (const p of POIS) out.push(circle(p.id, p.pos.x, p.pos.z, Math.max(1, p.radius) + 0.5));
  for (const s of POI_STRUCTURES) {
    const sh = s.shape;
    if (sh.kind === 'box') out.push(rect(s.id, (sh.minX + sh.maxX) / 2, (sh.minZ + sh.maxZ) / 2, (sh.maxX - sh.minX) / 2, (sh.maxZ - sh.minZ) / 2, 0));
    else out.push(circle(s.id, sh.x, sh.z, sh.radius));
  }
  for (const w of WAYSTONE_LIST) out.push(circle(w.id, w.x, w.z, WAYSTONE_STONE.radius + 1.5));
  // Challenge_Areas (their structures stand in and over them).
  const challenge = new Set<string>(CHALLENGE_AREA_IDS);
  for (const v of AREA_VOLUMES) {
    if (!challenge.has(v.id)) continue;
    const sh = v.shape;
    if (sh.kind === 'cylinder') out.push(circle(v.id, sh.x, sh.z, sh.radius));
    else out.push(rect(v.id, sh.x, sh.z, sh.halfX, sh.halfZ, sh.yaw));
  }
  // Blight gates and veils: nothing grows through a wall.
  for (const def of Object.values(BARRIERS)) {
    wallPieces(def).forEach((w, i) => out.push({
      kind: 'segment', id: `${def.id}_${i}`, ax: w.a.x, az: w.a.z, bx: w.b.x, bz: w.b.z, r: w.thickness / 2 + 1, mask: BLOCK_ALL,
    }));
  }
  // Key locations: pads keep their flat ground clear of the tall kinds; other locations a 6 m disc.
  for (const id of LOCATION_IDS) {
    const loc = LOCATIONS[id];
    const role = LOCATION_TERRAIN_ROLES[id];
    const r = role.kind === 'pad' ? role.radius : role.kind === 'water' ? 0 : 6;
    if (r > 0) out.push(circle(`loc_${id}`, loc.x, loc.z, r, BLOCK_TALL));
  }
  // The Elderbough's trunk and roots stand north-west of its location (landmarks.ts).
  out.push(circle('lm_elderbough_trunk', LOCATIONS.lm_elderbough.x - 8, LOCATIONS.lm_elderbough.z - 8, 16, BLOCK_TALL));
  return out;
}

/** Keep-out shapes in 64 m cells, so a chunk reads only the shapes near it. */
export class KeepOutIndex {
  private readonly cells = new Map<string, KeepOut[]>();
  private readonly cell: number;
  /** Largest margin a query may add (m): shapes are filed that much larger. */
  private readonly reach: number;

  constructor(shapes: readonly KeepOut[], cell = 64, reach = 6) {
    this.cell = cell;
    this.reach = reach;
    for (const k of shapes) {
      const b = keepOutBounds(k);
      for (let cz = Math.floor((b.minZ - reach) / cell); cz <= Math.floor((b.maxZ + reach) / cell); cz++) {
        for (let cx = Math.floor((b.minX - reach) / cell); cx <= Math.floor((b.maxX + reach) / cell); cx++) {
          const key = `${cx},${cz}`;
          let list = this.cells.get(key);
          if (list === undefined) this.cells.set(key, (list = []));
          list.push(k);
        }
      }
    }
  }

  /** Shapes that may reach into the rectangle (deduplicated). */
  near(minX: number, maxX: number, minZ: number, maxZ: number): KeepOut[] {
    const found = new Set<KeepOut>();
    for (let cz = Math.floor(minZ / this.cell); cz <= Math.floor(maxZ / this.cell); cz++) {
      for (let cx = Math.floor(minX / this.cell); cx <= Math.floor(maxX / this.cell); cx++) {
        for (const k of this.cells.get(`${cx},${cz}`) ?? []) found.add(k);
      }
    }
    return [...found];
  }

  /** Largest margin the index was built for. */
  get maxMargin(): number {
    return this.reach;
  }
}

/** Whether (x, z) lies inside any of `shapes` blocking `bit`, grown by `margin`. */
export function blockedBy(shapes: readonly KeepOut[], x: number, z: number, bit: number, margin: number): boolean {
  for (const k of shapes) {
    if ((k.mask & bit) === 0) continue;
    if (keepOutDistance(k, x, z) < margin) return true;
  }
  return false;
}
