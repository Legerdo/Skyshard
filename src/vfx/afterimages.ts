// Perfect_Dodge afterimages and Stagger stars (design "월드·진행 연출" 전투 연출, "타격 피드백"; Req 24.9, 26.9).
//
// Afterimages: on a Perfect_Dodge the character's meshes are copied three times, AFTERIMAGE_INTERVAL real seconds
// apart, as frozen translucent fresnel ghosts (world matrices, and for skinned meshes the bone matrices, copied at
// that moment) that fade out over the 0.5 s slow motion. Ghost meshes share the source geometry and are pooled per
// slot, so a dodge allocates nothing once the pool has seen the character's mesh count.
//
// Stagger stars: while an enemy (or Caelith) is staggered, three star billboards circle over its head.

import * as THREE from 'three';
import type { Vec3 } from '../core/types';
import { AFTERIMAGE_COUNT, AFTERIMAGE_INTERVAL, AFTERIMAGE_SECONDS, STAGGER_STARS, STAGGER_STAR_SPIN } from './catalog';
import { spriteUv } from './atlas';
import { VFX_RENDER_ORDER } from './meshFx';

const GHOST_VERT = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
varying vec3 vNormal;
varying vec3 vView;
void main() {
  #include <skinbase_vertex>
  #include <beginnormal_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
  vNormal = normalize(normalMatrix * objectNormal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const GHOST_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  float fresnel = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.0);
  gl_FragColor = vec4(uColor * (0.6 + 0.8 * fresnel), uOpacity * (0.25 + 0.75 * fresnel));
  #include <colorspace_fragment>
}`;

interface Ghost {
  group: THREE.Group;
  meshes: THREE.Mesh[];
  material: THREE.ShaderMaterial;
  t: number;
  /** Real seconds until this ghost's snapshot is taken. */
  wait: number;
  active: boolean;
}

export class Afterimages {
  readonly object = new THREE.Group();
  private readonly ghosts: Ghost[] = [];
  private readonly skinnedMaterial: THREE.ShaderMaterial[] = [];
  private source: THREE.Object3D | null = null;

  constructor() {
    this.object.name = 'vfxAfterimages';
    for (let i = 0; i < AFTERIMAGE_COUNT; i++) {
      const material = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(0xbfe4ff) }, uOpacity: { value: 0 } },
        vertexShader: GHOST_VERT, fragmentShader: GHOST_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const group = new THREE.Group();
      group.visible = false;
      this.object.add(group);
      this.ghosts.push({ group, meshes: [], material, t: 0, wait: 0, active: false });
    }
  }

  /** Ghosts showing now (tests). */
  get active(): number {
    return this.ghosts.filter((g) => g.active && g.wait <= 0).length;
  }

  /** Starts the three afterimages of `source` (the Active_Character's model root) tinted `color`. */
  trigger(source: THREE.Object3D | null, color: number): void {
    this.source = source;
    this.ghosts.forEach((g, i) => {
      g.active = source !== null;
      g.t = 0;
      g.wait = i * AFTERIMAGE_INTERVAL;
      (g.material.uniforms.uColor as { value: THREE.Color }).value.setHex(color);
      if (g.wait <= 0) this.snapshot(g);
    });
  }

  update(dt: number): void {
    for (const g of this.ghosts) {
      if (!g.active) continue;
      if (g.wait > 0) {
        g.wait -= dt;
        if (g.wait > 0) continue;
        this.snapshot(g);
      }
      g.t += dt;
      const life = AFTERIMAGE_SECONDS - (this.ghosts.indexOf(g) * AFTERIMAGE_INTERVAL);
      const k = Math.min(1, g.t / Math.max(0.05, life));
      (g.material.uniforms.uOpacity as { value: number }).value = 0.55 * (1 - k);
      if (k >= 1) {
        g.active = false;
        g.group.visible = false;
      }
    }
  }

  clear(): void {
    for (const g of this.ghosts) {
      g.active = false;
      g.group.visible = false;
    }
  }

  dispose(): void {
    for (const g of this.ghosts) g.material.dispose();
    for (const m of this.skinnedMaterial) m.dispose();
    this.object.clear();
  }

  /** Copies the source's meshes (world matrices, bone matrices) into ghost `g`. */
  private snapshot(g: Ghost): void {
    const source = this.source;
    if (source === null) {
      g.active = false;
      return;
    }
    source.updateWorldMatrix(true, true);
    const found: THREE.Mesh[] = [];
    source.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh === true && !(o as THREE.InstancedMesh).isInstancedMesh) found.push(o as THREE.Mesh);
    });
    found.forEach((src, i) => {
      const skinned = (src as THREE.SkinnedMesh).isSkinnedMesh === true;
      let ghost = g.meshes[i];
      if (ghost === undefined || ((ghost as THREE.SkinnedMesh).isSkinnedMesh === true) !== skinned) {
        if (ghost !== undefined) g.group.remove(ghost);
        ghost = skinned ? this.makeSkinned(g, src as THREE.SkinnedMesh) : new THREE.Mesh(src.geometry, g.material);
        ghost.matrixAutoUpdate = false;
        ghost.frustumCulled = false;
        ghost.renderOrder = VFX_RENDER_ORDER;
        g.meshes[i] = ghost;
        g.group.add(ghost);
      }
      ghost.geometry = src.geometry;
      ghost.visible = true;
      ghost.matrix.copy(src.matrixWorld);
      ghost.matrixWorld.copy(src.matrixWorld);
      if (skinned) this.freezeBones(ghost as THREE.SkinnedMesh, src as THREE.SkinnedMesh);
    });
    for (let i = found.length; i < g.meshes.length; i++) (g.meshes[i] as THREE.Mesh).visible = false;
    g.group.visible = true;
  }

  private makeSkinned(g: Ghost, src: THREE.SkinnedMesh): THREE.SkinnedMesh {
    const material = g.material.clone();
    material.uniforms = g.material.uniforms; // shares colour and opacity
    this.skinnedMaterial.push(material);
    const mesh = new THREE.SkinnedMesh(src.geometry, material);
    const bones = src.skeleton.bones.map(() => {
      const b = new THREE.Bone();
      b.matrixAutoUpdate = false;
      b.matrixWorldAutoUpdate = false;
      return b;
    });
    mesh.bind(new THREE.Skeleton(bones, src.skeleton.boneInverses.map((m) => m.clone())), src.bindMatrix.clone());
    return mesh;
  }

  /** Detached bones holding the source's world bone matrices at this moment. */
  private freezeBones(ghost: THREE.SkinnedMesh, src: THREE.SkinnedMesh): void {
    ghost.bindMatrix.copy(src.bindMatrix);
    ghost.bindMatrixInverse.copy(src.bindMatrixInverse);
    const n = Math.min(ghost.skeleton.bones.length, src.skeleton.bones.length);
    for (let i = 0; i < n; i++) (ghost.skeleton.bones[i] as THREE.Bone).matrixWorld.copy((src.skeleton.bones[i] as THREE.Bone).matrixWorld);
  }
}

/** Staggered bodies to mark: id, head point (m). */
export interface StaggerMark {
  readonly id: string;
  readonly head: Readonly<Vec3>;
}

export class StaggerStars {
  readonly object = new THREE.Group();
  private readonly groups: { key: string | null; group: THREE.Group; t: number }[] = [];
  private readonly material: THREE.SpriteMaterial;
  private readonly texture: THREE.Texture;

  constructor(atlas: THREE.Texture) {
    this.object.name = 'vfxStaggerStars';
    this.texture = atlas.clone();
    const uv = spriteUv('star');
    this.texture.offset.set(uv.u0, uv.v0);
    this.texture.repeat.set(uv.u1 - uv.u0, uv.v1 - uv.v0);
    this.texture.needsUpdate = true;
    this.material = new THREE.SpriteMaterial({ map: this.texture, color: 0xfff1a0, transparent: true, depthWrite: false });
    for (let i = 0; i < 6; i++) this.addGroup();
  }

  get active(): number {
    return this.groups.filter((g) => g.key !== null).length;
  }

  /** Shows the stars over exactly `marks`; `dt` real seconds spin them. */
  sync(marks: readonly StaggerMark[], dt: number): void {
    const keys = new Set(marks.map((m) => m.id));
    for (const g of this.groups) {
      if (g.key !== null && !keys.has(g.key)) {
        g.key = null;
        g.group.visible = false;
      }
    }
    for (const m of marks) {
      let g = this.groups.find((x) => x.key === m.id);
      if (g === undefined) {
        g = this.groups.find((x) => x.key === null) ?? this.addGroup();
        g.key = m.id;
        g.t = 0;
      }
      g.t += dt;
      g.group.position.set(m.head.x, m.head.y + 0.35, m.head.z);
      g.group.rotation.y = g.t * STAGGER_STAR_SPIN;
      g.group.visible = true;
    }
  }

  dispose(): void {
    this.material.dispose();
    this.texture.dispose();
    this.object.clear();
  }

  private addGroup(): { key: string | null; group: THREE.Group; t: number } {
    const group = new THREE.Group();
    for (let i = 0; i < STAGGER_STARS; i++) {
      const star = new THREE.Sprite(this.material);
      const a = (i / STAGGER_STARS) * Math.PI * 2;
      star.position.set(Math.sin(a) * 0.38, 0.05 * Math.sin(a * 2), Math.cos(a) * 0.38);
      star.scale.setScalar(0.26);
      star.renderOrder = VFX_RENDER_ORDER + 2;
      group.add(star);
    }
    group.visible = false;
    this.object.add(group);
    const entry = { key: null as string | null, group, t: 0 };
    this.groups.push(entry);
    return entry;
  }
}
