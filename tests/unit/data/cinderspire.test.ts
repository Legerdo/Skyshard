import { beforeAll, describe, expect, it } from 'vitest';
import {
  CHECKPOINT_RADIUS, CINDERSPIRE, CINDERSPIRE_ARENA_RADIUS, CINDERSPIRE_CLUSTER_PARTS, CINDERSPIRE_DEVICES, CINDERSPIRE_EXIT_END,
  CINDERSPIRE_SUMMIT_RADIUS, CINDERSPIRE_Y, checkpointById, type AreaLegDef, type RestLedgeId,
} from '../../../src/data/challengeAreas';
import { CINDERSPIRE_PUZZLES, PUZZLES, isOpensReward, partElement } from '../../../src/data/puzzles';
import { MAIN_QUEST } from '../../../src/data/quests';
import { SPAWNERS } from '../../../src/data/spawns';
import { AIR_VOLUMES, AREA_VOLUMES, HAZARD_VOLUMES, volumeContains } from '../../../src/data/volumes';
import { LOCATIONS } from '../../../src/data/worldLayout';
import { CLIMB_MOVE_STAMINA_PER_SEC, GLIDE_STAMINA_PER_SEC, STAMINA_RULES } from '../../../src/logic/stamina';
import {
  CLIMB_SPEED, GLIDE_MAX_DESCENT_SPEED, GLIDE_SPEED, GLIDE_TURN_RATE_DEG, HARD_LANDING_HEIGHT, STEP_UP_HEIGHT, UPDRAFT_RISE_SPEED,
} from '../../../src/player/core/constants';
import { buildTerrain, type TerrainField } from '../../../src/world/terrain';

// Cinderspire layout data (task 9.7; design "Cinderspire (수직 이동과 활강)"; Req 12.2, 12.6, 13.8, 13.9, 2.3).

const SEED = 20240601;
const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
const legOf = <K extends AreaLegDef['kind']>(id: string, kind: K): Extract<AreaLegDef, { kind: K }> => {
  const leg = CINDERSPIRE.legs.find((l) => l.id === id);
  if (leg?.kind !== kind) throw new Error(`no ${kind} leg ${id}`);
  return leg as Extract<AreaLegDef, { kind: K }>;
};
const ledgeOf = (id: RestLedgeId) => {
  const ledge = CINDERSPIRE.ledges.find((l) => l.id === id);
  if (ledge === undefined) throw new Error(`no ledge ${id}`);
  return ledge;
};
const updraftOf = (id: string) => {
  const u = CINDERSPIRE.updrafts.find((x) => x.id === id);
  if (u === undefined) throw new Error(`no updraft ${id}`);
  return u;
};
/** Glide ratio from the glide constants: 9 m/s forward for 2.5 m/s down (3.6). */
const GLIDE_RATIO = GLIDE_SPEED / GLIDE_MAX_DESCENT_SPEED;

let terrain: TerrainField;
beforeAll(() => {
  terrain = buildTerrain(SEED);
});

