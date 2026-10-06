import { beforeAll, describe, expect, it } from 'vitest';
import { PlayerCombat, type CombatBody } from '../../../src/combat/playerCombat';
import { createGameEventBus } from '../../../src/core/gameEvents';
import { createRng } from '../../../src/core/rng';
import type { Vec3 } from '../../../src/core/types';
import { UiCommandQueue } from '../../../src/core/uiCommands';
import { CHARACTERS } from '../../../src/data/characters';
import { CHARACTER_IDS, type CharacterId } from '../../../src/data/ids';
import { InputState, type RawInput } from '../../../src/input/inputState';
import { canStart, createStaminaState, type StaminaState } from '../../../src/logic/stamina';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { switchContextFor } from '../../../src/party/partySystem';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { analyticHeightfield, flatHeightfield } from '../../../src/physics/heightfield';
import type { CollisionWorld, Heightfield } from '../../../src/physics/types';
import { PlaySim } from '../../../src/playSim';
import {
  CAPSULE_HEIGHT,
  CAPSULE_RADIUS,
  FOOTSTEP_STRIDE,
  GLIDE_MAX_DESCENT_SPEED,
  GLIDE_SPEED,
  RUN_SPEED,
  SPRINT_SPEED,
  SWIM_DEPTH,
  SWIM_EXIT_PROBE,
  SWIM_FEET_DEPTH,
  SWIM_SETTLE_SPEED,
  SWIM_SPEED,
  WADE_SPEED_FACTOR,
} from '../../../src/player/core/constants';
import { stepController } from '../../../src/player/core/stepController';
import {
  createControllerState,
  type ControllerEventType,
  type ControllerInput,
  type ControllerState,
  type ControllerStepResult,
  type ControllerVolumes,
} from '../../../src/player/core/types';
import { PlayerController } from '../../../src/player/playerController';
import { RecoverySystem, type RecoveryTeleport, type SafePosition } from '../../../src/player/recovery';
import { createControllerVolumes } from '../../../src/world/controllerVolumes';
import { buildTerrain, type TerrainField } from '../../../src/world/terrain';
import { WATER_BODIES } from '../../../src/world/terrain/waterBodies';
import { VolumeIndex } from '../../../src/world/volumeIndex';

// Swimming and shallow water (design "Player Controller" → "수영·얕은 물"; Req 16.9–16.11) at fixed 60 Hz against a
// real CollisionWorld and ControllerVolumes. The water surface is at y 0 unless stated otherwise.
const DT = 1 / 60;
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const NO_INPUT: ControllerInput = { move: { x: 0, z: 0 }, sprint: false, walk: false, jump: false, dodge: false, release: false };
const inp = (over: Partial<ControllerInput> = {}): ControllerInput => ({ ...NO_INPUT, ...over });
const FORWARD = { x: 0, z: 1 };
const WEST = { x: -1, z: 0 };
const EAST = { x: 1, z: 0 };
/** Where the swimming feet are held: SWIM_FEET_DEPTH under the surface at y 0. */
const SWIM_Y = -SWIM_FEET_DEPTH;

type WaterTerrain = Heightfield & { waterDepthAt(x: number, z: number): number };

/** A terrain with water up to y 0 wherever the ground is below it. */
function withWater(hf: Heightfield): WaterTerrain {
  return { ...hf, waterDepthAt: (x, z) => Math.max(0, -hf.heightAt(x, z)) };
}

interface Pool {
  world: CollisionWorld<WaterTerrain>;
  volumes: ControllerVolumes;
  terrain: WaterTerrain;
}

function poolOf(terrain: WaterTerrain): Pool {
  return { world: createCollisionWorld(terrain), volumes: createControllerVolumes(new VolumeIndex(), terrain), terrain };
}

/** Flat bed `depth` m under the surface, water everywhere. */
const flatPool = (depth: number): Pool => poolOf(withWater(flatHeightfield(-depth)));

/**
 * A lake shore along x: a dry plateau at y 0.5 for x ≤ −2, a 14° bank y = −x/4 down to a flat bed at y −4 from x 16.
 * The water (surface y 0) starts at x 0; it is 1.1 m deep at x 4.4 and 1.2 m deep at x 4.8.
 */
const shoreHeight = (x: number): number => Math.min(0.5, Math.max(-4, -x / 4));
const lake = (): Pool => poolOf(withWater(analyticHeightfield((x) => shoreHeight(x))));

