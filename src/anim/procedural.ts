/*
 * Procedural layers (design.md "절차적 레이어"): corrections added every frame after the clips are composed, all in
 * the clips' scaled time. In order:
 * - pelvis height: while grounded the pelvis (`hips`) drops so the lower foot stays on the ground (rotation-only keys
 *   would lift the feet as the knees bend; the walk / run bob comes from here too);
 * - breathing: a 3.5 s, 1.5° sine on `chest` and the shoulders, 1.5 s for 3 s after a sprint;
 * - look-at: `neck` 40 % and `head` 60 % toward a target within range; past yaw ±70°, pitch ±30° or out of range the
 *   head returns to the front over 0.3 s;
 * - lean and landing squash: hips and spine lean into a turn by yaw rate × speed (max 12°, gliding 25°); a landing
 *   drops the hips up to 6 cm and squashes the model (y 0.92, xz 1.04) by the fall speed, back within 0.2 s on a
 *   damped spring.
 * The spring bones run after this (VisualInstance.update); the weapon trail anchors are read after the bone update.
 */
import * as THREE from 'three';
import type { Vec3 } from '../core/types';
import type { LeanMode } from './animState';

export const BREATH_PERIOD = 3.5;
export const BREATH_PERIOD_WINDED = 1.5;
export const BREATH_AMPLITUDE_DEG = 1.5;
/** Winded breathing lasts this long after a sprint ends (s). */
export const WINDED_SECONDS = 3;
export const LOOK_RANGE = 8;
export const LOOK_YAW_LIMIT_DEG = 70;
export const LOOK_PITCH_LIMIT_DEG = 30;
export const LOOK_RETURN_SECONDS = 0.3;
export const LEAN_MAX_DEG = 12;
export const GLIDE_LEAN_MAX_DEG = 25;
export const LANDING_DROP = 0.06;
export const LANDING_SQUASH = { y: 0.92, xz: 1.04 } as const;
/** Fall speed (m/s) that gives the full landing squash. */
const LANDING_FULL_SPEED = 12;
/** Spring rate of the landing recovery: (1 + ωt)·e^(−ωt) is ≈ 4 % at 0.2 s. */
const LANDING_OMEGA = 25;
const SLOPE_PITCH_DEG = 14;
const DEG = Math.PI / 180;

export interface ProceduralOptions {
  readonly height: number;
  /** Foot joints the pelvis keeps on the ground (humanoid: leftFoot, rightFoot). */
  readonly feet?: readonly string[];
  /** Joint lowered by the pelvis layer (default hips). */
  readonly pelvis?: string;
  /** Breathing joints and their weight (default chest 1, shoulders ±0.6). */
  readonly breathe?: readonly (readonly [string, 'x' | 'z', number])[];
  /** Look-at joints: [joint, share] (default neck 0.4, head 0.6) and range (default 8 m). */
  readonly look?: readonly (readonly [string, number])[];
  readonly lookRange?: number;
  /** Lean joints and their share (default hips 0.5, spine 0.5). */
  readonly lean?: readonly (readonly [string, number])[];
}

export interface ProceduralFrame {
  readonly grounded: boolean;
  /** Horizontal speed (m/s). */
  readonly speed: number;
  /** Turn rate of the facing (rad/s, positive toward +X). */
  readonly yawRate: number;
  readonly lean: LeanMode;
  readonly sprinting: boolean;
  /** Fall speed (m/s) in the frame a landing starts, else null. */
  readonly landing: number | null;
  /** World point to look at, or null. */
  readonly lookAt: Readonly<Vec3> | null;
}

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

/** Position of `bone` in `root`'s space from the local transforms (no world update needed). */
function inRoot(chain: readonly THREE.Object3D[], out: THREE.Vector3): THREE.Vector3 {
  _m.identity();
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i]!;
    node.updateMatrix();
    _m.multiply(node.matrix);
  }
  return out.setFromMatrixPosition(_m);
}

function chainTo(bone: THREE.Object3D, root: THREE.Object3D): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  let o: THREE.Object3D | null = bone;
  while (o !== null && o !== root) {
    out.push(o);
    o = o.parent;
  }
  return out;
}

