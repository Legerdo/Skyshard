/*
 * Test models for the external model path (task 19.8): headless three.js scenes shaped like what GLTFLoader /
 * FBXLoader hand back (a scene with an optional armature node, THREE.Bone joints, one SkinnedMesh bound to them),
 * plus minimal file bytes for the format checks. No WebGL, no loader: the tests inject these through the provider's
 * `parsers` / `fetch` options.
 */
import * as THREE from 'three';
import type { HumanoidBoneName } from '../../../src/data/visualManifest';
import { HUMANOID_PARENT } from '../../../src/visual/boneMap';
import type { LoadedModel, VrmModelInfo } from '../../../src/visual/externalModel';

export type FixtureBone =
  | 'hips' | 'spine' | 'chest' | 'upperChest' | 'neck' | 'head'
  | 'leftShoulder' | 'leftUpperArm' | 'leftLowerArm' | 'leftHand'
  | 'rightShoulder' | 'rightUpperArm' | 'rightLowerArm' | 'rightHand'
  | 'leftUpperLeg' | 'leftLowerLeg' | 'leftFoot' | 'leftToes'
  | 'rightUpperLeg' | 'rightLowerLeg' | 'rightFoot' | 'rightToes';

/** T-pose joint positions (m): facing +Z, the model's left on +X, feet at y = 0. */
export const T_POSE: Readonly<Record<FixtureBone, readonly [number, number, number]>> = {
  hips: [0, 0.95, 0], spine: [0, 1.05, 0], chest: [0, 1.18, 0], upperChest: [0, 1.3, 0], neck: [0, 1.45, 0], head: [0, 1.55, 0],
  leftShoulder: [0.04, 1.4, 0], leftUpperArm: [0.16, 1.4, 0], leftLowerArm: [0.42, 1.4, 0], leftHand: [0.66, 1.4, 0],
  rightShoulder: [-0.04, 1.4, 0], rightUpperArm: [-0.16, 1.4, 0], rightLowerArm: [-0.42, 1.4, 0], rightHand: [-0.66, 1.4, 0],
  leftUpperLeg: [0.09, 0.9, 0], leftLowerLeg: [0.09, 0.5, 0], leftFoot: [0.09, 0.09, 0], leftToes: [0.09, 0.02, 0.12],
  rightUpperLeg: [-0.09, 0.9, 0], rightLowerLeg: [-0.09, 0.5, 0], rightFoot: [-0.09, 0.09, 0], rightToes: [-0.09, 0.02, 0.12],
};

/** Parent-first order of the fixture bones. */
export const FIXTURE_BONES = Object.keys(T_POSE) as FixtureBone[];

/** Node names as three.js loaders leave Mixamo files (`mixamorig:Hips` → `mixamorigHips`). */
export const MIXAMO_NAMES: Readonly<Record<FixtureBone, string>> = {
  hips: 'mixamorigHips', spine: 'mixamorigSpine', chest: 'mixamorigSpine1', upperChest: 'mixamorigSpine2',
  neck: 'mixamorigNeck', head: 'mixamorigHead',
  leftShoulder: 'mixamorigLeftShoulder', leftUpperArm: 'mixamorigLeftArm', leftLowerArm: 'mixamorigLeftForeArm', leftHand: 'mixamorigLeftHand',
  rightShoulder: 'mixamorigRightShoulder', rightUpperArm: 'mixamorigRightArm', rightLowerArm: 'mixamorigRightForeArm', rightHand: 'mixamorigRightHand',
  leftUpperLeg: 'mixamorigLeftUpLeg', leftLowerLeg: 'mixamorigLeftLeg', leftFoot: 'mixamorigLeftFoot', leftToes: 'mixamorigLeftToeBase',
  rightUpperLeg: 'mixamorigRightUpLeg', rightLowerLeg: 'mixamorigRightLeg', rightFoot: 'mixamorigRightFoot', rightToes: 'mixamorigRightToeBase',
};

