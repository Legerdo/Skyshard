// Weapon trails (design "VFX 시스템" 무기 궤적). During a melee clip's hit window the Animation_System hands in the
// weapon tip and base world positions every frame (`WeaponTrails.sample`) with the real-time clock; the last
// TRAIL_WINDOW (0.15 s) is resampled by time with Catmull-Rom into TRAIL_SEGMENTS (12) segments of a ribbon mesh
// (pool of 2), so the trail has the same length at any frame rate. Colour runs from white at the tip to the
// character's Element colour at the base; older segments are more transparent. A released trail fades out as its
// last samples age past the window.

import * as THREE from 'three';
import type { Vec3 } from '../core/types';
import type { ElementId } from '../data/ids';
import { ELEMENT_COLORS } from './catalog';
import { VFX_RENDER_ORDER } from './meshFx';

export const TRAIL_WINDOW = 0.15;
export const TRAIL_SEGMENTS = 12;
export const TRAIL_POOL = 2;
/** Samples kept per trail (≥ 0.15 s at 144 fps plus slack). */
const MAX_SAMPLES = 32;

export interface TrailSample {
  t: number;
  tip: Vec3;
  base: Vec3;
}

/** Catmull-Rom point between p1 and p2 at u ∈ [0, 1] (uniform parameterisation). */
export function catmullRom(p0: Readonly<Vec3>, p1: Readonly<Vec3>, p2: Readonly<Vec3>, p3: Readonly<Vec3>, u: number, out: Vec3): Vec3 {
  const u2 = u * u;
  const u3 = u2 * u;
  const f = (a: number, b: number, c: number, d: number): number =>
    0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
  out.x = f(p0.x, p1.x, p2.x, p3.x);
  out.y = f(p0.y, p1.y, p2.y, p3.y);
  out.z = f(p0.z, p1.z, p2.z, p3.z);
  return out;
}

export interface ResampledTrail {
  /** segments + 1 points each, index 0 the newest. */
  tip: Vec3[];
  base: Vec3[];
  /** Age of each point as a fraction of the window (0 newest, 1 oldest). */
  age: number[];
}

/**
 * Resamples `samples` (ascending time) at `segments + 1` evenly spaced times from `now` back `window` s, each clamped
 * to the recorded span; null with fewer than two samples or when the newest is older than the window.
 */
export function resampleTrail(
  samples: readonly TrailSample[], now: number, window = TRAIL_WINDOW, segments = TRAIL_SEGMENTS,
): ResampledTrail | null {
  const n = samples.length;
  if (n < 2) return null;
  const first = samples[0] as TrailSample;
  const last = samples[n - 1] as TrailSample;
  if (now - last.t > window) return null;
  const out: ResampledTrail = { tip: [], base: [], age: [] };
  let seg = n - 2;
  for (let j = 0; j <= segments; j++) {
    const tj = Math.min(last.t, Math.max(first.t, now - (window * j) / segments));
    while (seg > 0 && (samples[seg] as TrailSample).t > tj) seg--;
    const a = samples[seg] as TrailSample;
    const b = samples[seg + 1] as TrailSample;
    const p0 = samples[Math.max(0, seg - 1)] as TrailSample;
    const p3 = samples[Math.min(n - 1, seg + 2)] as TrailSample;
    const span = b.t - a.t;
    const u = span > 1e-9 ? Math.min(1, Math.max(0, (tj - a.t) / span)) : 0;
    out.tip.push(catmullRom(p0.tip, a.tip, b.tip, p3.tip, u, { x: 0, y: 0, z: 0 }));
    out.base.push(catmullRom(p0.base, a.base, b.base, p3.base, u, { x: 0, y: 0, z: 0 }));
    out.age.push(j / segments);
  }
  return out;
}

