import { describe, expect, it } from 'vitest';
import { PlayerCombat, type CombatBody } from '../../../src/combat/playerCombat';
import { createGameEventBus } from '../../../src/core/gameEvents';
import { createRng } from '../../../src/core/rng';
import type { Vec3 } from '../../../src/core/types';
import { CHARACTERS } from '../../../src/data/characters';
import { CHARACTER_IDS, type CharacterId } from '../../../src/data/ids';
import { DeviceReceiver } from '../../../src/element/receivers';
import { InputState, type RawInput } from '../../../src/input/inputState';
import { createStaminaState, type StaminaState } from '../../../src/logic/stamina';
import { switchContextFor } from '../../../src/party/partySystem';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { flatHeightfield } from '../../../src/physics/heightfield';
import type { Collider, CollisionWorld } from '../../../src/physics/types';
import {
  CAPSULE_HEIGHT,
  CLIMB_ATTACH_PUSH_TIME,
  CLIMB_LEAP_DISTANCE,
  CLIMB_SPEED,
  CLIMB_SURFACE_OFFSET,
  MANTLE_TIME,
} from '../../../src/player/core/constants';
import { stepController } from '../../../src/player/core/stepController';
import {
  MOVE_MODES,
  createControllerState,
  isClimbMode,
  type ControllerEventType,
  type ControllerInput,
  type ControllerState,
  type ControllerStepResult,
} from '../../../src/player/core/types';
import { HeatCrystalWall, heatCrystalFlags } from '../../../src/world/heatCrystal';

// Climbing (design "Player Controller" → "등반"; Req 18.2–18.11) at fixed 60 Hz against a real CollisionWorld.
// The climbed wall is the x = 1 face of a box (outward normal −X); the character faces it along +X.
const DT = 1 / 60;
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const NO_INPUT: ControllerInput = { move: { x: 0, z: 0 }, sprint: false, walk: false, jump: false, dodge: false, release: false };
const inp = (over: Partial<ControllerInput> = {}): ControllerInput => ({ ...NO_INPUT, ...over });
const EAST = { x: 1, z: 0 };
const WEST = { x: -1, z: 0 };
/** Feet x of a character climbing the x = 1 face (capsule centre 0.45 m off it). */
const ON_WALL_X = 1 - CLIMB_SURFACE_OFFSET;
const CENTRE = CAPSULE_HEIGHT / 2;

function box(id: number, min: Vec3, max: Vec3, climbable: boolean): Collider {
  return { kind: 'aabb', id, min, max, flags: { climbable, walkableTop: true, blocksCamera: true, material: 'stone' } };
}

/** Flat ground at y 0 and a wall box x ∈ [1, 3], z ∈ [−10, 10] up to `height`. */
function wallWorld(height = 20, climbable = true): CollisionWorld {
  const world = createCollisionWorld(flatHeightfield(0));
  world.addStatic(box(1, v(1, -1, -10), v(3, height, 10), climbable));
  return world;
}

/** Climbing the x = 1 face with the feet at height y. */
const onWall = (y: number, z = 0): ControllerState => ({
  ...createControllerState(v(ON_WALL_X, y, z), Math.PI / 2),
  mode: 'climb',
  grounded: false,
  climbNormal: v(-1, 0, 0),
});

/** The facing's right in world space (core/math: yaw 0 faces +Z, its right is −X). */
const rightOf = (s: ControllerState) => ({ x: -Math.cos(s.yaw), z: Math.sin(s.yaw) });
/** The facing in world space (toward the wall: "up" while climbing). */
const forwardOf = (s: ControllerState) => ({ x: Math.sin(s.yaw), z: Math.cos(s.yaw) });

/** Runs `ticks` ticks; the input may depend on the state (camera behind the character). */
function run(
  world: CollisionWorld,
  start: ControllerState,
  input: (s: ControllerState, tick: number) => ControllerInput,
  ticks: number,
  opts: { stamina?: StaminaState; character?: CharacterId } = {},
): ControllerStepResult[] {
  const out: ControllerStepResult[] = [];
  let state = start;
  let stamina = opts.stamina ?? createStaminaState();
  for (let i = 0; i < ticks; i++) {
    const r = stepController(state, input(state, i), world, stamina, opts.character ?? 'kairen', DT);
    out.push(r);
    state = r.state;
    stamina = r.stamina;
  }
  return out;
}

