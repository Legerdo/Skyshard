import { describe, expect, it } from 'vitest';
import { PlayerCombat } from '../../../src/combat/playerCombat';
import { createGameEventBus } from '../../../src/core/gameEvents';
import { DEG2RAD, angleDelta, yawFromDir, type Vec3 } from '../../../src/core/math';
import { createRng } from '../../../src/core/rng';
import { CHARACTERS } from '../../../src/data/characters';
import { CHARACTER_IDS, type CharacterId } from '../../../src/data/ids';
import {
  AIR_VOLUMES,
  AIR_VOLUME_PRESENTATION,
  AREA_VOLUMES,
  BROKEN_BRIDGE_CHASM_CENTER,
  volumeContains,
  type UpdraftVolumeDef,
  type WindZoneVolumeDef,
} from '../../../src/data/volumes';
import { LOCATIONS } from '../../../src/data/worldLayout';
import { InputState, type RawInput } from '../../../src/input/inputState';
import { createStaminaState, type StaminaState } from '../../../src/logic/stamina';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { flatHeightfield } from '../../../src/physics/heightfield';
import type { Collider, CollisionWorld } from '../../../src/physics/types';
import {
  CAPSULE_HEIGHT,
  GLIDE_DEPLOY_TIME,
  GLIDE_GROUND_PROBE,
  GLIDE_MAX_DESCENT_SPEED,
  GLIDE_SPEED,
  GLIDE_TURN_RATE_DEG,
  SKIN_WIDTH,
  UPDRAFT_RISE_SPEED,
  WIND_ZONE_PUSH_SPEED,
} from '../../../src/player/core/constants';
import { glideLift, glideWindIntensity, groundClearance } from '../../../src/player/core/glide';
import { stepController } from '../../../src/player/core/stepController';
import {
  createControllerState,
  type ControllerEventType,
  type ControllerInput,
  type ControllerState,
  type ControllerStepResult,
  type ControllerVolumes,
  type ControllerWorld,
} from '../../../src/player/core/types';
import { PlayerController } from '../../../src/player/playerController';
import { createControllerVolumes } from '../../../src/world/controllerVolumes';
import { BROKEN_BRIDGE_CHASM } from '../../../src/world/terrain/features';
import { VolumeIndex } from '../../../src/world/volumeIndex';

// Gliding and air volumes (design "Player Controller" → "활강"; Req 19.1–19.10) at fixed 60 Hz against a real
// CollisionWorld, VolumeIndex and ControllerVolumes.
const DT = 1 / 60;
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const NO_INPUT: ControllerInput = { move: { x: 0, z: 0 }, sprint: false, walk: false, jump: false, dodge: false, release: false };
const inp = (over: Partial<ControllerInput> = {}): ControllerInput => ({ ...NO_INPUT, ...over });
const DEPLOY_TICKS = Math.round(GLIDE_DEPLOY_TIME / DT); // 18
const TURN_PER_TICK = GLIDE_TURN_RATE_DEG * DEG2RAD * DT;

const flatWorld = (y = 0): CollisionWorld => createCollisionWorld(flatHeightfield(y));

function box(id: number, min: Vec3, max: Vec3, climbable: boolean): Collider {
  return { kind: 'aabb', id, min, max, flags: { climbable, walkableTop: true, blocksCamera: true, material: 'stone' } };
}

/** At rest at feet height y, already falling (the coyote window closed). */
const falling = (y: number, vy = 0): ControllerState => ({
  ...createControllerState(v(0, y, 0), 0), mode: 'fall', grounded: false, vel: v(0, vy, 0), fallStartY: y,
});

/** Gliding at feet (x, y, z) along `yaw`, at the glide's speeds. */
const gliding = (y: number, yaw = 0, x = 0, z = 0): ControllerState => ({
  ...createControllerState(v(x, y, z), yaw),
  mode: 'glide',
  grounded: false,
  vel: v(Math.sin(yaw) * GLIDE_SPEED, -GLIDE_MAX_DESCENT_SPEED, Math.cos(yaw) * GLIDE_SPEED),
  fallStartY: y,
});

interface RunOptions {
  stamina?: StaminaState;
  character?: CharacterId;
  volumes?: ControllerVolumes | null;
}

