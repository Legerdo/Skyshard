/*
 * Humanoid retargeting (design.md "retarget", "rest 보정", Req 43.4). Pose clips hold normalized rotations: local
 * rotations of a T-pose skeleton whose rest world rotations are all identity (the procedural rig itself). An external
 * skeleton keeps its own rest rotations and bone lengths, so each mapped raw bone gets
 *
 *   raw = P⁻¹ · q · P · R
 *
 * with R its rest local rotation, P its raw parent's rest rotation (both in the model root frame, after the front /
 * height normalisation) and q the bone's normalized pose rotation — the same transfer as three-vrm's normalized
 * humanoid rig. Then every mapped bone's world rotation is Q(bone) · Wrest(bone), where Q is the normalized world
 * rotation, so a bone's world direction (towards its child) turns exactly like the common skeleton's (Property 31).
 *
 * Generalisation: q is the normalized rotation relative to the bone's *anchor* — its nearest mapped raw ancestor —
 * i.e. Q(anchor)⁻¹ · Q(bone). With the humanoid parent mapped this is the bone's own q; unmapped humanoid bones in
 * between (a model without `chest`) fold into it, and non-humanoid nodes in between (twist bones, an armature node)
 * simply ride along. VRM 0.x models (turned 180° about Y) need no sign flips here: P and R are measured in the root
 * frame after the front correction, which is what flipping q's x and z does for three-vrm's normalized nodes.
 *
 * Rest correction: `restPose: 'A'` (upper arms ±45° about Z) or per-bone Euler degrees turn the raw rest into the
 * T-pose before R and P are stored.
 */
import * as THREE from 'three';
import { HUMANOID_BONE_NAMES, type HumanoidBoneName, type VisualSpec } from '../data/visualManifest';
import { HUMANOID_PARENT } from './boneMap';

/** Normalized local rotation per humanoid bone (a missing bone is identity). */
export type NormalizedPose = ReadonlyMap<HumanoidBoneName, THREE.Quaternion>;
/** Raw local rotation per mapped bone (written by retargetPose). */
export type RawBoneRotations = Map<HumanoidBoneName, THREE.Quaternion>;

export interface HumanoidRestBone {
  readonly name: HumanoidBoneName;
  /** Nearest mapped humanoid bone among the raw ancestors (null: none, the hips). */
  readonly anchor: HumanoidBoneName | null;
  /** P: rest world rotation of the raw parent in the root frame. */
  readonly parentRest: THREE.Quaternion;
  /** R: rest local rotation. */
  readonly localRest: THREE.Quaternion;
}

export interface HumanoidRestInfo {
  /** Mapped bones in HUMANOID_BONE_NAMES order. */
  readonly bones: readonly HumanoidRestBone[];
}

const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

/** Rotation of `node` in `root`'s frame (world matrices must be current). */
export function rotationInRoot(node: THREE.Object3D, root: THREE.Object3D, out = new THREE.Quaternion()): THREE.Quaternion {
  _inv.copy(root.matrixWorld).invert();
  _m.multiplyMatrices(_inv, node.matrixWorld).decompose(_p, out, _s);
  return out;
}

/** Position of `node` in `root`'s frame (world matrices must be current). */
export function positionInRoot(node: THREE.Object3D, root: THREE.Object3D, out = new THREE.Vector3()): THREE.Vector3 {
  _inv.copy(root.matrixWorld).invert();
  return out.setFromMatrixPosition(_m.multiplyMatrices(_inv, node.matrixWorld));
}

/** Stores R, P and the anchor of every mapped bone (the model at its rest pose under `root`). */
export function captureRestInfo(root: THREE.Object3D, map: ReadonlyMap<HumanoidBoneName, THREE.Object3D>): HumanoidRestInfo {
  root.updateMatrixWorld(true);
  const byNode = new Map<THREE.Object3D, HumanoidBoneName>();
  for (const [name, node] of map) byNode.set(node, name);
  const bones: HumanoidRestBone[] = [];
  for (const name of HUMANOID_BONE_NAMES) {
    const node = map.get(name);
    if (node === undefined) continue;
    let anchor: HumanoidBoneName | null = null;
    for (let o = node.parent; o !== null && o !== root; o = o.parent) {
      const hit = byNode.get(o);
      if (hit !== undefined) {
        anchor = hit;
        break;
      }
    }
    const parentRest = node.parent === null || node.parent === root ? new THREE.Quaternion() : rotationInRoot(node.parent, root);
    bones.push({ name, anchor, parentRest, localRest: node.quaternion.clone() });
  }
  return { bones };
}

