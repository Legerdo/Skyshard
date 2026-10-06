import { beforeAll, describe, expect, it } from 'vitest';
import {
  CHECKPOINT_RADIUS, CINDERSPIRE, OBSERVATORY, OBSERVATORY_ARENA_RADIUS, OBSERVATORY_DOME_CENTER, OBSERVATORY_DOME_RADIUS,
  OBSERVATORY_HALL_CENTER, OBSERVATORY_HALL_RADIUS, OBSERVATORY_PEDESTAL_DISTANCE, OBSERVATORY_PEDESTALS, OBSERVATORY_WAVE_DELAY,
  OBSERVATORY_Y, checkpointById, type AreaPieceDef,
} from '../../../src/data/challengeAreas';
import { AETHER_SENTINEL, ELITE_DEFS, getEnemyDef, isRegionEnemyLevel } from '../../../src/data/enemies';
import { ELEMENT_IDS } from '../../../src/data/ids';
import {
  OBSERVATORY_STEPS, PUZZLES, isOpensReward, minTimeLimit, observatoryOrder, observatoryPuzzle, partElement, puzzleDefsFor,
} from '../../../src/data/puzzles';
import { RECEIVER_DEFS } from '../../../src/data/receivers';
import { MAIN_QUEST } from '../../../src/data/quests';
import { ENCOUNTER_GROUPS, SPAWNERS } from '../../../src/data/spawns';
import { TEMP_LIFTS, TEMP_PIECES } from '../../../src/data/tempRoute';
import { AIR_VOLUMES, AREA_VOLUMES, HAZARD_VOLUMES, volumeContains } from '../../../src/data/volumes';
import { LOCATIONS } from '../../../src/data/worldLayout';
import { GLIDE_STAMINA_PER_SEC, STAMINA_RULES } from '../../../src/logic/stamina';
import { GLIDE_MAX_DESCENT_SPEED, GLIDE_MIN_GROUND_CLEARANCE, GLIDE_SPEED, STEP_UP_HEIGHT } from '../../../src/player/core/constants';
import { MAX_WALKABLE_SLOPE_DEG } from '../../../src/physics/types';
import { OUT_OF_BOUNDS_RADIUS } from '../../../src/world/worldBounds';
import { buildTerrain, type TerrainField } from '../../../src/world/terrain';

// Starfall Observatory layout data (task 9.8; design "Starfall Observatory (속성 조합과 강화 전투)"; Req 12.3, 12.7, 12.9,
// 13.5, 13.6), and the ms5 / ms7 marker spots inside their reach volumes.

const SEED = 20240601;
const HALL = OBSERVATORY_HALL_CENTER;
const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
const piece = (id: string): AreaPieceDef => {
  const p = OBSERVATORY.pieces.find((x) => x.id === id);
  if (p === undefined) throw new Error(`no piece ${id}`);
  return p;
};
const topOf = (p: AreaPieceDef): number => (p.shape.kind === 'obb' ? p.shape.center.y + p.shape.half.y : p.shape.base.y + p.shape.height);
const area = (id: string) => {
  const v = AREA_VOLUMES.find((x) => x.id === id);
  if (v === undefined) throw new Error(`no area ${id}`);
  return v.shape;
};
const objective = (id: string) => {
  const o = MAIN_QUEST.stages.flatMap((s) => s.objectives).find((x) => x.id === id);
  if (o === undefined) throw new Error(`no objective ${id}`);
  return o;
};
const markerOf = (id: string) => {
  const m = objective(id).marker;
  if (m.kind !== 'exact') throw new Error(`${id} has no exact marker`);
  return m.pos;
};

let terrain: TerrainField;
beforeAll(() => {
  terrain = buildTerrain(SEED);
});

