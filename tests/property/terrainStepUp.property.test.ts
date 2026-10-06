// Feature: skyshard-echoes-of-the-wild, Property 27: 지형 위 유지와 턱 오르기
// **Validates: Requirements 20.1, 16.7**
//
// The pure controller core (stepController over a real CollisionWorld) at the fixed 60 Hz tick:
// 1. Terrain clamp: for any seeded terrain, collider layout, start and input sequence, the feet
//    satisfy y ≥ heightAt(x, z) after every tick.
// 2. Step-up: walking (no jump) into a box ledge with a walkable top, a ledge of at most 0.45 m is
//    stepped onto without the movement stalling, and a higher one blocks.
import fc, { type Arbitrary } from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../src/core/loop';
import { DEG2RAD, yawFromDir, type Vec3 } from '../../src/core/math';
import { CHARACTER_IDS, type CharacterId } from '../../src/data/ids';
import { BUFFER_SECONDS } from '../../src/input/actions';
import { createStaminaState, type StaminaState } from '../../src/logic/stamina';
import { createCollisionWorld } from '../../src/physics/collisionWorld';
import { analyticHeightfield, flatHeightfield } from '../../src/physics/heightfield';
import type { Collider, ColliderFlags, CollisionWorld, Heightfield, SurfaceMaterial } from '../../src/physics/types';
import { CAPSULE_RADIUS } from '../../src/player/core/constants';
import { snapToGround } from '../../src/player/core/moveAndSlide';
import { stepController } from '../../src/player/core/stepController';
import {
  createControllerState,
  type ControllerInput,
  type ControllerState,
  type MoveMode,
} from '../../src/player/core/types';
import { buildTerrain, type TerrainField } from '../../src/world/terrain';

const R = CAPSULE_RADIUS;

interface XZ {
  x: number;
  z: number;
}

/** Uniform on a `step` grid over [min, max] (fc.double clusters near 0 and the bounds). */
const arbGrid = (min: number, max: number, step: number): Arbitrary<number> =>
  fc.integer({ min: Math.round(min / step), max: Math.round(max / step) }).map((k) => k * step);
/** An angle in radians on a 0.5° grid. */
const arbAngle = arbGrid(0, 359.5, 0.5).map((deg) => deg * DEG2RAD);
/** True with probability `pct` %; shrinks toward false. */
const arbChance = (pct: number): Arbitrary<boolean> =>
  fc.oneof({ weight: 100 - pct, arbitrary: fc.constant(false) }, { weight: pct, arbitrary: fc.constant(true) });
const arbCharacter = fc.constantFrom<CharacterId>(...CHARACTER_IDS);
const arbMaterial = fc.constantFrom<SurfaceMaterial>('stone', 'wood', 'rock', 'dirt', 'crystal');

/** Colliders reach this far below the lowest terrain under them. */
const BURY = 0.5;

// ---------------------------------------------------------------------------
// arbTerrainSeed: a seeded terrain and a start point on it
// ---------------------------------------------------------------------------

/**
 * buildTerrain takes 0.2–0.3 s, too slow to call per run, so the generated terrains come from a few
 * fixed seeds, each built once on first use.
 */
const GENERATED_SEEDS = [20240601, 7, 0x2727] as const;
const generatedTerrains = new Map<number, TerrainField>();

function generatedTerrain(seed: number): TerrainField {
  let field = generatedTerrains.get(seed);
  if (field === undefined) {
    field = buildTerrain(seed);
    generatedTerrains.set(seed, field);
  }
  return field;
}

/** A sine ridge set: amp · sin(2π (x cos angle + z sin angle) / wavelength + phase). */
interface Wave {
  amp: number;
  wavelength: number;
  angle: number;
  phase: number;
}

/** Terraces along `angle`: every `period` m the ground rises `height` over a `riser`-wide ramp. */
interface Terrace {
  height: number;
  period: number;
  riser: number;
  angle: number;
}

interface AnalyticTerrain {
  kind: 'analytic';
  base: number;
  tiltX: number;
  tiltZ: number;
  waves: Wave[];
  terrace: Terrace | null;
}

type TerrainSpec = { kind: 'generated'; seed: number } | AnalyticTerrain;

interface TerrainCase {
  terrain: TerrainSpec;
  start: XZ;
}

