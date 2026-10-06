// Feature: skyshard-echoes-of-the-wild, Property 31: Humanoid retarget 방향 보존
import fc from 'fast-check';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { RIG_HUMANOID_BONES, type RigHumanoidBone } from '../../src/anim/rigLayout';
import type { HumanoidBoneName, VisualSpec } from '../../src/data/visualManifest';
import { HUMANOID_PARENT } from '../../src/visual/boneMap';
import { buildExternalTemplate } from '../../src/visual/externalModel';
import {
  applyRestCorrection, captureRestInfo, positionInRoot, restCorrections, retargetPose, rotationInRoot, type RawBoneRotations,
} from '../../src/visual/humanoidRetarget';
import { FIXTURE_BONES, humanoidFixture, loadedOf, placeWorld, T_POSE, type FixtureBone } from '../unit/visual/externalFixtures';

// **Validates: Requirements 43.4** — pose clips are defined on the common Humanoid_Skeleton (the procedural rig: T-pose,
// identity rest rotations). For a humanoid skeleton with arbitrary rest rotations and bone lengths (optionally an
// armature node, twist nodes, missing optional bones, an A-pose rest with `restPose: 'A'`) and an arbitrary pose,
// retargetPose (raw = P⁻¹·q·P·R) gives every bone the world direction the common skeleton gives it, within 1e-4.
// The second case runs the same through the game path: template normalisation, pose proxies, instance update.

const RUNS = { numRuns: 120 };
const TOL = 1e-4;

/** The common skeleton's bones (VRM humanoid core + upperChest + toes), parents first. */
const BONES = FIXTURE_BONES;
const N = BONES.length;
const OPTIONAL: readonly FixtureBone[] = ['chest', 'upperChest', 'neck', 'leftShoulder', 'rightShoulder', 'leftToes', 'rightToes'];
/** Tip offset of the leaf bones (m, common skeleton). */
const LEAF_TIP: Partial<Record<FixtureBone, readonly [number, number, number]>> = {
  head: [0, 0.2, 0], leftHand: [0.08, 0, 0], rightHand: [-0.08, 0, 0], leftToes: [0, 0, 0.06], rightToes: [0, 0, 0.06],
};
const ARM_CHAIN = /^(left|right)(UpperArm|LowerArm|Hand)$/;

// ── Generators ──────────────────────────────────────────────────────────────

type RotationSeed = [number, number, number];
const unit01 = fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true });
/** Seeds of uniformly distributed rotations (Shoemake), kept as numbers so counterexamples print plainly. */
const rotation: fc.Arbitrary<RotationSeed> = fc.tuple(unit01, unit01, unit01);
const perBone = <T>(arb: fc.Arbitrary<T>, n = N): fc.Arbitrary<T[]> => fc.array(arb, { minLength: n, maxLength: n });

/** Uniform rotation from three uniforms (the seed [0, 0, 0] is the identity, so shrunk counterexamples read easily). */
function quat([u1, u2, u3]: RotationSeed): THREE.Quaternion {
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  return new THREE.Quaternion(b * Math.sin(2 * Math.PI * u3), b * Math.cos(2 * Math.PI * u3), a * Math.sin(2 * Math.PI * u2), a * Math.cos(2 * Math.PI * u2));
}

const skeletonArb = fc.record({
  /** Rest world rotation of each bone's frame. */
  rest: perBone(rotation),
  /** Length factor of each bone's offset from its humanoid parent. */
  lengths: perBone(fc.double({ min: 0.3, max: 3, noNaN: true })),
  /** A non-humanoid node (twist bone) between a bone and its children: [where along the bone, its rest rotation]. */
  twists: perBone(fc.option(fc.tuple(fc.double({ min: 0.1, max: 0.9, noNaN: true }), rotation), { nil: null, freq: 3 })),
  omit: fc.subarray([...OPTIONAL]),
  /** An armature node above the hips (FBX style: any rotation, uniform world scale). */
  armature: fc.option(fc.record({ rotation, scale: fc.constantFrom(0.01, 1, 2.5) }), { nil: null }),
  /** Arms hanging 45° at rest, corrected with restPose 'A'. */
  aPose: fc.boolean(),
});
type SkeletonSeed = typeof skeletonArb extends fc.Arbitrary<infer T> ? T : never;

