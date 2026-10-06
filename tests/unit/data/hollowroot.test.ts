import { beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/core/types';
import {
  CHALLENGE_AREA_DEFS, CHECKPOINT_RADIUS, HOLLOWROOT, HOLLOWROOT_DEVICES, SHRINE_FLOOR_Y, SHRINE_UPPER_Y, checkpointById,
  type ShrineRoomId,
} from '../../../src/data/challengeAreas';
import { HOLLOWROOT_PUZZLES, PUZZLES, isOpensReward, partElement } from '../../../src/data/puzzles';
import { MAIN_QUEST } from '../../../src/data/quests';
import { SPAWNERS } from '../../../src/data/spawns';
import { AREA_VOLUMES, HAZARD_VOLUMES, volumeContains } from '../../../src/data/volumes';
import { LOCATIONS } from '../../../src/data/worldLayout';
import { buildTerrain, type TerrainField } from '../../../src/world/terrain';

// Hollowroot Shrine layout data (task 9.6; design "Hollowroot Shrine", "체크포인트와 실패 처리"; Req 12.1, 12.4, 12.7–12.9).

const SEED = 20240601;
const ROOMS: readonly ShrineRoomId[] = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6'];
/** Steepest walking leg the route may have (the terrain's walkable limit is 50°). */
const MAX_LEG_SLOPE_DEG = 35;
const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
const slopeDeg = (a: Vec3, b: Vec3): number => (Math.atan2(Math.abs(b.y - a.y), flat(a, b)) * 180) / Math.PI;

let terrain: TerrainField;
beforeAll(() => {
  terrain = buildTerrain(SEED);
});

describe('Hollowroot Shrine layout', () => {
  it('runs R0–R6 in order from the root arch (y 14) down the spiral ramp to the shrine floor (y −10)', () => {
    expect(HOLLOWROOT.rooms.map((r) => r.id)).toEqual(ROOMS);
    const entrance = LOCATIONS.hollowroot_entrance;
    const [first] = HOLLOWROOT.route;
    const last = HOLLOWROOT.route[HOLLOWROOT.route.length - 1];
    expect(first?.pos).toEqual({ x: entrance.x, y: entrance.groundY, z: entrance.z });
    expect(first?.pos.y).toBe(14);
    expect(last?.room).toBe('R6');
    expect(last?.pos.y).toBe(SHRINE_FLOOR_Y);
    // Rooms appear once each, in order.
    const order = HOLLOWROOT.route.map((r) => r.room).filter((room, i, all) => i === 0 || all[i - 1] !== room);
    expect(order).toEqual(ROOMS);
    // The spiral ramp (R0) never climbs and ends on the floor; it turns 270° around the well.
    const ramp = HOLLOWROOT.route.filter((r) => r.room === 'R0').map((r) => r.pos.y);
    for (let i = 1; i < ramp.length; i++) expect(ramp[i]).toBeLessThanOrEqual(ramp[i - 1] ?? Infinity);
    expect(ramp[ramp.length - 1]).toBe(SHRINE_FLOOR_Y);
    expect(ramp.length).toBeGreaterThanOrEqual(19);
    for (const room of HOLLOWROOT.rooms.slice(1)) {
      expect([SHRINE_FLOOR_Y, SHRINE_UPPER_Y], room.id).toContain(room.center.y);
    }
  });

  it('connects every leg: walking legs stay walkable, the lift leg rides a lift from its pad to its top', () => {
    const route = HOLLOWROOT.route;
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1];
      const b = route[i];
      if (a === undefined || b === undefined) continue;
      if (b.lift !== undefined) {
        const lift = HOLLOWROOT.lifts.find((l) => l.id === b.lift);
        expect(lift, b.lift).toBeDefined();
        if (lift === undefined) continue;
        expect(flat(a.pos, lift.pad), `${b.lift} pad`).toBeLessThan(0.5);
        expect(flat(b.pos, lift.to.pos) + Math.abs(b.pos.y - lift.to.pos.y), `${b.lift} top`).toBeLessThan(0.5);
        continue;
      }
      expect(flat(a.pos, b.pos), `leg ${i}`).toBeLessThan(25);
      expect(slopeDeg(a.pos, b.pos), `leg ${i} (${a.room} → ${b.room})`).toBeLessThanOrEqual(MAX_LEG_SLOPE_DEG);
    }
  });

  it('is carved into the terrain: every waypoint lies on walkable ground at its height, the room floors are flat', () => {
    for (const [i, r] of HOLLOWROOT.route.entries()) {
      expect(Math.abs(terrain.heightAt(r.pos.x, r.pos.z) - r.pos.y), `waypoint ${i} (${r.room})`).toBeLessThanOrEqual(1.2);
      expect(terrain.walkable(r.pos.x, r.pos.z), `waypoint ${i} (${r.room})`).toBe(true);
    }
    for (const room of HOLLOWROOT.rooms.slice(1)) expect(terrain.heightAt(room.center.x, room.center.z), room.id).toBe(room.center.y);
    // The ramp's start keeps the root arch's contract ground y 14.
    expect(terrain.heightAt(LOCATIONS.hollowroot_entrance.x, LOCATIONS.hollowroot_entrance.z)).toBe(14);
  });

  it('holds its Rootbound Warden arena on a 14 m flat floor at the deepest point', () => {
    const { arena } = HOLLOWROOT;
    expect(arena.elite).toBe('rootboundWarden');
    expect(arena.radius).toBe(14);
    expect(arena.center.y).toBe(SHRINE_FLOOR_Y);
    for (let a = 0; a < 16; a++) {
      const x = arena.center.x + Math.cos((a * Math.PI) / 8) * (arena.radius - 0.5);
      const z = arena.center.z + Math.sin((a * Math.PI) / 8) * (arena.radius - 0.5);
      expect(terrain.heightAt(x, z), `edge ${a}`).toBeCloseTo(SHRINE_FLOOR_Y, 3);
    }
    expect(flat(arena.guardian.pos, arena.center)).toBeLessThan(arena.radius);
    const warden = SPAWNERS.filter((s) => s.campId === 'rootboundWarden');
    expect(warden.map((s) => s.kind)).toEqual(['rootboundWarden']);
  });

  it('places two checkpoint runes of radius 2 m: behind the bramble gate and past the combat room (Req 12.7)', () => {
    expect(HOLLOWROOT.checkpoints.map((c) => c.id)).toEqual(['cp_hollowroot_1', 'cp_hollowroot_2']);
    for (const c of HOLLOWROOT.checkpoints) {
      expect(c.radius, c.id).toBe(CHECKPOINT_RADIUS);
      expect(CHECKPOINT_RADIUS).toBe(2);
      expect(terrain.heightAt(c.spot.pos.x, c.spot.pos.z), c.id).toBe(c.spot.pos.y);
      expect(checkpointById(c.id)?.area.id).toBe('hollowroot');
    }
    const along = (p: { x: number; z: number }): number => HOLLOWROOT.route.findIndex((r) => flat(r.pos, p) < 0.5);
    const [cp1, cp2] = HOLLOWROOT.checkpoints;
    const index = (room: ShrineRoomId): number => HOLLOWROOT.route.findIndex((r) => r.room === room);
    expect(along(cp1?.spot.pos ?? { x: 0, z: 0 })).toBeGreaterThan(index('R1'));
    expect(along(cp1?.spot.pos ?? { x: 0, z: 0 })).toBeLessThan(index('R2'));
    expect(along(cp2?.spot.pos ?? { x: 0, z: 0 })).toBeGreaterThan(index('R4'));
    expect(along(cp2?.spot.pos ?? { x: 0, z: 0 })).toBeLessThan(index('R6'));
    expect(cp2?.litWhen).toEqual({ kind: 'roomCleared', groupId: 'hollowroot_room' });
  });

  it('declares its own music and a green fog with glowing roots (Req 12.4)', () => {
    expect(HOLLOWROOT.music).toBe('mus_area_hollowroot');
    const { fogColor, glow, lights } = HOLLOWROOT.lighting;
    const green = (c: number): boolean => ((c >> 8) & 0xff) > ((c >> 16) & 0xff) && ((c >> 8) & 0xff) > (c & 0xff);
    expect(green(fogColor)).toBe(true);
    expect(green(glow)).toBe(true);
    expect(lights.length).toBeGreaterThanOrEqual(HOLLOWROOT.rooms.length - 1);
    expect(CHALLENGE_AREA_DEFS.map((a) => a.id)).toEqual(['hollowroot', 'cinderspire', 'observatory']);
  });

  it('is entered from inside only, and its fall judgement lies below the landing', () => {
    const volume = AREA_VOLUMES.find((v) => v.id === 'hollowroot');
    if (volume === undefined) throw new Error('no hollowroot area');
    const entrance = LOCATIONS.hollowroot_entrance;
    expect(volumeContains(volume.shape, { x: entrance.x, y: entrance.groundY, z: entrance.z })).toBe(false);
    for (const room of HOLLOWROOT.rooms.slice(1)) expect(volumeContains(volume.shape, room.center), room.id).toBe(true);
    for (const c of HOLLOWROOT.checkpoints) expect(volumeContains(volume.shape, c.spot.pos), c.id).toBe(true);
    const shrineHazards = HAZARD_VOLUMES.filter((h) => h.area === 'hollowroot');
    const [well] = shrineHazards;
    expect(shrineHazards.map((h) => [h.id, h.area, h.effect])).toEqual([['hazard_hollowroot_well', 'hollowroot', 'fall']]);
    const floor = HOLLOWROOT.hazards[0];
    if (well === undefined || floor === undefined) throw new Error('no well');
    expect(volumeContains(well.shape, { x: floor.center.x, y: terrain.heightAt(floor.center.x, floor.center.z), z: floor.center.z })).toBe(true);
    // No walking waypoint is inside the fall judgement.
    for (const r of HOLLOWROOT.route) expect(volumeContains(well.shape, r.pos)).toBe(false);
  });
});

