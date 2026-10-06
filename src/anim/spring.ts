/*
 * Spring bones (design.md "절차적 레이어" spring bone): hair, scarf, ponytail and cape chains of 4–8 joints moved by a
 * 60 Hz fixed-substep verlet integration (gravity, damping 0.1). The damping is air drag toward the wind velocity
 * (global breeze + Wind_Zone), so chains stream back while sprinting / gliding and downwind inside a Wind_Zone. Each
 * substep: integrate → segment-length constraint twice → push out of the collision spheres (head, chest, hips, upper
 * legs) → the bones turn so each points at the next point. A switch, teleport or respawn resets the chain to rest so
 * it never whips (reset() / a jump of the anchor over TELEPORT_DISTANCE).
 */
import * as THREE from 'three';

export const SPRING_HZ = 60;
const STEP = 1 / SPRING_HZ;
/** At most this many substeps per update (a long frame drops time rather than spiralling). */
const MAX_SUBSTEPS = 4;
const DAMPING = 0.1;
const GRAVITY = 9.81;
/** An anchor jump longer than this (m) in one update counts as a teleport: reset. */
export const TELEPORT_DISTANCE = 3;

export interface SpringCollider {
  readonly bone: THREE.Object3D;
  /** Sphere centre in the bone's space. */
  readonly offset: THREE.Vector3;
  readonly radius: number;
}

export interface SpringChainParams {
  readonly stiffness?: number;
  readonly drag?: number;
  readonly gravity?: number;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _s = new THREE.Vector3();

/** One chain: `bones[0]` hangs from a driven parent; the tip point sits `tip` past the last bone (its local space). */
export class SpringChain {
  /** World positions of bones[0..n-1] and the tip (n + 1 points). */
  readonly points: THREE.Vector3[];
  private readonly prev: THREE.Vector3[];
  /** Rest offsets from point i-1 to point i (i ≥ 1), in rest (world-aligned) space. */
  private readonly restOffsets: THREE.Vector3[];
  private readonly restDirs: THREE.Vector3[];
  private readonly stiffness: number;
  private readonly drag: number;
  private readonly gravity: number;
  private readonly lastAnchor = new THREE.Vector3();
  private started = false;

  constructor(readonly bones: readonly THREE.Bone[], tip: THREE.Vector3, params: SpringChainParams = {}) {
    if (bones.length === 0) throw new Error('SpringChain: no bones');
    this.restOffsets = [new THREE.Vector3()];
    for (let i = 1; i < bones.length; i++) this.restOffsets.push(bones[i]!.position.clone());
    this.restOffsets.push(tip.clone());
    this.restDirs = [];
    for (let i = 1; i < this.restOffsets.length; i++) this.restDirs.push(this.restOffsets[i]!.clone().normalize());
    this.points = this.restOffsets.map(() => new THREE.Vector3());
    this.prev = this.restOffsets.map(() => new THREE.Vector3());
    this.stiffness = params.stiffness ?? 0.04;
    this.drag = params.drag ?? 2.5;
    this.gravity = params.gravity ?? 1;
  }

  /** World position of bones[0] from its parent's current world matrix. */
  private anchor(out: THREE.Vector3): THREE.Vector3 {
    const bone = this.bones[0]!;
    const parent = bone.parent;
    out.copy(bone.position);
    return parent === null ? out : out.applyMatrix4(parent.matrixWorld);
  }

  private parentQuaternion(out: THREE.Quaternion): THREE.Quaternion {
    const parent = this.bones[0]!.parent;
    if (parent === null) return out.identity();
    parent.matrixWorld.decompose(_w, out, _s);
    return out;
  }

  private worldScale(): number {
    const parent = this.bones[0]!.parent;
    return parent === null ? 1 : parent.matrixWorld.getMaxScaleOnAxis();
  }

  /** Rest world positions under the current parent pose (straight chain). */
  private restPoint(i: number, out: THREE.Vector3): THREE.Vector3 {
    this.anchor(out);
    const q = this.parentQuaternion(_qp);
    const scale = this.worldScale();
    for (let k = 1; k <= i; k++) out.add(_v.copy(this.restOffsets[k]!).applyQuaternion(q).multiplyScalar(scale));
    return out;
  }

  /** Back to the rest shape with no velocity (switch, teleport, respawn). Needs current parent world matrices. */
  reset(): void {
    for (const bone of this.bones) bone.quaternion.identity();
    for (let i = 0; i < this.points.length; i++) {
      this.restPoint(i, this.points[i]!);
      this.prev[i]!.copy(this.points[i]!);
    }
    this.anchor(this.lastAnchor);
    this.started = true;
  }