const arbWave: Arbitrary<Wave> = fc
  .record({ wavelength: arbGrid(3, 60, 0.1), steepness: arbGrid(0, 0.45, 0.005), angle: arbAngle, phase: arbAngle })
  // steepness is the wave's largest gradient, amp · 2π / wavelength (0.45 ≈ 24°).
  .map(({ wavelength, steepness, angle, phase }) => ({ amp: (steepness * wavelength) / (2 * Math.PI), wavelength, angle, phase }));

const arbTerrace: Arbitrary<Terrace> = fc.record({
  height: arbGrid(0.05, 1.2, 0.01),
  period: arbGrid(1.5, 8, 0.05),
  riser: arbGrid(0.01, 0.8, 0.01),
  angle: arbAngle,
});

/**
 * arbTerrainSeed. Generated: a fixed-seed buildTerrain field with a start within 480 m of the centre
 * (the ring mountains begin at 470 m). Analytic: a tilted plane plus up to three sine ridge sets
 * (mostly walkable, up to ≈ 60° where they add up) and optional terraces whose risers are sharp
 * 0.05–1.2 m ledges, with a start within 40 m of the origin.
 */
const arbTerrainSeed: Arbitrary<TerrainCase> = fc.oneof(
  fc
    .record({ seed: fc.constantFrom(...GENERATED_SEEDS), bearing: arbAngle, radius: arbGrid(0, 480, 0.01) })
    .map(
      ({ seed, bearing, radius }): TerrainCase => ({
        terrain: { kind: 'generated', seed },
        start: { x: radius * Math.sin(bearing), z: radius * Math.cos(bearing) },
      }),
    ),
  fc
    .record({
      base: arbGrid(-50, 50, 0.01),
      tiltX: arbGrid(-0.3, 0.3, 0.005),
      tiltZ: arbGrid(-0.3, 0.3, 0.005),
      waves: fc.array(arbWave, { maxLength: 3 }),
      terrace: fc.option(arbTerrace, { nil: null }),
      x: arbGrid(-40, 40, 0.01),
      z: arbGrid(-40, 40, 0.01),
    })
    .map(({ x, z, ...t }): TerrainCase => ({ terrain: { kind: 'analytic', ...t }, start: { x, z } })),
);

function analyticHeight(t: AnalyticTerrain): (x: number, z: number) => number {
  const waves = t.waves.map((w) => {
    const k = (2 * Math.PI) / w.wavelength;
    return { amp: w.amp, kx: k * Math.cos(w.angle), kz: k * Math.sin(w.angle), phase: w.phase };
  });
  const tr = t.terrace;
  const tc = tr === null ? 0 : Math.cos(tr.angle);
  const ts = tr === null ? 0 : Math.sin(tr.angle);
  return (x, z) => {
    let h = t.base + t.tiltX * x + t.tiltZ * z;
    for (const w of waves) h += w.amp * Math.sin(w.kx * x + w.kz * z + w.phase);
    if (tr !== null) {
      const q = (x * tc + z * ts) / tr.period;
      const k = Math.floor(q);
      const tread = 1 - tr.riser / tr.period; // flat fraction of each period, the riser takes the rest
      h += tr.height * (k + Math.min(1, Math.max(0, (q - k - tread) / (1 - tread))));
    }
    return h;
  };
}

function heightfieldOf(t: TerrainSpec): Heightfield {
  return t.kind === 'generated' ? generatedTerrain(t.seed) : analyticHeightfield(analyticHeight(t));
}

// ---------------------------------------------------------------------------
// Collider layout, start state, stamina
// ---------------------------------------------------------------------------

type ObstacleShape = 'aabb' | 'obb' | 'cylinder';

/** A static collider standing on the terrain near the start. */
interface ObstacleSpec {
  shape: ObstacleShape;
  /** Gap (m) between the start's clear disc and the collider's footprint. */
  gap: number;
  /** Direction from the start. */
  bearing: number;
  /** Footprint half sizes; a cylinder's radius is halfX. */
  halfX: number;
  halfZ: number;
  /** Top above the terrain under the centre (m): low ones are ledges, high ones walls. */
  height: number;
  yaw: number;
  walkableTop: boolean;
  material: SurfaceMaterial;
}