// ── Skeletons ───────────────────────────────────────────────────────────────

const v = (t: readonly [number, number, number]): THREE.Vector3 => new THREE.Vector3(t[0], t[1], t[2]);
const parentOf = (b: FixtureBone): FixtureBone | null => HUMANOID_PARENT[b as HumanoidBoneName] as FixtureBone | null;
const childrenOf = (b: FixtureBone): FixtureBone[] => BONES.filter((c) => parentOf(c) === b);
const worldPos = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3());
const worldDir = (a: THREE.Object3D, b: THREE.Object3D): THREE.Vector3 => worldPos(b).sub(worldPos(a)).normalize();
const worldRot = (o: THREE.Object3D): THREE.Quaternion => o.getWorldQuaternion(new THREE.Quaternion());

/** Angle between two rotations (rad; q ≡ −q). */
function rotationError(a: THREE.Quaternion, b: THREE.Quaternion): number {
  return 2 * Math.acos(Math.min(1, Math.abs(a.clone().normalize().dot(b.clone().normalize()))));
}

/** The common skeleton: identity rest rotations at the T-pose, posed with the normalized local rotations. */
function commonSkeleton(pose: readonly RotationSeed[]): { bones: Map<FixtureBone, THREE.Object3D>; tips: Map<FixtureBone, THREE.Object3D> } {
  const root = new THREE.Group();
  const bones = new Map<FixtureBone, THREE.Object3D>();
  const tips = new Map<FixtureBone, THREE.Object3D>();
  BONES.forEach((b, i) => {
    const node = new THREE.Object3D();
    const p = parentOf(b);
    node.position.copy(p === null ? v(T_POSE[b]) : v(T_POSE[b]).sub(v(T_POSE[p])));
    node.quaternion.copy(quat(pose[i]!));
    (p === null ? root : bones.get(p)!).add(node);
    bones.set(b, node);
    const tip = LEAF_TIP[b];
    if (tip !== undefined) {
      const t = new THREE.Object3D();
      t.position.copy(v(tip));
      node.add(t);
      tips.set(b, t);
    }
  });
  root.updateMatrixWorld(true);
  return { bones, tips };
}

interface Target {
  readonly root: THREE.Group;
  readonly bones: Map<FixtureBone, THREE.Object3D>;
  /** What each bone points at: mapped children (nearest mapped humanoid ancestor = the bone) or a tip node. */
  readonly ends: Map<FixtureBone, { node: THREE.Object3D; bone: FixtureBone | null; common: FixtureBone | 'tip' | null }[]>;
}

