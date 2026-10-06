import { describe, expect, it } from 'vitest';
import { BARRIERS, VEIL_TOP_Y, wallPieces, type GateDef, type VeilDef } from '../../../src/data/barriers';
import { BARRIER_IDS, REGION_IDS, type RegionId } from '../../../src/data/ids';
import { QUESTS } from '../../../src/data/quests';
import { RESONANCE_ALTAR, STARLIT_STAIR } from '../../../src/data/starlitStair';
import { AREA_VOLUMES, DISCOVERY_VOLUMES, volumeContains } from '../../../src/data/volumes';
import {
  GLIDE_RATIO, LAYOUT_TRAVEL, LOCATION_IDS, LOCATIONS, REGIONS, REGION_SUBTITLES, regionAt, type LocationId, type XZ,
} from '../../../src/data/worldLayout';
import { STAIR_FALL_DISTANCE } from '../../../src/logic/stairFall';
import { JUMP_APEX_HEIGHT as JUMP_HEIGHT, STEP_UP_HEIGHT } from '../../../src/player/core/constants';
import { OUT_OF_BOUNDS_RADIUS } from '../../../src/world/worldBounds';

// Placement data of task 4.5: barriers, trigger volumes, the altar and the Starlit_Stair.

/** Proper crossing of segments pq and rs in the XZ plane. */
function crosses(p: XZ, q: XZ, r: XZ, s: XZ): boolean {
  const orient = (a: XZ, b: XZ, c: XZ): number => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
  const d1 = orient(r, s, p);
  const d2 = orient(r, s, q);
  const d3 = orient(p, q, r);
  const d4 = orient(p, q, s);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * Crossings of the segment from `from` to `to` with the closed barrier line: the veil's ground-level pieces
 * and its gate wall (the lintel lies over the gate and adds no crossing of its own).
 */
function barrierCrossings(veil: VeilDef, from: XZ, to: XZ): number {
  const ground = wallPieces(veil).filter((w) => w.bottomY === veil.bottomY && w.topY === VEIL_TOP_Y);
  return [...ground, ...wallPieces(BARRIERS[veil.gate])].filter((w) => crosses(from, to, w.a, w.b)).length;
}

const xz = (id: LocationId): XZ => ({ x: LOCATIONS[id].x, z: LOCATIONS[id].z });

describe('barriers', () => {
  it('declares every BarrierId once, gates and veils guarding their Region', () => {
    expect(Object.keys(BARRIERS).sort()).toEqual([...BARRIER_IDS].sort());
    for (const id of BARRIER_IDS) expect(BARRIERS[id].id).toBe(id);
    expect(BARRIERS.gate_ember.region).toBe('ember');
    expect(BARRIERS.veil_azure.region).toBe('azure');
    expect(BARRIERS.seal_sanctum.region).toBe('sanctum');
  });

  it('lets each veil reach past the recovery radius at both ends and leaves its gap exactly for the gate', () => {
    for (const id of ['veil_ember', 'veil_azure'] as const) {
      const veil = BARRIERS[id] as VeilDef;
      const gate = BARRIERS[veil.gate] as GateDef;
      expect(veil.requires).toEqual(gate.requires);
      const first = veil.runs[0][0];
      const lastRun = veil.runs[veil.runs.length - 1];
      const last = lastRun[lastRun.length - 1];
      expect(Math.hypot(first.x, first.z)).toBeGreaterThan(OUT_OF_BOUNDS_RADIUS);
      expect(Math.hypot(last.x, last.z)).toBeGreaterThan(OUT_OF_BOUNDS_RADIUS);
      expect(veil.runs).toHaveLength(2);
      const gapEnds = [veil.runs[0][veil.runs[0].length - 1], veil.runs[1][0]];
      expect(gapEnds).toEqual(expect.arrayContaining([gate.span.a, gate.span.b]));
      expect(veil.lintels).toEqual([{ a: gate.span.a, b: gate.span.b, bottomY: gate.topY }]); // no way over the wall
      expect(veil.topY).toBe(260);
    }
  });

  it('puts the gate walls on the gate locations, above the ground there', () => {
    for (const id of ['gate_ember', 'gate_azure'] as const) {
      const gate = BARRIERS[id] as GateDef;
      const loc = LOCATIONS[id];
      const mid = { x: (gate.span.a.x + gate.span.b.x) / 2, z: (gate.span.a.z + gate.span.b.z) / 2 };
      expect(mid).toEqual({ x: loc.x, z: loc.z });
      expect(gate.groundY).toBe(loc.groundY);
      expect(gate.bottomY).toBeLessThan(loc.groundY);
      expect(gate.topY - loc.groundY).toBeGreaterThan(JUMP_HEIGHT + 10);
    }
  });

  it('separates the locked Region from Thistlewick: its locations lie behind the veil and gate, the rest in front', () => {
    const sides: [VeilDef, RegionId][] = [
      [BARRIERS.veil_ember as VeilDef, 'ember'],
      [BARRIERS.veil_azure as VeilDef, 'azure'],
    ];
    const start = xz('thistlewick');
    for (const [veil, region] of sides) {
      for (const id of LOCATION_IDS) {
        const loc = LOCATIONS[id];
        if (loc.border !== undefined) continue; // the gate locations sit on the line
        const behind = barrierCrossings(veil, start, xz(id)) % 2 === 1;
        expect(behind, `${id} vs ${veil.id}`).toBe(loc.region === region);
      }
    }
  });

  it('wraps the whole Sanctum in the seal sphere', () => {
    const seal = BARRIERS.seal_sanctum;
    if (seal.kind !== 'seal') throw new Error('seal_sanctum is a seal');
    const { bounds, altitude } = REGIONS.sanctum;
    if (bounds.kind !== 'circle' || altitude === undefined) throw new Error('sanctum is a floating circle');
    for (const y of [altitude.minY, altitude.maxY]) {
      const dy = y - seal.center.y;
      expect(Math.hypot(bounds.radius, dy)).toBeLessThan(seal.radius);
    }
  });
});

describe('trigger volumes', () => {
  it('has unique area and Landmark ids and a subtitle for every Region', () => {
    const areaIds = AREA_VOLUMES.map((v) => v.id);
    expect(new Set(areaIds).size).toBe(areaIds.length);
    for (const r of REGION_IDS) expect(areaIds).not.toContain(r); // Regions come from regionAt
    const landmarks = DISCOVERY_VOLUMES.map((v) => v.id);
    expect(new Set(landmarks).size).toBe(landmarks.length);
    for (const r of REGION_IDS) expect(REGION_SUBTITLES[r].length).toBeGreaterThan(0);
  });

  it('gives every Main_Quest reach target an area volume in its Region', () => {
    const reach = QUESTS.flatMap((q) => q.stages.flatMap((s) => s.objectives))
      .flatMap((o) => (o.trigger.kind === 'reach' ? [o.trigger.areaId] : []));
    expect(reach.length).toBeGreaterThan(10);
    for (const id of reach) {
      const volume = AREA_VOLUMES.find((v) => v.id === id);
      expect(volume, id).toBeDefined();
    }
  });

  it('covers the quest marker spots of location-based reach targets', () => {
    for (const id of ['thistlewick', 'vista_verdant', 'lm_elderbough', 'cinderspire_base', 'resonance_altar', 'sanctum_gate', 'sanctum_arena'] as const) {
      const loc = LOCATIONS[id];
      const volume = AREA_VOLUMES.find((v) => v.id === id);
      expect(volume && volumeContains(volume.shape, { x: loc.x, y: loc.groundY, z: loc.z }), id).toBe(true);
      expect(volume?.region, id).toBe(regionAt({ x: loc.x, y: loc.groundY, z: loc.z }));
    }
  });

  it('keeps gate_ember and gate_azure reach areas behind their walls', () => {
    for (const id of ['gate_ember', 'gate_azure'] as const) {
      const veil = (id === 'gate_ember' ? BARRIERS.veil_ember : BARRIERS.veil_azure) as VeilDef;
      const shape = AREA_VOLUMES.find((v) => v.id === id)?.shape;
      if (shape === undefined) throw new Error(id);
      expect(barrierCrossings(veil, xz('thistlewick'), { x: shape.x, z: shape.z }) % 2).toBe(1);
    }
  });
});

describe('Resonance_Altar and Starlit_Stair', () => {
  const { platforms, updrafts } = STARLIT_STAIR;

  it('stands the altar on its location with a dais low enough to step onto', () => {
    expect(RESONANCE_ALTAR.pos).toEqual({ x: LOCATIONS.resonance_altar.x, y: LOCATIONS.resonance_altar.groundY, z: LOCATIONS.resonance_altar.z });
    expect(RESONANCE_ALTAR.daisHeight).toBeLessThanOrEqual(STEP_UP_HEIGHT);
  });

  it('climbs from the stair start to the Sanctum gate', () => {
    const start = LOCATIONS.starlit_stair_start;
    const first = platforms[0];
    expect(first.topY - start.groundY).toBeLessThanOrEqual(JUMP_HEIGHT - 0.2);
    const last = platforms[platforms.length - 1];
    const gateArea = AREA_VOLUMES.find((v) => v.id === 'sanctum_gate');
    expect(gateArea && volumeContains(gateArea.shape, { x: last.x, y: last.topY, z: last.z })).toBe(true);
    expect(platforms.map((p) => p.tier)).toEqual([...platforms.map((p) => p.tier)].sort());
  });

  it('keeps consecutive platforms of a tier within a running jump: rise ≤ 1.2 m, gap ≤ 1.5 m', () => {
    for (let i = 1; i < platforms.length; i++) {
      const a = platforms[i - 1];
      const b = platforms[i];
      if (a.tier !== b.tier) continue;
      const gapX = Math.max(0, Math.abs(b.x - a.x) - a.halfX - b.halfX);
      const gapZ = Math.max(0, Math.abs(b.z - a.z) - a.halfZ - b.halfZ);
      expect(Math.hypot(gapX, gapZ), `gap ${i}`).toBeLessThanOrEqual(1.5);
      expect(b.topY - a.topY, `rise ${i}`).toBeLessThanOrEqual(1.2);
    }
  });

  it('joins the tiers with two Updrafts next to the tier landings, each ride and glide within base Stamina', () => {
    expect(updrafts).toHaveLength(2);
    for (const [k, u] of updrafts.entries()) {
      const tier = (k + 1) as 1 | 2;
      const from = platforms.filter((p) => p.tier === tier).at(-1);
      const to = platforms.find((p) => p.tier === tier + 1);
      if (from === undefined || to === undefined) throw new Error(`tier ${tier}`);
      const { shape } = u;
      // Take-off: the column starts under the landing and its edge is within a step of the landing's edge.
      expect(shape.minY).toBeLessThanOrEqual(from.topY);
      const edgeGap = (p: typeof from): number =>
        Math.max(0, Math.hypot(Math.max(0, Math.abs(shape.x - p.x) - p.halfX), Math.max(0, Math.abs(shape.z - p.z) - p.halfZ)) - shape.radius);
      expect(edgeGap(from)).toBeLessThanOrEqual(1.5);
      // Arrival: from the top of the column the next landing is reachable at glide ratio 3.6 ...
      const reach = edgeGap(to) + 2 * shape.radius; // worst case: leaving from the far side of the column
      expect(shape.maxY - (reach / GLIDE_RATIO), `glide to tier ${tier + 1}`).toBeGreaterThanOrEqual(to.topY);
      expect(shape.maxY - to.topY).toBeLessThan(STAIR_FALL_DISTANCE); // ... and landing there is no fall
      // ... within the Stamina of one full bar: rise at 8 m/s plus the glide, at 6/s.
      const seconds = (shape.maxY - from.topY) / 8 + reach / LAYOUT_TRAVEL.glideSpeed;
      expect(seconds * LAYOUT_TRAVEL.glideStaminaPerSecond).toBeLessThanOrEqual(LAYOUT_TRAVEL.baseStamina);
    }
  });
});