describe('Cinderspire route (Req 12.2)', () => {
  it('runs foot ramp → C1 → U1 → G1 → H1 → C3 → U2 → G2 from the base (y 6) to the summit (y 95), each leg starting where the last ended', () => {
    expect(CINDERSPIRE.legs.map((l) => [l.id, l.kind, l.fromY, l.toY])).toEqual([
      ['ramp', 'walk', 6, 20],
      ['C1', 'climb', 20, 32],
      ['U1', 'updraft', 32, 58],
      ['G1', 'glide', 58, 52],
      ['H1', 'climb', 52, 64],
      ['C3', 'climb', 64, 76],
      ['U2', 'updraft', 76, 104],
      ['G2', 'glide', 104, 95],
    ]);
    expect(CINDERSPIRE.legs[0]?.fromY).toBe(LOCATIONS.cinderspire_base.groundY);
    expect(CINDERSPIRE.legs[CINDERSPIRE.legs.length - 1]?.toY).toBe(LOCATIONS.cinderspire_summit.groundY);
    for (let i = 1; i < CINDERSPIRE.legs.length; i++) {
      expect(CINDERSPIRE.legs[i]?.fromY, CINDERSPIRE.legs[i]?.id).toBe(CINDERSPIRE.legs[i - 1]?.toY);
    }
    // Req 12.2: ≥ 3 mandatory climbs (one on a Tide-cooled Heat_Crystal), ≥ 2 Updrafts, ≥ 2 glides between spires.
    const climbs = CINDERSPIRE.legs.filter((l) => l.kind === 'climb');
    expect(climbs.map((l) => l.id)).toEqual(['C1', 'H1', 'C3']);
    expect(climbs.filter((l) => l.kind === 'climb' && l.heatWall !== undefined).map((l) => l.id)).toEqual(['H1']);
    expect(CINDERSPIRE.legs.filter((l) => l.kind === 'updraft')).toHaveLength(2);
    expect(CINDERSPIRE.legs.filter((l) => l.kind === 'glide')).toHaveLength(2);
    expect(CINDERSPIRE.music).toBe('mus_area_cinderspire');
  });

  it('walks the foot ramp in 0.4 m steps from the base pad to L1 without a leg steeper than the steps allow', () => {
    const ramp = legOf('ramp', 'walk');
    const [first] = ramp.points;
    const last = ramp.points[ramp.points.length - 1];
    expect(first?.y).toBe(CINDERSPIRE_Y.base);
    expect(flat(first ?? { x: 0, z: 0 }, LOCATIONS.cinderspire_base)).toBeLessThan(8); // on the base pad (radius 8)
    expect(last).toEqual(ledgeOf('L1').center);
    const steps = CINDERSPIRE.pieces.filter((p) => p.id.startsWith('cs_ramp_'));
    expect(steps).toHaveLength(35);
    const tops = steps.map((p) => (p.shape.kind === 'obb' ? p.shape.center.y + p.shape.half.y : Number.NaN));
    tops.forEach((top, i) => expect(top - (i === 0 ? CINDERSPIRE_Y.base : (tops[i - 1] ?? 0))).toBeLessThanOrEqual(STEP_UP_HEIGHT));
    expect(tops[tops.length - 1]).toBeCloseTo(CINDERSPIRE_Y.L1, 9);
    expect(CINDERSPIRE.route.map((r) => r.pos)).toEqual(ramp.points);
  });

  it('keeps every mandatory climb within 14 m, so it costs ≤ 70 of the base 100 Stamina at 10/s and 2 m/s (Req 12.6)', () => {
    for (const leg of CINDERSPIRE.legs) {
      if (leg.kind !== 'climb') continue;
      expect(leg.mandatory).toBe(true);
      const height = leg.toY - leg.fromY;
      expect(height, leg.id).toBe(12);
      expect(height, leg.id).toBeLessThanOrEqual(14);
      const stamina = (height / CLIMB_SPEED) * CLIMB_MOVE_STAMINA_PER_SEC;
      expect(stamina, leg.id).toBe(60);
      expect(stamina, leg.id).toBeLessThanOrEqual(0.7 * STAMINA_RULES.baseMax);
      // Its wall foot stands on the ledge below, its top is the ledge above.
      expect(leg.foot.y, leg.id).toBe(ledgeOf(leg.from).center.y);
      expect(leg.top, leg.id).toEqual(ledgeOf(leg.to).center);
    }
  });

  it('puts a rest ledge at least 3 m across before and after every climb and flight: L1–L5 (Req 12.6)', () => {
    expect(CINDERSPIRE.ledges.map((l) => [l.id, l.center.y])).toEqual([['L1', 20], ['L2', 32], ['L3', 52], ['L4', 64], ['L5', 76]]);
    for (const l of CINDERSPIRE.ledges) expect(l.width, l.id).toBeGreaterThanOrEqual(3);
    const stops = CINDERSPIRE.legs.flatMap((l) => {
      if (l.kind === 'walk') return [l.to];
      if (l.kind === 'climb') return [l.from, l.to];
      if (l.kind === 'updraft') return [l.from];
      return l.to === undefined ? [] : [l.to];
    });
    expect([...new Set(stops)].sort()).toEqual(['L1', 'L2', 'L3', 'L4', 'L5']);
  });

  it('lands each glide at least 1 m above its landing surface at the glide ratio from the glide constants (Req 2.3)', () => {
    expect(GLIDE_RATIO).toBeCloseTo(3.6, 9);
    const arrivals = ['G1', 'G2'].map((id) => {
      const g = legOf(id, 'glide');
      const column = updraftOf(g.updraft);
      // It starts on the Updraft's axis at its top and flies `horizontal` m to the landing's near edge.
      expect(flat(g.start, column.center), id).toBeLessThan(1e-9);
      expect(g.start.y, id).toBe(column.maxY);
      expect(flat(g.start, g.landing), id).toBeCloseTo(g.horizontal, 9);
      const arrival = g.start.y - g.horizontal / GLIDE_RATIO;
      expect(arrival - g.landing.y, id).toBeGreaterThanOrEqual(1);
      return [g.horizontal, arrival - g.landing.y];
    });
    expect(arrivals).toEqual([[18, 1], [27, 1.5]]);
    expect(legOf('G1', 'glide').to).toBe('L3');
    expect(legOf('G2', 'glide').landing.y).toBe(CINDERSPIRE_Y.summit);
  });

  it('costs 31.5 and 39 Stamina for Updraft + glide, both below the base maximum 100 (Req 2.3)', () => {
    const cost = (updraftId: string, glideId: string): number => {
      const u = legOf(updraftId, 'updraft');
      const g = legOf(glideId, 'glide');
      return ((u.toY - u.fromY) / UPDRAFT_RISE_SPEED + g.horizontal / GLIDE_SPEED) * GLIDE_STAMINA_PER_SEC;
    };
    expect(cost('U1', 'G1')).toBeCloseTo(31.5, 9);
    expect(cost('U2', 'G2')).toBeCloseTo(39, 9);
    for (const c of [cost('U1', 'G1'), cost('U2', 'G2')]) expect(c).toBeLessThan(STAMINA_RULES.baseMax);
  });

  it('stands two 4 m Updrafts beside L2 and L5, wider than the glide turning circle and out of reach from below', () => {
    const turningRadius = GLIDE_SPEED / ((GLIDE_TURN_RATE_DEG * Math.PI) / 180);
    for (const [legId, ledgeId, below] of [['U1', 'L2', 'L1'], ['U2', 'L5', 'L4']] as const) {
      const leg = legOf(legId, 'updraft');
      const u = updraftOf(leg.updraft);
      expect(u.radius, legId).toBe(4);
      expect(u.radius, legId).toBeGreaterThan(turningRadius);
      expect(u.maxY, legId).toBe(leg.toY);
      // From 4 m below the take-off ledge: a glider from the ledge below never rides it.
      expect(u.minY, legId).toBeLessThan(ledgeOf(ledgeId).center.y);
      expect(u.minY, legId).toBeGreaterThan(ledgeOf(below).center.y + 3);
      expect(flat(u.center, ledgeOf(ledgeId).center), legId).toBeLessThan(12);
      const air = AIR_VOLUMES.find((v) => v.id === u.id);
      expect(air?.kind, legId).toBe('updraft');
      expect(air?.shape, legId).toEqual({ kind: 'cylinder', x: u.center.x, z: u.center.z, radius: 4, minY: u.minY, maxY: u.maxY });
    }
  });

  it('holds the Cinder Alpha arena (14 m) on the summit platform at cinderspire_summit (y 95)', () => {
    const { arena } = CINDERSPIRE;
    const summit = LOCATIONS.cinderspire_summit;
    expect(arena.elite).toBe('cinderAlpha');
    expect(arena.radius).toBe(14);
    expect(CINDERSPIRE_ARENA_RADIUS).toBe(14);
    expect(arena.center).toEqual({ x: summit.x, y: summit.groundY, z: summit.z });
    expect(CINDERSPIRE_SUMMIT_RADIUS).toBeGreaterThanOrEqual(arena.radius);
    const floor = CINDERSPIRE.pieces.find((p) => p.id === 'cs_summit_floor');
    expect(floor?.shape).toMatchObject({ kind: 'cylinder', radius: CINDERSPIRE_SUMMIT_RADIUS });
    expect(floor?.shape.kind === 'cylinder' ? floor.shape.base.y + floor.shape.height : 0).toBe(summit.groundY);
    expect(flat(arena.guardian.pos, arena.center)).toBeLessThan(arena.radius);
    expect(SPAWNERS.filter((s) => s.campId === 'cinderAlpha').map((s) => [s.kind, s.pos])).toEqual([
      ['cinderAlpha', { x: arena.guardian.pos.x, y: arena.guardian.pos.y, z: arena.guardian.pos.z }],
    ]);
    // Skyshard 2 on the platform, caged until Cinder Alpha falls.
    expect(CINDERSPIRE.skyshard.index).toBe(2);
    expect(flat(CINDERSPIRE.skyshard.pos, arena.center)).toBeLessThan(CINDERSPIRE_SUMMIT_RADIUS - 2);
    expect(CINDERSPIRE.doors.map((d) => [d.id, d.openWhen])).toEqual([['cs_door_skyshard', { kind: 'eliteDefeated', elite: 'cinderAlpha' }]]);
  });

  it('places cp_cinderspire_1 on L2 and cp_cinderspire_2 on L4 (radius 2), the ms5 reach targets (Req 12.7)', () => {
    expect(CINDERSPIRE.checkpoints.map((c) => [c.id, c.spot.pos, c.radius])).toEqual([
      ['cp_cinderspire_1', ledgeOf('L2').center, CHECKPOINT_RADIUS],
      ['cp_cinderspire_2', ledgeOf('L4').center, CHECKPOINT_RADIUS],
    ]);
    expect(CHECKPOINT_RADIUS).toBe(2);
    const reach = MAIN_QUEST.stages.flatMap((s) => s.objectives).flatMap((o) => (o.trigger.kind === 'reach' ? [o.trigger.areaId] : []));
    const area = AREA_VOLUMES.find((v) => v.id === 'cinderspire');
    for (const c of CINDERSPIRE.checkpoints) {
      expect(checkpointById(c.id)?.area.id).toBe('cinderspire');
      expect(reach).toContain(c.id);
      const volume = AREA_VOLUMES.find((v) => v.id === c.id);
      expect(volume !== undefined && volumeContains(volume.shape, c.spot.pos), c.id).toBe(true);
      expect(area !== undefined && volumeContains(area.shape, c.spot.pos), c.id).toBe(true);
    }
    // The ledge below a checkpoint's ledge is outside its reach volume (it is reached on the ledge, not on the way).
    const cp2 = AREA_VOLUMES.find((v) => v.id === 'cp_cinderspire_2');
    expect(cp2 !== undefined && volumeContains(cp2.shape, ledgeOf('L3').center)).toBe(false);
  });
});