describe('Hollowroot puzzles, doors and lifts', () => {
  it('has one Ember, one Gale and one Terra puzzle in ms3 order (Req 12.1)', () => {
    const table = HOLLOWROOT_PUZZLES.map((d) => ({ id: d.id, kind: d.kind, devices: d.parts.map((p) => p.device), elements: d.parts.map((_, i) => partElement(d, i)) }));
    expect(table).toEqual([
      { id: 'pz_hollowroot_1', kind: 'single', devices: ['brambleGate'], elements: ['ember'] },
      { id: 'pz_hollowroot_2', kind: 'single', devices: ['windWheel'], elements: ['gale'] },
      { id: 'pz_hollowroot_3', kind: 'weight', devices: ['pressurePlate', 'crackedBoulder'], elements: ['terra', 'terra'] },
    ]);
    for (const d of HOLLOWROOT_PUZZLES) expect(PUZZLES).toContain(d);
    const solves = MAIN_QUEST.stages.flatMap((s) => s.objectives).flatMap((o) => (o.trigger.kind === 'solve' ? [o.trigger.puzzleId] : []));
    expect(solves.filter((id) => id.startsWith('pz_hollowroot_'))).toEqual(HOLLOWROOT_PUZZLES.map((d) => d.id));
    for (const d of HOLLOWROOT_PUZZLES) {
      for (const p of d.parts) expect(terrain.heightAt(p.pos.x, p.pos.z), p.id).toBeCloseTo(p.pos.y ?? Number.NaN, 3);
    }
  });

  it('puts the root door 12 m past the pressure plate, with the boulder behind the door', () => {
    expect(flat(HOLLOWROOT_DEVICES.plate, HOLLOWROOT_DEVICES.rootDoor)).toBeCloseTo(12, 6);
    const door = HOLLOWROOT.doors.find((d) => d.id === 'hr_door_root');
    expect(door?.openWhen).toEqual({ kind: 'puzzleOpen', target: 'hollowroot_root_door' });
    const pz3 = HOLLOWROOT_PUZZLES.find((d) => d.id === 'pz_hollowroot_3');
    expect(pz3 !== undefined && isOpensReward(pz3.reward) ? pz3.reward.opens : null).toBe('hollowroot_root_door');
    const route = HOLLOWROOT.route.map((r) => r.pos);
    const nearest = (p: { x: number; z: number }): number => route.reduce((best, q, i) => (flat(q, p) < flat(route[best] ?? q, p) ? i : best), 0);
    expect(nearest(HOLLOWROOT_DEVICES.plate)).toBeLessThan(nearest(HOLLOWROOT_DEVICES.rootDoor));
    expect(nearest(HOLLOWROOT_DEVICES.rootDoor)).toBeLessThan(nearest(HOLLOWROOT_DEVICES.boulder));
  });

  it('opens each door on its own condition and runs the exit lift only after Skyshard 1 (Req 12.9)', () => {
    expect(HOLLOWROOT.doors.map((d) => [d.id, d.openWhen])).toEqual([
      ['hr_door_bramble', { kind: 'puzzleSolved', puzzleId: 'pz_hollowroot_1' }],
      ['hr_door_root', { kind: 'puzzleOpen', target: 'hollowroot_root_door' }],
      ['hr_door_boulder', { kind: 'puzzleSolved', puzzleId: 'pz_hollowroot_3' }],
      ['hr_door_room_in', { kind: 'roomUnlocked', groupId: 'hollowroot_room' }],
      ['hr_door_room_out', { kind: 'roomCleared', groupId: 'hollowroot_room' }],
      ['hr_door_skyshard', { kind: 'eliteDefeated', elite: 'rootboundWarden' }],
    ]);
    const exit = HOLLOWROOT.lifts.find((l) => l.id === HOLLOWROOT.exitLift);
    expect(exit?.when).toEqual({ kind: 'skyshard', index: 1 });
    const ws = LOCATIONS.ws_elderbough;
    expect(flat(exit?.to.pos ?? { x: 0, z: 0 }, ws)).toBeLessThan(4);
    expect(exit?.to.pos.y).toBe(terrain.heightAt(exit?.to.pos.x ?? 0, exit?.to.pos.z ?? 0));
    expect(HOLLOWROOT.skyshard.index).toBe(1);
    expect(flat(HOLLOWROOT.skyshard.pos, HOLLOWROOT.rooms[6]?.center ?? { x: 0, z: 0 })).toBeLessThan(HOLLOWROOT.rooms[6]?.radius ?? 0);
    // The R4 room holds bramblekin ×4 and thornspitter ×2 (design R4).
    const room = SPAWNERS.filter((s) => s.campId === 'hollowroot_room');
    expect(room.map((s) => s.kind).sort()).toEqual(['bramblekin', 'bramblekin', 'bramblekin', 'bramblekin', 'thornspitter', 'thornspitter']);
    const r4 = HOLLOWROOT.combatRooms[0];
    for (const s of room) expect(flat(s.pos, r4?.center ?? { x: 0, z: 0 }), s.id).toBeLessThan((r4?.radius ?? 0) + 1);
  });
});