interface RunOptions {
  stamina?: StaminaState;
  character?: CharacterId;
}

/** Runs `ticks` ticks from `start` in `pool`; the input may depend on the tick and the state. */
function run(
  pool: Pool | null,
  start: ControllerState,
  input: (tick: number, s: ControllerState) => ControllerInput,
  ticks: number,
  opts: RunOptions = {},
): ControllerStepResult[] {
  const world = pool?.world ?? createCollisionWorld(flatHeightfield(0));
  const out: ControllerStepResult[] = [];
  let state = start;
  let stamina = opts.stamina ?? createStaminaState();
  for (let i = 0; i < ticks; i++) {
    const r = stepController(state, input(i, state), world, stamina, opts.character ?? 'kairen', DT, pool?.volumes ?? null);
    out.push(r);
    state = r.state;
    stamina = r.stamina;
  }
  return out;
}

const types = (r: ControllerStepResult): ControllerEventType[] => r.events.map((e) => e.type);
const allTypes = (rs: readonly ControllerStepResult[]): ControllerEventType[] => rs.flatMap(types);
const hSpeed = (s: ControllerState): number => Math.hypot(s.vel.x, s.vel.z);
const last = (rs: readonly ControllerStepResult[]): ControllerStepResult => rs[rs.length - 1];

/** Standing at rest on the bed of `pool` (feet at y −depth). */
const onBed = (depth: number, x = 0): ControllerState => createControllerState(v(x, -depth, 0), 0);
/** Swimming at rest at the swim height, feet at (x, SWIM_Y, z). */
const swimming = (x = 0, z = 0, yaw = 0): ControllerState => ({
  ...createControllerState(v(x, SWIM_Y, z), yaw), mode: 'swim', grounded: false,
});
const low = (value: number, exhausted = false): StaminaState => ({ value, max: 100, exhausted, idleTimer: 0 });

describe('water depth: wading below 1.2 m, swimming from 1.2 m (Req 16.9, 16.10)', () => {
  it('1.19 m deep only sets the wading flag; 1.2 m deep swims with enteredWater', () => {
    const [shallow] = run(flatPool(1.19), onBed(1.19), () => NO_INPUT, 1);
    expect(shallow.state).toMatchObject({ mode: 'grounded', grounded: true, wading: true });
    expect(shallow.events).toEqual([]);

    const [deep] = run(flatPool(SWIM_DEPTH), onBed(SWIM_DEPTH), () => NO_INPUT, 1);
    expect(deep.state).toMatchObject({ mode: 'swim', grounded: false, wading: false });
    expect(types(deep)).toEqual(['enteredWater']);

    // Walking around in 1.19 m of water never starts a swim.
    const walk = run(flatPool(1.19), onBed(1.19), () => inp({ move: FORWARD }), 120);
    expect(walk.every((r) => r.state.mode === 'grounded' && r.state.wading)).toBe(true);
  });

  it('dry ground, and a bridge deck above deep water, are not wading', () => {
    const [dry] = run(null, createControllerState(v(0, 0, 0), 0), () => NO_INPUT, 1);
    expect(dry.state.wading).toBe(false);
    const pool = flatPool(3);
    pool.world.addStatic({
      kind: 'aabb', id: 1, min: v(-5, -3, -5), max: v(5, 0.5, 5),
      flags: { climbable: false, walkableTop: true, blocksCamera: true, material: 'wood' },
    });
    const deck = run(pool, createControllerState(v(0, 0.5, 0), 0), () => inp({ move: FORWARD }), 30);
    expect(deck.every((r) => r.state.mode === 'grounded' && !r.state.wading && r.events.length === 0)).toBe(true);
  });
});

