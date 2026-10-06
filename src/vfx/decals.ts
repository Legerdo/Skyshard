// Ground decals (design "Telegraph 표시"; Req 26.5, 26.8, 35.7, 25.9).
//
// Telegraph decals: circle (slams), sector (swings, breath), line (charge paths, aim lines) and ring (shock rings)
// on a 16 × 16 grid whose vertices are laid on the ground under them (re-laid when the decal moves), with the
// shape's size in uniforms. The fragment shader normalises the distance to the shape's edge to d (0 at the edge, 1 at
// the centre) and fills where d < uProgress, so the fill rises from the edge and reaches the centre at the moment of
// the hit; the outline is bold from the start, the fill carries diagonal stripes and lines carry chevrons flowing
// along the charge, so colour is never the only cue. Ordinary enemies and Elites are red-orange (#FF4A2A), Caelith
// gold-red (#FFC247 outline, #E03A2A fill). Decals draw after every combat VFX (higher renderOrder), with polygon
// offset (−2, −4) against the ground, depth-tested but never depth-writing. The pool of 12 grows instead of dropping
// a Telegraph. Enemy Telegraphs are read from their attack playback, Caelith's from the encounter snapshot.
//
// Puddle decals: the lava rift and the mud of 진흙 속박 use the same ground grid (pool of 3) at a lower renderOrder.

import * as THREE from 'three';
import type { BossTelegraph } from '../boss/bossSnapshot';
import type { Vec3 } from '../core/types';
import type { TelegraphDef } from '../data/combatTypes';
import type { EnemyRuntime } from '../save/runtimeState';
import { TELEGRAPH_COLORS } from './catalog';
import { VFX_RENDER_ORDER } from './meshFx';

export const DECAL_POOL = 12;
export const PUDDLE_POOL = 3;
export const DECAL_GRID = 16;
/** Telegraphs draw above every combat effect; puddles below them. */
export const DECAL_RENDER_ORDER = VFX_RENDER_ORDER + 10;
export const PUDDLE_RENDER_ORDER = VFX_RENDER_ORDER - 2;
export const DECAL_POLYGON_OFFSET = { factor: -2, units: -4 } as const;
/** Height of the decal surface above the ground (m). */
const DECAL_LIFT = 0.04;
/** Outline width (m): ordinary and strong attacks. */
const OUTLINE = { normal: 0.14, strong: 0.22 } as const;
/** Ring Telegraphs without an inner radius use this fraction of the outer one. */
const RING_INNER = 0.8;

export type DecalShape = 'circle' | 'sector' | 'line' | 'ring';
const SHAPE_INDEX: Readonly<Record<DecalShape, number>> = { circle: 0, sector: 1, line: 2, ring: 3 };

/** One Telegraph to show, in the attacker's frame: local +Z along `yaw` from `center`. */
export interface TelegraphInput {
  /** Stable while it shows (keeps its decal). */
  readonly key: string;
  readonly shape: DecalShape;
  readonly center: Readonly<Vec3>;
  readonly yaw: number;
  readonly radius: number;
  readonly inner: number;
  readonly angleDeg: number;
  readonly length: number;
  readonly width: number;
  /** 0 at the start of the Telegraph, 1 at the hit. */
  readonly progress: number;
  readonly boss: boolean;
  readonly strong: boolean;
  /** Lie flat at `center.y` (the boss arena floor) instead of following the terrain. */
  readonly flat: boolean;
}

export interface DecalParams {
  readonly shape: number;
  readonly radius: number;
  readonly inner: number;
  /** Half angle (rad). */
  readonly half: number;
  readonly length: number;
  readonly width: number;
  readonly progress: number;
  readonly edge: number;
  readonly fill: number;
  readonly outline: number;
  /** Local rectangle (m) the grid spans: x across, z forward. */
  readonly bounds: { readonly x0: number; readonly x1: number; readonly z0: number; readonly z1: number };
}

const clamp01 = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0);