describe('Starfall Observatory structure (Req 12.3)', () => {
  it('climbs from the entrance stair (y 130) through the great hall (132) and the ring corridor (140) to the dome (150)', () => {
    expect(OBSERVATORY_Y).toEqual({ entrance: 130, hall: 132, ring: 140, dome: 150 });
    const entrance = LOCATIONS.observatory_entrance;
    expect(OBSERVATORY.entrance.pos).toMatchObject({ y: entrance.groundY });
    expect(flat(OBSERVATORY.entrance.pos, entrance)).toBeLessThan(1);
    // The entrance stair: five steps from the terrace up to the hall floor, none higher than a step-up.
    const entry = OBSERVATORY.pieces.filter((p) => p.id.startsWith('obs_entry_step_')).map(topOf);
    expect(entry).toHaveLength(5);
    entry.forEach((top, i) => expect(top - (i === 0 ? OBSERVATORY_Y.entrance : (entry[i - 1] ?? 0))).toBeLessThanOrEqual(STEP_UP_HEIGHT));
    expect(entry[entry.length - 1]).toBeCloseTo(OBSERVATORY_Y.hall, 9);
    expect(topOf(piece('obs_hall_floor'))).toBe(OBSERVATORY_Y.hall);
    expect(topOf(piece('obs_roof'))).toBeCloseTo(OBSERVATORY_Y.ring, 9);
    // The dome stairs: 25 steps from the ring corridor up to the dome drum, each a step-up.
    const dome = OBSERVATORY.pieces.filter((p) => p.id.startsWith('obs_dome_step_')).map(topOf);
    expect(dome).toHaveLength(25);
    dome.forEach((top, i) => expect(top - (i === 0 ? OBSERVATORY_Y.ring : (dome[i - 1] ?? 0))).toBeLessThanOrEqual(STEP_UP_HEIGHT + 1e-9));
    expect(dome[dome.length - 1]).toBeCloseTo(OBSERVATORY_Y.dome, 9);
    expect(topOf(piece('obs_dome_drum'))).toBe(OBSERVATORY_Y.dome);
    // The route goes up floor by floor: entrance → hall → (lift) ring → stairs → dome → balcony.
    const rooms = OBSERVATORY.route.map((r) => r.room).filter((r, i, all) => all[i - 1] !== r);
    expect(rooms).toEqual(['entrance', 'hall', 'ring', 'stair', 'dome', 'balcony']);
    const heights = OBSERVATORY.route.map((r) => r.pos.y);
    heights.forEach((y, i) => expect(y).toBeGreaterThanOrEqual(heights[i - 1] ?? y));
    expect(OBSERVATORY.route.find((r) => r.lift !== undefined)).toMatchObject({ room: 'ring', lift: 'lift_observatory_up' });
    expect(OBSERVATORY.music).toBe('mus_area_observatory');
    // White stone and cold blue light: a blue-violet haze and a violet starlight glow (Req 12.4).
    const { fogColor, glow } = OBSERVATORY.lighting;
    const blue = (c: number): boolean => (c & 0xff) > ((c >> 16) & 0xff) && (c & 0xff) > ((c >> 8) & 0xff);
    expect([blue(fogColor), blue(glow)]).toEqual([true, true]);
  });

  it('stands the four Element pedestals 6 m from the hall centre at the four compass points, under three ceiling constellations', () => {
    expect(OBSERVATORY_PEDESTAL_DISTANCE).toBe(6);
    const compass = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] } as const;
    expect(OBSERVATORY_PEDESTALS.map((p) => p.id)).toEqual(['north', 'east', 'south', 'west']);
    for (const p of OBSERVATORY_PEDESTALS) {
      const [dx, dz] = compass[p.id];
      expect(p.pos, p.id).toEqual({ x: HALL.x + 6 * dx, y: OBSERVATORY_Y.hall, z: HALL.z + 6 * dz });
    }
    expect(OBSERVATORY_PEDESTALS.map((p) => p.element).sort()).toEqual([...ELEMENT_IDS].sort());
    // Three constellations on the ceiling of the hall, one per step of the order.
    const constellations = OBSERVATORY.constellations;
    expect(constellations.map((c) => [c.puzzle, c.step])).toEqual([['pz_observatory_1', 0], ['pz_observatory_1', 1], ['pz_observatory_1', 2]]);
    for (const c of constellations) {
      expect(flat(c.center, HALL) + Math.max(...c.stars.map((s) => Math.hypot(s.x, s.z)))).toBeLessThan(OBSERVATORY_HALL_RADIUS);
      expect(c.center.y).toBeGreaterThan(OBSERVATORY_Y.hall + 6);
      expect(c.center.y).toBeLessThan(OBSERVATORY_Y.ring);
      expect(c.stars.length).toBeGreaterThanOrEqual(5);
    }
  });

  it('draws three distinct Elements of the four from the save seed, the same every time for one seed and varied across seeds', () => {
    const orders = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const order = observatoryOrder(seed);
      expect(order).toHaveLength(OBSERVATORY_STEPS);
      expect(new Set(order).size).toBe(3);
      for (const el of order) expect(ELEMENT_IDS).toContain(el);
      expect(observatoryOrder(seed)).toEqual(order);
      expect(observatoryPuzzle(seed).order).toEqual(order);
      orders.add(order.join('>'));
    }
    expect(orders.size).toBeGreaterThanOrEqual(20); // of the 24 possible orders
    expect(observatoryOrder(SEED)).toEqual(observatoryOrder(SEED));
  });

  it('builds pz_observatory_1 as a 3-step sequence over the pedestals in that order, the fourth a decoy, 15 s ≥ 3 × 5 s (Req 13.6)', () => {
    for (const seed of [1, 7, SEED]) {
      const def = observatoryPuzzle(seed);
      const order = observatoryOrder(seed);
      expect([def.id, def.kind, def.region]).toEqual(['pz_observatory_1', 'sequence', 'azure']);
      expect(def.timeLimitSec).toBe(15);
      expect(def.timeLimitSec ?? 0).toBeGreaterThanOrEqual(minTimeLimit(OBSERVATORY_STEPS));
      expect(minTimeLimit(OBSERVATORY_STEPS)).toBe(3 * 5);
      expect(def.parts).toHaveLength(4);
      expect(def.parts.slice(0, 3).map((p) => p.element)).toEqual(order);
      const decoy = def.parts[3];
      expect(order).not.toContain(decoy?.element);
      def.parts.forEach((p, i) => {
        expect(p.device).toBe('elementPedestal');
        const pedestal = OBSERVATORY_PEDESTALS.find((x) => x.element === p.element);
        expect(p.id).toBe(`pz_observatory_1_${pedestal?.id}`);
        expect({ x: p.pos.x, y: p.pos.y, z: p.pos.z }).toEqual(pedestal?.pos);
        // Each shows its pedestal's Element (Req 13.2), one the pedestal takes.
        expect(partElement(def, i)).toBe(p.element);
        expect(RECEIVER_DEFS.elementPedestal.accepts).toContain(partElement(def, i));
      });
      expect(def.hint.length).toBeLessThanOrEqual(40);
      expect(isOpensReward(def.reward) && def.reward.opens).toBe('observatory_ring_lift');
      const defs = puzzleDefsFor(seed);
      expect(defs.filter((d) => d.id === 'pz_observatory_1')).toHaveLength(1);
      const parts = defs.flatMap((d) => d.parts.map((p) => p.id));
      expect(new Set(parts).size).toBe(parts.length);
    }
    expect(PUZZLES.some((d) => d.id === 'pz_observatory_1')).toBe(false); // the seeded one is puzzleDefsFor's
    // Its lift and first checkpoint open with it.
    expect(OBSERVATORY.lifts.find((l) => l.id === 'lift_observatory_up')?.when).toEqual({ kind: 'puzzleSolved', puzzleId: 'pz_observatory_1' });
  });

  it('keeps two 2 m checkpoint runes: on the ring lift’s landing, and in front of the dome stairs once the waves are cleared (Req 12.7)', () => {
    expect(OBSERVATORY.checkpoints.map((c) => [c.id, c.radius, c.litWhen])).toEqual([
      ['cp_observatory_1', CHECKPOINT_RADIUS, { kind: 'puzzleSolved', puzzleId: 'pz_observatory_1' }],
      ['cp_observatory_2', CHECKPOINT_RADIUS, { kind: 'roomCleared', groupId: 'observatory_waves' }],
    ]);
    expect(CHECKPOINT_RADIUS).toBe(2);
    const [cp1, cp2] = OBSERVATORY.checkpoints;
    expect(cp1?.spot.pos).toEqual(OBSERVATORY.lifts.find((l) => l.id === 'lift_observatory_up')?.to.pos);
    expect(cp1?.spot.pos.y).toBe(OBSERVATORY_Y.ring);
    const firstStep = OBSERVATORY.pieces.find((p) => p.id === 'obs_dome_step_1');
    expect(firstStep !== undefined && firstStep.shape.kind === 'obb' ? flat(cp2?.spot.pos ?? HALL, firstStep.shape.center) : 99).toBeLessThan(5);
    for (const c of OBSERVATORY.checkpoints) {
      expect(checkpointById(c.id)?.area.id).toBe('observatory');
      expect(volumeContains(area('observatory'), c.spot.pos), c.id).toBe(true);
    }
  });

  it('fights wave 1 (windcutter ×2, aetherSentinel ×1) then, 2 s after its clear, wave 2 (aetherSentinel ×2) on the ring corridor', () => {
    const [room] = OBSERVATORY.combatRooms;
    expect(room).toMatchObject({ groupId: 'observatory_waves', waves: ['observatory_wave_1', 'observatory_waves'], waveDelay: 2 });
    expect(OBSERVATORY_WAVE_DELAY).toBe(2);
    expect(room?.center).toEqual({ x: HALL.x, y: OBSERVATORY_Y.ring, z: HALL.z });
    const roster = (g: string) => SPAWNERS.filter((s) => s.campId === g);
    expect(roster('observatory_wave_1').map((s) => s.kind).sort()).toEqual(['aetherSentinel', 'windcutter', 'windcutter']);
    expect(roster('observatory_waves').map((s) => s.kind)).toEqual(['aetherSentinel', 'aetherSentinel']);
    for (const s of [...roster('observatory_wave_1'), ...roster('observatory_waves')]) {
      expect(s.pos.y, s.id).toBe(OBSERVATORY_Y.ring);
      expect(flat(s.pos, HALL), s.id).toBeLessThan(room?.radius ?? 0);
      expect(flat(s.pos, HALL), s.id).toBeGreaterThan(3.5 + getEnemyDef(s.kind).radius); // clear of the oculus
      expect(isRegionEnemyLevel('azure', s.level), s.id).toBe(true);
    }
    expect(ENCOUNTER_GROUPS.filter((g) => g.id.startsWith('observatory_')).map((g) => [g.id, g.byArea])).toEqual([
      ['observatory_wave_1', true], ['observatory_waves', true],
    ]);
    // Aether Sentinel: Element_Shield 400 switching every 10 s (Req 12.3).
    expect(AETHER_SENTINEL.shield).toEqual({ element: 'ember', max: 400, rotation: { every: 10, order: ['ember', 'tide', 'gale', 'terra'] } });
    // The corridor's two ends close while it fights; the stairs' end stays closed until it is cleared.
    expect(OBSERVATORY.doors.filter((d) => d.look === 'starBarrier').map((d) => [d.id, d.openWhen])).toEqual([
      ['obs_barrier_lift', { kind: 'roomUnlocked', groupId: 'observatory_waves' }],
      ['obs_barrier_stair', { kind: 'roomCleared', groupId: 'observatory_waves' }],
    ]);
  });

  it('holds Sentinel Prime (with 2 drones) in its 9 m arena on the dome, Skyshard 3 in the star cage and the balcony gate (Req 12.9)', () => {
    const { arena } = OBSERVATORY;
    expect(arena.elite).toBe('sentinelPrime');
    expect(arena.center).toEqual({ x: OBSERVATORY_DOME_CENTER.x, y: OBSERVATORY_Y.dome, z: OBSERVATORY_DOME_CENTER.z });
    expect(OBSERVATORY_ARENA_RADIUS).toBeLessThan(OBSERVATORY_DOME_RADIUS);
    expect(flat(arena.guardian.pos, arena.center)).toBeLessThan(arena.radius);
    expect(SPAWNERS.filter((s) => s.campId === 'sentinelPrime').map((s) => [s.kind, s.pos])).toEqual([
      ['sentinelPrime', { x: arena.guardian.pos.x, y: arena.guardian.pos.y, z: arena.guardian.pos.z }],
    ]);
    expect(ELITE_DEFS.sentinelPrime.drones?.count).toBe(2);
    expect(OBSERVATORY.skyshard.index).toBe(3);
    expect(flat(OBSERVATORY.skyshard.pos, arena.center)).toBeLessThan(OBSERVATORY_DOME_RADIUS - 2);
    expect(OBSERVATORY.doors.filter((d) => d.look === 'starCage' || d.look === 'balconyGate').map((d) => [d.id, d.openWhen])).toEqual([
      ['obs_cage_skyshard', { kind: 'eliteDefeated', elite: 'sentinelPrime' }],
      ['obs_gate_balcony', { kind: 'skyshard', index: 3 }],
    ]);
    expect(OBSERVATORY.exitGlide.door).toBe('obs_gate_balcony');
    expect(OBSERVATORY.exitGlide.start.pos.y).toBe(OBSERVATORY_Y.dome);
  });

  it('judges falls from the dome stairs into the walled courtyard below them, and nowhere else it can be walked', () => {
    const [court] = HAZARD_VOLUMES.filter((h) => h.area === 'observatory');
    expect(court?.id).toBe('hazard_observatory_court');
    const shape = court?.shape;
    if (shape === undefined) throw new Error('no courtyard');
    const [hazard] = OBSERVATORY.hazards;
    if (hazard === undefined) throw new Error('no hazard');
    const floor = (x: number, z: number) => ({ x, y: terrain.heightAt(x, z), z });
    expect(volumeContains(shape, floor(hazard.center.x, hazard.center.z + 4))).toBe(true);
    expect(volumeContains(shape, floor(hazard.center.x - 6, hazard.center.z - 4))).toBe(true);
    // Not the hall floor, the ring, the plateau outside the courtyard walls, or the terrace.
    expect(volumeContains(shape, { x: HALL.x + 11, y: OBSERVATORY_Y.hall, z: HALL.z })).toBe(false);
    expect(volumeContains(shape, { x: HALL.x + 11, y: OBSERVATORY_Y.ring, z: HALL.z })).toBe(false);
    expect(volumeContains(shape, floor(hazard.center.x, hazard.center.z + 7.5))).toBe(false);
    expect(volumeContains(shape, floor(hazard.center.x, hazard.center.z - 7.5))).toBe(false);
    expect(volumeContains(shape, OBSERVATORY.entrance.pos)).toBe(false);
  });

  it('marks its area from the terrace to the dome and balcony; the temporary Observatory pieces and lifts are gone', () => {
    const shape = area('observatory');
    for (const p of [OBSERVATORY.entrance.pos, ...OBSERVATORY.route.map((r) => r.pos), OBSERVATORY.arena.center]) {
      expect(volumeContains(shape, p), JSON.stringify(p)).toBe(true);
    }
    const cliffLift = TEMP_LIFTS.find((l) => l.id === 'lift_observatory_cliff');
    expect(cliffLift).toBeDefined();
    expect(volumeContains(shape, { x: cliffLift?.pad.x ?? 0, y: terrain.heightAt(cliffLift?.pad.x ?? 0, cliffLift?.pad.z ?? 0), z: cliffLift?.pad.z ?? 0 })).toBe(false);
    expect(TEMP_PIECES.some((p) => p.id.startsWith('obs_'))).toBe(false);
    expect(TEMP_LIFTS.map((l) => l.id).filter((id) => id.includes('observatory'))).toEqual(['lift_observatory_cliff']);
    // No air volume reaches into the dome's exit glide's first stretch.
    expect(AIR_VOLUMES.filter((v) => volumeContains(v.shape, OBSERVATORY.exitGlide.start.pos))).toEqual([]);
  });
});