/** Runs `ticks` ticks from `start`; the input may depend on the tick and the state. */
function run(
  world: ControllerWorld,
  start: ControllerState,
  input: (tick: number, s: ControllerState) => ControllerInput,
  ticks: number,
  opts: RunOptions = {},
): ControllerStepResult[] {
  const out: ControllerStepResult[] = [];
  let state = start;
  let stamina = opts.stamina ?? createStaminaState();
  for (let i = 0; i < ticks; i++) {
    const r = stepController(state, input(i, state), world, stamina, opts.character ?? 'kairen', DT, opts.volumes ?? null);
    out.push(r);
    state = r.state;
    stamina = r.stamina;
  }
  return out;
}

const types = (r: ControllerStepResult): ControllerEventType[] => r.events.map((e) => e.type);
const firstWith = (rs: readonly ControllerStepResult[], type: ControllerEventType): number =>
  rs.findIndex((r) => r.events.some((e) => e.type === type));
const hSpeed = (s: ControllerState): number => Math.hypot(s.vel.x, s.vel.z);
/** State before tick i of a run from `start`. */
const before = (start: ControllerState, rs: readonly ControllerStepResult[], i: number): ControllerState =>
  i === 0 ? start : rs[i - 1].state;

/** A VolumeIndex holding `defs`, seen through the controller's volume interface (no water). */
function airVolumes(...defs: (UpdraftVolumeDef | WindZoneVolumeDef)[]): ControllerVolumes {
  const index = new VolumeIndex();
  index.addAll(defs);
  return createControllerVolumes(index);
}

describe('glide deploy (Req 19.1)', () => {
  it('a jump press in a fall with the ground 3 m or more below opens the glider: 0.3 s glideDeploy, then glide with glideStarted', () => {
    const res = run(flatWorld(), falling(20), (i) => inp({ jump: i === 0 }), 60);
    expect(res[0].consumed.jump).toBe(true);
    expect(res.slice(0, DEPLOY_TICKS - 1).every((r) => r.state.mode === 'glideDeploy')).toBe(true);
    const started = firstWith(res, 'glideStarted');
    expect(started).toBe(DEPLOY_TICKS - 1); // the 18th deploy tick turns into glide
    expect(res[started].state.mode).toBe('glide');
    expect(res.filter((r) => types(r).includes('glideStarted'))).toHaveLength(1);
    // The deploy eases the fall's (zero) horizontal speed up to the glide speed.
    expect(hSpeed(res[started].state)).toBeCloseTo(GLIDE_SPEED, 9);
    expect(res.slice(started).every((r) => r.state.mode === 'glide')).toBe(true);
  });

  it('deploys with nothing within 200 m below and from 3 m up, but not closer, not while Exhausted, not rising from a jump', () => {
    const deploys = (world: CollisionWorld, start: ControllerState, stamina?: StaminaState): boolean => {
      const [r] = run(world, start, () => inp({ jump: true }), 1, { stamina });
      expect(r.consumed.jump).toBe(r.state.mode === 'glideDeploy'); // a refused press stays in the buffer
      return r.state.mode === 'glideDeploy';
    };
    expect(groundClearance(flatWorld(-500), v(0, 0, 0), GLIDE_GROUND_PROBE)).toBeNull();
    expect(deploys(flatWorld(-500), falling(0))).toBe(true);
    expect(deploys(flatWorld(), falling(3.01))).toBe(true);
    expect(deploys(flatWorld(), falling(2.95))).toBe(false);
    const tired: StaminaState = { value: 20, max: 100, exhausted: true, idleTimer: 0 };
    expect(deploys(flatWorld(), falling(20), tired)).toBe(false);
    expect(deploys(flatWorld(), { ...falling(20, 5), mode: 'jump' })).toBe(false);
  });

  it('brakes a fast fall to the 2.5 m/s glide descent within the deploy', () => {
    const res = run(flatWorld(), falling(100, -30), (i) => inp({ jump: i === 0 }), DEPLOY_TICKS);
    expect(res.every((r) => r.state.vel.y >= -30)).toBe(true);
    expect(res[DEPLOY_TICKS - 1].state).toMatchObject({ mode: 'glide', vel: { y: -GLIDE_MAX_DESCENT_SPEED } });
  });
});

