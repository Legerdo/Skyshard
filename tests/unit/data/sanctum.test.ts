import { describe, expect, it } from 'vitest';
import { ARENA, SHARD_CRYSTAL_SOCKETS } from '../../../src/data/boss';
import type { AreaShape } from '../../../src/data/challengeAreas';
import { CHARACTERS } from '../../../src/data/characters';
import { arenaBearing, arenaSectorAt, SANCTUM, type SanctumPieceDef } from '../../../src/data/sanctum';
import { STARLIT_STAIR } from '../../../src/data/starlitStair';
import { LOCATIONS } from '../../../src/data/worldLayout';
import { CAPSULE_HEIGHT, CAPSULE_RADIUS, JUMP_APEX_HEIGHT, STEP_UP_HEIGHT } from '../../../src/player/core/constants';
import { sanctumPieceCollider } from '../../../src/world/sanctum';

// Astral Sanctum layout (task 10.2; design "Boss Caelith" Arena; Req 5.7, 6.11): the arena at sanctum_arena with its
// sectors, pedestals, rim, ward and entrance, and the connecting hall with ws_sanctum and the mural.

const { arena } = SANCTUM;
const piece = (id: string): SanctumPieceDef => {
  const p = SANCTUM.pieces.find((x) => x.id === id);
  if (p === undefined) throw new Error(`no piece ${id}`);
  return p;
};
const byLook = (look: SanctumPieceDef['look']): SanctumPieceDef[] => SANCTUM.pieces.filter((p) => p.look === look);
type Obb = Extract<AreaShape, { kind: 'obb' }>;
const obb = (p: SanctumPieceDef): Obb => {
  if (p.shape.kind !== 'obb') throw new Error(`${p.id} is not a box`);
  return p.shape;
};
const top = (s: AreaShape): number => (s.kind === 'obb' ? s.center.y + s.half.y : s.base.y + s.height);
const bottom = (s: AreaShape): number => (s.kind === 'obb' ? s.center.y - s.half.y : s.base.y);
/** Whether (x, z) lies in the box's footprint (local +Z along dirFromYaw(yaw), grown by `grow`). */
const inFootprint = (s: Obb, x: number, z: number, grow = 0): boolean => {
  const dx = x - s.center.x;
  const dz = z - s.center.z;
  const c = Math.cos(s.yaw);
  const n = Math.sin(s.yaw);
  return Math.abs(dx * c - dz * n) <= s.half.x + grow && Math.abs(dx * n + dz * c) <= s.half.z + grow;
};
/** Point on the circle of radius `r` around the arena centre at compass bearing `deg`. */
const onCircle = (deg: number, r: number): { x: number; z: number } => {
  const a = (deg * Math.PI) / 180;
  return { x: arena.center.x + r * Math.sin(a), z: arena.center.z - r * Math.cos(a) };
};