/** A model skeleton with other rests, lengths and extra nodes (see skeletonArb), at its rest pose. */
function targetSkeleton(s: SkeletonSeed): Target {
  const root = new THREE.Group();
  let top: THREE.Object3D = root;
  const scale = s.armature?.scale ?? 1;
  if (s.armature !== null) {
    const armature = new THREE.Object3D();
    armature.name = 'Armature';
    placeWorld(armature, root, new THREE.Vector3(), quat(s.armature.rotation), scale);
    top = armature;
  }
  const index = (b: FixtureBone): number => BONES.indexOf(b);
  // T-pose joints with this model's bone lengths (the directions of the common skeleton).
  const tPose = new Map<FixtureBone, THREE.Vector3>();
  for (const b of BONES) {
    const p = parentOf(b);
    tPose.set(b, p === null ? v(T_POSE[b]) : v(T_POSE[b]).sub(v(T_POSE[p])).multiplyScalar(s.lengths[index(b)]!).add(tPose.get(p)!));
  }
  // A-pose: the arm chains turned 45° down about their upper-arm joint (left arm on +X).
  const hang = (b: FixtureBone): THREE.Quaternion | null => (!s.aPose || !ARM_CHAIN.test(b)
    ? null
    : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (b.startsWith('left') ? -45 : 45) * (Math.PI / 180)));
  const rested = (b: FixtureBone, p: THREE.Vector3): THREE.Vector3 => {
    const h = hang(b);
    if (h === null) return p.clone();
    const pivot = tPose.get(b.startsWith('left') ? 'leftUpperArm' : 'rightUpperArm')!;
    return p.clone().sub(pivot).applyQuaternion(h).add(pivot);
  };
  const restRot = (b: FixtureBone): THREE.Quaternion => {
    const q = quat(s.rest[index(b)]!);
    const h = hang(b);
    return h === null ? q : q.premultiply(h);
  };
  const present = BONES.filter((b) => !s.omit.includes(b));
  const nearestPresentAncestor = (b: FixtureBone): FixtureBone | null => {
    for (let p = parentOf(b); p !== null; p = parentOf(p)) if (present.includes(p)) return p;
    return null;
  };
  const bones = new Map<FixtureBone, THREE.Object3D>();
  const attach = new Map<FixtureBone, THREE.Object3D>();
  const ends: Target['ends'] = new Map();
  for (const b of present) {
    const anchor = nearestPresentAncestor(b);
    const node = new THREE.Bone();
    node.name = b;
    placeWorld(node, anchor === null ? top : attach.get(anchor)!, rested(b, tPose.get(b)!), restRot(b), scale);
    bones.set(b, node);
    attach.set(b, node);
    ends.set(b, []);
    // What the bone points at: its first mapped descendant, else a tip (a leaf, or all children missing).
    const firstEnd = present.find((c) => nearestPresentAncestor(c) === b);
    const tipAt = firstEnd !== undefined
      ? null
      : childrenOf(b).length > 0
        ? tPose.get(childrenOf(b)[0]!)!.clone()
        : tPose.get(b)!.clone().add(v(LEAF_TIP[b]!).multiplyScalar(s.lengths[index(b)]!));
    const endPos = firstEnd !== undefined ? rested(firstEnd, tPose.get(firstEnd)!) : rested(b, tipAt!);
    const twist = s.twists[index(b)];
    if (twist !== null && twist !== undefined) {
      const t = new THREE.Object3D();
      t.name = `${b}_twist`;
      placeWorld(t, node, rested(b, tPose.get(b)!).lerp(endPos, twist[0]), quat(twist[1]), scale);
      attach.set(b, t);
    }
    if (tipAt !== null) {
      const tip = new THREE.Object3D();
      tip.name = `${b}_end`;
      placeWorld(tip, attach.get(b)!, endPos, restRot(b), scale);
      ends.get(b)!.push({ node: tip, bone: null, common: childrenOf(b)[0] ?? 'tip' });
    }
  }
  for (const c of present) {
    const a = nearestPresentAncestor(c);
    if (a !== null) ends.get(a)!.push({ node: bones.get(c)!, bone: c, common: parentOf(c) === a ? c : null });
  }
  root.updateMatrixWorld(true);
  return { root, bones, ends };
}

// ── Property ────────────────────────────────────────────────────────────────

