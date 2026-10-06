/*
 * ProceduralVisualProvider (design.md "Visual_Provider" table: `procedural` — rig kit, Humanoid_Skeleton as is,
 * always succeeds). A template prepares the entity's rig geometry once (layout + merged BufferGeometry); every
 * instance assembles its own bones, Skeleton, material instance, sockets and springs over that shared geometry, plus
 * its model extras: the heroes' weapons, the Elites' aura shell, Caelith's greatsword and starlight cape (a second
 * SkinnedMesh on the same Skeleton, geometry shared by the template), and a FaceAnimator where the model has a face.
 * Loading is synchronous under the Promise, so the default build never waits.
 */
import * as THREE from 'three';
import { CAELITH_SWORD, caelithCapeGeometry } from '../anim/caelithRig';
import { eliteAuraColor, eliteAuraWidth } from '../anim/enemyRigs';
import { FaceAnimator } from '../anim/face';
import { HERO_LOOKS } from '../anim/heroes';
import { modelRigSpec } from '../anim/models';
import { assembleRig, prepareRig, type PreparedRig } from '../anim/rigKit';
import { RIG_HUMANOID_BONES } from '../anim/rigLayout';
import { capeUniformsOf, createCapeMaterial } from '../anim/rigMaterial';
import type { RigBuild, RigBuildOptions, RigSpec } from '../anim/rigTypes';
import { createWeapon } from '../anim/weapons';
import { isCharacterId, isEliteId, type VisualEntityId } from '../data/ids';
import type { HumanoidBoneName, SocketName, VisualSpec } from '../data/visualManifest';
import type { HumanoidPoseTarget, VisualInstance, VisualProvider, VisualTemplate } from './types';

/** The procedural RigSpec of any entity (heroes, enemies, Elites, NPCs, Caelith). */
export function proceduralRigSpec(id: VisualEntityId): RigSpec {
  return modelRigSpec(id);
}

/** One procedural model instance: the rig plus its weapon, extras and face timing. */
export class ProceduralVisualInstance implements VisualInstance {
  readonly root: THREE.Object3D;
  readonly humanoid: HumanoidPoseTarget | null;
  readonly mixer = null;
  readonly sockets: ReadonlyMap<SocketName, THREE.Object3D>;
  readonly joints: ReadonlyMap<string, THREE.Object3D>;
  readonly height: number;
  readonly face: FaceAnimator | null;
  private blinkWeight = 0;
  private capeTransparent = false;

  constructor(readonly id: VisualEntityId, readonly rig: RigBuild, readonly cape: THREE.SkinnedMesh | null = null) {
    this.root = rig.root;
    this.sockets = rig.sockets;
    this.joints = rig.bones;
    this.height = rig.spec.height;
    this.root.userData.visualEntity = id;
    if (rig.spec.preset === 'humanoid') {
      const bones = new Map<HumanoidBoneName, THREE.Object3D>();
      for (const name of RIG_HUMANOID_BONES) {
        const bone = rig.bones.get(name);
        if (bone !== undefined) bones.set(name, bone);
      }
      this.humanoid = { bones, restHipsHeight: rig.layout.pos('hips')[1] };
    } else {
      this.humanoid = null;
    }
    this.face = rig.spec.face === undefined ? null : new FaceAnimator(`face:${id}`, (eye, mouth) => rig.setFaceCell(eye, mouth));
  }

  setOpacity(a: number): void {
    this.rig.setOpacity(a);
  }

  setFlash(t: number, color?: THREE.ColorRepresentation): void {
    this.rig.setFlash(t, color);
  }

  setDissolve(amount: number, rise = false): void {
    this.rig.setDissolve(amount, rise);
    if (this.cape !== null) {
      // The cape fades with the body (switching to blending once).
      const material = this.cape.material as THREE.MeshBasicMaterial;
      const transparent = amount > 0;
      if (transparent !== this.capeTransparent) {
        this.capeTransparent = transparent;
        material.transparent = transparent;
        material.needsUpdate = true;
      }
      material.opacity = 1 - Math.min(1, Math.max(0, amount));
    }
  }

  /** blink ≥ 0.5 closes the eyes now (one blink); talk > 0 moves the mouth. */
  setExpression(name: 'blink' | 'talk', weight: number): void {
    if (this.face === null) return;
    if (name === 'talk') this.face.talking = weight > 0;
    else {
      if (weight >= 0.5 && this.blinkWeight < 0.5) this.face.blink();
      this.blinkWeight = weight;
    }
  }

