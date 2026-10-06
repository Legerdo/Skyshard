// Mesh effects (design "VFX 시스템" Mesh 효과): small boot-time pools of shock rings (RingGeometry ×5), explosion
// spheres (IcosahedronGeometry ×3, stepped toon shading plus a rim), crystal shards and mud vines (InstancedMesh with
// 96 and 24 instances) and light beams / pillars (open cylinders ×8). Rings, spheres and beams only change their
// transform and `uProgress`; shards and vines only their instance matrices. A full pool takes back its oldest
// effect. Everything runs on real seconds and writes no depth.

import * as THREE from 'three';
import type { Vec3 } from '../core/types';
import { FxRandom } from './particles';

export const RING_POOL = 5;
export const SPHERE_POOL = 3;
export const SHARD_INSTANCES = 96;
export const VINE_INSTANCES = 24;
export const BEAM_POOL = 8;

/** Combat mesh effects draw at this order; Telegraph decals above them. */
export const VFX_RENDER_ORDER = 12;

interface Timed {
  active: boolean;
  t: number;
  life: number;
  delay: number;
  serial: number;
}

/** Index of a free slot, else of the oldest active one. */
export function claimSlot(slots: readonly Timed[]): number {
  let oldest = 0;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i] as Timed;
    if (!s.active) return i;
    if (s.serial < (slots[oldest] as Timed).serial) oldest = i;
  }
  return oldest;
}

interface MeshSlot extends Timed {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  radius: number;
}

interface InstanceSlot extends Timed {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  axis: THREE.Vector3;
  spin: number;
  scale: number;
  gravity: number;
}