describe('gliding (Req 19.2)', () => {
  it('descends at no more than 2.5 m/s, moves 9 m/s horizontally and keeps the fall start at the current height', () => {
    const start = gliding(100);
    const res = run(flatWorld(), start, () => NO_INPUT, 120);
    for (const [i, r] of res.entries()) {
      const s = r.state;
      expect(s.mode).toBe('glide');
      expect(s.vel.y).toBeGreaterThanOrEqual(-GLIDE_MAX_DESCENT_SPEED);
      expect(before(start, res, i).pos.y - s.pos.y).toBeLessThanOrEqual(GLIDE_MAX_DESCENT_SPEED * DT + 1e-9);
      expect(hSpeed(s)).toBeCloseTo(GLIDE_SPEED, 9);
      expect(s.fallStartY).toBe(s.pos.y);
    }
    expect(res[59].state.pos.y).toBeCloseTo(100 - GLIDE_MAX_DESCENT_SPEED, 6); // 1 s
    expect(res[59].state.pos.z).toBeCloseTo(GLIDE_SPEED, 6);
  });

  it('drains 6 Stamina per second, 30 % less for Wren', () => {
    const drained = (character: CharacterId): number => {
      const res = run(flatWorld(), gliding(100), () => NO_INPUT, 60, { character });
      return 100 - res[59].stamina.value;
    };
    expect(drained('kairen')).toBeCloseTo(6, 6);
    expect(drained('wren')).toBeCloseTo(6 * 0.7, 6);
  });

  it('turns toward the move input at up to 200°/s at full speed, and keeps its heading without input', () => {
    const start = gliding(100);
    const res = run(flatWorld(), start, () => inp({ move: { x: 0, z: -1 } }), 60);
    for (const [i, r] of res.entries()) {
      const s = r.state;
      expect(Math.abs(angleDelta(before(start, res, i).yaw, s.yaw))).toBeLessThanOrEqual(TURN_PER_TICK + 1e-9);
      expect(Math.abs(angleDelta(yawFromDir(s.vel.x, s.vel.z), s.yaw))).toBeLessThan(1e-9); // the facing follows the heading
      expect(hSpeed(s)).toBeCloseTo(GLIDE_SPEED, 9);
    }
    expect(Math.abs(res[26].state.yaw)).toBeCloseTo(Math.PI / 2, 6); // 27 ticks: 90°
    expect(Math.abs(angleDelta(res[59].state.yaw, Math.PI))).toBeLessThan(1e-9); // 180° reached within 0.9 s + 1 tick

    const straight = run(flatWorld(), gliding(100, 0.4), () => NO_INPUT, 30);
    expect(straight.every((r) => Math.abs(angleDelta(r.state.yaw, 0.4)) < 1e-9)).toBe(true);
  });
});

describe('Updraft and Wind_Zone (Req 19.6, 19.7)', () => {
  const updraft: UpdraftVolumeDef = {
    kind: 'updraft', id: 'test_updraft', shape: { kind: 'cylinder', x: 0, z: 0, radius: 300, minY: 0, maxY: 30 },
  };

  it('an Updraft lifts a glider at 8 m/s up to its top and holds it there with vy 0', () => {
    const start = gliding(10);
    const res = run(flatWorld(), start, () => NO_INPUT, 200, { volumes: airVolumes(updraft) });
    const top = res.findIndex((r) => r.state.pos.y >= 30 - 1e-6);
    expect(top).toBe(Math.ceil(20 / (UPDRAFT_RISE_SPEED * DT) - 1e-9) - 1); // 150 ticks of 8/60 m
    for (const [i, r] of res.entries()) {
      const s = r.state;
      const dy = s.pos.y - before(start, res, i).pos.y;
      if (i < top) {
        expect(dy).toBeCloseTo(UPDRAFT_RISE_SPEED * DT, 9);
        expect(s.vel.y).toBe(UPDRAFT_RISE_SPEED);
      } else if (i > top) {
        expect(s.pos.y).toBeCloseTo(30, 6);
        expect(s.vel.y).toBeCloseTo(0, 9);
      }
      expect(s).toMatchObject({ mode: 'glide', fallStartY: s.pos.y });
      expect(hSpeed(s)).toBeCloseTo(GLIDE_SPEED, 9);
    }
    // Only a glider rides it: a plain fall inside the column keeps falling.
    const fall = run(flatWorld(), falling(20), () => NO_INPUT, 30, { volumes: airVolumes(updraft) });
    expect(fall[29].state.vel.y).toBeLessThan(-10);
  });

  it('a Wind_Zone adds 4 m/s along its direction while the glider is inside, as an offset that never builds up', () => {
    // 20 m deep along Z, wide along X, blowing toward +X; the glider crosses it heading +Z.
    const wind: WindZoneVolumeDef = {
      kind: 'windZone', id: 'test_wind',
      shape: { kind: 'box', x: 0, z: 0, halfX: 50, halfZ: 10, yaw: 0, minY: 0, maxY: 200 },
      direction: { x: 2, z: 0 }, // any length: the push is always 4 m/s
    };
    const start = gliding(100, 0, 0, -12);
    const res = run(flatWorld(), start, () => NO_INPUT, 240, { volumes: airVolumes(wind) });
    let pushed = 0;
    for (const [i, r] of res.entries()) {
      const from = before(start, res, i).pos;
      const inside = volumeContains(wind.shape, from);
      if (inside) pushed++;
      expect(r.state.pos.x - from.x).toBeCloseTo(inside ? WIND_ZONE_PUSH_SPEED * DT : 0, 9);
      expect(r.state.pos.z - from.z).toBeCloseTo(GLIDE_SPEED * DT, 9);
      expect(r.state.vel.x).toBeCloseTo(0, 12); // never accumulated in the velocity
    }
    // 20 m at 9 m/s: about 2.2 s (133 ticks) inside, then out of the zone with no push left over.
    expect(pushed).toBeGreaterThanOrEqual(132);
    expect(pushed).toBeLessThanOrEqual(135);
    expect(res[239].state.pos.x).toBeCloseTo(pushed * WIND_ZONE_PUSH_SPEED * DT, 9);
  });
});