export interface FixtureOptions {
  /** Node name per bone (default MIXAMO_NAMES). */
  readonly names?: Partial<Record<FixtureBone, string>>;
  /** Bones the file does not have. */
  readonly omit?: readonly FixtureBone[];
  /** File units per metre (FBX centimetres: 100). */
  readonly unit?: number;
  /** The model faces −Z (VRM 0.x): everything turned 180° about Y. */
  readonly faceBack?: boolean;
  /** Arms hanging 45° (an A-pose rest). */
  readonly aPose?: boolean;
  /** Rest world rotation per bone (default: Blender-style, local +Y along the bone). */
  readonly restRotation?: (bone: FixtureBone) => THREE.Quaternion;
  /** Length factor of the offset from each bone's humanoid parent (other proportions, same T-pose directions). */
  readonly boneScale?: (bone: FixtureBone) => number;
  /** An 'Armature' node above the hips with this world rotation and uniform scale (FBX style). */
  readonly armature?: { readonly rotation: THREE.Quaternion; readonly scale: number };
  /** Mesh extent (m): the visible body from `bottom` to `top`. */
  readonly bottom?: number;
  readonly top?: number;
  readonly animations?: readonly THREE.AnimationClip[];
}

export interface Fixture {
  readonly scene: THREE.Group;
  readonly bones: ReadonlyMap<FixtureBone, THREE.Bone>;
  readonly mesh: THREE.SkinnedMesh;
  readonly animations: THREE.AnimationClip[];
}

const Y = new THREE.Vector3(0, 1, 0);
const DEG = Math.PI / 180;

/** The joint each bone points at (leaves: a tip offset in m). */
const POINTS_AT: Readonly<Record<FixtureBone, FixtureBone | readonly [number, number, number]>> = {
  hips: 'spine', spine: 'chest', chest: 'upperChest', upperChest: 'neck', neck: 'head', head: [0, 0.2, 0],
  leftShoulder: 'leftUpperArm', leftUpperArm: 'leftLowerArm', leftLowerArm: 'leftHand', leftHand: [0.08, 0, 0],
  rightShoulder: 'rightUpperArm', rightUpperArm: 'rightLowerArm', rightLowerArm: 'rightHand', rightHand: [-0.08, 0, 0],
  leftUpperLeg: 'leftLowerLeg', leftLowerLeg: 'leftFoot', leftFoot: 'leftToes', leftToes: [0, 0, 0.06],
  rightUpperLeg: 'rightLowerLeg', rightLowerLeg: 'rightFoot', rightFoot: 'rightToes', rightToes: [0, 0, 0.06],
};

const v = (t: readonly [number, number, number]): THREE.Vector3 => new THREE.Vector3(t[0], t[1], t[2]);

/** T-pose direction (unnormalised) from a bone to what it points at. */
function tipOf(bone: FixtureBone): THREE.Vector3 {
  const target = POINTS_AT[bone];
  return typeof target === 'string' ? v(T_POSE[target]).sub(v(T_POSE[bone])) : v(target);
}

/** Blender-style rest: the bone's local +Y along its tip direction (a non-identity rest rotation for every bone). */
export function alongBone(bone: FixtureBone): THREE.Quaternion {
  const dir = tipOf(bone);
  if (dir.lengthSq() < 1e-12) return new THREE.Quaternion();
  return new THREE.Quaternion().setFromUnitVectors(Y, dir.normalize());
}

/** Places `node` under `parent` at a world transform (parent world matrix current). */
export function placeWorld(node: THREE.Object3D, parent: THREE.Object3D, pos: THREE.Vector3, rot: THREE.Quaternion, scale = 1): void {
  parent.updateMatrixWorld(true);
  const world = new THREE.Matrix4().compose(pos, rot, new THREE.Vector3(scale, scale, scale));
  const local = parent.matrixWorld.clone().invert().multiply(world);
  local.decompose(node.position, node.quaternion, node.scale);
  parent.add(node);
  node.updateMatrixWorld(true);
}