const RING_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uProgress;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  float fade = pow(1.0 - clamp(uProgress, 0.0, 1.0), 1.5);
  gl_FragColor = vec4(uColor, uOpacity * fade);
  #include <colorspace_fragment>
}`;

const BASIC_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SPHERE_VERT = /* glsl */ `
varying vec3 vNormal;
void main() {
  vNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SPHERE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uProgress;
varying vec3 vNormal;
void main() {
  vec3 n = normalize(vNormal);
  float lambert = dot(n, normalize(vec3(0.3, 0.8, 0.5)));
  float band = lambert > 0.35 ? 1.0 : lambert > -0.2 ? 0.8 : 0.62;
  float rim = pow(1.0 - abs(n.z), 2.5);
  float fade = pow(1.0 - clamp(uProgress, 0.0, 1.0), 2.0);
  gl_FragColor = vec4(uColor * band + vec3(rim * 0.7), (0.55 + 0.4 * rim) * fade);
  #include <colorspace_fragment>
}`;

const BEAM_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uProgress;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  float p = clamp(uProgress, 0.0, 1.0);
  float grow = smoothstep(0.0, 0.15, p);
  float fade = 1.0 - smoothstep(0.7, 1.0, p);
  float along = pow(1.0 - vUv.y, 0.7);
  float edge = 0.55 + 0.45 * sin(vUv.x * 6.2831 * 3.0 + p * 12.0);
  gl_FragColor = vec4(uColor, uOpacity * grow * fade * along * edge);
  #include <colorspace_fragment>
}`;

const UP = new THREE.Vector3(0, 1, 0);

export class MeshFx {
  readonly object = new THREE.Group();
  private readonly rings: MeshSlot[] = [];
  private readonly spheres: MeshSlot[] = [];
  private readonly beams: MeshSlot[] = [];
  private readonly shardSlots: InstanceSlot[] = [];
  private readonly vineSlots: InstanceSlot[] = [];
  private readonly shardMesh: THREE.InstancedMesh;
  private readonly vineMesh: THREE.InstancedMesh;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly v = new THREE.Vector3();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly tint = new THREE.Color();
  private readonly rng: FxRandom;
  private serial = 0;

  constructor(rng = new FxRandom(0x51ab)) {
    this.rng = rng;
    this.object.name = 'vfxMeshes';
    const ringGeometry = this.track(new THREE.RingGeometry(0.86, 1, 48).rotateX(-Math.PI / 2));
    const sphereGeometry = this.track(new THREE.IcosahedronGeometry(1, 3));
    const beamGeometry = this.track(new THREE.CylinderGeometry(1, 1, 1, 16, 1, true).translate(0, 0.5, 0));
    for (let i = 0; i < RING_POOL; i++) this.rings.push(this.meshSlot(ringGeometry, BASIC_VERT, RING_FRAG, THREE.AdditiveBlending));
    for (let i = 0; i < SPHERE_POOL; i++) this.spheres.push(this.meshSlot(sphereGeometry, SPHERE_VERT, SPHERE_FRAG, THREE.NormalBlending));
    for (let i = 0; i < BEAM_POOL; i++) this.beams.push(this.meshSlot(beamGeometry, BASIC_VERT, BEAM_FRAG, THREE.AdditiveBlending));

    const shardGeometry = this.track(new THREE.OctahedronGeometry(1, 0).scale(0.5, 1, 0.5));
    const shardMaterial = this.track(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
    this.shardMesh = new THREE.InstancedMesh(shardGeometry, shardMaterial, SHARD_INSTANCES);
    const vineGeometry = this.track(vineTube());
    const vineMaterial = this.track(new THREE.MeshLambertMaterial({ color: 0x5a6a2c, emissive: 0x2a2a10 }));
    this.vineMesh = new THREE.InstancedMesh(vineGeometry, vineMaterial, VINE_INSTANCES);
    for (const [mesh, slots, n] of [[this.shardMesh, this.shardSlots, SHARD_INSTANCES], [this.vineMesh, this.vineSlots, VINE_INSTANCES]] as const) {
      mesh.frustumCulled = false;
      mesh.renderOrder = VFX_RENDER_ORDER;
      for (let i = 0; i < n; i++) {
        mesh.setMatrixAt(i, this.hidden);
        mesh.setColorAt(i, this.tint.setHex(0xffffff));
        slots.push({
          active: false, t: 0, life: 0, delay: 0, serial: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
          axis: new THREE.Vector3(0, 1, 0), spin: 0, scale: 1, gravity: 0,
        });
      }
      this.object.add(mesh);
    }
  }

  /** Active effects per pool (tests, F3). */
  counts(): { rings: number; spheres: number; beams: number; shards: number; vines: number } {
    const n = (slots: readonly Timed[]): number => slots.filter((s) => s.active).length;
    return { rings: n(this.rings), spheres: n(this.spheres), beams: n(this.beams), shards: n(this.shardSlots), vines: n(this.vineSlots) };
  }

  /** A flat shock / ripple ring racing out to `radius` m over `seconds`. */
  ring(at: Readonly<Vec3>, radius: number, seconds: number, color: number, opacity = 0.85): void {
    const slot = this.start(this.rings, seconds, 0, radius);
    slot.mesh.position.set(at.x, at.y + 0.05, at.z);
    this.uniform(slot, 'uColor').value.setHex(color);
    this.uniform(slot, 'uOpacity').value = opacity;
    this.drawRing(slot);
  }

  /** An explosion sphere swelling to `radius` m. */
  sphere(at: Readonly<Vec3>, radius: number, seconds: number, color: number): void {
    const slot = this.start(this.spheres, seconds, 0, radius);
    slot.mesh.position.set(at.x, at.y, at.z);
    this.uniform(slot, 'uColor').value.setHex(color);
    this.drawSphere(slot);
  }

  /** A light beam from `from` to `to` (thin cone of light, altar and Skyshard rays), starting after `delay` s. */
  beam(from: Readonly<Vec3>, to: Readonly<Vec3>, radius: number, seconds: number, color: number, delay = 0, opacity = 0.8): void {
    const slot = this.start(this.beams, seconds, delay, radius);
    this.v.set(to.x - from.x, to.y - from.y, to.z - from.z);
    const length = Math.max(0.01, this.v.length());
    slot.mesh.position.set(from.x, from.y, from.z);
    slot.mesh.quaternion.setFromUnitVectors(UP, this.v.normalize());
    slot.mesh.scale.set(radius, length, radius);
    slot.mesh.visible = delay <= 0;
    this.uniform(slot, 'uColor').value.setHex(color);
    this.uniform(slot, 'uOpacity').value = opacity;
    this.uniform(slot, 'uProgress').value = 0;
  }

  /** A vertical light pillar of `height` m standing on `at`. */
  pillar(at: Readonly<Vec3>, radius: number, height: number, seconds: number, color: number): void {
    this.beam(at, { x: at.x, y: at.y + height, z: at.z }, radius, seconds, color, 0, 0.7);
  }

  /** `count` crystal shards flung out of `at` (Element_Shield break, Terra). */
  shards(at: Readonly<Vec3>, count: number, color: number, speed = 5, size = 0.25, life = 0.9): void {
    for (let i = 0; i < count; i++) {
      const s = this.startInstance(this.shardSlots, life * (0.8 + 0.4 * this.rng.next()), 0);
      s.pos.set(at.x, at.y, at.z);
      const a = this.rng.next() * Math.PI * 2;
      const up = 0.3 + this.rng.next() * 0.8;
      s.vel.set(Math.sin(a), up, Math.cos(a)).normalize().multiplyScalar(speed * (0.6 + 0.6 * this.rng.next()));
      this.shardLook(s, size, color);
    }
    this.shardMesh.instanceMatrix.needsUpdate = true;
  }

  /** Shards across a wall from `a` to `b` between `bottomY` and `topY` (Blight_Barrier shattering). */
  shardsAlong(a: Readonly<Vec3>, b: Readonly<Vec3>, bottomY: number, topY: number, count: number, color: number): void {
    const nx = -(b.z - a.z);
    const nz = b.x - a.x;
    const nl = Math.hypot(nx, nz) || 1;
    for (let i = 0; i < count; i++) {
      const s = this.startInstance(this.shardSlots, 1.2 + 0.6 * this.rng.next(), 0);
      const k = this.rng.next();
      s.pos.set(a.x + (b.x - a.x) * k, bottomY + (topY - bottomY) * this.rng.next(), a.z + (b.z - a.z) * k);
      const side = this.rng.next() < 0.5 ? -1 : 1;
      s.vel.set((nx / nl) * side * (1 + 3 * this.rng.next()), 1 + 3 * this.rng.next(), (nz / nl) * side * (1 + 3 * this.rng.next()));
      this.shardLook(s, 0.35 + 0.35 * this.rng.next(), color);
    }
    this.shardMesh.instanceMatrix.needsUpdate = true;
  }

  /** Mud vines coiling around the ankles at `at` for `seconds`. */
  vines(at: Readonly<Vec3>, seconds: number, count = 3): void {
    for (let i = 0; i < count; i++) {
      const s = this.startInstance(this.vineSlots, seconds, 0.05 * i);
      const a = (i / count) * Math.PI * 2 + this.rng.next();
      s.pos.set(at.x + Math.sin(a) * 0.35, at.y, at.z + Math.cos(a) * 0.35);
      s.vel.set(0, 0, 0);
      s.axis.set(0, 1, 0);
      s.spin = a;
      s.scale = 0.8 + 0.4 * this.rng.next();
      s.gravity = 0;
    }
  }

  /** Advances every effect by `dt` real seconds. */
  update(dt: number): void {
    for (const slot of this.rings) if (this.advance(slot, dt)) this.drawRing(slot);
    for (const slot of this.spheres) if (this.advance(slot, dt)) this.drawSphere(slot);
    for (const slot of this.beams) {
      if (!this.advance(slot, dt)) continue;
      slot.mesh.visible = slot.delay <= 0;
      this.uniform(slot, 'uProgress').value = slot.life > 0 ? slot.t / slot.life : 1;
    }
    let shardsDirty = false;
    this.shardSlots.forEach((s, i) => {
      if (!s.active) return;
      shardsDirty = true;
      if (!this.advanceTimed(s, dt)) {
        this.shardMesh.setMatrixAt(i, this.hidden);
        return;
      }
      if (s.delay > 0) return;
      s.vel.y -= s.gravity * dt;
      s.pos.addScaledVector(s.vel, dt);
      const k = s.t / s.life;
      this.q.setFromAxisAngle(s.axis, s.spin * s.t);
      const sc = s.scale * (1 - k * k);
      this.m.compose(s.pos, this.q, this.s.set(sc, sc, sc));
      this.shardMesh.setMatrixAt(i, this.m);
    });
    if (shardsDirty) this.shardMesh.instanceMatrix.needsUpdate = true;
    let vinesDirty = false;
    this.vineSlots.forEach((s, i) => {
      if (!s.active) return;
      vinesDirty = true;
      if (!this.advanceTimed(s, dt)) {
        this.vineMesh.setMatrixAt(i, this.hidden);
        return;
      }
      if (s.delay > 0) {
        this.vineMesh.setMatrixAt(i, this.hidden);
        return;
      }
      const grow = Math.min(1, s.t / 0.3, (s.life - s.t) / 0.3);
      this.q.setFromAxisAngle(UP, s.spin + s.t * 0.4);
      this.m.compose(s.pos, this.q, this.s.set(s.scale, s.scale * Math.max(0.01, grow), s.scale));
      this.vineMesh.setMatrixAt(i, this.m);
    });
    if (vinesDirty) this.vineMesh.instanceMatrix.needsUpdate = true;
  }

  /** Every effect ends at once. */
  clear(): void {
    for (const slot of [...this.rings, ...this.spheres, ...this.beams]) {
      slot.active = false;
      slot.mesh.visible = false;
    }
    for (const [mesh, slots] of [[this.shardMesh, this.shardSlots], [this.vineMesh, this.vineSlots]] as const) {
      slots.forEach((s, i) => {
        s.active = false;
        mesh.setMatrixAt(i, this.hidden);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.shardMesh.dispose();
    this.vineMesh.dispose();
    this.object.clear();
  }

  private track<T extends { dispose(): void }>(d: T): T {
    this.disposables.push(d);
    return d;
  }

  private meshSlot(geometry: THREE.BufferGeometry, vertexShader: string, fragmentShader: string, blending: THREE.Blending): MeshSlot {
    const material = this.track(new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0xffffff) }, uProgress: { value: 0 }, uOpacity: { value: 1 } },
      vertexShader, fragmentShader, transparent: true, depthWrite: false, blending, side: THREE.DoubleSide,
    }));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = VFX_RENDER_ORDER;
    this.object.add(mesh);
    return { mesh, material, active: false, t: 0, life: 0, delay: 0, serial: 0, radius: 1 };
  }

  private uniform<K extends 'uColor' | 'uProgress' | 'uOpacity'>(
    slot: MeshSlot, name: K,
  ): { value: K extends 'uColor' ? THREE.Color : number } {
    return slot.material.uniforms[name] as { value: K extends 'uColor' ? THREE.Color : number };
  }

  private start(slots: MeshSlot[], seconds: number, delay: number, radius: number): MeshSlot {
    const slot = slots[claimSlot(slots)] as MeshSlot;
    slot.active = true;
    slot.t = 0;
    slot.life = Math.max(0.01, seconds);
    slot.delay = Math.max(0, delay);
    slot.serial = ++this.serial;
    slot.radius = radius;
    slot.mesh.visible = slot.delay <= 0;
    return slot;
  }

  private startInstance(slots: InstanceSlot[], seconds: number, delay: number): InstanceSlot {
    const s = slots[claimSlot(slots)] as InstanceSlot;
    s.active = true;
    s.t = 0;
    s.life = Math.max(0.01, seconds);
    s.delay = delay;
    s.serial = ++this.serial;
    return s;
  }

  private shardLook(s: InstanceSlot, size: number, color: number): void {
    s.axis.set(this.rng.next() - 0.5, this.rng.next() - 0.5, this.rng.next() - 0.5).normalize();
    s.spin = 6 + 10 * this.rng.next();
    s.scale = size;
    s.gravity = 12;
    const i = this.shardSlots.indexOf(s);
    this.shardMesh.setColorAt(i, this.tint.setHex(color));
    if (this.shardMesh.instanceColor !== null) this.shardMesh.instanceColor.needsUpdate = true;
  }

  /** Delay, then time; false once the slot ended (and hides its mesh). */
  private advance(slot: MeshSlot, dt: number): boolean {
    if (!slot.active) return false;
    if (!this.advanceTimed(slot, dt)) {
      slot.mesh.visible = false;
      return false;
    }
    return slot.delay <= 0;
  }

  private advanceTimed(s: Timed, dt: number): boolean {
    if (s.delay > 0) {
      s.delay -= dt;
      if (s.delay > 0) return true;
      dt = -s.delay;
      s.delay = 0;
    }
    s.t += dt;
    if (s.t >= s.life) {
      s.active = false;
      return false;
    }
    return true;
  }

  private drawRing(slot: MeshSlot): void {
    const k = Math.min(1, slot.t / slot.life);
    const ease = 1 - (1 - k) * (1 - k);
    slot.mesh.scale.setScalar(Math.max(0.05, slot.radius * ease));
    this.uniform(slot, 'uProgress').value = k;
  }

  private drawSphere(slot: MeshSlot): void {
    const k = Math.min(1, slot.t / slot.life);
    slot.mesh.scale.setScalar(slot.radius * (0.25 + 0.75 * Math.sqrt(k)));
    this.uniform(slot, 'uProgress').value = k;
  }
}

/** A thin coil 0.9 m tall around a 0.3 m radius (one vine instance before scaling). */
function vineTube(): THREE.BufferGeometry {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const a = t * Math.PI * 3;
    const r = 0.3 * (1 - 0.4 * t);
    points.push(new THREE.Vector3(Math.sin(a) * r, t * 0.9, Math.cos(a) * r));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 32, 0.045, 5, false);
}