describe('glide end transitions (Req 19.3–19.5)', () => {
  it('a jump press or C falls with glideEnded; after C a new jump press deploys again', () => {
    const [jumped] = run(flatWorld(), gliding(50), () => inp({ jump: true }), 1);
    expect(jumped.state.mode).toBe('fall');
    expect(types(jumped)).toEqual(['glideEnded']);
    expect(jumped.consumed.jump).toBe(true);
    expect(jumped.state.fallStartY).toBe(50); // the fall counts from where the glide ended

    const res = run(flatWorld(), gliding(50), (i) => inp({ release: i === 0, jump: i === 20 }), 21);
    expect(types(res[0])).toEqual(['glideEnded']);
    expect(res[0].consumed.jump).toBe(false);
    expect(res.slice(0, 20).every((r) => r.state.mode === 'fall')).toBe(true);
    expect(res[19].state.vel.y).toBeLessThan(-GLIDE_MAX_DESCENT_SPEED); // gravity took over
    expect(res[20].state.mode).toBe('glideDeploy');
  });

  it('Stamina running out falls with exhausted and glideEnded, and the glider stays shut while Exhausted', () => {
    const low: StaminaState = { value: 0.05, max: 100, exhausted: false, idleTimer: 0 };
    const res = run(flatWorld(), gliding(50), (i) => inp({ jump: i > 0 }), 10, { stamina: low });
    expect(types(res[0])).toEqual(['exhausted', 'glideEnded']);
    expect(res[0].state.mode).toBe('fall');
    expect(res[0].stamina).toMatchObject({ value: 0, exhausted: true });
    expect(res.slice(1).every((r) => r.state.mode === 'fall' && !r.consumed.jump)).toBe(true);
  });

  it('touching the ground ends the glide in a landing whose fall height leaves out the altitude glided from', () => {
    const res = run(flatWorld(), gliding(30), () => NO_INPUT, 900);
    const land = firstWith(res, 'landed');
    expect(land).toBeGreaterThan(0);
    expect(types(res[land])).toEqual(['glideEnded', 'landed']);
    expect(res.slice(0, land).every((r) => r.state.mode === 'glide')).toBe(true);
    const landed = res[land].events.find((e) => e.type === 'landed');
    // A 30 m fall would stagger (HARD_LANDING_HEIGHT); the glide lands straight in grounded.
    expect(landed?.type === 'landed' ? landed.fallHeight : NaN).toBeLessThan(0.1);
    expect(res[land].state).toMatchObject({ mode: 'grounded', grounded: true });
    expect(res[land].state.pos.y).toBeCloseTo(0, 6);
  });

  it('deep water (≥ 1.2 m) ends the glide in swim with glideEnded; shallower water lands', () => {
    const water = (floorY: number, depth: number) => {
      const terrain = flatHeightfield(floorY);
      const world = createCollisionWorld(terrain);
      const volumes = createControllerVolumes(new VolumeIndex(), {
        heightAt: (x, z) => terrain.heightAt(x, z), waterDepthAt: () => depth,
      });
      return run(world, gliding(3), () => NO_INPUT, 300, { volumes });
    };
    const deep = water(-3, 3); // surface y 0, 3 m deep
    const swim = deep.findIndex((r) => r.state.mode === 'swim');
    expect(swim).toBeGreaterThan(0);
    expect(types(deep[swim])).toEqual(['glideEnded', 'enteredWater']);
    expect(deep[swim].state.pos.y).toBeLessThanOrEqual(0);
    expect(deep[swim].state.pos.y).toBeGreaterThan(-GLIDE_MAX_DESCENT_SPEED * DT);

    const shallow = water(-1, 1); // surface y 0, 1 m deep: wading depth
    expect(shallow.some((r) => r.state.mode === 'swim')).toBe(false);
    const land = firstWith(shallow, 'landed');
    expect(types(shallow[land])).toEqual(['glideEnded', 'landed']);
    expect(shallow[land].state.pos.y).toBeCloseTo(-1, 6);
  });

  it('gliding into a climbable wall attaches (climbAttach) with glideEnded; a non-climbable wall does not', () => {
    const wallWorld = (climbable: boolean): CollisionWorld => {
      const world = flatWorld();
      world.addStatic(box(1, v(5, -1, -10), v(7, 30, 10), climbable));
      return world;
    };
    const east = gliding(10, Math.PI / 2); // heading +X, toward the x = 5 face
    const res = run(wallWorld(true), east, () => NO_INPUT, 60);
    const attach = firstWith(res, 'climbStarted');
    expect(attach).toBeGreaterThan(0);
    expect(types(res[attach])).toEqual(['glideEnded', 'climbStarted']);
    expect(res[attach].state).toMatchObject({ mode: 'climbAttach', vel: v(0, 0, 0) });
    expect(res.slice(0, attach).every((r) => r.state.mode === 'glide')).toBe(true);

    const blocked = run(wallWorld(false), east, () => NO_INPUT, 60);
    expect(blocked.every((r) => r.state.mode === 'glide' && r.events.length === 0)).toBe(true);
    expect(blocked[59].state.pos.x).toBeLessThan(5);
  });
});