const arbObstacle: Arbitrary<ObstacleSpec> = fc.record({
  shape: fc.constantFrom<ObstacleShape>('aabb', 'obb', 'cylinder'),
  gap: arbGrid(0, 4, 0.01),
  bearing: arbAngle,
  halfX: arbGrid(0.2, 3, 0.01),
  halfZ: arbGrid(0.2, 3, 0.01),
  height: fc.oneof(arbGrid(0.05, 0.6, 0.01), arbGrid(0.6, 3, 0.01)),
  yaw: arbAngle,
  walkableTop: arbChance(80),
  material: arbMaterial,
});

/** No collider comes within this of the start's capsule (m). */
const START_CLEARANCE = 0.5;
const FOOTPRINT_CORNERS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

function placeObstacle(id: number, o: ObstacleSpec, start: XZ, hf: Heightfield): Collider {
  const reach = o.shape === 'cylinder' ? o.halfX : Math.hypot(o.halfX, o.halfZ);
  const d = R + START_CLEARANCE + reach + o.gap;
  const cx = start.x + d * Math.sin(o.bearing);
  const cz = start.z + d * Math.cos(o.bearing);
  const centre = hf.heightAt(cx, cz);
  let low = centre;
  for (const [sx, sz] of FOOTPRINT_CORNERS) low = Math.min(low, hf.heightAt(cx + sx * reach, cz + sz * reach));
  const bottom = low - BURY;
  const top = centre + o.height;
  const flags: ColliderFlags = { climbable: false, walkableTop: o.walkableTop, blocksCamera: true, material: o.material };
  switch (o.shape) {
    case 'aabb':
      return { kind: 'aabb', min: { x: cx - o.halfX, y: bottom, z: cz - o.halfZ }, max: { x: cx + o.halfX, y: top, z: cz + o.halfZ }, id, flags };
    case 'obb':
      return { kind: 'obb', center: { x: cx, y: (bottom + top) / 2, z: cz }, half: { x: o.halfX, y: (top - bottom) / 2, z: o.halfZ }, yaw: o.yaw, id, flags };
    case 'cylinder':
      return { kind: 'cylinder', base: { x: cx, y: bottom, z: cz }, radius: o.halfX, height: top - bottom, id, flags };
  }
}

interface StartSpec {
  /** 0: standing on the ground; otherwise falling from this height above it with `vel`. */
  lift: number;
  vel: Vec3;
  yaw: number;
}

const arbStart: Arbitrary<StartSpec> = fc.record({
  lift: fc.oneof({ weight: 3, arbitrary: fc.constant(0) }, { weight: 2, arbitrary: arbGrid(0.3, 16, 0.01) }),
  vel: fc.record({ x: arbGrid(-8, 8, 0.01), y: arbGrid(-12, 8, 0.01), z: arbGrid(-8, 8, 0.01) }),
  yaw: arbAngle,
});

function startState(world: CollisionWorld, at: XZ, s: StartSpec): ControllerState {
  const h = world.terrain.heightAt(at.x, at.z);
  // Rest the capsule on the ground below (on a slope it touches uphill of the feet). The start is
  // the test's precondition, so a snap that rounds a hair under h is lifted onto h itself.
  const snap = snapToGround(world, { x: at.x, y: h + 2, z: at.z }, 4);
  const feet: Vec3 = { x: at.x, y: snap.snapped ? Math.max(snap.pos.y, h) : h, z: at.z };
  const state = createControllerState(feet, s.yaw);
  if (s.lift === 0) return state;
  const y = feet.y + s.lift;
  return { ...state, pos: { ...feet, y }, vel: { ...s.vel }, mode: 'fall', grounded: false, fallStartY: y };
}

/** Party stamina from empty to full, sometimes still exhausted below 30 %. */
const arbStamina: Arbitrary<StaminaState> = fc
  .record({ value: fc.integer({ min: 0, max: 100 }), tired: fc.boolean() })
  .map(({ value, tired }) => ({ value, max: 100, exhausted: value === 0 || (tired && value < 30), idleTimer: 0 }));

// ---------------------------------------------------------------------------
// arbInputSeq: held move input with buffered jump / dodge presses
// ---------------------------------------------------------------------------

/** One input held for `ticks` ticks; jump, dodge and release are pressed on its first tick. */
interface Segment {
  ticks: number;
  /** World-space move direction (yaw convention) and stick tilt (0 = no move input). */
  angle: number;
  tilt: number;
  sprint: boolean;
  walk: boolean;
  jump: boolean;
  dodge: boolean;
  release: boolean;
}

