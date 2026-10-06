/*
 * VRM adapter (design.md "Visual_Provider" table, `vrm` row): GLTFLoader + `VRMLoaderPlugin` from `@pixiv/three-vrm`.
 * Only ./externalLoaders imports this module, by dynamic import, so three-vrm is a separate chunk requested only when
 * the Visual_Manifest has a VRM entry.
 *
 * - Humanoid: the VRM humanoid definition supplies the bone map (raw bone nodes); the pose goes through the shared
 *   retarget (raw = P⁻¹·q·P·R, the same transfer as three-vrm's normalized rig, so `autoUpdateHumanBones` is off).
 * - VRM 0.x faces −Z: the template turns it with `yawDeg` (default 180°), i.e. VRMUtils.rotateVRM0 is never applied
 *   on top of it.
 * - Per instance (a clone of the loaded scene): spring bones rebuilt on the cloned nodes (joints, colliders, collider
 *   groups, centers) in a VRMSpringBoneManager of its own, and expressions (blink, talk) as the cloned meshes' morph
 *   target binds. Spring colliders, expression nodes and three-vrm's normalized rig are left out of the clone.
 * - Materials: MToon ('original', the VRM default) or the game's toon; both get the shared flash / opacity / dissolve.
 */
import {
  VRMExpressionMorphTargetBind, VRMLoaderPlugin, VRMSpringBoneCollider, VRMSpringBoneJoint, VRMSpringBoneManager, VRMUtils,
  type VRM, type VRMHumanBoneName, type VRMSpringBoneColliderGroup,
} from '@pixiv/three-vrm';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HUMANOID_BONE_NAMES, type HumanoidBoneName } from '../data/visualManifest';
import type { LoadedModel, VrmInstanceParts, VrmModelInfo } from './externalModel';
import { ModelLoadError } from './modelFormat';

interface ExpressionBinds {
  readonly isBinary: boolean;
  readonly binds: readonly { readonly mesh: THREE.Mesh; readonly index: number; readonly weight: number }[];
}

class VrmParts implements VrmInstanceParts {
  private readonly manager = new VRMSpringBoneManager();
  private readonly expressions = new Map<string, ExpressionBinds>();
  private readonly colliders: VRMSpringBoneCollider[] = [];

  constructor(vrm: VRM, map: ReadonlyMap<THREE.Object3D, THREE.Object3D>) {
    // three-vrm leaves springBoneManager null (not undefined) for a VRM without VRMC_springBone (it is optional).
    const source = vrm.springBoneManager ?? undefined;
    if (source !== undefined) {
      const colliderMap = new Map<VRMSpringBoneCollider, VRMSpringBoneCollider>();
      for (const c of source.colliders) {
        const parent = c.parent === null ? undefined : map.get(c.parent);
        if (parent === undefined) continue;
        const copy = new VRMSpringBoneCollider(c.shape);
        copy.name = c.name;
        copy.position.copy(c.position);
        copy.quaternion.copy(c.quaternion);
        copy.scale.copy(c.scale);
        parent.add(copy);
        colliderMap.set(c, copy);
        this.colliders.push(copy);
      }
      const groups = new Map<VRMSpringBoneColliderGroup, VRMSpringBoneColliderGroup>();
      for (const g of source.colliderGroups) {
        groups.set(g, { name: g.name, colliders: g.colliders.map((c) => colliderMap.get(c)).filter((c): c is VRMSpringBoneCollider => c !== undefined) });
      }
      for (const j of source.joints) {
        const bone = map.get(j.bone);
        if (bone === undefined) continue;
        const child = j.child === null ? null : map.get(j.child) ?? null;
        const joint = new VRMSpringBoneJoint(
          bone, child, { ...j.settings, gravityDir: j.settings.gravityDir.clone() },
          j.colliderGroups.map((g) => groups.get(g)).filter((g): g is VRMSpringBoneColliderGroup => g !== undefined),
        );
        if (j.center !== null) joint.center = map.get(j.center) ?? null;
        this.manager.addJoint(joint);
      }
    }
    for (const e of vrm.expressionManager?.expressions ?? []) {
      const binds: { mesh: THREE.Mesh; index: number; weight: number }[] = [];
      for (const b of e.binds) {
        if (!(b instanceof VRMExpressionMorphTargetBind)) continue;
        for (const primitive of b.primitives) {
          const mesh = map.get(primitive);
          if (mesh instanceof THREE.Mesh) binds.push({ mesh, index: b.index, weight: b.weight });
        }
      }
      this.expressions.set(e.expressionName, { isBinary: e.isBinary, binds });
    }
  }

  setInitState(): void {
    this.manager.setInitState();
  }

  update(dt: number): void {
    if (dt > 0) this.manager.update(dt);
  }

  reset(): void {
    this.manager.reset();
  }

  hasExpression(name: string): boolean {
    return (this.expressions.get(name)?.binds.length ?? 0) > 0;
  }

  setExpression(name: string, weight: number): void {
    const e = this.expressions.get(name);
    if (e === undefined) return;
    const w = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0;
    const value = e.isBinary ? (w > 0.5 ? 1 : 0) : w;
    for (const b of e.binds) {
      const influences = b.mesh.morphTargetInfluences;
      if (influences !== undefined && b.index < influences.length) influences[b.index] = value * b.weight;
    }
  }

  dispose(): void {
    for (const c of this.colliders) c.parent?.remove(c);
    this.colliders.length = 0;
  }
}

/** Parses a .vrm (GLB with the VRMC_vrm / VRM extension); throws ModelLoadError when it is no VRM. */
export async function parseVrmBuffer(buffer: ArrayBuffer, path: string): Promise<LoadedModel> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser, { autoUpdateHumanBones: false }));
  const gltf = await loader.parseAsync(buffer, path);
  const vrm = (gltf.userData as { vrm?: VRM }).vrm;
  if (vrm === undefined) throw new ModelLoadError('not a VRM file (no VRM humanoid extension)');
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  const humanBones = new Map<HumanoidBoneName, THREE.Object3D>();
  for (const bone of HUMANOID_BONE_NAMES) {
    const node = vrm.humanoid.getRawBoneNode(bone as VRMHumanBoneName);
    if (node !== null) humanBones.set(bone, node);
  }
  const skipped = new Set<THREE.Object3D>([vrm.humanoid.normalizedHumanBonesRoot]);
  for (const e of vrm.expressionManager?.expressions ?? []) skipped.add(e);
  const info: VrmModelInfo = {
    version: vrm.meta.metaVersion === '0' ? '0' : '1',
    humanBones,
    skip: (node) => skipped.has(node) || node instanceof VRMSpringBoneCollider,
    instantiate: (map) => new VrmParts(vrm, map),
    dispose: () => VRMUtils.deepDispose(vrm.scene),
  };
  return { kind: 'vrm', scene: vrm.scene, animations: gltf.animations, vrm: info };
}