describe("Wren's Skill while gliding (Req 19.9)", () => {
  it('glideLift raises a glider 6 m at once, stopping its head under a ceiling; nothing happens outside the glide', () => {
    const open = gliding(10);
    const lifted = glideLift(open, flatWorld(), 6);
    expect(lifted).not.toBeNull();
    expect(lifted?.pos).toEqual(v(0, 16, 0));
    expect(lifted).toMatchObject({ mode: 'glide', fallStartY: 16, vel: { y: 0 } });
    expect(open.pos.y).toBe(10); // the input state is not mutated

    const roofed = flatWorld();
    roofed.addStatic(box(1, v(-5, 14, -5), v(5, 15, 5), false));
    const under = glideLift(open, roofed, 6);
    expect((under?.pos.y ?? NaN) + CAPSULE_HEIGHT).toBeCloseTo(14 - SKIN_WIDTH, 9);

    expect(glideLift({ ...gliding(10), mode: 'glideDeploy' }, flatWorld(), 6)?.pos.y).toBe(16);
    expect(glideLift(falling(10), flatWorld(), 6)).toBeNull();
    expect(glideLift(createControllerState(v(0, 0, 0), 0), flatWorld(), 6)).toBeNull();
    expect(glideLift(open, flatWorld(), 0)).toBeNull();
    expect(glideLift(open, flatWorld(), Number.NaN)).toBeNull();
  });

  it("Wren's Skill cast while gliding lifts the player 6 m and starts its cooldown; Kairen's Skill press does nothing", () => {
    const tap = (code: string): RawInput[] => [
      { kind: 'down', code, time: 0 },
      { kind: 'up', code, time: 0 },
    ];
    const castWhileGliding = (character: CharacterId) => {
      const bus = createGameEventBus();
      const refused: unknown[] = [];
      bus.on('ability:refused', (p) => refused.push(p));
      const cooldowns = Object.fromEntries(CHARACTER_IDS.map((id) => [id, 0])) as Record<CharacterId, number>;
      const input = new InputState();
      const player = new PlayerController({ world: flatWorld(), pos: v(0, 40, 0), yaw: 0, character });
      const combat = new PlayerCombat({ bus, rng: createRng(1), level: () => 1, character: () => character, cooldowns });
      const tick = (raw: RawInput[] = []): void => {
        input.beginTick(raw, DT);
        player.tick(input, 0, DT);
        combat.tick({ input, body: player, cameraYaw: 0, targets: [], dt: DT });
        bus.dispatch();
      };
      for (let i = 0; i < 10; i++) tick(); // walks off into a fall; the coyote window closes
      tick(tap('Space'));
      for (let i = 0; i < DEPLOY_TICKS + 2; i++) tick();
      expect(player.state.mode).toBe('glide');
      const y0 = player.state.pos.y;
      tick(tap('KeyE'));
      return { rise: player.state.pos.y - (y0 - GLIDE_MAX_DESCENT_SPEED * DT), player, combat, cooldowns, refused };
    };

    const wren = castWhileGliding('wren');
    expect(CHARACTERS.wren.skill.params.glideRise).toBe(6);
    expect(wren.rise).toBeCloseTo(6, 6);
    expect(wren.player.state).toMatchObject({ mode: 'glide', fallStartY: wren.player.state.pos.y });
    expect(wren.combat.attack?.def.id).toBe('atk_wren_skill');
    expect(wren.cooldowns.wren).toBe(CHARACTERS.wren.skill.cooldown);

    const kairen = castWhileGliding('kairen');
    expect(kairen.rise).toBeCloseTo(0, 6);
    expect(kairen.combat.attack).toBeNull();
    expect([kairen.cooldowns.kairen, kairen.refused]).toEqual([0, []]);
  });
});