const IDENTITY = new THREE.Quaternion();
const BONE_INDEX = new Map<HumanoidBoneName, number>(HUMANOID_BONE_NAMES.map((b, i) => [b, i]));
const PARENT_INDEX = HUMANOID_BONE_NAMES.map((b) => {
  const p = HUMANOID_PARENT[b];
  return p === null ? -1 : BONE_INDEX.get(p)!;
});
/** Normalized world rotations Q per bone (scratch, HUMANOID_BONE_NAMES order: parents first). */
const WORLD = HUMANOID_BONE_NAMES.map(() => new THREE.Quaternion());

/**
 * Normalized pose → raw local rotations of the target's mapped bones: raw = P⁻¹ · (Q(anchor)⁻¹ · Q(bone)) · P · R.
 * `out` entries are reused (created on first use).
 */
export function retargetPose(pose: NormalizedPose, target: HumanoidRestInfo, out: RawBoneRotations): void {
  for (let i = 0; i < HUMANOID_BONE_NAMES.length; i++) {
    const q = pose.get(HUMANOID_BONE_NAMES[i]!) ?? IDENTITY;
    const p = PARENT_INDEX[i]!;
    if (p < 0) WORLD[i]!.copy(q);
    else WORLD[i]!.multiplyQuaternions(WORLD[p]!, q);
  }
  for (const bone of target.bones) {
    const world = WORLD[BONE_INDEX.get(bone.name)!]!;
    // rel = Q(anchor)⁻¹ · Q(bone)
    if (bone.anchor === null) _q.copy(world);
    else _q.copy(WORLD[BONE_INDEX.get(bone.anchor)!]!).invert().multiply(world);
    // raw = P⁻¹ · rel · P · R
    _q2.copy(bone.parentRest).invert().multiply(_q).multiply(bone.parentRest).multiply(bone.localRest);
    let slot = out.get(bone.name);
    if (slot === undefined) {
      slot = new THREE.Quaternion();
      out.set(bone.name, slot);
    }
    slot.copy(_q2).normalize();
  }
}

/** Nominal upper-arm drop of an A-pose rest (°). */
export const A_POSE_ARM_DEG = 45;

const DEG = Math.PI / 180;

/**
 * World-frame (root frame) correction rotations that turn the given rest into the T-pose: none for 'T' / undefined,
 * the upper arms raised ±45° about Z for 'A' (left arm on +X: +45°), or per-bone Euler degrees (XYZ).
 */
export function restCorrections(restPose: VisualSpec['restPose']): Map<HumanoidBoneName, THREE.Quaternion> {
  const out = new Map<HumanoidBoneName, THREE.Quaternion>();
  if (restPose === undefined || restPose === 'T') return out;
  if (restPose === 'A') {
    out.set('leftUpperArm', new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), A_POSE_ARM_DEG * DEG));
    out.set('rightUpperArm', new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -A_POSE_ARM_DEG * DEG));
    return out;
  }
  for (const bone of HUMANOID_BONE_NAMES) {
    const deg = restPose[bone];
    if (deg === undefined) continue;
    out.set(bone, new THREE.Quaternion().setFromEuler(new THREE.Euler(deg[0] * DEG, deg[1] * DEG, deg[2] * DEG, 'XYZ')));
  }
  return out;
}

/**
 * Applies root-frame corrections to the mapped bones' rest (parents first): the bone's rest world rotation becomes
 * C · Wrest, its children following. Call before captureRestInfo.
 */
export function applyRestCorrection(
  root: THREE.Object3D, map: ReadonlyMap<HumanoidBoneName, THREE.Object3D>, corrections: ReadonlyMap<HumanoidBoneName, THREE.Quaternion>,
): void {
  if (corrections.size === 0) return;
  for (const name of HUMANOID_BONE_NAMES) {
    const c = corrections.get(name);
    const node = map.get(name);
    if (c === undefined || node === undefined) continue;
    root.updateMatrixWorld(true);
    const parent = node.parent === null || node.parent === root ? new THREE.Quaternion() : rotationInRoot(node.parent, root);
    // L' = Wp⁻¹ · C · Wp · L
    _q.copy(parent).invert().multiply(c).multiply(parent);
    node.quaternion.premultiply(_q).normalize();
  }
  root.updateMatrixWorld(true);
}