describe('wading (Req 16.9)', () => {
  it('slows ground movement by 20 %: run 4.8 m/s and sprint 7.2 m/s', () => {
    const speed = (pool: Pool | null, start: ControllerState, sprint: boolean): number =>
      hSpeed(last(run(pool, start, () => inp({ move: FORWARD, sprint }), 60)).state);
    expect(speed(flatPool(0.8), onBed(0.8), false)).toBeCloseTo(RUN_SPEED * WADE_SPEED_FACTOR, 9);
    expect(speed(flatPool(0.8), onBed(0.8), true)).toBeCloseTo(SPRINT_SPEED * WADE_SPEED_FACTOR, 9);
    expect(speed(null, createControllerState(v(0, 0, 0), 0), false)).toBeCloseTo(RUN_SPEED, 9);
    expect(WADE_SPEED_FACTOR).toBe(0.8);
  });

  it('emits footstep{material: water} once per stride while wading, and none on dry ground', () => {
    const wade = run(flatPool(0.8), onBed(0.8), () => inp({ move: FORWARD }), 120);
    const steps = wade.flatMap((r) => r.events);
    const walked = last(wade).state.pos.z;
    expect(steps.length).toBe(Math.floor(walked / FOOTSTEP_STRIDE));
    expect(steps.length).toBeGreaterThanOrEqual(6); // ≈ 9.4 m in 2 s
    expect(steps.every((e) => e.type === 'footstep' && e.material === 'water')).toBe(true);
    // Standing still in the water makes no steps.
    expect(run(flatPool(0.8), onBed(0.8), () => NO_INPUT, 120).some((r) => r.events.length > 0)).toBe(false);

    const dry = run(null, createControllerState(v(0, 0, 0), 0), () => inp({ move: FORWARD }), 120);
    expect(allTypes(dry)).toEqual([]);
  });
});

describe('surface swimming (Req 16.10)', () => {
  it('rises from the bed to the swim height and holds it there without gravity, head above the surface', () => {
    const res = run(flatPool(3), onBed(3), () => inp({ move: FORWARD }), 180);
    expect(types(res[0])).toEqual(['enteredWater']);
    expect(res.slice(1).every((r) => r.state.mode === 'swim' && r.events.length === 0)).toBe(true);
    // The feet settle upward at up to SWIM_SETTLE_SPEED, then stay put: no sinking, no bobbing.
    for (let i = 1; i < res.length; i++) {
      expect(Math.abs(res[i].state.pos.y - res[i - 1].state.pos.y)).toBeLessThanOrEqual(SWIM_SETTLE_SPEED * DT + 1e-9);
    }
    const settled = res.slice(60);
    for (const r of settled) {
      expect(r.state.pos.y).toBeCloseTo(SWIM_Y, 9);
      expect(r.state.vel.y).toBe(0);
      expect(r.state.pos.y + CAPSULE_HEIGHT - CAPSULE_RADIUS).toBeGreaterThan(0.5); // head sphere clear of the water
    }
    // The swim height leaves water deep enough to swim in clear of the shore probe.
    expect(SWIM_FEET_DEPTH + SWIM_EXIT_PROBE).toBeLessThan(SWIM_DEPTH);
  });

  it('swims at 3.5 m/s toward the camera-relative input and turns to face it; brakes without input', () => {
    const res = run(flatPool(3), swimming(), (i) => inp({ move: i < 60 ? FORWARD : EAST }), 120);
    expect(hSpeed(res[59].state)).toBeCloseTo(SWIM_SPEED, 9);
    expect(res[59].state.vel.x).toBeCloseTo(0, 9);
    const turned = last(res).state;
    expect(hSpeed(turned)).toBeCloseTo(SWIM_SPEED, 9);
    expect(turned.vel.x).toBeCloseTo(SWIM_SPEED, 9);
    expect(turned.yaw).toBeCloseTo(Math.PI / 2, 9);
    for (const r of res) {
      expect(r.state.mode).toBe('swim');
      expect(r.state.pos.y).toBeCloseTo(SWIM_Y, 9);
    }

    const stop = run(flatPool(3), last(res).state, () => NO_INPUT, 30);
    expect(hSpeed(last(stop).state)).toBe(0);
  });

  it('drains the swim activity 6/s while moving (Isla ×0.6) and nothing while treading water', () => {
    const drain = (character: CharacterId, move: { x: number; z: number }): number =>
      last(run(flatPool(3), swimming(), () => inp({ move }), 60, { stamina: low(50), character })).stamina.value;
    expect(drain('kairen', FORWARD)).toBeCloseTo(50 - 6, 9);
    expect(drain('isla', FORWARD)).toBeCloseTo(50 - 6 * 0.6, 9);
    expect(drain('kairen', { x: 0, z: 0 })).toBeGreaterThanOrEqual(50);
  });

  it('an Exhausted party still enters the water and swims (Req 17.4 does not refuse swim)', () => {
    expect(canStart(low(10, true), 'swim')).toBe(true);
    const res = run(lake(), createControllerState(v(3, shoreHeight(3), 0), Math.PI / 2), () => inp({ move: EAST }), 90, {
      stamina: low(10, true),
    });
    const entered = res.findIndex((r) => types(r).includes('enteredWater'));
    expect(entered).toBeGreaterThan(0);
    expect(res.slice(entered).every((r) => r.state.mode === 'swim')).toBe(true);
    expect(hSpeed(last(res).state)).toBeCloseTo(SWIM_SPEED, 9);
    expect(last(res).stamina.value).toBeLessThan(10);
    expect(last(res).stamina.exhausted).toBe(true);
  });

  it('a fall or a glide into deep water swims instead of landing on its bed', () => {
    const pool = flatPool(3);
    const falling: ControllerState = { ...createControllerState(v(0, 6, 0), 0), mode: 'fall', grounded: false, fallStartY: 6 };
    const fall = run(pool, falling, () => NO_INPUT, 120);
    const entered = fall.findIndex((r) => r.state.mode === 'swim');
    expect(types(fall[entered])).toEqual(['enteredWater']);
    expect(fall[entered].state.pos.y).toBeLessThanOrEqual(0);
    expect(allTypes(fall)).not.toContain('landed');
    expect(last(fall).state.pos.y).toBeCloseTo(SWIM_Y, 9);

    const gliding: ControllerState = {
      ...createControllerState(v(0, 2, 0), 0), mode: 'glide', grounded: false,
      vel: v(0, -GLIDE_MAX_DESCENT_SPEED, GLIDE_SPEED), fallStartY: 2,
    };
    const glide = run(pool, gliding, () => NO_INPUT, 180);
    const swim = glide.findIndex((r) => r.state.mode === 'swim');
    expect(swim).toBeGreaterThan(0);
    expect(types(glide[swim])).toEqual(['glideEnded', 'enteredWater']);
    expect(glide.slice(swim).every((r) => r.state.mode === 'swim')).toBe(true);
    expect(allTypes(glide)).not.toContain('landed');
    expect(last(glide).state.pos.y).toBeCloseTo(SWIM_Y, 9);
    expect(hSpeed(last(glide).state)).toBe(0); // the glide's 9 m/s braked away without input
  });
});