describe('the dome balcony exit glide (Req 12.9, 19.2)', () => {
  it('from y 150 toward the crater stays above the slope for all the base Stamina lasts and ends over walkable ground in the world', () => {
    const { start, toward } = OBSERVATORY.exitGlide;
    const seconds = STAMINA_RULES.baseMax / GLIDE_STAMINA_PER_SEC; // 16.7 s of glide on the base Stamina
    const reach = GLIDE_SPEED * seconds; // 150 m
    const drop = GLIDE_MAX_DESCENT_SPEED * seconds; // 41.7 m
    expect(reach).toBeCloseTo(150, 9);
    expect(drop).toBeCloseTo(41.667, 3);
    const heading = { x: toward.x - start.pos.x, z: toward.z - start.pos.z };
    const len = Math.hypot(heading.x, heading.z);
    let lowest = Infinity;
    for (let s = 0; s <= reach; s += 1) {
      const x = start.pos.x + (heading.x / len) * s;
      const z = start.pos.z + (heading.z / len) * s;
      const y = start.pos.y - s / (GLIDE_SPEED / GLIDE_MAX_DESCENT_SPEED);
      lowest = Math.min(lowest, y - terrain.heightAt(x, z));
    }
    expect(lowest).toBeGreaterThanOrEqual(1); // never meets the slope in flight
    // The glider opens off the balcony (ground at least 3 m below).
    expect(start.pos.y - terrain.heightAt(start.pos.x, start.pos.z + 1)).toBeGreaterThan(GLIDE_MIN_GROUND_CLEARANCE);
    // Where it comes down: walkable ground inside the world, outside every fall judgement and the area.
    const end = { x: start.pos.x + (heading.x / len) * reach, z: start.pos.z + (heading.z / len) * reach };
    const ground = { ...end, y: terrain.heightAt(end.x, end.z) };
    expect(terrain.slopeDeg(end.x, end.z)).toBeLessThanOrEqual(MAX_WALKABLE_SLOPE_DEG);
    expect(terrain.walkable(end.x, end.z)).toBe(true);
    expect(Math.hypot(end.x, end.z)).toBeLessThan(OUT_OF_BOUNDS_RADIUS);
    expect(HAZARD_VOLUMES.some((h) => volumeContains(h.shape, ground))).toBe(false);
    expect(volumeContains(area('observatory'), ground)).toBe(false);
    expect(flat(end, toward)).toBeLessThan(flat(start.pos, toward) - reach + 1e-6);
  });
});