describe('Property 31: Humanoid retarget 방향 보존', () => {
  it('retargetPose: every bone of any rest / length skeleton points where the common skeleton points it', () => {
    fc.assert(
      fc.property(skeletonArb, perBone(rotation), (s, pose) => {
        const target = targetSkeleton(s);
        const map = new Map<HumanoidBoneName, THREE.Object3D>([...target.bones].map(([b, n]) => [b as HumanoidBoneName, n]));
        if (s.aPose) applyRestCorrection(target.root, map, restCorrections('A'));
        // Rest (T-pose after the correction): world rotations and bone directions.
        const restRotation = new Map([...target.bones].map(([b, n]) => [b, worldRot(n)]));
        const restDirection = new Map([...target.ends].map(([b, list]) => [b, list.map((e) => worldDir(target.bones.get(b)!, e.node))]));
        const rest = captureRestInfo(target.root, map);
        const normalized = new Map<HumanoidBoneName, THREE.Quaternion>(BONES.map((b, i) => [b as HumanoidBoneName, quat(pose[i]!)]));
        const out: RawBoneRotations = new Map();
        retargetPose(normalized, rest, out);
        expect([...out.keys()].sort()).toEqual([...map.keys()].sort());
        for (const [b, q] of out) map.get(b)!.quaternion.copy(q);
        target.root.updateMatrixWorld(true);
        const common = commonSkeleton(pose);
        for (const [b, node] of target.bones) {
          // Q: the common skeleton's world rotation of the bone (identity rest → the normalized world rotation).
          const Q = worldRot(common.bones.get(b)!);
          expect(rotationError(worldRot(node), Q.clone().multiply(restRotation.get(b)!)), `${b} rotation`).toBeLessThan(TOL);
          target.ends.get(b)!.forEach((end, k) => {
            const got = worldDir(node, end.node);
            expect(got.distanceTo(restDirection.get(b)![k]!.clone().applyQuaternion(Q)), `${b} → ${end.node.name}`).toBeLessThan(TOL);
            if (end.common === null) return;
            const commonEnd = end.common === 'tip' ? common.tips.get(b)! : common.bones.get(end.common)!;
            expect(got.distanceTo(worldDir(common.bones.get(b)!, commonEnd)), `${b} → ${end.node.name} (common joints)`).toBeLessThan(TOL);
          });
        }
      }),
      RUNS,
    );
  });

  it('game path: the instance turns its raw bones like the pose proxies (normalisation, yaw, A-pose, FBX armature)', () => {
    const RIG_SET: ReadonlySet<string> = new Set(RIG_HUMANOID_BONES);
    const quiet = { warn: (): void => undefined, log: (): void => undefined };
    fc.assert(
      fc.property(
        fc.record({
          rest: perBone(rotation),
          lengths: perBone(fc.double({ min: 0.5, max: 2, noNaN: true })),
          armature: fc.option(fc.record({ rotation, fbx: fc.boolean() }), { nil: null }),
          faceBack: fc.boolean(),
          aPose: fc.boolean(),
          pose: perBone(rotation, RIG_HUMANOID_BONES.length),
        }),
        (s) => {
          const fbx = s.armature?.fbx === true;
          const fixture = humanoidFixture({
            restRotation: (b) => quat(s.rest[FIXTURE_BONES.indexOf(b)]!),
            boneScale: (b) => s.lengths[FIXTURE_BONES.indexOf(b)]!,
            unit: fbx ? 100 : 1,
            armature: s.armature === null ? undefined : { rotation: quat(s.armature.rotation), scale: fbx ? 0.01 : 1 },
            faceBack: s.faceBack,
            aPose: s.aPose,
          });
          const spec: VisualSpec = {
            source: { kind: fbx ? 'fbx' : 'gltf', url: fbx ? 'assets/models/p31.fbx' : 'assets/models/p31.glb' }, rig: 'humanoid',
            materials: 'original', outline: false, hideProceduralWeapon: true,
            ...(s.faceBack ? { yawDeg: 180 } : {}), ...(s.aPose ? { restPose: 'A' as const } : {}),
          };
          const template = buildExternalTemplate('kairen', spec, loadedOf(fixture, fbx ? 'fbx' : 'gltf'), quiet);
          const instance = template.instantiate();
          try {
            const proxy = (b: RigHumanoidBone): THREE.Object3D => instance.humanoid!.bones.get(b)!;
            const raw = (b: RigHumanoidBone): THREE.Object3D => instance.rawBones.get(b)!;
            RIG_HUMANOID_BONES.forEach((b, i) => proxy(b).quaternion.copy(quat(s.pose[i]!)));
            instance.update(1 / 60);
            const root = instance.root;
            const dir = (a: THREE.Object3D, b: THREE.Object3D): THREE.Vector3 => positionInRoot(b, root).sub(positionInRoot(a, root)).normalize();
            for (const b of RIG_HUMANOID_BONES) {
              const restBone = template.rest!.bones.find((x) => x.name === b)!;
              const turned = rotationInRoot(raw(b), root).multiply(restBone.parentRest.clone().multiply(restBone.localRest).invert());
              expect(rotationError(turned, rotationInRoot(proxy(b), root)), `${b} rotation`).toBeLessThan(TOL);
              const parent = proxy(b).parent?.name;
              if (parent === undefined || !RIG_SET.has(parent)) continue;
              const a = parent as RigHumanoidBone;
              expect(dir(raw(a), raw(b)).distanceTo(dir(proxy(a), proxy(b))), `${a} → ${b}`).toBeLessThan(TOL);
            }
          } finally {
            instance.dispose();
            template.dispose();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