describe('Cinderspire puzzles, risers and the floor', () => {
  it('makes H1 pz_cinderspire_1: allOf the Tide Heat_Crystal wall and the L4 arrival (Req 13.8)', () => {
    const [pz1, pz2, pz3] = CINDERSPIRE_PUZZLES;
    for (const d of CINDERSPIRE_PUZZLES) expect(PUZZLES).toContain(d);
    expect(pz1?.id).toBe('pz_cinderspire_1');
    expect(pz1?.kind).toBe('allOf');
    expect(pz1?.parts.map((p) => [p.id, p.device])).toEqual([['pz_cinderspire_1_wall', 'heatCrystal'], ['pz_cinderspire_1_top', 'arrival']]);
    expect(pz1 === undefined ? null : partElement(pz1, 0)).toBe('tide');
    expect(pz1?.parts[0]?.solid).toBe(false); // the area's HeatCrystalWall is its collider
    expect(pz1?.parts[1]?.pos).toEqual(ledgeOf('L4').center);
    const [wall] = CINDERSPIRE.heatWalls;
    expect(CINDERSPIRE.heatWalls.map((w) => [w.id, w.part])).toEqual([['cs_heat_wall', 'pz_cinderspire_1_wall']]);
    expect(legOf('H1', 'climb').heatWall).toBe(wall?.id);
    // The wall rises from L3 to L4, and the part's hurt capsule reaches out over L3 from its face.
    expect(wall === undefined ? [] : [wall.shape.center.y - wall.shape.half.y, wall.shape.center.y + wall.shape.half.y]).toEqual([52, 64]);
    expect(CINDERSPIRE_DEVICES.heatWall.y).toBe(CINDERSPIRE_Y.L3);
    expect(MAIN_QUEST.stages.flatMap((s) => s.objectives).filter((o) => o.trigger.kind === 'solve' && o.trigger.puzzleId.startsWith('pz_cinderspire_'))
      .map((o) => o.id)).toEqual(['ms5_heat_crystal']);
    // The Unstable_Crystal clusters on the L2 and L5 rims hold back the vent ledges (Req 13.9).
    expect([pz2, pz3].map((d) => [d?.id, d?.kind, d?.parts.map((p) => [p.id, p.device]), d !== undefined && partElement(d, 0)])).toEqual([
      ['pz_cinderspire_2', 'single', [[CINDERSPIRE_CLUSTER_PARTS.u1, 'unstableCrystal']], 'ember'],
      ['pz_cinderspire_3', 'single', [[CINDERSPIRE_CLUSTER_PARTS.u2, 'unstableCrystal']], 'ember'],
    ]);
    expect(CINDERSPIRE_DEVICES.clusterU1.y).toBe(CINDERSPIRE_Y.L2);
    expect(flat(CINDERSPIRE_DEVICES.clusterU1, ledgeOf('L2').center)).toBeLessThan(ledgeOf('L2').width / 2);
    expect(CINDERSPIRE_DEVICES.clusterU2.y).toBe(CINDERSPIRE_Y.L5);
    for (const d of [pz2, pz3]) expect(d !== undefined && isOpensReward(d.reward)).toBe(true);
  });

  it('frees a vent ledge toward each Updraft with its cluster’s blast, ending just outside the column', () => {
    const ledges = CINDERSPIRE.risers.filter((r) => r.look === 'ventLedge');
    expect(ledges.map((r) => [r.id, r.when])).toEqual([
      ['cs_vent_ledge_1', { kind: 'partGone', part: CINDERSPIRE_CLUSTER_PARTS.u1 }],
      ['cs_vent_ledge_2', { kind: 'partGone', part: CINDERSPIRE_CLUSTER_PARTS.u2 }],
    ]);
    const columns = [updraftOf('updraft_cinderspire_1'), updraftOf('updraft_cinderspire_2')];
    ledges.forEach((r, i) => {
      const c = columns[i];
      if (c === undefined) throw new Error('column');
      const { center, half, yaw } = r.shape;
      const tip = { x: center.x + Math.sin(yaw) * half.z, z: center.z + Math.cos(yaw) * half.z };
      expect(center.y + half.y, r.id).toBe(i === 0 ? CINDERSPIRE_Y.L2 : CINDERSPIRE_Y.L5);
      expect(flat(tip, c.center), r.id).toBeGreaterThan(c.radius);
      expect(flat(tip, c.center), r.id).toBeLessThan(c.radius + 1);
    });
  });

  it('raises 35 exit stairs from the summit’s west edge down toward ws_ember after Skyshard 2 (Req 12.9)', () => {
    const stairs = CINDERSPIRE.risers.filter((r) => r.look === 'exitStair');
    expect(stairs.map((r) => r.id)).toEqual(CINDERSPIRE.exitRisers);
    expect(stairs).toHaveLength(35);
    for (const r of stairs) expect(r.when, r.id).toEqual({ kind: 'skyshard', index: 2 });
    const summit = LOCATIONS.cinderspire_summit;
    const tops = stairs.map((r) => r.shape.center.y + r.shape.half.y);
    let last = summit.groundY;
    for (const top of tops) {
      expect(last - top).toBeCloseTo(2.5, 9); // every drop is a short hop, far below a hard landing
      expect(last - top).toBeLessThan(HARD_LANDING_HEIGHT);
      last = top;
    }
    const first = stairs[0];
    const bottom = stairs[stairs.length - 1];
    if (first === undefined || bottom === undefined) throw new Error('stairs');
    // West of the summit centre, at its edge; each next step farther along toward ws_ember.
    expect(first.shape.center.x).toBeLessThan(summit.x - CINDERSPIRE_SUMMIT_RADIUS + 2);
    const toWs = (p: { x: number; z: number }): number => flat(p, LOCATIONS.ws_ember);
    stairs.slice(1).forEach((r, i) => expect(toWs(r.shape.center)).toBeLessThan(toWs(stairs[i]?.shape.center ?? r.shape.center)));
    // The last step sits on the canyon floor, and the way out ends beyond it, outside the area.
    const floorY = terrain.heightAt(bottom.shape.center.x, bottom.shape.center.z);
    expect(tops[tops.length - 1] - floorY).toBeGreaterThanOrEqual(0);
    expect(tops[tops.length - 1] - floorY).toBeLessThanOrEqual(2.5);
    expect(terrain.walkable(CINDERSPIRE_EXIT_END.x, CINDERSPIRE_EXIT_END.z)).toBe(true);
    const area = AREA_VOLUMES.find((v) => v.id === 'cinderspire');
    const end = { ...CINDERSPIRE_EXIT_END, y: terrain.heightAt(CINDERSPIRE_EXIT_END.x, CINDERSPIRE_EXIT_END.z) };
    expect(area !== undefined && volumeContains(area.shape, end)).toBe(false);
    expect(toWs(CINDERSPIRE_EXIT_END)).toBeLessThan(toWs(summit));
  });

  it('judges falls on the canyon floor between the spires, never on the base pad, the ramp or the canyon path in', () => {
    const hazards = HAZARD_VOLUMES.filter((h) => h.area === 'cinderspire');
    expect(hazards.map((h) => h.id)).toEqual(CINDERSPIRE.hazards.map((h) => h.id));
    for (const h of CINDERSPIRE.hazards) {
      const floor = { x: h.center.x, y: terrain.heightAt(h.center.x, h.center.z), z: h.center.z };
      expect(hazards.some((v) => volumeContains(v.shape, floor)), h.id).toBe(true);
      expect(h.look).toBe('embers');
    }
    const inHazard = (p: { x: number; y: number; z: number }): boolean => hazards.some((v) => volumeContains(v.shape, p));
    const base = LOCATIONS.cinderspire_base;
    expect(inHazard({ x: base.x, y: base.groundY, z: base.z })).toBe(false);
    expect(inHazard(CINDERSPIRE.entrance.pos)).toBe(false);
    for (const r of CINDERSPIRE.route) expect(inHazard(r.pos)).toBe(false);
    for (const p of CINDERSPIRE.pieces.filter((x) => x.id.startsWith('cs_ramp_'))) {
      if (p.shape.kind !== 'obb') continue;
      expect(inHazard({ ...p.shape.center, y: p.shape.center.y + p.shape.half.y }), p.id).toBe(false);
    }
    // The canyon path in from ws_ember (the route's last ground leg) stays off the floor judgement.
    for (let t = 0; t <= 1; t += 0.05) {
      const x = 282 + (327 - 282) * t;
      const z = 168 + (123 - 168) * t;
      expect(inHazard({ x, y: terrain.heightAt(x, z), z }), `${x}, ${z}`).toBe(false);
    }
    // Everything the climb rests on lies inside the area bounds.
    const area = AREA_VOLUMES.find((v) => v.id === 'cinderspire');
    for (const l of CINDERSPIRE.ledges) expect(area !== undefined && volumeContains(area.shape, l.center), l.id).toBe(true);
    for (const u of CINDERSPIRE.updrafts) expect(area !== undefined && volumeContains(area.shape, { ...u.center, y: u.maxY }), u.id).toBe(true);
    expect(area !== undefined && volumeContains(area.shape, CINDERSPIRE.arena.center)).toBe(true);
  });

  it('declares an orange-glow palette of its own (Req 12.4)', () => {
    const { glow, lights } = CINDERSPIRE.lighting;
    const r = (glow >> 16) & 0xff;
    const g = (glow >> 8) & 0xff;
    const b = glow & 0xff;
    expect(r > g && g > b).toBe(true);
    expect(lights.length).toBeGreaterThanOrEqual(5);
  });
});