const approach = (value: number, target: number, rate: number, dt: number): number => value + (target - value) * (1 - Math.exp(-rate * dt));

/** One rig's procedural corrections. */
export class ProceduralLayers {
  private readonly feet: { chain: THREE.Object3D[] }[] = [];
  private readonly restFootY: number;
  private readonly pelvis: THREE.Object3D | null;
  private readonly pelvisRestY: number;
  private readonly breathe: { bone: THREE.Object3D; axis: THREE.Vector3; weight: number }[] = [];
  private readonly look: { bone: THREE.Object3D; share: number }[] = [];
  private readonly lookOrigin = new THREE.Vector3();
  private readonly leanJoints: { bone: THREE.Object3D; share: number }[] = [];
  private breathPhase = 0;
  private winded = 0;
  private wasSprinting = false;
  private lookWeight = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private leanRoll = 0;
  private leanPitch = 0;
  private landingAmp = 0;
  private landingTime = Infinity;
  /** Pelvis drop applied this frame (m, tests). */
  drop = 0;

  constructor(private readonly root: THREE.Object3D, joints: ReadonlyMap<string, THREE.Object3D>, private readonly options: ProceduralOptions) {
    const pelvis = joints.get(options.pelvis ?? 'hips') ?? null;
    this.pelvis = pelvis;
    this.pelvisRestY = pelvis?.position.y ?? 0;
    let minY = Infinity;
    for (const name of options.feet ?? []) {
      const bone = joints.get(name);
      if (bone === undefined) continue;
      const chain = chainTo(bone, root);
      this.feet.push({ chain });
      minY = Math.min(minY, inRoot(chain, _v).y);
    }
    this.restFootY = Number.isFinite(minY) ? minY : 0;
    const breathe = options.breathe ?? [['chest', 'x', 1], ['leftShoulder', 'z', 0.6], ['rightShoulder', 'z', -0.6]];
    for (const [name, axis, weight] of breathe) {
      const bone = joints.get(name);
      if (bone !== undefined) this.breathe.push({ bone, axis: axis === 'x' ? X : Z, weight });
    }
    for (const [name, share] of options.look ?? [['neck', 0.4], ['head', 0.6]]) {
      const bone = joints.get(name);
      if (bone !== undefined) this.look.push({ bone, share });
    }
    const head = this.look[this.look.length - 1]?.bone;
    if (head !== undefined) inRoot(chainTo(head, root), this.lookOrigin);
    for (const [name, share] of options.lean ?? [['hips', 0.5], ['spine', 0.5]]) {
      const bone = joints.get(name);
      if (bone !== undefined) this.leanJoints.push({ bone, share });
    }
  }

  /** Current look weight 0..1 (tests). */
  get lookAmount(): number {
    return this.lookWeight;
  }

  get breathingPeriod(): number {
    return this.winded > 0 ? BREATH_PERIOD_WINDED : BREATH_PERIOD;
  }

  /** Back to neutral (switch, teleport). */
  reset(): void {
    this.lookWeight = 0;
    this.leanRoll = 0;
    this.leanPitch = 0;
    this.landingTime = Infinity;
    this.root.scale.set(1, 1, 1);
    if (this.pelvis !== null) this.pelvis.position.y = this.pelvisRestY;
  }