const arbSegment: Arbitrary<Segment> = fc.record({
  ticks: fc.integer({ min: 1, max: 45 }),
  angle: arbAngle,
  tilt: fc.oneof(
    { weight: 1, arbitrary: fc.constant(0) },
    { weight: 4, arbitrary: fc.constant(1) },
    { weight: 2, arbitrary: arbGrid(0.05, 1, 0.01) },
  ),
  sprint: fc.boolean(),
  walk: arbChance(20),
  jump: arbChance(35),
  dodge: arbChance(20),
  release: arbChance(10),
});

/** arbInputSeq: 1–12 segments (at most 540 ticks, 9 s). */
const arbInputSeq = fc.array(arbSegment, { minLength: 1, maxLength: 12 });

/** A jump / dodge press stays usable for BUFFER_SECONDS: its own tick and the next 9 at 60 Hz. */
const BUFFER_TICKS = Math.floor(BUFFER_SECONDS / SIM_DT + 1e-9) + 1;

interface ClampRun {
  /** First tick whose feet were below the terrain, or null. */
  violation: string | null;
  modes: Set<MoveMode>;
  /** Horizontal distance from the start to the end (m). */
  travel: number;
  /** The character stood on a collider at some tick. */
  onCollider: boolean;
}

function runClamp(
  tc: TerrainCase,
  obstacles: readonly ObstacleSpec[],
  start: StartSpec,
  stamina0: StaminaState,
  character: CharacterId,
  inputs: readonly Segment[],
): ClampRun {
  const hf = heightfieldOf(tc.terrain);
  const layout = obstacles.map((o, i) => placeObstacle(i + 1, o, tc.start, hf));
  const world = createCollisionWorld(hf);
  // A copy answers the test's own queries: a world keeps its NaN fallbacks per instance, so they
  // stay the controller's.
  const probe = createCollisionWorld(hf);
  for (const c of layout) {
    world.addStatic(c);
    probe.addStatic(c);
  }
  const below = (s: ControllerState, when: string): string | null => {
    const ground = hf.heightAt(s.pos.x, s.pos.z);
    return s.pos.y >= ground ? null : `${when} (${s.mode}): feet (${s.pos.x}, ${s.pos.y}, ${s.pos.z}) below heightAt = ${ground}`;
  };

  let state = startState(probe, tc.start, start);
  let stamina = stamina0;
  let violation = below(state, 'start');
  const modes = new Set<MoveMode>();
  let onCollider = false;
  let jumpLeft = 0;
  let dodgeLeft = 0;
  let tick = 0;
  for (const seg of inputs) {
    const move = { x: seg.tilt * Math.sin(seg.angle), z: seg.tilt * Math.cos(seg.angle) };
    for (let k = 0; k < seg.ticks && violation === null; k++, tick++) {
      if (k === 0 && seg.jump) jumpLeft = BUFFER_TICKS;
      if (k === 0 && seg.dodge) dodgeLeft = BUFFER_TICKS;
      const input: ControllerInput = {
        move,
        sprint: seg.sprint,
        walk: seg.walk,
        jump: jumpLeft > 0,
        dodge: dodgeLeft > 0,
        release: k === 0 && seg.release,
      };
      const r = stepController(state, input, world, stamina, character, SIM_DT);
      jumpLeft = r.consumed.jump ? 0 : Math.max(0, jumpLeft - 1);
      dodgeLeft = r.consumed.dodge ? 0 : Math.max(0, dodgeLeft - 1);
      state = r.state;
      stamina = r.stamina;
      modes.add(state.mode);
      violation = below(state, `tick ${tick}`);
      if (!onCollider && state.grounded) onCollider = (probe.groundProbe(state.pos, 0.05)?.colliderId ?? null) !== null;
    }
  }
  return { violation, modes, travel: Math.hypot(state.pos.x - tc.start.x, state.pos.z - tc.start.z), onCollider };
}

// ---------------------------------------------------------------------------
// Step-up: box ledges on flat ground
// ---------------------------------------------------------------------------
//
// The ledges are colliders: the game's terrain is a 2 m bilinear grid, so a rise of 0.45 m or less
// spreads over at least 2 m of walkable slope. The analytic terraces above (sharp risers no game
// terrain has) are only held to the clamp.

