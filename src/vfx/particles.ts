// GPU particle buffer (design "VFX 시스템" 파티클 buffer, 정점·시계; Req 38.2, 38.6). Every particle lives in one
// `Points` object (frustumCulled off) whose buffer holds PARTICLE_BASE_CAPACITY × the preset's particleScale points
// (low 2,000 / medium 4,000 / high 6,000), split by `addGroup` into an additive range (60 %: fire, light, sparks) and
// an alpha range (40 %: smoke, dust, droplets) drawn with two materials, so two draw calls; neither writes depth.
//
// A point stores its axis point, start offset, initial velocity, birth time, life, start / end size, colour and
// opacity, atlas cell, swirl rate, gravity and drag. The vertex shader computes the path (drag, gravity, a turn about
// the vertical axis through the axis point) from `uTime`, the real-time clock the VfxSystem advances (it stops only
// while paused, so Hit_Stop frames keep spreading debris); points outside their life get size 0. The CPU writes each
// new point into its range's ring (the oldest slot first) and uploads only the written span with addUpdateRange.

import * as THREE from 'three';
import { spriteIndex, type BurstSpec } from './catalog';
import { createAtlasTexture, ATLAS_CELL, ATLAS_PADDING, ATLAS_SIZE } from './atlas';
import type { Vec3 } from '../core/types';

export const PARTICLE_BASE_CAPACITY = 4000;
export const ADDITIVE_SHARE = 0.6;

export type ParticleBlend = 'add' | 'alpha';

export interface ParticleCapacity {
  readonly total: number;
  readonly add: number;
  readonly alpha: number;
}

/** Buffer size for a preset's particleScale (medium 1 → 4,000; low 0.5 → 2,000; high 1.5 → 6,000). */
export function particleCapacity(particleScale: number): ParticleCapacity {
  const scale = Number.isFinite(particleScale) && particleScale > 0 ? particleScale : 1;
  const total = Math.max(10, Math.round(PARTICLE_BASE_CAPACITY * scale));
  const add = Math.round(total * ADDITIVE_SHARE);
  return { total, add, alpha: total - add };
}

/** Particles a burst of `count` emits at `particleScale`: scaled, at least 1; `essential` bursts are never scaled. */
export function scaledCount(count: number, particleScale: number, essential = false): number {
  if (!(count > 0)) return 0;
  if (essential) return Math.round(count);
  const scale = Number.isFinite(particleScale) && particleScale > 0 ? particleScale : 1;
  return Math.max(1, Math.round(count * scale));
}

/** One point to write (reused scratch; every field is copied). */
export interface ParticleSeed {
  center: Vec3;
  offset: Vec3;
  vel: Vec3;
  birth: number;
  life: number;
  size0: number;
  size1: number;
  color: number;
  alpha: number;
  cell: number;
  swirl: number;
  gravity: number;
  drag: number;
}