/** Shader parameters and grid bounds of a Telegraph; null when it has no area. */
export function decalParams(t: Readonly<TelegraphInput>): DecalParams | null {
  const colors = t.boss ? TELEGRAPH_COLORS.boss : TELEGRAPH_COLORS.enemy;
  const base = {
    shape: SHAPE_INDEX[t.shape], progress: clamp01(t.progress), edge: colors.edge, fill: colors.fill,
    outline: t.strong ? OUTLINE.strong : OUTLINE.normal,
  };
  switch (t.shape) {
    case 'circle':
    case 'ring': {
      const r = t.radius;
      if (!(r > 0)) return null;
      const inner = t.shape === 'ring' ? Math.min(r * 0.98, t.inner > 0 ? t.inner : r * RING_INNER) : 0;
      return { ...base, radius: r, inner, half: Math.PI, length: 0, width: 0, bounds: { x0: -r, x1: r, z0: -r, z1: r } };
    }
    case 'sector': {
      const r = t.radius;
      if (!(r > 0)) return null;
      const half = (Math.min(360, Math.max(1, t.angleDeg > 0 ? t.angleDeg : 90)) * Math.PI) / 360;
      const xr = half >= Math.PI / 2 ? r : r * Math.sin(half);
      const z0 = Math.min(0, r * Math.cos(half));
      return { ...base, radius: r, inner: 0, half, length: 0, width: 0, bounds: { x0: -xr, x1: xr, z0, z1: r } };
    }
    case 'line': {
      const l = t.length;
      const w = t.width > 0 ? t.width : 1;
      if (!(l > 0)) return null;
      return { ...base, radius: 0, inner: 0, half: 0, length: l, width: w, bounds: { x0: -w / 2, x1: w / 2, z0: 0, z1: l } };
    }
  }
}

/** Minimal view of an enemy for its Telegraph (EnemyRuntime satisfies it). */
export type TelegraphEnemy = Pick<EnemyRuntime, 'id' | 'state' | 'attack' | 'aim'>;

/**
 * The ground Telegraph of an enemy's attack from its start to its first HitEvent, at the locked target point for
 * target-aimed attacks, else at the attacker's (interpolated) feet along its facing; null otherwise (and for glows).
 */
export function enemyTelegraph(e: Readonly<TelegraphEnemy>, pos: Readonly<Vec3>, yaw: number): TelegraphInput | null {
  const attack = e.attack;
  if (e.state !== 'attack' || attack === null) return null;
  const first = attack.def.hits[0];
  const def: TelegraphDef | undefined = attack.def.telegraph;
  if (first === undefined || def === undefined || def.kind === 'glow' || !(attack.t < first.t)) return null;
  return {
    key: `${e.id}:${attack.def.id}`,
    shape: def.kind,
    center: e.aim ?? pos,
    yaw: e.aim === null ? yaw : 0,
    radius: def.radius ?? 0,
    inner: 0,
    angleDeg: def.angleDeg ?? 90,
    length: def.length ?? 0,
    width: def.width ?? 1,
    progress: first.t > 0 ? attack.t / first.t : 1,
    boss: false,
    strong: def.strong,
    flat: false,
  };
}

/** A Telegraph of Caelith's snapshot on the arena floor. */
export function bossTelegraph(t: Readonly<BossTelegraph>): TelegraphInput {
  const progress = t.duration > 0 ? 1 - t.remaining / t.duration : 1;
  const common = { key: `boss:${t.id}`, center: t.center, yaw: t.yaw, progress, boss: true, strong: t.strong, flat: true };
  switch (t.shape) {
    case 'circle':
      return { ...common, shape: 'circle', radius: t.radius, inner: 0, angleDeg: 360, length: 0, width: 0 };
    case 'sector':
    case 'arenaSector':
      return { ...common, shape: 'sector', radius: t.radius, inner: 0, angleDeg: t.angleDeg, length: 0, width: 0 };
    case 'line':
    case 'aim':
      return { ...common, shape: 'line', radius: 0, inner: 0, angleDeg: 0, length: t.length, width: t.width };
    case 'ring': {
      // The Astral Sweep's warning glow around Caelith (its ring starts at radius 0).
      const outer = Math.max(6, t.radius);
      return { ...common, shape: 'ring', radius: outer, inner: outer * 0.7, angleDeg: 360, length: 0, width: 0 };
    }
  }
}

/** Ground height under (x, z) for a decal whose reference height is `refY`. */
export type GroundAt = (x: number, z: number, refY: number) => number;

const TELEGRAPH_VERT = /* glsl */ `
attribute vec2 aLocal;
varying vec2 vLocal;
void main() {
  vLocal = aLocal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const TELEGRAPH_FRAG = /* glsl */ `