/** Req 16.7's step limit, stated here rather than read from the controller constants it checks. */
const STEP_LIMIT = 0.45;
/**
 * Ledge heights keep out of the 0.44–0.47 m band around the limit: right at it the outcome depends
 * on tolerances the property does not fix (the step accepts a top up to 1 mm above the limit, and
 * its sweeps stop 1 cm short of contacts), not on the rule.
 */
const LOW_MAX = STEP_LIMIT - 0.01;
const HIGH_MIN = STEP_LIMIT + 0.02;
const arbLowLedgeHeight = arbGrid(0.02, LOW_MAX, 0.001);
const arbHighLedgeHeight = arbGrid(HIGH_MIN, 1.2, 0.001);

interface LedgeSpec {
  shape: 'aabb' | 'obb';
  /** aabb: which axis the face looks along (index into QUARTER_NORMALS). */
  quarter: number;
  /** obb: yaw of the face's outward normal. */
  normalYaw: number;
  /** Extent into the ledge from the face, and half the face width (m). */
  depth: number;
  halfWidth: number;
  /** Flat ground height (m). */
  ground: number;
  material: SurfaceMaterial;
}

const arbLedge: Arbitrary<LedgeSpec> = fc.record({
  shape: fc.constantFrom<'aabb' | 'obb'>('aabb', 'obb'),
  quarter: fc.integer({ min: 0, max: 3 }),
  normalYaw: arbAngle,
  depth: arbGrid(1.6, 4, 0.01),
  halfWidth: arbGrid(8, 12, 0.01),
  ground: arbGrid(-20, 20, 0.01),
  material: arbMaterial,
});

type Pace = 'walkToggle' | 'walkTilt' | 'run' | 'sprint';

interface ApproachSpec {
  /** Gap (m) between the capsule and the face at the start. */
  gap: number;
  /** Direction of travel off the face's inward normal (rad). */
  offAngle: number;
  /** Where the path meets the face, along it from its centre (m). */
  lateral: number;
  pace: Pace;
  /** Stick tilt for 'walkTilt' (≤ 0.5 walks). */
  tilt: number;
  yaw: number;
  character: CharacterId;
}

const MAX_OFF_ANGLE_DEG = 30;

const arbApproach: Arbitrary<ApproachSpec> = fc.record({
  gap: arbGrid(0.05, 2.5, 0.01),
  offAngle: arbGrid(-MAX_OFF_ANGLE_DEG, MAX_OFF_ANGLE_DEG, 0.1).map((deg) => deg * DEG2RAD),
  lateral: arbGrid(-1, 1, 0.01),
  pace: fc.constantFrom<Pace>('walkToggle', 'walkTilt', 'run', 'sprint'),
  tilt: arbGrid(0.2, 0.5, 0.01),
  yaw: arbAngle,
  character: arbCharacter,
});

/** A box ledge with its face centred on the origin: u points into the ledge, w along the face. */
interface Ledge {
  collider: Collider;
  u: XZ;
  w: XZ;
  ground: number;
  top: number;
  halfWidth: number;
}

const QUARTER_NORMALS: readonly XZ[] = [
  { x: 0, z: 1 },
  { x: 1, z: 0 },
  { x: 0, z: -1 },
  { x: -1, z: 0 },
];

function buildLedge(spec: LedgeSpec, height: number): Ledge {
  const n = spec.shape === 'aabb' ? QUARTER_NORMALS[spec.quarter] : { x: Math.sin(spec.normalYaw), z: Math.cos(spec.normalYaw) };
  const u = { x: -n.x, z: -n.z };
  const w = { x: n.z, z: -n.x };
  const bottom = spec.ground - BURY;
  const top = spec.ground + height;
  const id = 1;
  // The top is flat and flagged walkable: the ledge's walkable top.
  const flags: ColliderFlags = { climbable: false, walkableTop: true, blocksCamera: true, material: spec.material };
  let collider: Collider;
  if (spec.shape === 'aabb') {
    // Footprint u ∈ [0, depth] × w ∈ [−halfWidth, halfWidth]; n is a unit axis, so its corners are exact.
    const xs: number[] = [];
    const zs: number[] = [];
    for (const a of [0, spec.depth]) {
      for (const b of [-spec.halfWidth, spec.halfWidth]) {
        xs.push(u.x * a + w.x * b);
        zs.push(u.z * a + w.z * b);
      }
    }
    const min = { x: Math.min(...xs), y: bottom, z: Math.min(...zs) };
    const max = { x: Math.max(...xs), y: top, z: Math.max(...zs) };
    collider = { kind: 'aabb', min, max, id, flags };
  } else {
    // The obb's local +Z (half depth / 2) runs along u, so the face is its −Z side.
    const center = { x: (u.x * spec.depth) / 2, y: (bottom + top) / 2, z: (u.z * spec.depth) / 2 };
    const half = { x: spec.halfWidth, y: (top - bottom) / 2, z: spec.depth / 2 };
    collider = { kind: 'obb', center, half, yaw: yawFromDir(u.x, u.z), id, flags };
  }
  return { collider, u, w, ground: spec.ground, top, halfWidth: spec.halfWidth };
}