describe('Caelith arena (design Arena)', () => {
  it('is the 32 m disc at sanctum_arena (0, 30), floor y 182', () => {
    const loc = LOCATIONS.sanctum_arena;
    expect(ARENA.location).toBe('sanctum_arena');
    expect(arena.center).toEqual({ x: loc.x, y: loc.groundY, z: loc.z });
    expect(arena.center).toEqual({ x: 0, y: 182, z: 30 });
    expect(arena.radius).toBe(32);
    const floor = piece('sanctum_arena_floor');
    expect(floor.walkableTop).toBe(true);
    expect(floor.shape).toMatchObject({ kind: 'cylinder', base: { x: 0, z: 30 }, radius: 32 });
    expect(top(floor.shape)).toBe(182);
  });

  it('divides the floor into 8 sectors of 45°, sector 0 facing the entrance (north), numbered clockwise', () => {
    expect(arena.sectors).toHaveLength(ARENA.sectors);
    expect(arena.sectors.map((s) => s.toDeg - s.fromDeg)).toEqual(Array(8).fill(45));
    expect(arena.sectors.map((s) => s.centerDeg)).toEqual([0, 45, 90, 135, 180, 225, 270, 315]);
    arena.sectors.forEach((s, i) => expect(s.fromDeg).toBe(i === 0 ? -22.5 : arena.sectors[i - 1].toDeg));
    // Every point of the disc is in exactly the sector around its bearing; off the disc there is none.
    for (let deg = 0; deg < 360; deg += 7.5) {
      for (const r of [1, 16, 31.9]) {
        const p = onCircle(deg + 0.1, r);
        expect(arenaSectorAt(p.x, p.z)).toBe(Math.floor(((deg + 0.1 + 22.5) % 360) / 45));
      }
    }
    expect(arenaSectorAt(0, 30 - 20)).toBe(0);
    expect(arenaSectorAt(20, 30)).toBe(2);
    expect(arenaSectorAt(0, 50)).toBe(4);
    expect(arenaSectorAt(-20, 30)).toBe(6);
    expect(arenaSectorAt(0, 30 - 32.5)).toBeNull();
    expect(arenaSectorAt(Number.NaN, 30)).toBeNull();
    expect(arenaBearing(33, 30)).toBeCloseTo(90);
  });

  it('puts the four Shard_Crystal pedestals 18 m out, north / east / south / west, one Element each', () => {
    expect(arena.pedestals).toHaveLength(4);
    expect(arena.pedestals.map((p) => p.element).sort()).toEqual(['ember', 'gale', 'terra', 'tide']);
    for (const p of arena.pedestals) {
      expect(Math.hypot(p.pos.x - arena.center.x, p.pos.z - arena.center.z)).toBeCloseTo(ARENA.socketRadius, 9);
      expect(p.pos.y).toBe(arena.center.y);
      const socket = SHARD_CRYSTAL_SOCKETS.find((s) => s.element === p.element);
      expect(p.pos).toEqual({ x: arena.center.x + (socket?.dx ?? NaN), y: 182, z: arena.center.z + (socket?.dz ?? NaN) });
      // A low standable dais (the Shard_Crystal stands on it), in the sector around its bearing.
      const solid = piece(p.id);
      expect(solid.shape).toMatchObject({ kind: 'cylinder', base: p.pos, radius: p.radius, height: p.height });
      expect(p.height).toBeLessThanOrEqual(STEP_UP_HEIGHT);
      expect(p.sector).toBe(arenaSectorAt(p.pos.x, p.pos.z));
    }
    expect(arena.pedestals.map((p) => p.sector).sort()).toEqual([0, 2, 4, 6]);
  });

  it('rings the disc with a 1.2 m rim wall nobody climbs or stands on, and a ward above it no jump clears', () => {
    const rims = byLook('rim');
    const wards = byLook('ward');
    expect(arena.rim.height).toBe(ARENA.rimHeight);
    expect(ARENA.rimHeight).toBe(1.2);
    expect(rims).toHaveLength(arena.rim.segments - 1); // one segment left out: the entrance
    for (const rim of rims) {
      expect(top(rim.shape) - arena.center.y).toBeCloseTo(1.2, 9);
      expect(rim.walkableTop).toBe(false);
      const collider = sanctumPieceCollider(rim, 1);
      expect(collider.flags).toMatchObject({ climbable: false, walkableTop: false });
    }
    // Nothing in the Sanctum is climbable.
    expect(SANCTUM.pieces.every((p) => !sanctumPieceCollider(p, 1).flags.climbable)).toBe(true);
    // The ward stands on the rim up to above a jump from a Talus pillar with the whole capsule.
    const pillar = CHARACTERS.talus.skill.params.pillarHeight ?? 0;
    expect(arena.rim.wardTop).toBeGreaterThan(pillar + JUMP_APEX_HEIGHT + CAPSULE_HEIGHT);
    expect(JUMP_APEX_HEIGHT).toBeGreaterThan(ARENA.rimHeight); // why the ward is there
    expect(wards).toHaveLength(rims.length);
    for (const ward of wards) {
      expect(bottom(ward.shape) - arena.center.y).toBeCloseTo(1.2, 9);
      expect(top(ward.shape) - arena.center.y).toBeCloseTo(arena.rim.wardTop, 9);
      expect(sanctumPieceCollider(ward, 1).flags).toMatchObject({ climbable: false, walkableTop: false, blocksCamera: false });
    }
    // Walls all around the circle but for the gap toward the hall (bearing 0), which the entrance seal fills. The
    // circle sampled runs inside every tangent segment, at its middle and at the joints with its neighbours.
    const r = arena.radius - 0.1;
    const covered = (deg: number, shapes: readonly Obb[]): boolean => {
      const p = onCircle(deg, r);
      return shapes.some((s) => inFootprint(s, p.x, p.z));
    };
    const rimShapes = rims.map(obb);
    const wardShapes = wards.map(obb);
    const seal = arena.seal.shape;
    for (let deg = -180; deg < 180; deg += 0.5) {
      if (Math.abs(deg) >= 8) {
        expect(covered(deg, rimShapes), `rim at ${deg}°`).toBe(true);
        expect(covered(deg, wardShapes), `ward at ${deg}°`).toBe(true);
      }
      if (Math.abs(deg) <= 7) expect(covered(deg, rimShapes), `gap at ${deg}°`).toBe(false);
      if (Math.abs(deg) <= 7.5) expect(covered(deg, [seal]), `seal at ${deg}°`).toBe(true);
    }
    expect(bottom(seal)).toBeLessThanOrEqual(arena.center.y - 0.5);
    expect(top(seal) - arena.center.y).toBeCloseTo(arena.rim.wardTop, 9);
    // The gap faces the hall: its middle is due north of the centre, toward sanctum_hall.
    expect(seal.center.x).toBeCloseTo(0, 9);
    expect(seal.center.z).toBeLessThan(arena.center.z - 31);
  });

  it('starts the fight 4 m inside the edge and retries just inside the entrance', () => {
    expect(arena.fightRadius).toBe(arena.radius - 4);
    const entry = SANCTUM.arenaEntry.pos;
    expect(entry.y).toBe(182);
    expect(Math.hypot(entry.x - arena.center.x, entry.z - arena.center.z)).toBeLessThanOrEqual(arena.fightRadius);
    expect(inFootprint(arena.seal.shape, entry.x, entry.z, CAPSULE_RADIUS)).toBe(false);
  });
});