describe('leaving the water on the shore', () => {
  it('stands up (grounded, wading) once walkable ground is within 0.5 m of the swimming feet, and swims again past 1.2 m', () => {
    const pool = lake();
    const out = run(pool, swimming(10, 0, -Math.PI / 2), () => inp({ move: WEST }), 240);
    const ashore = out.findIndex((r) => r.state.mode !== 'swim');
    expect(ashore).toBeGreaterThan(0);
    const s = out[ashore].state;
    expect(s).toMatchObject({ mode: 'grounded', grounded: true, wading: true });
    expect(out[ashore].events).toEqual([]);
    // Depth there is at most 1.1 m (0.6 + 0.5, the sphere probe on the bank touches a little early).
    const depth = pool.terrain.waterDepthAt(s.pos.x, s.pos.z);
    expect(depth).toBeLessThanOrEqual(SWIM_FEET_DEPTH + SWIM_EXIT_PROBE + 0.05);
    expect(depth).toBeGreaterThan(1);
    expect(s.pos.y - pool.terrain.heightAt(s.pos.x, s.pos.z)).toBeLessThan(0.05); // feet on the bank
    // One transition: wading up the bank onto the dry plateau, never back into the swim.
    const after = out.slice(ashore);
    expect(after.every((r) => r.state.mode === 'grounded')).toBe(true);
    expect(allTypes(after).every((t) => t === 'footstep')).toBe(true);
    expect(last(out).state).toMatchObject({ wading: false });
    expect(last(out).state.pos.x).toBeLessThan(-2);

    // Back into the lake: wading down the bank until 1.2 m, then swimming again.
    const back = run(pool, last(out).state, () => inp({ move: EAST }), 240);
    const swim = back.findIndex((r) => r.state.mode === 'swim');
    expect(types(back[swim])).toEqual(['enteredWater']);
    expect(pool.terrain.waterDepthAt(back[swim].state.pos.x, 0)).toBeGreaterThanOrEqual(SWIM_DEPTH);
    expect(back.slice(0, swim).some((r) => r.state.wading)).toBe(true);
    expect(back.slice(swim).every((r) => r.state.mode === 'swim')).toBe(true);
  });
});