uniform float uShape;
uniform float uRadius;
uniform float uInner;
uniform float uHalf;
uniform float uLength;
uniform float uWidth;
uniform float uProgress;
uniform float uOutline;
uniform float uTime;
uniform float uOpacity;
uniform vec3 uEdge;
uniform vec3 uFill;
varying vec2 vLocal;
void main() {
  vec2 p = vLocal;
  float inside;
  float d;
  float edge;
  if (uShape < 0.5) {
    float r = length(p);
    inside = step(r, uRadius);
    d = 1.0 - r / uRadius;
    edge = uRadius - r;
  } else if (uShape < 1.5) {
    float r = length(p);
    float a = abs(atan(p.x, p.y));
    inside = step(r, uRadius) * step(a, uHalf);
    d = 1.0 - r / uRadius;
    float side = uHalf < 3.1 ? r * sin(clamp(uHalf - a, 0.0, 1.5707)) : 1000.0;
    edge = min(uRadius - r, side);
  } else if (uShape < 2.5) {
    float hw = 0.5 * uWidth;
    inside = step(abs(p.x), hw) * step(0.0, p.y) * step(p.y, uLength);
    d = 1.0 - abs(p.x) / hw;
    edge = min(hw - abs(p.x), min(p.y, uLength - p.y));
  } else {
    float r = length(p);
    float mid = 0.5 * (uRadius + uInner);
    float hb = max(0.001, 0.5 * (uRadius - uInner));
    inside = step(uInner, r) * step(r, uRadius);
    d = 1.0 - abs(r - mid) / hb;
    edge = hb - abs(r - mid);
  }
  if (inside < 0.5) discard;
  float outline = 1.0 - smoothstep(uOutline * 0.55, uOutline, edge);
  float filled = step(d, uProgress);
  float stripes = step(0.5, fract((p.x + p.y) * 1.25 - uTime * 0.6));
  float chevron = (uShape > 1.5 && uShape < 2.5) ? step(0.62, fract(p.y * 0.7 - abs(p.x) * 0.7 - uTime * 1.6)) : 0.0;
  float fillAlpha = filled * (0.36 + 0.2 * stripes) + (1.0 - filled) * (0.1 + 0.07 * stripes) + chevron * 0.2;
  vec3 color = mix(uFill, uEdge * 1.4, outline);
  gl_FragColor = vec4(color, max(fillAlpha, outline * 0.95) * uOpacity);
  #include <colorspace_fragment>
}`;

const PUDDLE_FRAG = /* glsl */ `
uniform float uRadius;
uniform float uKind;
uniform float uTime;
uniform float uOpacity;
varying vec2 vLocal;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  float r = length(vLocal) / uRadius;
  float n = noise(vLocal * 1.6 + vec2(0.0, uTime * 0.15)) * 0.6 + noise(vLocal * 4.0 - uTime * 0.3) * 0.4;
  float rim = 1.0 - smoothstep(0.82 + 0.12 * n, 1.0, r);
  if (rim <= 0.001) discard;
  vec3 color;
  float alpha;
  if (uKind < 0.5) {
    float crack = smoothstep(0.42, 0.5, n) * (1.0 - smoothstep(0.5, 0.6, n));
    float pulse = 0.75 + 0.25 * sin(uTime * 5.0 + n * 6.0);
    color = mix(vec3(0.18, 0.05, 0.02), vec3(1.0, 0.45, 0.08) * 1.6, max(crack * 1.4, 0.25 * pulse));
    alpha = 0.85 * rim;
  } else {
    float ringLines = 0.5 + 0.5 * sin(r * 22.0 - uTime * 2.0 + n * 3.0);
    color = mix(vec3(0.24, 0.16, 0.08), vec3(0.42, 0.3, 0.16), ringLines * n);
    alpha = 0.78 * rim;
  }
  gl_FragColor = vec4(color, alpha * uOpacity);
  #include <colorspace_fragment>
}`;

/** A 16 × 16 grid laid on the ground over a local rectangle turned by `yaw` about `center`. */
class GroundGrid {
  readonly geometry = new THREE.BufferGeometry();
  private readonly positions: Float32Array;
  private readonly local: Float32Array;
  private key = '';

  constructor() {
    const n = (DECAL_GRID + 1) * (DECAL_GRID + 1);
    this.positions = new Float32Array(n * 3);
    this.local = new Float32Array(n * 2);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aLocal', new THREE.BufferAttribute(this.local, 2).setUsage(THREE.DynamicDrawUsage));
    const index: number[] = [];
    const row = DECAL_GRID + 1;
    for (let j = 0; j < DECAL_GRID; j++) {
      for (let i = 0; i < DECAL_GRID; i++) {
        const a = j * row + i;
        index.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      }
    }
    this.geometry.setIndex(index);
  }

  /** Lays the grid (only when center, yaw, bounds or flatness changed). */
  lay(center: Readonly<Vec3>, yaw: number, b: DecalParams['bounds'], flat: boolean, ground: GroundAt): void {
    const key = `${center.x.toFixed(2)},${center.y.toFixed(2)},${center.z.toFixed(2)},${yaw.toFixed(3)},${b.x0},${b.x1},${b.z0},${b.z1},${flat}`;
    if (key === this.key) return;
    this.key = key;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    let k = 0;
    for (let j = 0; j <= DECAL_GRID; j++) {
      const lz = b.z0 + ((b.z1 - b.z0) * j) / DECAL_GRID;
      for (let i = 0; i <= DECAL_GRID; i++) {
        const lx = b.x0 + ((b.x1 - b.x0) * i) / DECAL_GRID;
        const wx = center.x + lx * c + lz * s;
        const wz = center.z - lx * s + lz * c;
        const wy = (flat ? center.y : ground(wx, wz, center.y)) + DECAL_LIFT;
        this.positions[k * 3] = wx;
        this.positions[k * 3 + 1] = wy;
        this.positions[k * 3 + 2] = wz;
        this.local[k * 2] = lx;
        this.local[k * 2 + 1] = lz;
        k++;
      }
    }
    (this.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aLocal') as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  /** World position of grid vertex (i, j) (tests). */
  vertex(i: number, j: number): Vec3 {
    const k = j * (DECAL_GRID + 1) + i;
    return { x: this.positions[k * 3] ?? 0, y: this.positions[k * 3 + 1] ?? 0, z: this.positions[k * 3 + 2] ?? 0 };
  }
}

interface DecalSlot {
  key: string | null;
  grid: GroundGrid;
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  pos: Vec3;
  color: number;
}

type U = { value: number };

export class TelegraphDecals {
  readonly object = new THREE.Group();
  private readonly slots: DecalSlot[] = [];
  private readonly ground: GroundAt;
  private readonly edge = new THREE.Color();
  private readonly fill = new THREE.Color();

  constructor(ground: GroundAt, pool = DECAL_POOL) {
    this.ground = ground;
    this.object.name = 'vfxTelegraphs';
    for (let i = 0; i < pool; i++) this.addSlot();
  }

  /** Decal meshes built (pool size, grows past 12 rather than drop a Telegraph). */
  get poolSize(): number {
    return this.slots.length;
  }

  /** Decals showing now. */
  get active(): number {
    return this.slots.filter((s) => s.key !== null).length;
  }

  /** Mesh of the decal keyed `key` (tests). */
  meshOf(key: string): THREE.Mesh | null {
    return this.slots.find((s) => s.key === key)?.mesh ?? null;
  }

  /** Grid vertex (i, j) of the decal keyed `key` (tests). */
  vertexOf(key: string, i: number, j: number): Vec3 | null {
    return this.slots.find((s) => s.key === key)?.grid.vertex(i, j) ?? null;
  }

  /** Centres and outline colours of the Telegraphs showing (Camera_System off-screen arrows, Req 21.5). */
  activeTelegraphs(): { pos: Vec3; color: number }[] {
    return this.slots.filter((s) => s.key !== null).map((s) => ({ pos: { ...s.pos }, color: s.color }));
  }

  /** Shows exactly `list` this frame; `time` (real s) moves the stripes. */
  sync(list: readonly TelegraphInput[], time: number): void {
    const wanted = new Map<string, { t: TelegraphInput; p: DecalParams }>();
    for (const t of list) {
      const p = decalParams(t);
      if (p !== null) wanted.set(t.key, { t, p });
    }
    for (const s of this.slots) {
      if (s.key !== null && !wanted.has(s.key)) {
        s.key = null;
        s.mesh.visible = false;
      }
    }
    for (const [key, { t, p }] of wanted) {
      let slot = this.slots.find((s) => s.key === key);
      if (slot === undefined) {
        slot = this.slots.find((s) => s.key === null) ?? this.addSlot();
        slot.key = key;
      }
      this.draw(slot, t, p, time);
    }
  }

  clear(): void {
    this.sync([], 0);
  }

  dispose(): void {
    for (const s of this.slots) {
      s.grid.geometry.dispose();
      s.material.dispose();
    }
    this.object.clear();
  }

  private addSlot(): DecalSlot {
    const grid = new GroundGrid();
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uShape: { value: 0 }, uRadius: { value: 1 }, uInner: { value: 0 }, uHalf: { value: Math.PI }, uLength: { value: 0 },
        uWidth: { value: 1 }, uProgress: { value: 0 }, uOutline: { value: OUTLINE.normal }, uTime: { value: 0 }, uOpacity: { value: 1 },
        uEdge: { value: new THREE.Color() }, uFill: { value: new THREE.Color() },
      },
      vertexShader: TELEGRAPH_VERT, fragmentShader: TELEGRAPH_FRAG, transparent: true, depthWrite: false, depthTest: true,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: DECAL_POLYGON_OFFSET.factor,
      polygonOffsetUnits: DECAL_POLYGON_OFFSET.units,
    });
    const mesh = new THREE.Mesh(grid.geometry, material);
    mesh.renderOrder = DECAL_RENDER_ORDER;
    mesh.visible = false;
    mesh.name = 'telegraphDecal';
    this.object.add(mesh);
    const slot: DecalSlot = { key: null, grid, mesh, material, pos: { x: 0, y: 0, z: 0 }, color: 0 };
    this.slots.push(slot);
    return slot;
  }

  private draw(slot: DecalSlot, t: TelegraphInput, p: DecalParams, time: number): void {
    slot.grid.lay(t.center, t.yaw, p.bounds, t.flat, this.ground);
    const u = slot.material.uniforms;
    (u.uShape as U).value = p.shape;
    (u.uRadius as U).value = p.radius;
    (u.uInner as U).value = p.inner;
    (u.uHalf as U).value = p.half;
    (u.uLength as U).value = p.length;
    (u.uWidth as U).value = p.width;
    (u.uProgress as U).value = p.progress;
    (u.uOutline as U).value = p.outline;
    (u.uTime as U).value = time;
    ((u.uEdge as { value: THREE.Color }).value).copy(this.edge.setHex(p.edge));
    ((u.uFill as { value: THREE.Color }).value).copy(this.fill.setHex(p.fill));
    slot.pos = { x: t.center.x, y: t.center.y, z: t.center.z };
    slot.color = p.edge;
    slot.mesh.visible = true;
  }
}

export type PuddleKind = 'lava' | 'mud';

interface PuddleSlot {
  key: string | null;
  grid: GroundGrid;
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  serial: number;
}

/** Lava and mud puddles (pool of 3, the oldest reused), drawn below the Telegraphs. */
export class PuddleDecals {
  readonly object = new THREE.Group();
  private readonly slots: PuddleSlot[] = [];
  private readonly ground: GroundAt;
  private serial = 0;

  constructor(ground: GroundAt) {
    this.ground = ground;
    this.object.name = 'vfxPuddles';
    for (let i = 0; i < PUDDLE_POOL; i++) {
      const grid = new GroundGrid();
      const material = new THREE.ShaderMaterial({
        uniforms: { uRadius: { value: 1 }, uKind: { value: 0 }, uTime: { value: 0 }, uOpacity: { value: 1 } },
        vertexShader: TELEGRAPH_VERT, fragmentShader: PUDDLE_FRAG, transparent: true, depthWrite: false, depthTest: true,
        side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
      });
      const mesh = new THREE.Mesh(grid.geometry, material);
      mesh.renderOrder = PUDDLE_RENDER_ORDER;
      mesh.visible = false;
      this.object.add(mesh);
      this.slots.push({ key: null, grid, mesh, material, serial: 0 });
    }
  }

  get active(): number {
    return this.slots.filter((s) => s.key !== null).length;
  }

  /**
   * Shows exactly `list` (key, kind, centre, radius, opacity 0..1); the oldest keys win the pool when there are more
   * than three.
   */
  sync(list: readonly { key: string; kind: PuddleKind; center: Readonly<Vec3>; radius: number; opacity: number }[], time: number): void {
    const shown = list.slice(0, PUDDLE_POOL);
    const keys = new Set(shown.map((p) => p.key));
    for (const s of this.slots) {
      if (s.key !== null && !keys.has(s.key)) {
        s.key = null;
        s.mesh.visible = false;
      }
    }
    for (const p of shown) {
      let slot = this.slots.find((s) => s.key === p.key);
      if (slot === undefined) {
        slot = this.slots.find((s) => s.key === null) ?? this.slots.reduce((a, b) => (b.serial < a.serial ? b : a));
        slot.key = p.key;
        slot.serial = ++this.serial;
      }
      const r = Math.max(0.1, p.radius);
      slot.grid.lay(p.center, 0, { x0: -r, x1: r, z0: -r, z1: r }, false, this.ground);
      const u = slot.material.uniforms;
      (u.uRadius as U).value = r;
      (u.uKind as U).value = p.kind === 'lava' ? 0 : 1;
      (u.uTime as U).value = time;
      (u.uOpacity as U).value = clamp01(p.opacity);
      slot.mesh.visible = true;
    }
  }

  dispose(): void {
    for (const s of this.slots) {
      s.grid.geometry.dispose();
      s.material.dispose();
    }
    this.object.clear();
  }
}