const types = (r: ControllerStepResult): ControllerEventType[] => r.events.map((e) => e.type);
const firstWith = (rs: readonly ControllerStepResult[], type: ControllerEventType): number =>
  rs.findIndex((r) => r.events.some((e) => e.type === type));
const centreOf = (s: ControllerState): Vec3 => v(s.pos.x, s.pos.y + CENTRE, s.pos.z);

/** Distance from `p` to an axis-aligned box (0 inside). */
function boxDistance(p: Vec3, min: Vec3, max: Vec3): number {
  const dx = Math.max(min.x - p.x, 0, p.x - max.x);
  const dy = Math.max(min.y - p.y, 0, p.y - max.y);
  const dz = Math.max(min.z - p.z, 0, p.z - max.z);
  return Math.hypot(dx, dy, dz);
}

describe('climb attach (Req 18.2, 18.9)', () => {
  const start = createControllerState(v(0, 0, 0), Math.PI / 2);
  const push = () => inp({ move: EAST });

  it('attaches after pushing into a climbable ≥ 65° wall for 0.2 s: velocity 0, climbStarted, facing the wall', () => {
    const res = run(wallWorld(), start, push, 60);
    const contact = res.findIndex((r) => r.state.pos.x >= 0.589);
    const attach = firstWith(res, 'climbStarted');
    expect(contact).toBeGreaterThan(0);
    expect(attach - contact).toBe(Math.round(CLIMB_ATTACH_PUSH_TIME / DT) - 1); // the 12th pushing tick
    expect(res.slice(0, attach).every((r) => r.state.mode === 'grounded')).toBe(true);
    const s = res[attach].state;
    expect(types(res[attach])).toEqual(['climbStarted']);
    expect(s).toMatchObject({ mode: 'climbAttach', vel: v(0, 0, 0), grounded: false });
    expect(s.pos.x).toBeCloseTo(ON_WALL_X, 6);
    expect(s.climbNormal!.x).toBeCloseTo(-1, 9);
    expect(s.yaw).toBeCloseTo(Math.PI / 2, 9);
    expect(firstWith(res.slice(attach + 1), 'climbStarted')).toBe(-1);
    // climbAttach turns into climb, and the held input climbs.
    expect(res[59].state.mode).toBe('climb');
    expect(res[59].state.pos.y).toBeGreaterThan(0.2);
  });

  it('does not attach while Exhausted (canStart climbMove refuses), to a non-climbable wall, or to an object under 1 m', () => {
    const tired: StaminaState = { value: 10, max: 100, exhausted: true, idleTimer: 0 };
    const cases: [CollisionWorld, StaminaState | undefined][] = [
      [wallWorld(), tired],
      [wallWorld(20, false), undefined], // Blight crystal, seal, hot Heat_Crystal: climbable false
      [wallWorld(0.95), undefined], // too high to step onto, too low to climb
    ];
    for (const [world, stamina] of cases) {
      const res = run(world, start, push, 90, { stamina });
      expect(firstWith(res, 'climbStarted')).toBe(-1);
      expect(res.every((r) => r.state.mode === 'grounded')).toBe(true);
      expect(res[89].state.pos.x).toBeCloseTo(0.59, 3); // stopped by the wall
    }
  });

  it('attaches in the air on touching a climbable wall while pushing into it, unless Exhausted', () => {
    const falling: ControllerState = { ...createControllerState(v(0.3, 6, 0), Math.PI / 2), mode: 'fall', grounded: false };
    const res = run(wallWorld(), falling, push, 30);
    const attach = firstWith(res, 'climbStarted');
    expect(attach).toBeGreaterThanOrEqual(0);
    expect(res[attach].state).toMatchObject({ mode: 'climbAttach', vel: v(0, 0, 0) });
    expect(res[attach].state.pos.y).toBeGreaterThan(5);
    expect(res[attach].state.fallStartY).toBe(res[attach].state.pos.y);

    const tired = run(wallWorld(), falling, push, 30, { stamina: { value: 10, max: 100, exhausted: true, idleTimer: 0 } });
    expect(firstWith(tired, 'climbStarted')).toBe(-1);
  });
});