describe('Sanctum approach and the connecting hall (Req 5.7)', () => {
  const { hall } = SANCTUM;
  const inHall = (p: { x: number; y: number; z: number }): boolean =>
    p.x >= hall.min.x && p.x <= hall.max.x && p.z >= hall.min.z && p.z <= hall.max.z && p.y >= hall.min.y && p.y <= hall.max.y;

  it('places ws_sanctum inside sanctum_hall with the spot 2 m in front of it, toward the arena', () => {
    const loc = LOCATIONS.sanctum_hall;
    expect(inHall({ x: loc.x, y: loc.groundY, z: loc.z })).toBe(true);
    const ws = SANCTUM.waystone;
    expect(ws.id).toBe('ws_sanctum');
    expect(ws.pos).toEqual({ x: LOCATIONS.ws_sanctum.x, y: LOCATIONS.ws_sanctum.groundY, z: LOCATIONS.ws_sanctum.z });
    expect(inHall(ws.pos)).toBe(true);
    expect(piece('sanctum_waystone').shape).toMatchObject({ kind: 'cylinder', base: ws.pos, radius: ws.radius });
    expect(inHall(ws.spot.pos)).toBe(true);
    expect(Math.hypot(ws.spot.pos.x - ws.pos.x, ws.spot.pos.z - ws.pos.z)).toBeCloseTo(2, 9);
    expect(ws.spot.pos.z).toBeGreaterThan(ws.pos.z); // the arena side
  });

  it('paints the mural on the hall wall, its interaction point inside the hall', () => {
    expect(SANCTUM.mural.id).toBe('sanctum_mural');
    expect(inHall(SANCTUM.mural.pos)).toBe(true);
    const wall = obb(piece('sanctum_hall_wall_w'));
    expect(Math.abs(SANCTUM.mural.panel.center.x - (wall.center.x + wall.half.x))).toBeLessThan(0.2);
    expect(sanctumPieceCollider(piece('sanctum_hall_wall_w'), 1).flags.climbable).toBe(false);
  });

  it('joins the Starlit_Stair to the hall and the hall to the arena with steps under the step-up height', () => {
    // Tier 3's last platform lies on the gate slab at the same height.
    const last = STARLIT_STAIR.platforms.at(-1);
    const gate = obb(piece('sanctum_gate_floor'));
    expect(last).toBeDefined();
    if (last === undefined) return;
    expect(top(gate)).toBe(last.topY);
    expect(inFootprint(gate, last.x, last.z)).toBe(true);
    const flight = (prefix: string): Obb[] => SANCTUM.pieces.filter((p) => p.id.startsWith(prefix)).map(obb);
    const hallFloor = obb(piece('sanctum_hall_floor'));
    for (const [steps, from, to] of [
      [flight('sanctum_steps_hall_'), top(gate), top(hallFloor)],
      [flight('sanctum_bridge_'), top(hallFloor), arena.center.y],
    ] as const) {
      const tops = [from, ...steps.map(top)];
      expect(tops.at(-1)).toBeCloseTo(to, 9);
      for (let i = 1; i < tops.length; i++) expect(tops[i] - tops[i - 1]).toBeLessThanOrEqual(STEP_UP_HEIGHT);
    }
    // The bridge's last step meets the arena's entrance edge.
    const bridge = flight('sanctum_bridge_');
    const lastStep = bridge.at(-1);
    expect(lastStep).toBeDefined();
    if (lastStep !== undefined) expect(lastStep.center.z + lastStep.half.z).toBeCloseTo(arena.center.z - arena.radius, 9);
  });
});