/** Signed distance of the capsule centre past the face plane (−R at contact). */
const into = (l: Ledge, p: Readonly<Vec3>): number => p.x * l.u.x + p.z * l.u.z;
/** Position along the face from its centre. */
const along = (l: Ledge, p: Readonly<Vec3>): number => p.x * l.w.x + p.z * l.w.z;
const fmt = (p: Readonly<Vec3>): string => `${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)}`;

/** Start at rest `gap` m out from the face, on a straight path that meets it `lateral` m off centre. */
function approach(l: Ledge, a: ApproachSpec): { start: ControllerState; input: ControllerInput } {
  const c = Math.cos(a.offAngle);
  const s = Math.sin(a.offAngle);
  const dir = { x: l.u.x * c + l.w.x * s, z: l.u.z * c + l.w.z * s };
  // Where the centre touches the face (R out of it), then back along the path until `gap` out.
  const meetX = -l.u.x * R + l.w.x * a.lateral;
  const meetZ = -l.u.z * R + l.w.z * a.lateral;
  const back = a.gap / c;
  const start = createControllerState({ x: meetX - dir.x * back, y: l.ground, z: meetZ - dir.z * back }, a.yaw);
  const tilt = a.pace === 'walkTilt' ? a.tilt : 1;
  const input: ControllerInput = {
    move: { x: dir.x * tilt, z: dir.z * tilt },
    sprint: a.pace === 'sprint',
    walk: a.pace === 'walkToggle',
    jump: false,
    dodge: false,
    release: false,
  };
  return { start, input };
}

function ledgeWorld(l: Ledge): CollisionWorld {
  const world = createCollisionWorld(flatHeightfield(l.ground));
  world.addStatic(l.collider);
  return world;
}

/** A run ends once the capsule centre is this far past the face, so the whole capsule is over the top (m). */
const PAST_FACE = 1;
/**
 * Stall: a tick must gain at least this fraction of the same tick's progress toward the ledge in a
 * run over plain flat ground. Stopping at the face gains 0; rolling over a low ledge's edge keeps
 * ≥ cos² 50° ≈ 0.41 of it.
 */
const STALL_RATIO = 0.3;
const MAX_TICKS = 240;
/** Feet standing on a flat surface: within this of its height (m). */
const REST_TOLERANCE = 1e-3;
/** After first reaching a high ledge's face, the character keeps pushing into it this long. */
const PUSH_TICKS = 45;
/** Reaching the face: the capsule within this of it (collide-and-slide stops 1 cm short). */
const CONTACT_SLACK = 0.02;
/** Overlap with the face allowed for rounding (m). */
const PENETRATION_TOLERANCE = 1e-3;

/** Walks into a low ledge next to a reference run over flat ground; null when it stepped up without stalling. */
function stepOntoLedge(spec: LedgeSpec, height: number, a: ApproachSpec): string | null {
  const l = buildLedge(spec, height);
  const world = ledgeWorld(l);
  const flat = createCollisionWorld(flatHeightfield(l.ground));
  const { start, input } = approach(l, a);
  let s = start;
  let ref = start;
  let stamina = createStaminaState();
  let refStamina = stamina;
  for (let i = 0; i < MAX_TICKS; i++) {
    const r = stepController(s, input, world, stamina, a.character, SIM_DT);
    const f = stepController(ref, input, flat, refStamina, a.character, SIM_DT);
    const p = r.state.pos;
    const at = `tick ${i} at (${fmt(p)})`;
    if (r.state.mode !== 'grounded') return `${at}: mode ${r.state.mode}`;
    if (Math.abs(along(l, p)) > l.halfWidth - R) return `${at}: walked off the side of the face`;
    const gained = into(l, p) - into(l, s.pos);
    const flatGained = into(l, f.state.pos) - into(l, ref.pos);
    if (!(gained >= STALL_RATIO * flatGained)) return `${at}: gained ${gained} m toward the ledge, ${flatGained} m on flat ground`;
    s = r.state;
    stamina = r.stamina;
    ref = f.state;
    refStamina = f.stamina;
    if (into(l, p) >= PAST_FACE) {
      return Math.abs(p.y - l.top) <= REST_TOLERANCE ? null : `${at}: past the face with the feet at ${p.y}, not on the top at ${l.top}`;
    }
  }
  return `not ${PAST_FACE} m past the face after ${MAX_TICKS} ticks (at ${fmt(s.pos)})`;
}