describe('climbing on the wall (Req 18.3, 18.10)', () => {
  it('climbs up, down and sideways at 2 m/s, 0.45 m off the surface, draining 10/s moving and 2/s holding', () => {
    const world = wallWorld();
    const upRes = run(world, onWall(2), () => inp({ move: EAST }), 60);
    expect(upRes.every((r) => r.state.mode === 'climb')).toBe(true);
    expect(upRes[59].state.pos.y - 2).toBeCloseTo(CLIMB_SPEED, 6);
    for (const r of upRes) expect(r.state.pos.x).toBeCloseTo(ON_WALL_X, 6);
    expect(upRes[59].stamina.value).toBeCloseTo(90, 6);

    const side = run(world, onWall(2), (s) => inp({ move: rightOf(s) }), 60);
    expect(side[59].state.pos.z).toBeCloseTo(CLIMB_SPEED, 6); // facing +X, right is +Z
    expect(side[59].state.pos.y).toBeCloseTo(2, 6);

    const down = run(world, onWall(4), () => inp({ move: WEST }), 30);
    expect(down[29].state.pos.y).toBeCloseTo(4 - CLIMB_SPEED / 2, 6);

    const hold = run(world, onWall(2), () => NO_INPUT, 60);
    expect(hold.every((r) => r.state.mode === 'climb' && Math.abs(r.state.pos.y - 2) < 1e-9)).toBe(true);
    expect(hold[59].stamina.value).toBeCloseTo(98, 6);
    expect(run(world, onWall(2), () => inp({ move: EAST }), 60, { character: 'talus' })[59].stamina.value).toBeCloseTo(92.5, 6);
  });

  it('wraps around a convex corner: the normal turns onto the next face and the centre stays 0.45 m off the box', () => {
    const min = v(1, -1, -10);
    const max = v(3, 20, 2);
    const world = createCollisionWorld(flatHeightfield(0));
    world.addStatic(box(1, min, max, true));
    const res = run(world, onWall(3), (s) => inp({ move: rightOf(s) }), 120);
    for (const r of res) {
      expect(r.state.mode).toBe('climb');
      const d = boxDistance(centreOf(r.state), min, max);
      expect(d).toBeGreaterThanOrEqual(0.3);
      expect(d).toBeLessThanOrEqual(0.5);
    }
    const end = res[119].state;
    expect(end.climbNormal!.z).toBeCloseTo(1, 6); // now on the z = 2 face
    expect(end.yaw).toBeCloseTo(Math.PI, 6); // facing −Z
    expect(end.pos.z).toBeCloseTo(2 + CLIMB_SURFACE_OFFSET, 6);
    expect(end.pos.x).toBeGreaterThan(1.5);
  });

  it('turns onto the adjacent face of a concave corner with the tangent sweep instead of entering it', () => {
    const world = createCollisionWorld(flatHeightfield(0));
    const a = { min: v(1, -1, -10), max: v(3, 20, 10) };
    const b = { min: v(-4, -1, 2), max: v(1, 20, 4) }; // meets the x = 1 face along z = 2
    world.addStatic(box(1, a.min, a.max, true));
    world.addStatic(box(2, b.min, b.max, true));
    const res = run(world, onWall(3), (s) => inp({ move: rightOf(s) }), 120);
    for (const r of res) {
      expect(r.state.mode).toBe('climb');
      expect(boxDistance(centreOf(r.state), a.min, a.max)).toBeGreaterThanOrEqual(0.3);
      expect(boxDistance(centreOf(r.state), b.min, b.max)).toBeGreaterThanOrEqual(0.3);
    }
    const end = res[119].state;
    expect(end.climbNormal!.z).toBeCloseTo(-1, 6); // on the z = 2 face of b, facing +Z
    expect(end.pos.z).toBeCloseTo(2 - CLIMB_SURFACE_OFFSET, 6);
    expect(end.pos.x).toBeLessThan(0);
  });

  it('falls when no climbable surface is within 0.9 m (a Heat_Crystal heating up again)', () => {
    const world = createCollisionWorld(flatHeightfield(0));
    const crystal = new DeviceReceiver('hc', 'heatCrystal');
    const wall = new HeatCrystalWall(world, 7, { kind: 'aabb', min: v(1, -1, -10), max: v(3, 20, 10) }, crystal);
    expect(heatCrystalFlags(crystal, 0)).toMatchObject({ climbable: false, hazard: 'heat' });
    wall.sync(0);
    expect(firstWith(run(world, createControllerState(v(0, 0, 0), Math.PI / 2), () => inp({ move: EAST }), 60), 'climbStarted')).toBe(-1);

    crystal.onElement('tide', 0);
    expect(heatCrystalFlags(crystal, 0)).toEqual({ climbable: true, walkableTop: false, blocksCamera: true, material: 'crystal' });
    expect(wall.sync(0)).toBe(true);
    const climbing = run(world, onWall(3), () => inp({ move: EAST }), 30);
    expect(climbing.every((r) => r.state.mode === 'climb')).toBe(true);

    expect(wall.sync(10)).toBe(true); // 10 s after the Tide: hot again, not climbable
    const [r] = run(world, climbing[29].state, () => inp({ move: EAST }), 1, { stamina: climbing[29].stamina });
    expect(r.state).toMatchObject({ mode: 'fall', climbNormal: null, grounded: false });
  });
});

