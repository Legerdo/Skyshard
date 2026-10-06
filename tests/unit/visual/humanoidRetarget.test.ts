import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { HumanoidBoneName } from '../../../src/data/visualManifest';
import {
  A_POSE_ARM_DEG, applyRestCorrection, captureRestInfo, restCorrections, retargetPose, type RawBoneRotations,
} from '../../../src/visual/humanoidRetarget';
import { directionBetween, placeWorld } from './externalFixtures';

// Task 19.8: raw = P⁻¹·q·P·R (design.md "retarget") and the A-pose rest correction ("rest 보정"). Headless three.js.

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const axis = (a: THREE.Vector3, deg: number): THREE.Quaternion => new THREE.Quaternion().setFromAxisAngle(a, (deg * Math.PI) / 180);

/** Same rotation (q ≡ −q); compares |dot| with 1 (acos near 1 is too coarse for tight tolerances). */
function expectRot(actual: THREE.Quaternion, expected: THREE.Quaternion): void {
  expect(Math.abs(actual.dot(expected))).toBeCloseTo(1, 12);
}

function expectVec(actual: THREE.Vector3, expected: THREE.Vector3, digits = 9): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
}

/**
 * A two-bone left arm with Blender-like rests: the upper arm's local +Y along world +X (rest rotation −90° about Z),
 * the forearm additionally twisted 40° about its own axis; a tip node marks the forearm's end.
 */
function twoBoneArm() {
  const root = new THREE.Group();
  const upper = new THREE.Bone();
  const lower = new THREE.Bone();
  const tip = new THREE.Object3D();
  const upperRest = axis(Z, -90);
  const lowerRest = upperRest.clone().multiply(axis(Y, 40));
  placeWorld(upper, root, new THREE.Vector3(0.2, 1.4, 0), upperRest);
  placeWorld(lower, upper, new THREE.Vector3(0.5, 1.4, 0), lowerRest);
  placeWorld(tip, lower, new THREE.Vector3(0.75, 1.4, 0), lowerRest);
  const map = new Map<HumanoidBoneName, THREE.Object3D>([['leftUpperArm', upper], ['leftLowerArm', lower]]);
  return { root, upper, lower, tip, map };
}

function apply(out: RawBoneRotations, map: ReadonlyMap<HumanoidBoneName, THREE.Object3D>, root: THREE.Object3D): void {
  for (const [bone, q] of out) map.get(bone)!.quaternion.copy(q);
  root.updateMatrixWorld(true);
}