describe('glide wind loudness (Req 19.10)', () => {
  it('glideWindIntensity = clamp01(0.5·h / 40 m + 0.5·v / 13 m/s), rising with height and speed', () => {
    expect(glideWindIntensity(0, 0)).toBe(0);
    expect(glideWindIntensity(20, 0)).toBeCloseTo(0.25, 12);
    expect(glideWindIntensity(0, 6.5)).toBeCloseTo(0.25, 12);
    expect(glideWindIntensity(40, 13)).toBeCloseTo(1, 12);
    expect(glideWindIntensity(400, 40)).toBe(1);
    expect(glideWindIntensity(-5, Number.NaN)).toBe(0);
    expect(glideWindIntensity(30, 9)).toBeGreaterThan(glideWindIntensity(10, 9));
    expect(glideWindIntensity(10, 12)).toBeGreaterThan(glideWindIntensity(10, 9));
  });

  it('the controller adapter hands the loudness from the height above the ground and the speed to its sink every tick', () => {
    const heard: number[] = [];
    const world = flatWorld();
    const input = new InputState();
    const player = new PlayerController({ world, pos: v(0, 30, 0), yaw: 0, glideWind: { setGlideWind: (i) => heard.push(i) } });
    const tick = (raw: RawInput[] = []): void => {
      input.beginTick(raw, DT);
      const from = player.state.pos;
      player.tick(input, 0, DT);
      const to = player.state.pos;
      const expected = player.state.mode === 'glide' || player.state.mode === 'glideDeploy'
        ? glideWindIntensity(to.y, Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z) / DT)
        : 0;
      expect(heard.at(-1)).toBeCloseTo(expected, 6); // the height comes from the downward ray
      expect(player.windIntensity).toBe(heard.at(-1));
    };
    for (let i = 0; i < 10; i++) tick();
    expect(heard.every((i) => i === 0)).toBe(true); // falling: no glide wind
    tick([{ kind: 'down', code: 'Space', time: 0 }, { kind: 'up', code: 'Space', time: 0 }]);
    for (let i = 0; i < 60; i++) tick();
    expect(heard).toHaveLength(71);
    expect(heard.at(-1)).toBeGreaterThan(0.5); // ~29 m up at ~9.3 m/s: about 0.72
    expect(heard.at(-1)).toBeLessThanOrEqual(1);
  });
});