const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uPointScale;
uniform float uMaxPointSize;
attribute vec3 aOffset;
attribute vec3 aVelocity;
attribute vec4 aTime;   // birth, life, size0, size1
attribute vec4 aColor;  // rgb, alpha
attribute vec4 aParams; // cell, swirl, gravity, drag
varying vec4 vColor;
varying float vCell;
void main() {
  float age = uTime - aTime.x;
  if (aTime.y <= 0.0 || age < 0.0 || age > aTime.y) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec4(0.0);
    vCell = 0.0;
    return;
  }
  float k = age / aTime.y;
  float drag = aParams.w;
  float travel = drag > 0.0 ? (1.0 - exp(-drag * age)) / drag : age;
  vec3 rel = aOffset + aVelocity * travel;
  float a = aParams.y * age;
  float c = cos(a);
  float s = sin(a);
  rel.xz = vec2(c * rel.x - s * rel.z, s * rel.x + c * rel.z);
  vec3 p = position + rel;
  p.y -= 0.5 * aParams.z * age * age;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = mix(aTime.z, aTime.w, k);
  gl_PointSize = min(size * uPointScale / max(0.05, -mv.z), uMaxPointSize);
  float fade = k < 0.12 ? k / 0.12 : 1.0 - (k - 0.12) / 0.88;
  vColor = vec4(aColor.rgb, aColor.a * fade);
  vCell = aParams.x;
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uAtlas;
varying vec4 vColor;
varying float vCell;
void main() {
  float cell = floor(vCell + 0.5);
  float col = mod(cell, 3.0);
  float row = floor(cell / 3.0);
  vec2 px = vec2(col * ${ATLAS_CELL.toFixed(1)} + ${ATLAS_PADDING.toFixed(1)} + gl_PointCoord.x * ${(ATLAS_CELL - 2 * ATLAS_PADDING).toFixed(1)},
                 row * ${ATLAS_CELL.toFixed(1)} + ${ATLAS_PADDING.toFixed(1)} + gl_PointCoord.y * ${(ATLAS_CELL - 2 * ATLAS_PADDING).toFixed(1)});
  vec2 uv = vec2(px.x / ${ATLAS_SIZE.toFixed(1)}, 1.0 - px.y / ${ATLAS_SIZE.toFixed(1)});
  vec4 tex = texture2D(uAtlas, uv);
  float alpha = tex.a * vColor.a;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * tex.rgb, alpha);
  #include <colorspace_fragment>
}`;

interface Range {
  readonly start: number;
  readonly size: number;
  cursor: number;
  /** Points written since the last flush (capped at size: the whole range). */
  written: number;
  /** Cursor at the first write since the last flush. */
  from: number;
}

/** A small deterministic generator (xorshift32) so bursts replay the same in tests. */
export class FxRandom {
  private s: number;
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 0x100000000;
  }
  range(r: readonly [number, number]): number {
    return r[0] + (r[1] - r[0]) * this.next();
  }
}

const UP: Readonly<Vec3> = { x: 0, y: 1, z: 0 };

export class ParticleBuffer {
  readonly points: THREE.Points;
  readonly capacity: ParticleCapacity;
  readonly materials: readonly [THREE.ShaderMaterial, THREE.ShaderMaterial];
  private readonly geometry: THREE.BufferGeometry;
  private readonly attrs: THREE.BufferAttribute[];
  private readonly center: Float32Array;
  private readonly offset: Float32Array;
  private readonly velocity: Float32Array;
  private readonly time: Float32Array;
  private readonly color: Float32Array;
  private readonly params: Float32Array;
  private readonly ranges: Record<ParticleBlend, Range>;
  private readonly tint = new THREE.Color();
  private readonly rng: FxRandom;
  private readonly seed: ParticleSeed = {
    center: { x: 0, y: 0, z: 0 }, offset: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, birth: 0, life: 0,
    size0: 0, size1: 0, color: 0xffffff, alpha: 1, cell: 0, swirl: 0, gravity: 0, drag: 0,
  };
  private emitted = 0;
  private readonly ownsAtlas: boolean;

  /** `atlas` is shared; omitted, a fresh one is drawn (and disposed with the buffer). */
  constructor(particleScale: number, atlas?: THREE.Texture, rng = new FxRandom()) {
    this.capacity = particleCapacity(particleScale);
    this.rng = rng;
    const n = this.capacity.total;
    this.center = new Float32Array(n * 3);
    this.offset = new Float32Array(n * 3);
    this.velocity = new Float32Array(n * 3);
    this.time = new Float32Array(n * 4);
    this.color = new Float32Array(n * 4);
    this.params = new Float32Array(n * 4);
    this.geometry = new THREE.BufferGeometry();
    const attr = (array: Float32Array, size: number): THREE.BufferAttribute => {
      const a = new THREE.BufferAttribute(array, size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.attrs = [
      attr(this.center, 3), attr(this.offset, 3), attr(this.velocity, 3), attr(this.time, 4), attr(this.color, 4), attr(this.params, 4),
    ];
    const names = ['position', 'aOffset', 'aVelocity', 'aTime', 'aColor', 'aParams'];
    names.forEach((name, i) => this.geometry.setAttribute(name, this.attrs[i] as THREE.BufferAttribute));
    this.geometry.addGroup(0, this.capacity.add, 0);
    this.geometry.addGroup(this.capacity.add, this.capacity.alpha, 1);
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Number.POSITIVE_INFINITY);
    const texture = atlas ?? createAtlasTexture();
    this.ownsAtlas = atlas === undefined;
    const uniforms = {
      uTime: { value: 0 },
      uPointScale: { value: 600 },
      uMaxPointSize: { value: 256 },
      uAtlas: { value: texture },
    };
    const make = (blending: THREE.Blending): THREE.ShaderMaterial =>
      new THREE.ShaderMaterial({
        uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, depthTest: true, blending,
      });
    this.materials = [make(THREE.AdditiveBlending), make(THREE.NormalBlending)];
    this.points = new THREE.Points(this.geometry, [...this.materials]);
    this.points.frustumCulled = false;
    this.points.name = 'vfxParticles';
    this.points.renderOrder = 12;
    this.ranges = {
      add: { start: 0, size: this.capacity.add, cursor: 0, written: 0, from: 0 },
      alpha: { start: this.capacity.add, size: this.capacity.alpha, cursor: 0, written: 0, from: 0 },
    };
  }

  /** Points written since construction (tests). */
  get totalEmitted(): number {
    return this.emitted;
  }

  /** The real-time clock the shader reads (s). */
  get now(): number {
    return (this.materials[0].uniforms.uTime as { value: number }).value;
  }

  setTime(seconds: number): void {
    (this.materials[0].uniforms.uTime as { value: number }).value = seconds;
  }

  /** Pixel scale of a 1 m point at 1 m: viewport height / (2 tan(fov / 2)); clamp to the GPU's point size limit. */
  setPointScale(viewportHeight: number, fovDeg: number, maxPointSize = 256): void {
    const u = this.materials[0].uniforms;
    (u.uPointScale as { value: number }).value = viewportHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
    (u.uMaxPointSize as { value: number }).value = maxPointSize;
  }

  /** Slot index the next `blend` point goes to (tests). */
  nextSlot(blend: ParticleBlend): number {
    const r = this.ranges[blend];
    return r.start + r.cursor;
  }

  /** Birth time stored in `slot` (tests). */
  birthAt(slot: number): number {
    return this.time[slot * 4] ?? Number.NaN;
  }

  /** Writes one point into the oldest slot of its range. */
  write(blend: ParticleBlend, p: Readonly<ParticleSeed>): number {
    const r = this.ranges[blend];
    if (r.size <= 0) return -1;
    if (r.written === 0) r.from = r.cursor;
    const slot = r.start + r.cursor;
    r.cursor = (r.cursor + 1) % r.size;
    r.written = Math.min(r.size, r.written + 1);
    const i3 = slot * 3;
    const i4 = slot * 4;
    this.center[i3] = p.center.x;
    this.center[i3 + 1] = p.center.y;
    this.center[i3 + 2] = p.center.z;
    this.offset[i3] = p.offset.x;
    this.offset[i3 + 1] = p.offset.y;
    this.offset[i3 + 2] = p.offset.z;
    this.velocity[i3] = p.vel.x;
    this.velocity[i3 + 1] = p.vel.y;
    this.velocity[i3 + 2] = p.vel.z;
    this.time[i4] = p.birth;
    this.time[i4 + 1] = p.life;
    this.time[i4 + 2] = p.size0;
    this.time[i4 + 3] = p.size1;
    this.tint.setHex(p.color);
    this.color[i4] = this.tint.r;
    this.color[i4 + 1] = this.tint.g;
    this.color[i4 + 2] = this.tint.b;
    this.color[i4 + 3] = p.alpha;
    this.params[i4] = p.cell;
    this.params[i4 + 1] = p.swirl;
    this.params[i4 + 2] = p.gravity;
    this.params[i4 + 3] = p.drag;
    this.emitted++;
    return slot;
  }

  /**
   * Emits `count` points of `spec` at `at` (count already scaled by the caller), along `dir` for cone bursts.
   * Returns the points written.
   */
  burst(spec: Readonly<BurstSpec>, count: number, at: Readonly<Vec3>, dir: Readonly<Vec3> = UP): number {
    const rng = this.rng;
    const p = this.seed;
    const now = this.now;
    p.center.x = at.x;
    p.center.y = at.y;
    p.center.z = at.z;
    p.cell = spriteIndex(spec.sprite);
    p.color = spec.color;
    p.alpha = spec.alpha ?? 1;
    p.swirl = spec.swirl ?? 0;
    p.gravity = spec.gravity ?? 0;
    p.drag = spec.drag ?? 0;
    const radius = spec.radius ?? 0;
    const layout = spec.layout ?? 'ball';
    const lift = spec.lift ?? 0;
    const shrink = spec.shrink ?? 0.4;
    const cone = spec.cone === undefined ? null : (spec.cone * Math.PI) / 180;
    // Cone basis around dir.
    const d = normalized(dir);
    const t1 = Math.abs(d.y) < 0.95 ? cross(d, UP) : cross(d, { x: 1, y: 0, z: 0 });
    const t2 = cross(d, t1);
    let n = 0;
    for (let i = 0; i < count; i++) {
      layoutPoint(layout, radius, spec.height ?? 1, i, count, rng, p.offset);
      const speed = rng.range(spec.speed);
      if (cone !== null) {
        const cosA = 1 - rng.next() * (1 - Math.cos(cone));
        const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
        const phi = rng.next() * Math.PI * 2;
        const cx = Math.cos(phi) * sinA;
        const cy = Math.sin(phi) * sinA;
        p.vel.x = (d.x * cosA + t1.x * cx + t2.x * cy) * speed;
        p.vel.y = (d.y * cosA + t1.y * cx + t2.y * cy) * speed + lift;
        p.vel.z = (d.z * cosA + t1.z * cx + t2.z * cy) * speed;
      } else {
        const o = p.offset;
        const len = Math.hypot(o.x, layout === 'column' ? 0 : o.y, o.z);
        if (len > 1e-6) {
          p.vel.x = (o.x / len) * speed;
          p.vel.y = (layout === 'column' ? 0 : o.y / len) * speed + lift;
          p.vel.z = (o.z / len) * speed;
        } else {
          randomDir(rng, p.vel);
          p.vel.x *= speed;
          p.vel.y = Math.abs(p.vel.y) * speed + lift;
          p.vel.z *= speed;
        }
      }
      p.birth = now + (spec.delay === undefined ? 0 : rng.range(spec.delay));
      p.life = rng.range(spec.life);
      p.size0 = rng.range(spec.size);
      p.size1 = p.size0 * shrink;
      if (this.write(spec.blend, p) >= 0) n++;
    }
    return n;
  }

  /** Uploads the ranges written since the last flush. */
  flush(): void {
    let any = false;
    for (const r of [this.ranges.add, this.ranges.alpha]) if (r.written > 0) any = true;
    if (!any) return;
    this.attrs.forEach((a) => a.clearUpdateRanges());
    for (const r of [this.ranges.add, this.ranges.alpha]) {
      if (r.written === 0) continue;
      const spans: [number, number][] = r.written >= r.size
        ? [[r.start, r.size]]
        : r.from + r.written <= r.size
          ? [[r.start + r.from, r.written]]
          : [[r.start + r.from, r.size - r.from], [r.start, r.from + r.written - r.size]];
      for (const [start, count] of spans) {
        for (const a of this.attrs) a.addUpdateRange(start * a.itemSize, count * a.itemSize);
      }
      r.written = 0;
    }
    for (const a of this.attrs) a.needsUpdate = true;
  }

  /** Update ranges queued on `position` (tests). */
  pendingRanges(): readonly { start: number; count: number }[] {
    return (this.attrs[0] as THREE.BufferAttribute).updateRanges;
  }

  /** Every point dies at once (session reset). */
  clear(): void {
    this.time.fill(0);
    for (const r of [this.ranges.add, this.ranges.alpha]) {
      r.cursor = 0;
      r.written = r.size;
      r.from = 0;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    for (const m of this.materials) m.dispose();
    if (this.ownsAtlas) (this.materials[0].uniforms.uAtlas as { value: THREE.Texture }).value.dispose();
  }
}

function normalized(v: Readonly<Vec3>): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z);
  return l > 1e-9 ? { x: v.x / l, y: v.y / l, z: v.z / l } : { x: 0, y: 1, z: 0 };
}

function cross(a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  return normalized({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
}

function randomDir(rng: FxRandom, out: Vec3): void {
  const z = rng.next() * 2 - 1;
  const phi = rng.next() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  out.x = Math.cos(phi) * r;
  out.y = z;
  out.z = Math.sin(phi) * r;
}

/** Start offset of point `i` of `count` for a layout (y up). */
function layoutPoint(layout: string, radius: number, height: number, i: number, count: number, rng: FxRandom, out: Vec3): void {
  const a = ((i + rng.next() * 0.5) / Math.max(1, count)) * Math.PI * 2;
  switch (layout) {
    case 'ring':
      out.x = Math.sin(a) * radius;
      out.y = 0;
      out.z = Math.cos(a) * radius;
      return;
    case 'disc': {
      const r = Math.sqrt(rng.next()) * radius;
      out.x = Math.sin(a) * r;
      out.y = 0;
      out.z = Math.cos(a) * r;
      return;
    }
    case 'hex': {
      // A point on the hexagon outline of circumradius `radius`.
      const side = Math.floor(rng.next() * 6);
      const t = rng.next();
      const a0 = (side * Math.PI) / 3;
      const a1 = ((side + 1) * Math.PI) / 3;
      out.x = (Math.sin(a0) * (1 - t) + Math.sin(a1) * t) * radius;
      out.y = 0;
      out.z = (Math.cos(a0) * (1 - t) + Math.cos(a1) * t) * radius;
      return;
    }
    case 'column':
      out.x = Math.sin(a) * radius;
      out.y = rng.next() * height;
      out.z = Math.cos(a) * radius;
      return;
    default: {
      randomDir(rng, out);
      const r = Math.cbrt(rng.next()) * radius;
      out.x *= r;
      out.y *= r;
      out.z *= r;
    }
  }
}