  /** One 1/60 s substep with `wind` (m/s, world) and the collision spheres. */
  step(wind: THREE.Vector3, colliders: readonly SpringCollider[]): void {
    if (!this.started) this.reset();
    const pts = this.points;
    this.anchor(pts[0]!);
    this.prev[0]!.copy(pts[0]!);
    const scale = this.worldScale();
    const pull = this.stiffness;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i]!;
      const prev = this.prev[i]!;
      // velocity (m/s) → damped verlet with gravity and drag toward the wind.
      _v.subVectors(p, prev).divideScalar(STEP);
      _d.copy(wind).sub(_v).multiplyScalar(this.drag);
      _d.y -= GRAVITY * this.gravity;
      prev.copy(p);
      p.addScaledVector(_v, STEP * (1 - DAMPING)).addScaledVector(_d, STEP * STEP);
      if (pull > 0) p.lerp(this.restPoint(i, _w), pull);
    }
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        const len = this.restOffsets[i]!.length() * scale;
        _d.subVectors(b, a);
        const d = _d.length();
        if (d > 1e-9) b.copy(a).addScaledVector(_d, len / d);
        else b.copy(a).addScaledVector(this.restDirs[i - 1]!, len);
      }
    }
    for (const c of colliders) {
      _w.copy(c.offset).applyMatrix4(c.bone.matrixWorld);
      const r = c.radius * c.bone.matrixWorld.getMaxScaleOnAxis();
      for (let i = 1; i < pts.length; i++) {
        _d.subVectors(pts[i]!, _w);
        const d = _d.length();
        if (d < r) {
          if (d > 1e-9) pts[i]!.copy(_w).addScaledVector(_d, r / d);
          else pts[i]!.set(_w.x, _w.y, _w.z - r); // exactly at the centre: push behind
        }
      }
    }
  }

  /** Turns each bone so it points at the next point (bones[0]'s parent world matrix must be current). */
  apply(): void {
    // With parent world rotation P, bone i's rest direction is P·rest_i in the world. The shortest arc Δ from there to
    // the current direction gives the bone's world rotation W = Δ·P (keeping the parent's twist, e.g. the body's yaw),
    // so its local rotation is P⁻¹·Δ·P, and W is the next bone's parent rotation.
    const parentWorld = this.parentQuaternion(_qp);
    for (let i = 0; i < this.bones.length; i++) {
      _d.subVectors(this.points[i + 1]!, this.points[i]!);
      if (_d.lengthSq() < 1e-12) {
        this.bones[i]!.quaternion.identity();
        continue;
      }
      _d.normalize();
      _w.copy(this.restDirs[i]!).applyQuaternion(parentWorld);
      _q.setFromUnitVectors(_w, _d).multiply(parentWorld); // W = Δ·P
      _qi.copy(parentWorld).invert();
      this.bones[i]!.quaternion.copy(_qi.multiply(_q)); // P⁻¹·W
      parentWorld.copy(_q);
    }
    this.bones[0]!.updateMatrixWorld(true);
  }

  /** Whether the anchor jumped (teleport) since the last update; updates the remembered anchor. */
  anchorJumped(): boolean {
    this.anchor(_v);
    const jumped = this.started && _v.distanceTo(this.lastAnchor) > TELEPORT_DISTANCE;
    this.lastAnchor.copy(_v);
    return jumped;
  }
}

/** Every chain of one rig plus its collision spheres, stepped at 60 Hz. */
export class SpringSystem {
  private accumulator = 0;
  private readonly wind = new THREE.Vector3();

  constructor(readonly chains: readonly SpringChain[], readonly colliders: readonly SpringCollider[]) {}

  /** Chains back to rest (call after the rig's pose is set and its world matrices are current). */
  reset(): void {
    this.accumulator = 0;
    for (const chain of this.chains) chain.reset();
  }

  /**
   * Advances `dt` s (scaled time) with `wind` (world m/s, optional). The rig's world matrices must be current; the
   * chain bones' rotations are rewritten.
   */
  update(dt: number, wind?: Readonly<{ x: number; y: number; z: number }>): void {
    if (this.chains.length === 0) return;
    if (wind !== undefined) this.wind.set(wind.x, wind.y, wind.z);
    else this.wind.set(0, 0, 0);
    let teleported = false;
    for (const chain of this.chains) if (chain.anchorJumped()) teleported = true;
    if (teleported) {
      this.reset();
      for (const chain of this.chains) chain.apply();
      return;
    }
    this.accumulator = Math.min(this.accumulator + (Number.isFinite(dt) && dt > 0 ? dt : 0), MAX_SUBSTEPS * STEP);
    let steps = 0;
    while (this.accumulator >= STEP - 1e-9 && steps < MAX_SUBSTEPS) {
      this.accumulator -= STEP;
      steps++;
      for (const chain of this.chains) chain.step(this.wind, this.colliders);
    }
    if (steps > 0) for (const chain of this.chains) chain.apply();
  }
}