describe('climb exits (Req 18.4–18.8)', () => {
  it('mantles onto the top in 0.45 s once the head ray misses and walkable ground is within 1.2 m', () => {
    const world = wallWorld(3);
    const res = run(world, onWall(0.5), () => inp({ move: EAST }), 90);
    const entered = res.findIndex((r) => r.state.mode === 'mantle');
    const done = firstWith(res, 'mantled');
    expect(entered).toBeGreaterThan(0);
    expect(res[entered - 1].state.mode).toBe('climb');
    expect(res[entered].state.pos.y + 1.7).toBeGreaterThan(3); // the head ray passes over the top
    // Entered at the end of a climb tick, then 27 scripted ticks (0.45 s ≤ 0.5 s) onto the top.
    expect(done - entered).toBe(Math.round(MANTLE_TIME / DT));
    expect(res.slice(entered, done).every((r) => r.state.mode === 'mantle')).toBe(true);
    expect(res[done].state).toMatchObject({ mode: 'grounded', grounded: true, climbNormal: null, mantleTarget: null });
    expect(res[done].state.pos.y).toBeCloseTo(3, 6);
    expect(res[done].state.pos.x).toBeGreaterThan(1.4);
    expect(res.filter((r) => types(r).includes('mantled'))).toHaveLength(1);
  });

  it('attaches to a 1.2 m climbable block from the ground and mantles straight onto it', () => {
    const res = run(wallWorld(1.2), createControllerState(v(0, 0, 0), Math.PI / 2), () => inp({ move: EAST }), 90);
    expect(firstWith(res, 'climbStarted')).toBeGreaterThan(0);
    const done = firstWith(res, 'mantled');
    expect(done).toBeGreaterThan(0);
    expect(res[done].state.pos.y).toBeCloseTo(1.2, 6);
  });

  it('stands on walkable ground found within 0.3 m below the feet while climbing down', () => {
    const res = run(wallWorld(), onWall(1), () => inp({ move: WEST }), 40);
    const stand = res.findIndex((r) => r.state.mode === 'grounded');
    expect(stand).toBeGreaterThan(0);
    expect(res[stand - 1].state.pos.y).toBeGreaterThan(0.3 - 1e-9);
    expect(res[stand].state).toMatchObject({ grounded: true, climbNormal: null });
    expect(res[stand].state.pos.y).toBeCloseTo(0, 9);
  });

  it('leaps 2 m toward the input (up without input) for 20 Stamina, and not without 20', () => {
    const world = wallWorld();
    const leapUp = run(world, onWall(2), (_, i) => inp({ jump: i === 0 }), 30);
    expect(leapUp[0].consumed.jump).toBe(true);
    expect(leapUp[0].state.mode).toBe('climbLeap');
    expect(leapUp[0].stamina.value).toBe(80);
    const back = leapUp.findIndex((r) => r.state.mode === 'climb');
    expect(back).toBe(Math.round(0.4 / DT) - 1); // 24 ticks = 0.4 s
    expect(leapUp[back].state.pos.y - 2).toBeCloseTo(CLIMB_LEAP_DISTANCE, 6);
    expect(leapUp[back].state.pos.x).toBeCloseTo(ON_WALL_X, 6);

    const leapSide = run(world, onWall(2), (s, i) => inp({ move: rightOf(s), jump: i === 0 }), 24, { character: 'talus' });
    expect(leapSide[0].stamina.value).toBe(85); // Talus −25 %
    expect(leapSide[23].state.pos.z).toBeCloseTo(CLIMB_LEAP_DISTANCE, 6);
    expect(leapSide[23].state.pos.y).toBeCloseTo(2, 6);

    const [low] = run(world, onWall(2), () => inp({ jump: true }), 1, { stamina: { value: 19, max: 100, exhausted: false, idleTimer: 0 } });
    expect(low.consumed.jump).toBe(false);
    expect(low.state.mode).toBe('climb');
  });

  it('lets go into a fall on C and does not grab the wall again at once', () => {
    const world = wallWorld();
    const res = run(world, onWall(5), (s, i) => inp({ move: forwardOf(s), release: i === 0 }), 60);
    expect(res[0].state).toMatchObject({ mode: 'fall', climbNormal: null, grounded: false });
    expect(res.slice(0, 18).every((r) => r.state.mode === 'fall')).toBe(true); // 0.3 s
    expect(res[17].state.pos.y).toBeLessThan(5);
  });

  it('drops into a fall on the tick Stamina runs out', () => {
    const [r] = run(wallWorld(), onWall(5), () => inp({ move: EAST }), 1, { stamina: { value: 0.1, max: 100, exhausted: false, idleTimer: 0 } });
    expect(types(r)).toEqual(['exhausted']);
    expect(r.stamina).toMatchObject({ value: 0, exhausted: true });
    expect(r.state).toMatchObject({ mode: 'fall', climbNormal: null });
  });
});