const VERT = /* glsl */ `
attribute vec4 aColor;
varying vec4 vColor;
void main() {
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAG = /* glsl */ `
varying vec4 vColor;
void main() {
  gl_FragColor = vColor;
  #include <colorspace_fragment>
}`;

interface Ribbon {
  key: string | null;
  samples: TrailSample[];
  color: THREE.Color;
  live: boolean;
  serial: number;
  mesh: THREE.Mesh;
  positions: Float32Array;
  colors: Float32Array;
}

export class WeaponTrails {
  readonly object = new THREE.Group();
  private readonly ribbons: Ribbon[] = [];
  private readonly material: THREE.ShaderMaterial;
  private readonly white = new THREE.Color(0xffffff);
  private readonly mix = new THREE.Color();
  private serial = 0;

  constructor() {
    this.object.name = 'vfxTrails';
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const verts = (TRAIL_SEGMENTS + 1) * 2;
    const index: number[] = [];
    for (let j = 0; j < TRAIL_SEGMENTS; j++) {
      const a = j * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    for (let i = 0; i < TRAIL_POOL; i++) {
      const geometry = new THREE.BufferGeometry();
      const positions = new Float32Array(verts * 3);
      const colors = new Float32Array(verts * 4);
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 4).setUsage(THREE.DynamicDrawUsage));
      geometry.setIndex(index);
      const mesh = new THREE.Mesh(geometry, this.material);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = VFX_RENDER_ORDER + 1;
      this.object.add(mesh);
      this.ribbons.push({ key: null, samples: [], color: new THREE.Color(), live: false, serial: 0, mesh, positions, colors });
    }
  }

  /** Trails drawing now (tests). */
  get active(): number {
    return this.ribbons.filter((r) => r.mesh.visible).length;
  }

  /**
   * One frame of the weapon `key` (e.g. the character id): tip and base world positions at real time `now`, in the
   * Element colour (null: white). A new key takes a free ribbon, else the oldest.
   */
  sample(key: string, tip: Readonly<Vec3>, base: Readonly<Vec3>, element: ElementId | null, now: number): void {
    let r = this.ribbons.find((x) => x.key === key && x.live);
    if (r === undefined) {
      r = this.ribbons.find((x) => x.key === null) ?? this.ribbons.reduce((a, b) => (b.serial < a.serial ? b : a));
      r.key = key;
      r.samples.length = 0;
      r.live = true;
      r.serial = ++this.serial;
    }
    r.color.setHex(element === null ? 0xffffff : ELEMENT_COLORS[element]);
    const last = r.samples[r.samples.length - 1];
    if (last !== undefined && now <= last.t) {
      last.tip = { x: tip.x, y: tip.y, z: tip.z };
      last.base = { x: base.x, y: base.y, z: base.z };
      return;
    }
    r.samples.push({ t: now, tip: { x: tip.x, y: tip.y, z: tip.z }, base: { x: base.x, y: base.y, z: base.z } });
    if (r.samples.length > MAX_SAMPLES) r.samples.shift();
  }

  /** The hit window of `key` closed: its ribbon fades out as the samples age. */
  end(key: string): void {
    for (const r of this.ribbons) if (r.key === key) r.live = false;
  }

  /** Rebuilds every ribbon for real time `now`. */
  update(now: number): void {
    for (const r of this.ribbons) {
      while (r.samples.length > 2 && now - (r.samples[1] as TrailSample).t > TRAIL_WINDOW) r.samples.shift();
      const trail = r.key === null ? null : resampleTrail(r.samples, now);
      if (trail === null) {
        r.mesh.visible = false;
        if (!r.live) {
          r.key = null;
          r.samples.length = 0;
        }
        continue;
      }
      const newest = (r.samples[r.samples.length - 1] as TrailSample).t;
      const fade = r.live ? 1 : Math.max(0, 1 - (now - newest) / TRAIL_WINDOW);
      for (let j = 0; j <= TRAIL_SEGMENTS; j++) {
        const tip = trail.tip[j] as Vec3;
        const base = trail.base[j] as Vec3;
        const a = (1 - (trail.age[j] as number)) * fade;
        const i = j * 2;
        r.positions.set([tip.x, tip.y, tip.z, base.x, base.y, base.z], i * 3);
        this.mix.copy(this.white).lerp(r.color, 0.25);
        r.colors.set([this.mix.r, this.mix.g, this.mix.b, a * 0.9, r.color.r, r.color.g, r.color.b, a * 0.35], i * 4);
      }
      const g = r.mesh.geometry;
      (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (g.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
      r.mesh.visible = true;
    }
  }

  dispose(): void {
    for (const r of this.ribbons) r.mesh.geometry.dispose();
    this.material.dispose();
    this.object.clear();
  }
}