describe('air volume data (Req 19.6–19.8)', () => {
  const updraft = AIR_VOLUMES.find((u) => u.id === 'updraft_broken_bridge');
  const wind = AIR_VOLUMES.find((u) => u.id === 'wind_azure_ridge');

  it('stands the Broken Bridge Updraft in the terrain chasm, from its floor to above the rims', () => {
    expect(updraft?.kind).toBe('updraft');
    if (updraft?.kind !== 'updraft') return;
    expect(BROKEN_BRIDGE_CHASM_CENTER.x).toBeCloseTo(BROKEN_BRIDGE_CHASM.center.x, 9);
    expect(BROKEN_BRIDGE_CHASM_CENTER.z).toBeCloseTo(BROKEN_BRIDGE_CHASM.center.z, 9);
    expect(updraft.shape).toMatchObject({ x: BROKEN_BRIDGE_CHASM_CENTER.x, z: BROKEN_BRIDGE_CHASM_CENTER.z, minY: BROKEN_BRIDGE_CHASM.floorY });
    expect(updraft.shape.radius).toBeLessThanOrEqual(BROKEN_BRIDGE_CHASM.floorHalfWidth); // clear of the chasm walls
    expect(updraft.shape.maxY).toBeGreaterThan(LOCATIONS.broken_bridge.groundY); // rises out over the rim (y 12)
  });

  it('blows the Azure ridge wind over wind_ridge_end from camp_oriel toward the Observatory', () => {
    expect(wind?.kind).toBe('windZone');
    if (wind?.kind !== 'windZone') return;
    const end = AREA_VOLUMES.find((a) => a.id === 'wind_ridge_end');
    if (end === undefined) throw new Error('wind_ridge_end');
    expect(volumeContains(wind.shape, v(end.shape.x, (end.shape.minY + end.shape.maxY) / 2, end.shape.z))).toBe(true);
    const oriel = LOCATIONS.camp_oriel;
    const target = LOCATIONS.observatory_entrance;
    const toward = Math.atan2(target.x - oriel.x, target.z - oriel.z);
    expect(Math.hypot(wind.direction.x, wind.direction.z)).toBeCloseTo(1, 12);
    expect(angleDelta(yawFromDir(wind.direction.x, wind.direction.z), toward)).toBeCloseTo(0, 9);
    expect(volumeContains(wind.shape, v(oriel.x + 10 * wind.direction.x, oriel.groundY + 10, oriel.z + 10 * wind.direction.z))).toBe(true);
  });

  it('gives each air volume kind its particle look and a looped wind sound', () => {
    expect(AIR_VOLUME_PRESENTATION.updraft).toMatchObject({ vfx: 'vfx_updraft_column', sfx: 'sfx_updraft_loop' });
    expect(AIR_VOLUME_PRESENTATION.windZone).toMatchObject({ vfx: 'vfx_wind_streaks', sfx: 'sfx_wind_zone_loop' });
  });

  it('createControllerVolumes answers the highest Updraft top, the unit wind direction and the water depth', () => {
    const index = new VolumeIndex();
    index.addAll([
      { kind: 'updraft', id: 'low', shape: { kind: 'cylinder', x: 0, z: 0, radius: 5, minY: 0, maxY: 20 } },
      { kind: 'updraft', id: 'high', shape: { kind: 'cylinder', x: 3, z: 0, radius: 5, minY: 0, maxY: 50 } },
      { kind: 'windZone', id: 'w', shape: { kind: 'box', x: 0, z: 0, halfX: 5, halfZ: 5, yaw: 0, minY: 0, maxY: 10 }, direction: { x: 3, z: 4 } },
    ]);
    const volumes = createControllerVolumes(index, { heightAt: () => -2, waterDepthAt: (x) => (x > 100 ? 2 : 0) });
    expect(volumes.updraftTop(v(1, 5, 0))).toBe(50);
    expect(volumes.updraftTop(v(-4, 5, 0))).toBe(20);
    expect(volumes.updraftTop(v(1, 60, 0))).toBeNull();
    expect(volumes.windDirection(v(0, 5, 0))).toEqual({ x: 0.6, z: 0.8 });
    expect(volumes.windDirection(v(0, 15, 0))).toBeNull();
    expect(volumes.water(150, 0)).toEqual({ level: 0, depth: 2 });
    expect(volumes.water(0, 0)).toBeNull();
  });
});