/** Walks into a high ledge and keeps pushing; null when it stayed on the ground outside the face. */
function blockedByLedge(spec: LedgeSpec, height: number, a: ApproachSpec): string | null {
  const l = buildLedge(spec, height);
  const world = ledgeWorld(l);
  const { start, input } = approach(l, a);
  let s = start;
  let stamina = createStaminaState();
  let contact = -1;
  for (let i = 0; i < MAX_TICKS; i++) {
    const r = stepController(s, input, world, stamina, a.character, SIM_DT);
    s = r.state;
    stamina = r.stamina;
    const p = s.pos;
    const at = `tick ${i} at (${fmt(p)})`;
    if (s.mode !== 'grounded') return `${at}: mode ${s.mode}`;
    if (Math.abs(p.y - l.ground) > REST_TOLERANCE) return `${at}: feet off the ground at ${l.ground} (ledge top ${l.top})`;
    if (into(l, p) + R > PENETRATION_TOLERANCE) return `${at}: capsule ${into(l, p) + R} m into the face`;
    if (Math.abs(along(l, p)) > l.halfWidth - R) return `${at}: walked off the side of the face`;
    if (contact < 0 && into(l, p) + R >= -CONTACT_SLACK) contact = i;
    if (contact >= 0 && i - contact >= PUSH_TICKS) return null;
  }
  return `never reached the face in ${MAX_TICKS} ticks (at ${fmt(s.pos)})`;
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('Property 27: 지형 위 유지와 턱 오르기', () => {
  it('keeps the feet at or above heightAt(x, z) after every tick on seeded terrain with colliders', () => {
    const seen = new Set<MoveMode>();
    let moved = 0;
    let onCollider = 0;
    fc.assert(
      fc.property(
        arbTerrainSeed,
        fc.array(arbObstacle, { maxLength: 10 }),
        arbStart,
        arbStamina,
        arbCharacter,
        arbInputSeq,
        (terrain, obstacles, start, stamina, character, inputs) => {
          const run = runClamp(terrain, obstacles, start, stamina, character, inputs);
          expect(run.violation).toBeNull();
          for (const m of run.modes) seen.add(m);
          if (run.travel > 2) moved++;
          if (run.onCollider) onCollider++;
        },
      ),
      { numRuns: 200, seed: 2701 },
    );
    // Guard against a vacuous pass: runs must travel, stand on colliders and go through every
    // ground and air mode.
    expect(moved).toBeGreaterThan(100);
    expect(onCollider).toBeGreaterThan(25);
    expect([...seen]).toEqual(expect.arrayContaining<MoveMode>(['grounded', 'jump', 'fall', 'landing', 'dodge', 'slide']));
  });

  it(`steps onto ledges up to ${LOW_MAX.toFixed(2)} m with a walkable top without the movement stalling`, () => {
    fc.assert(
      fc.property(arbLedge, arbLowLedgeHeight, arbApproach, (ledge, height, a) => {
        expect(stepOntoLedge(ledge, height, a)).toBeNull();
      }),
      { numRuns: 200, seed: 2702 },
    );
  });

  it(`is blocked by ledges from ${HIGH_MIN.toFixed(2)} to 1.2 m and stays outside them`, () => {
    fc.assert(
      fc.property(arbLedge, arbHighLedgeHeight, arbApproach, (ledge, height, a) => {
        expect(blockedByLedge(ledge, height, a)).toBeNull();
      }),
      { numRuns: 200, seed: 2703 },
    );
  });
});