describe('Stamina running out while swimming (Req 16.11)', () => {
  it('locks the swimmer with exhausted and recoveryNeeded; it floats there ignoring input', () => {
    const res = run(flatPool(3), swimming(), () => inp({ move: FORWARD, jump: true, dodge: true }), 60, { stamina: low(0.05) });
    expect(types(res[0])).toEqual(['exhausted', 'recoveryNeeded']);
    expect(res[0].state).toMatchObject({ mode: 'locked', vel: v(0, 0, 0) });
    const held = res[0].state.pos;
    for (const r of res.slice(1)) {
      expect(r.state.mode).toBe('locked');
      expect(r.events).toEqual([]);
      expect(r.consumed).toEqual({ jump: false, dodge: false });
      expect(r.state.pos).toEqual(held); // afloat at the swim height, not sinking to the bed
    }
    expect(held.y).toBeCloseTo(SWIM_Y, 9);
  });

  it('the RecoverySystem fades out and puts the character on the newest Safe_Position, which is never in the water', () => {
    // The adapter wiring of PlaySim: recoveryNeeded → restorePlayer('swimExhausted'), the teleport ends the lock.
    const pool = lake();
    const spawn: SafePosition = { pos: v(-8, 0.5, 0), yaw: 0 };
    const player = new PlayerController({ world: pool.world, volumes: pool.volumes, pos: spawn.pos, yaw: Math.PI / 2 });
    const recovery = new RecoverySystem({ world: pool.world, initial: spawn, fallback: () => spawn });
    const input = new InputState();
    input.beginTick([{ kind: 'down', code: 'KeyW', time: 0 }], DT); // W held: toward +X with the camera yaw π/2
    const log: { mode: string; teleport: RecoveryTeleport | null; safe: SafePosition[] }[] = [];
    for (let i = 0; i < 60 * 60 && log.every((e) => e.teleport === null); i++) {
      if (i > 0) input.beginTick([], DT);
      // Past x 12 the camera turns 1.2 rad/s, so the swimmer circles out in the deep water until Stamina runs out.
      const yaw = player.state.pos.x < 12 ? Math.PI / 2 : Math.PI / 2 + (i % 10000) * 0.02;
      if (!recovery.active) {
        const events = player.tick(input, yaw, DT);
        if (events.some((e) => e.type === 'recoveryNeeded')) expect(recovery.restorePlayer('swimExhausted')).toBe(true);
      }
      const { teleport } = recovery.tick({ body: player.state, dt: DT });
      if (teleport !== null) player.teleport(teleport.pos, teleport.yaw);
      log.push({ mode: player.state.mode, teleport, safe: recovery.safePositions });
    }
    const done = log.findIndex((e) => e.teleport !== null);
    expect(done).toBeGreaterThan(0);
    const teleport = log[done].teleport as RecoveryTeleport;
    expect(teleport).toMatchObject({ reason: 'swimExhausted', source: 'safePosition' });
    const drowned = log.findIndex((e) => e.mode === 'locked');
    expect(drowned).toBeGreaterThan(0);
    expect(log.slice(drowned, done).every((e) => e.mode === 'locked')).toBe(true); // held until the teleport
    expect(done - drowned).toBeGreaterThanOrEqual(Math.round(0.35 / DT) - 1); // the fade-out came first
    // The newest record: walked on the dry plateau and the dry bank, none from the water.
    const safe = log[drowned].safe;
    expect(teleport.pos).toEqual(safe[0].pos);
    expect(safe.length).toBeGreaterThan(1);
    for (const p of safe) expect(pool.terrain.waterDepthAt(p.pos.x, p.pos.z)).toBe(0);
    // Standing there afterwards: the lock is over.
    expect(player.state).toMatchObject({ mode: 'grounded', grounded: true, wading: false });
    expect(player.state.pos).toEqual(teleport.pos);
  });
});