  setGlow(v: number): void {
    this.rig.setGlow(v);
  }

  stowWeapon(onBack: boolean): void {
    this.rig.stowWeapon(onBack);
  }

  resetSecondary(): void {
    this.root.updateMatrixWorld(true);
    this.rig.springs.reset();
  }

  update(dt: number, wind?: Readonly<{ x: number; y: number; z: number }>): void {
    this.face?.update(dt);
    const aura = this.rig.aura;
    if (aura !== null) (aura.material as THREE.ShaderMaterial).uniforms.uTime!.value += Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (this.cape !== null) {
      const u = capeUniformsOf(this.cape.material as THREE.Material);
      if (u !== undefined) u.uTime.value += Number.isFinite(dt) && dt > 0 ? dt : 0;
    }
    this.root.updateMatrixWorld(true);
    this.rig.springs.update(dt, wind);
  }

  dispose(): void {
    this.root.parent?.remove(this.root);
    if (this.cape !== null) (this.cape.material as THREE.Material).dispose();
    this.rig.dispose();
  }
}

/** A prepared rig: geometry built once, instances share it (and Caelith's cape geometry). */
export class ProceduralVisualTemplate implements VisualTemplate {
  readonly kind = 'procedural' as const;
  readonly prepared: PreparedRig;
  private readonly capeGeometry: THREE.BufferGeometry | null;

  constructor(readonly id: VisualEntityId, spec: RigSpec, private readonly options: RigBuildOptions = {}) {
    this.prepared = prepareRig(spec);
    if (id === 'caelith') {
      const index = new Map(this.prepared.layout.joints.map((j, i) => [j.name, i]));
      this.capeGeometry = caelithCapeGeometry(this.prepared.layout, (name) => {
        const i = index.get(name);
        if (i === undefined) throw new Error(`caelith cape: unknown joint ${name}`);
        return i;
      });
    } else {
      this.capeGeometry = null;
    }
  }

  get height(): number {
    return this.prepared.spec.height;
  }

  instantiate(): ProceduralVisualInstance {
    const rig = assembleRig(this.prepared, this.options, false);
    if (isCharacterId(this.id)) {
      rig.equip(createWeapon(HERO_LOOKS[this.id].weapon, rig.spec.palette, rig.material));
    } else if (isEliteId(this.id)) {
      rig.attachAura(eliteAuraColor(this.id), eliteAuraWidth(rig.spec.height));
    }
    let cape: THREE.SkinnedMesh | null = null;
    if (this.id === 'caelith' && this.capeGeometry !== null) {
      rig.equip(createWeapon(CAELITH_SWORD, rig.spec.palette, rig.material));
      cape = new THREE.SkinnedMesh(this.capeGeometry, createCapeMaterial());
      cape.name = 'caelith:cape';
      cape.bindMode = rig.body.bindMode;
      cape.bind(rig.skeleton, rig.body.bindMatrix);
      cape.boundingSphere = rig.body.boundingSphere?.clone() ?? null;
      cape.castShadow = true;
      rig.body.add(cape);
    }
    return new ProceduralVisualInstance(this.id, rig, cape);
  }

  dispose(): void {
    this.prepared.geometry.dispose();
    this.capeGeometry?.dispose();
  }
}

/** The procedural source: rig-kit templates, cached per entity id. */
export class ProceduralVisualProvider implements VisualProvider {
  private readonly templates = new Map<VisualEntityId, ProceduralVisualTemplate>();

  constructor(private readonly options: RigBuildOptions = {}) {}

  /** The cached template of `id`, built on first use. */
  template(id: VisualEntityId): ProceduralVisualTemplate {
    let template = this.templates.get(id);
    if (template === undefined) {
      template = new ProceduralVisualTemplate(id, proceduralRigSpec(id), this.options);
      this.templates.set(id, template);
    }
    return template;
  }

  load(id: VisualEntityId, _spec: VisualSpec): Promise<VisualTemplate> {
    return Promise.resolve(this.template(id));
  }

  dispose(): void {
    for (const t of this.templates.values()) t.dispose();
    this.templates.clear();
  }
}