  /** Applies the corrections on top of the pose the Animator just wrote (`dt` scaled s). */
  apply(dt: number, frame: ProceduralFrame): void {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    const H = this.options.height;
    // Breathing (winded for 3 s after a sprint).
    if (this.wasSprinting && !frame.sprinting) this.winded = WINDED_SECONDS;
    this.wasSprinting = frame.sprinting;
    this.winded = Math.max(0, this.winded - step);
    this.breathPhase = (this.breathPhase + step * (Math.PI * 2) / this.breathingPeriod) % (Math.PI * 2);
    const breath = Math.sin(this.breathPhase) * BREATH_AMPLITUDE_DEG * DEG;
    for (const b of this.breathe) b.bone.quaternion.multiply(_q.setFromAxisAngle(b.axis, breath * b.weight));
    // Look-at.
    let valid = false;
    if (frame.lookAt !== null && this.look.length > 0) {
      this.root.updateWorldMatrix(true, false);
      _v.set(frame.lookAt.x, frame.lookAt.y, frame.lookAt.z);
      this.root.worldToLocal(_v).sub(this.lookOrigin);
      const dist = _v.length();
      const yaw = Math.atan2(_v.x, _v.z);
      const pitch = Math.atan2(_v.y, Math.hypot(_v.x, _v.z));
      valid = dist <= (this.options.lookRange ?? LOOK_RANGE) && Math.abs(yaw) <= LOOK_YAW_LIMIT_DEG * DEG && Math.abs(pitch) <= LOOK_PITCH_LIMIT_DEG * DEG;
      if (valid) {
        this.lookYaw = this.lookWeight <= 0 ? yaw : approach(this.lookYaw, yaw, 10, step);
        this.lookPitch = this.lookWeight <= 0 ? pitch : approach(this.lookPitch, pitch, 10, step);
      }
    }
    this.lookWeight = Math.min(1, Math.max(0, this.lookWeight + (valid ? 1 : -1) * step / LOOK_RETURN_SECONDS));
    if (this.lookWeight > 0) {
      for (const l of this.look) {
        const k = l.share * this.lookWeight;
        _q.setFromAxisAngle(Y, this.lookYaw * k).multiply(_q2.setFromAxisAngle(X, -this.lookPitch * k));
        l.bone.quaternion.multiply(_q);
      }
    }
    // Lean into turns (whole body while gliding), forward on a slide.
    const max = (frame.lean === 'glide' ? GLIDE_LEAN_MAX_DEG : LEAN_MAX_DEG) * DEG;
    const rollTarget = frame.lean === 'turn' || frame.lean === 'glide'
      ? Math.max(-max, Math.min(max, -Math.atan((frame.yawRate * frame.speed) / 9.81)))
      : 0;
    this.leanRoll = approach(this.leanRoll, Number.isFinite(rollTarget) ? rollTarget : 0, 6, step);
    this.leanPitch = approach(this.leanPitch, frame.lean === 'slope' ? SLOPE_PITCH_DEG * DEG : 0, 6, step);
    if (Math.abs(this.leanRoll) > 1e-5 || Math.abs(this.leanPitch) > 1e-5) {
      const joints = frame.lean === 'glide' ? this.leanJoints.slice(0, 1).map((j) => ({ bone: j.bone, share: 1 })) : this.leanJoints;
      for (const j of joints) {
        _q.setFromAxisAngle(Z, this.leanRoll * j.share).multiply(_q2.setFromAxisAngle(X, this.leanPitch * j.share));
        j.bone.quaternion.premultiply(_q);
      }
    }
    // Landing squash on a damped spring.
    if (frame.landing !== null) {
      this.landingAmp = Math.min(1, Math.max(0, frame.landing / LANDING_FULL_SPEED));
      this.landingTime = 0;
    } else if (Number.isFinite(this.landingTime)) {
      this.landingTime += step;
    }
    const w = this.omegaT();
    const squash = this.landingAmp * w;
    this.root.scale.set(1 + (LANDING_SQUASH.xz - 1) * squash, 1 + (LANDING_SQUASH.y - 1) * squash, 1 + (LANDING_SQUASH.xz - 1) * squash);
    // Pelvis height: the lower foot back on the ground while grounded.
    if (this.pelvis !== null) {
      this.pelvis.position.y = this.pelvisRestY;
      let drop = 0;
      if (frame.grounded && this.feet.length > 0) {
        let minY = Infinity;
        for (const f of this.feet) minY = Math.min(minY, inRoot(f.chain, _v).y);
        drop = Math.max(0, Math.min(0.4 * H, minY - this.restFootY));
      }
      drop += LANDING_DROP * squash;
      this.pelvis.position.y = this.pelvisRestY - drop;
      this.drop = drop;
    }
  }

  /** Landing spring envelope 1 → 0 ((1 + ωt)·e^(−ωt)), 0 once settled. */
  private omegaT(): number {
    if (!Number.isFinite(this.landingTime)) return 0;
    const x = LANDING_OMEGA * this.landingTime;
    const v = (1 + x) * Math.exp(-x);
    if (v < 0.01) {
      this.landingTime = Infinity;
      return 0;
    }
    return v;
  }
}