describe('input limits while swimming (Req 23.4, weapon on the back)', () => {
  const tap = (code: string): RawInput[] => [
    { kind: 'down', code, time: 0 },
    { kind: 'up', code, time: 0 },
  ];
  const perCharacter = (n: number) => Object.fromEntries(CHARACTER_IDS.map((id) => [id, n])) as Record<CharacterId, number>;

  class Body implements CombatBody {
    state: ControllerState = swimming();
    face(yaw: number): void {
      this.state = { ...this.state, yaw };
    }
  }

  it('refuses party switches', () => {
    expect(switchContextFor('swim')).toBe('swim');
  });

  it('ignores Normal_Attack, Skill and Burst input: nothing starts or is refused, a buffered press does not fire ashore', () => {
    const bus = createGameEventBus();
    const refused: unknown[] = [];
    bus.on('ability:refused', (p) => refused.push(p));
    const energy = perCharacter(0);
    energy.kairen = CHARACTERS.kairen.burst.energyCost;
    const cooldowns = perCharacter(0);
    cooldowns.kairen = 3; // a Skill press on cooldown would be refused on land
    const input = new InputState();
    const body = new Body();
    const combat = new PlayerCombat({ bus, rng: createRng(1), level: () => 1, character: () => 'kairen', energy, cooldowns });
    const tick = (raw: RawInput[] = []) => {
      input.beginTick(raw, DT);
      combat.tick({ input, body, cameraYaw: 0, targets: [], dt: DT });
      bus.dispatch();
    };
    for (const raw of [tap('Mouse0'), tap('KeyE'), tap('KeyQ')]) {
      tick(raw);
      expect(combat.attack).toBeNull();
    }
    expect(refused).toEqual([]);
    expect(energy.kairen).toBe(CHARACTERS.kairen.burst.energyCost);

    tick(tap('Mouse0'));
    body.state = createControllerState(v(0, 0, 0), 0); // ashore the next tick
    tick();
    expect(combat.attack).toBeNull();
    tick(tap('Mouse0'));
    expect(combat.attack?.def.id).toBe('atk_kairen_n1');
  });
});

describe('swimming in the play session (PlaySim wiring)', () => {
  let terrain: TerrainField;
  beforeAll(() => {
    terrain = buildTerrain(20240601);
  });

  it('a swim out of Stamina in pond_verdant fades back to the last Safe_Position; the entry splash sits on the surface', () => {
    const pond = WATER_BODIES.find((b) => b.id === 'pond_verdant');
    if (pond === undefined || pond.kind !== 'circle') throw new Error('no pond');
    expect(terrain.waterDepthAt(pond.x, pond.z)).toBeGreaterThanOrEqual(SWIM_DEPTH);
    const gameState = createNewGameState(20240601);
    const input = new InputState();
    const heard = { entries: [] as Vec3[] };
    const sim = new PlaySim({
      gameState, terrain, input, commands: new UiCommandQueue(),
      sinks: { partyWipe: () => {}, ending: () => {}, enteredWater: (pos) => heard.entries.push({ ...pos }) },
    });
    const step = (raw: RawInput[] = [], yaw = 0) => {
      input.beginTick(raw, DT);
      return sim.tick(DT, yaw);
    };
    for (let i = 0; i < 90; i++) step(); // stand at the start: it is recorded as a Safe_Position
    const safe = sim.recovery.safePositions[0];
    expect(terrain.waterDepthAt(safe.pos.x, safe.pos.z)).toBe(0);

    // Onto the pond's bed, W held; the camera turns 1.2 rad/s so the swimmer circles near the middle.
    expect(sim.player.teleport({ x: pond.x, y: terrain.heightAt(pond.x, pond.z), z: pond.z }, 0)).toBe(true);
    step([{ kind: 'down', code: 'KeyW', time: 0 }]);
    let locked = false;
    let teleported = false;
    for (let i = 1; i < 60 * 30 && !teleported; i++) {
      teleported = step([], i * 0.02).teleported;
      if (sim.player.state.mode === 'locked') {
        locked = true;
        expect(sim.recovery.reason).toBe('swimExhausted');
      }
    }
    expect(heard.entries).toHaveLength(1);
    expect(heard.entries[0].y).toBeCloseTo(pond.level, 6); // the splash sits on the surface
    expect([locked, teleported]).toEqual([true, true]);
    expect(sim.player.state).toMatchObject({ mode: 'grounded', wading: false });
    expect(sim.player.state.pos).toEqual(safe.pos);
    expect(sim.runtime.stamina.value).toBe(0);
  });
});