describe('input limits while climbing (Req 18.11, 23.4)', () => {
  const tap = (code: string): RawInput[] => [
    { kind: 'down', code, time: 0 },
    { kind: 'up', code, time: 0 },
  ];
  const perCharacter = (n: number) => Object.fromEntries(CHARACTER_IDS.map((id) => [id, n])) as Record<CharacterId, number>;

  class Body implements CombatBody {
    state: ControllerState = onWall(3);
    face(yaw: number): void {
      this.state = { ...this.state, yaw };
    }
  }

  it('the climbing family refuses party switches', () => {
    for (const mode of MOVE_MODES) expect(isClimbMode(mode), mode).toBe(switchContextFor(mode) === 'climb');
  });

  it('ignores Normal_Attack, Skill and Burst input: nothing starts, nothing is refused, a buffered press does not fire later', () => {
    const bus = createGameEventBus();
    const refused: unknown[] = [];
    bus.on('ability:refused', (p) => refused.push(p));
    const energy = perCharacter(0);
    energy.kairen = CHARACTERS.kairen.burst.energyCost;
    const cooldowns = perCharacter(0);
    const input = new InputState();
    const body = new Body();
    const combat = new PlayerCombat({ bus, rng: createRng(1), level: () => 1, character: () => 'kairen', energy, cooldowns });
    const tick = (raw: RawInput[] = []) => {
      input.beginTick(raw, DT);
      combat.tick({ input, body, cameraYaw: 0, targets: [], dt: DT });
      bus.dispatch();
    };
    for (const mode of ['climbAttach', 'climb', 'climbLeap', 'mantle'] as const) {
      body.state = { ...body.state, mode };
      for (const raw of [tap('Mouse0'), tap('KeyE'), tap('KeyQ')]) {
        tick(raw);
        expect(combat.attack, mode).toBeNull();
      }
    }
    expect(refused).toEqual([]);
    expect([energy.kairen, cooldowns.kairen]).toEqual([CHARACTERS.kairen.burst.energyCost, 0]);

    // Back on the ground the next tick: the attack pressed while climbing is gone from the buffer.
    tick(tap('Mouse0'));
    body.state = { ...createControllerState(v(0, 0, 0), 0) };
    tick();
    expect(combat.attack).toBeNull();
    tick(tap('Mouse0'));
    expect(combat.attack?.def.id).toBe('atk_kairen_n1');
  });
});