describe('ms5 and ms7 markers inside their reach and area volumes', () => {
  it('puts the ms5 ledge markers on the cp_cinderspire_1 / cp_cinderspire_2 runes, inside their reach volumes', () => {
    const cp = (id: string) => checkpointById(id)?.checkpoint.spot.pos;
    expect(markerOf('ms5_ledge_1')).toEqual(cp('cp_cinderspire_1'));
    expect(markerOf('ms5_ledge_2')).toEqual(cp('cp_cinderspire_2'));
    expect(volumeContains(area('cp_cinderspire_1'), markerOf('ms5_ledge_1'))).toBe(true);
    expect(volumeContains(area('cp_cinderspire_2'), markerOf('ms5_ledge_2'))).toBe(true);
    expect(volumeContains(area('cp_cinderspire_2'), markerOf('ms5_heat_crystal'))).toBe(true);
    for (const id of ['ms5_ledge_1', 'ms5_ledge_2', 'ms5_heat_crystal', 'ms5_alpha', 'ms5_skyshard']) {
      expect(volumeContains(area('cinderspire'), markerOf(id)), id).toBe(true);
    }
    expect(CINDERSPIRE.checkpoints.map((c) => c.id)).toEqual(['cp_cinderspire_1', 'cp_cinderspire_2']);
  });

  it('puts the ms7 markers in the great hall, on the ring corridor and on the dome, all inside the Observatory', () => {
    for (const id of ['ms7_hall', 'ms7_constellation']) {
      expect(volumeContains(area('observatory_hall'), markerOf(id)), id).toBe(true);
    }
    expect(markerOf('ms7_hall')).toEqual({ x: HALL.x, y: OBSERVATORY_Y.hall, z: HALL.z });
    const ring = markerOf('ms7_waves');
    expect(ring.y).toBe(OBSERVATORY_Y.ring);
    expect(flat(ring, HALL)).toBeLessThan(OBSERVATORY.combatRooms[0]?.radius ?? 0);
    for (const id of ['ms7_prime', 'ms7_skyshard']) {
      expect(markerOf(id)).toEqual(OBSERVATORY.arena.center);
      expect(flat(markerOf(id), OBSERVATORY.arena.center)).toBeLessThan(OBSERVATORY.arena.radius);
    }
    for (const id of ['ms7_hall', 'ms7_constellation', 'ms7_waves', 'ms7_prime', 'ms7_skyshard']) {
      expect(volumeContains(area('observatory'), markerOf(id)), id).toBe(true);
    }
  });
});