describe('retargetPose (raw = P⁻¹·q·P·R)', () => {
  it('stores R, P and the mapped anchor of a two-bone chain', () => {
    const { root, map } = twoBoneArm();
    const rest = captureRestInfo(root, map);
    expect(rest.bones.map((b) => [b.name, b.anchor])).toEqual([['leftUpperArm', null], ['leftLowerArm', 'leftUpperArm']]);
    const [upper, lower] = rest.bones;
    expectRot(upper!.parentRest, new THREE.Quaternion());
    expectRot(lower!.parentRest, axis(Z, -90));
    expectRot(lower!.localRest, axis(Y, 40));
  });

  it('turns the chain like the normalized skeleton: upper arm raised (+X → +Y), forearm swung back (→ −Z)', () => {
    const { root, upper, lower, tip, map } = twoBoneArm();
    const rest = captureRestInfo(root, map);
    // Normalized pose: world-axis rotations of an identity-rest T-pose skeleton.
    const pose = new Map<HumanoidBoneName, THREE.Quaternion>([['leftUpperArm', axis(Z, 90)], ['leftLowerArm', axis(Y, 90)]]);
    const out: RawBoneRotations = new Map();
    retargetPose(pose, rest, out);
    apply(out, map, root);
    // Expected from the common skeleton: Q(upper) = rotZ(90°) turns +X to +Y; Q(lower) = rotZ(90°)·rotY(90°) turns +X to −Z.
    expectVec(directionBetween(upper, lower), Y);
    expectVec(directionBetween(lower, tip), new THREE.Vector3(0, 0, -1));
    // World rotations are Q · Wrest (the forearm's own twist kept).
    expectRot(lower.getWorldQuaternion(new THREE.Quaternion()), axis(Z, 90).multiply(axis(Y, 90)).multiply(axis(Z, -90)).multiply(axis(Y, 40)));
    // The identity pose gives the rest back; entries are reused between calls.
    const slot = out.get('leftLowerArm');
    retargetPose(new Map(), rest, out);
    expect(out.get('leftLowerArm')).toBe(slot);
    apply(out, map, root);
    expectVec(directionBetween(upper, lower), X);
    expectVec(directionBetween(lower, tip), X);
  });

  it('folds an unmapped humanoid parent and non-humanoid nodes between into the child (a twist bone, no shoulder)', () => {
    const root = new THREE.Group();
    const chest = new THREE.Bone();
    const upper = new THREE.Bone();
    const twist = new THREE.Object3D();
    const lower = new THREE.Bone();
    placeWorld(chest, root, new THREE.Vector3(0, 1.3, 0), axis(X, 20));
    placeWorld(upper, chest, new THREE.Vector3(0.2, 1.4, 0), axis(Z, -90));
    placeWorld(twist, upper, new THREE.Vector3(0.35, 1.4, 0), axis(X, 70));
    placeWorld(lower, twist, new THREE.Vector3(0.5, 1.4, 0), axis(Z, -90).multiply(axis(Y, -30)));
    const map = new Map<HumanoidBoneName, THREE.Object3D>([['chest', chest], ['leftUpperArm', upper], ['leftLowerArm', lower]]);
    const rest = captureRestInfo(root, map);
    expect(rest.bones.find((b) => b.name === 'leftUpperArm')!.anchor).toBe('chest');
    const qChest = axis(Y, 30);
    const qShoulder = axis(Z, 15); // the model has no shoulder: folded into the upper arm
    const qUpper = axis(Z, -60);
    const pose = new Map<HumanoidBoneName, THREE.Quaternion>([['chest', qChest], ['leftShoulder', qShoulder], ['leftUpperArm', qUpper]]);
    const out: RawBoneRotations = new Map();
    retargetPose(pose, rest, out);
    apply(out, map, root);
    const expected = X.clone().applyQuaternion(qChest.clone().multiply(qShoulder).multiply(qUpper));
    expectVec(directionBetween(upper, lower), expected);
  });
});

describe('rest correction', () => {
  it("'A' raises the upper arms 45° about Z (left +, right −); per-bone degrees are XYZ Euler", () => {
    expect(A_POSE_ARM_DEG).toBe(45);
    expect(restCorrections(undefined).size).toBe(0);
    expect(restCorrections('T').size).toBe(0);
    const a = restCorrections('A');
    expect([...a.keys()]).toEqual(['leftUpperArm', 'rightUpperArm']);
    expectRot(a.get('leftUpperArm')!, axis(Z, 45));
    expectRot(a.get('rightUpperArm')!, axis(Z, -45));
    const custom = restCorrections({ leftUpperArm: [0, 0, 45], head: [10, 0, 0] });
    expectRot(custom.get('leftUpperArm')!, a.get('leftUpperArm')!);
    expectRot(custom.get('head')!, axis(X, 10));
  });

  it('turns an A-pose arm into the T-pose before the rest is stored (children follow)', () => {
    const root = new THREE.Group();
    const chest = new THREE.Bone();
    const upper = new THREE.Bone();
    const lower = new THREE.Bone();
    const down = axis(Z, -45);
    placeWorld(chest, root, new THREE.Vector3(0, 1.3, 0), axis(Y, 25));
    placeWorld(upper, chest, new THREE.Vector3(0.2, 1.4, 0), down.clone().multiply(axis(Z, -90)));
    placeWorld(lower, upper, new THREE.Vector3(0.2, 1.4, 0).add(new THREE.Vector3(0.3, 0, 0).applyQuaternion(down)), down.clone().multiply(axis(Z, -90)));
    const map = new Map<HumanoidBoneName, THREE.Object3D>([['chest', chest], ['leftUpperArm', upper], ['leftLowerArm', lower]]);
    expectVec(directionBetween(upper, lower), new THREE.Vector3(Math.SQRT1_2, -Math.SQRT1_2, 0));
    applyRestCorrection(root, map, restCorrections('A'));
    expectVec(directionBetween(upper, lower), X);
    // The corrected rest is what the retarget keeps for the identity pose.
    const rest = captureRestInfo(root, map);
    const out: RawBoneRotations = new Map();
    retargetPose(new Map(), rest, out);
    apply(out, map, root);
    expectVec(directionBetween(upper, lower), X);
    expectRot(chest.quaternion, axis(Y, 25));
  });
});