/** A humanoid test model (see FixtureOptions). */
export function humanoidFixture(options: FixtureOptions = {}): Fixture {
  const unit = options.unit ?? 1;
  const omit = new Set(options.omit ?? []);
  const names = { ...MIXAMO_NAMES, ...options.names };
  const turn = new THREE.Quaternion().setFromAxisAngle(Y, options.faceBack === true ? Math.PI : 0);
  const scene = new THREE.Group();
  scene.name = 'Scene';
  let top: THREE.Object3D = scene;
  const scale = options.armature?.scale ?? 1;
  if (options.armature !== undefined) {
    const armature = new THREE.Object3D();
    armature.name = 'Armature';
    placeWorld(armature, scene, new THREE.Vector3(), options.armature.rotation, scale);
    top = armature;
  }
  // A-pose: the arm chains turned 45° down about their upper-arm joint.
  const aPose = (bone: FixtureBone): THREE.Quaternion | null => {
    if (options.aPose !== true) return null;
    if (/^left(UpperArm|LowerArm|Hand)$/.test(bone)) return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -45 * DEG);
    if (/^right(UpperArm|LowerArm|Hand)$/.test(bone)) return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 45 * DEG);
    return null;
  };
  // T-pose joints with the bone lengths scaled (each offset from the humanoid parent times `boneScale`).
  const tPose = new Map<FixtureBone, THREE.Vector3>();
  for (const bone of FIXTURE_BONES) {
    const parent = HUMANOID_PARENT[bone as HumanoidBoneName] as FixtureBone | null;
    const k = options.boneScale?.(bone) ?? 1;
    tPose.set(bone, parent === null ? v(T_POSE[bone]) : v(T_POSE[bone]).sub(v(T_POSE[parent])).multiplyScalar(k).add(tPose.get(parent)!));
  }
  const restPos = (bone: FixtureBone): THREE.Vector3 => {
    const p = tPose.get(bone)!.clone();
    const a = aPose(bone);
    if (a !== null) {
      const pivot = tPose.get(bone.startsWith('left') ? 'leftUpperArm' : 'rightUpperArm')!;
      p.sub(pivot).applyQuaternion(a).add(pivot);
    }
    return p.applyQuaternion(turn).multiplyScalar(unit);
  };
  const restRot = (bone: FixtureBone): THREE.Quaternion => {
    const q = (options.restRotation ?? alongBone)(bone).clone();
    const a = aPose(bone);
    if (a !== null) q.premultiply(a);
    return q.premultiply(turn);
  };
  const bones = new Map<FixtureBone, THREE.Bone>();
  for (const bone of FIXTURE_BONES) {
    if (omit.has(bone)) continue;
    const node = new THREE.Bone();
    node.name = names[bone];
    let parent: THREE.Object3D = top;
    for (let p = HUMANOID_PARENT[bone as HumanoidBoneName]; p !== null; p = HUMANOID_PARENT[p]) {
      const hit = bones.get(p as FixtureBone);
      if (hit !== undefined) {
        parent = hit;
        break;
      }
    }
    placeWorld(node, parent, restPos(bone), restRot(bone), scale);
    bones.set(bone, node);
  }
  // Body: a box from `bottom` to `top`, skinned to the first bone.
  const bottom = options.bottom ?? 0;
  const height = (options.top ?? 1.75) - bottom;
  const geometry = new THREE.BoxGeometry(0.5 * unit, height * unit, 0.3 * unit);
  geometry.translate(0, (bottom + height / 2) * unit, 0);
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) weights[i * 4] = 1;
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  const material = new THREE.MeshStandardMaterial({ color: 0x8899aa, name: 'body' });
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = 'Body';
  scene.add(mesh);
  scene.updateMatrixWorld(true);
  const skinBones = [...bones.values()];
  mesh.bind(new THREE.Skeleton(skinBones.length > 0 ? skinBones : [new THREE.Bone()]));
  return { scene, bones, mesh, animations: [...(options.animations ?? [])] };
}

/** The loader output of a fixture (glTF / FBX; VRM with `vrm`). */
export function loadedOf(fixture: Fixture, kind: LoadedModel['kind'] = 'gltf', vrm?: VrmModelInfo): LoadedModel {
  return vrm === undefined ? { kind, scene: fixture.scene, animations: fixture.animations } : { kind, scene: fixture.scene, animations: fixture.animations, vrm };
}

/** A minimal GLB: the 12-byte header and one JSON chunk. */
export function glbBytes(json: unknown = { asset: { version: '2.0' } }): ArrayBuffer {
  let text = JSON.stringify(json);
  while (text.length % 4 !== 0) text += ' ';
  const body = new TextEncoder().encode(text);
  const total = 12 + 8 + body.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode('glTF'), 0);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, body.length, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(body, 20);
  return out.buffer;
}

/** The start of a binary FBX file. */
export function fbxBytes(): ArrayBuffer {
  const out = new Uint8Array(64);
  out.set(new TextEncoder().encode('Kaydara FBX Binary  \0'), 0);
  return out.buffer;
}

export const textBytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

/** World direction from `a` to `b` (world matrices current). */
export function directionBetween(a: THREE.Object3D, b: THREE.Object3D): THREE.Vector3 {
  const pa = a.getWorldPosition(new THREE.Vector3());
  return b.getWorldPosition(new THREE.Vector3()).sub(pa).normalize();
}
