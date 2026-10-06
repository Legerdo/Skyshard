import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { HERO_LOOKS, heroRigSpec } from '../../../src/anim/heroes';
import { modelRigSpec } from '../../../src/anim/models';
import { buildRig, chainWeights, prepareRig, RIG_ATTRIBUTES } from '../../../src/anim/rigKit';
import { buildLayout, RIG_HUMANOID_BONES, RIG_SOCKETS } from '../../../src/anim/rigLayout';
import {
  patchRigFragment, patchRigOutlineVertex, patchRigVertex, RIG_OUTLINE_PROGRAM_KEY, RIG_PROGRAM_KEY, rigOutlineMaterial, rigUniformsOf,
} from '../../../src/anim/rigMaterial';
import type { RigBuild, RigSpec } from '../../../src/anim/rigTypes';
import { createWeapon } from '../../../src/anim/weapons';
import { CAPSULE_HEIGHT, CAPSULE_RADIUS } from '../../../src/player/core/constants';
import { CHARACTER_IDS, isCharacterId, type CharacterId } from '../../../src/data/ids';
import { VISUAL_ENTITY_IDS } from '../../../src/data/visualManifest';
import { patchToonFragment } from '../../../src/render/toonMaterial';

// Tasks 19.1 / 19.2: the rig kit (deterministic skeleton + merged rigid skinning, shared body/outline) and the heroes,
// in Node: no WebGL and no canvas (faceAtlas: false).

const NODE = { faceAtlas: false } as const;
const build = (spec: RigSpec): RigBuild => buildRig(spec, NODE);
const hero = (id: CharacterId): RigBuild => {
  const rig = build(heroRigSpec(id));
  rig.root.updateMatrixWorld(true);
  return rig;
};

describe('rig kit: skeleton', () => {
  it('names the humanoid joints after the VRM humanoid bones, plus root, sockets and spring joints, in the design hierarchy', () => {
    const rig = hero('kairen');
    const names = rig.skeleton.bones.map((b) => b.name);
    for (const name of [...RIG_HUMANOID_BONES, 'root', ...RIG_SOCKETS]) expect(names).toContain(name);
    expect(names.filter((n) => n.startsWith('scarf_'))).toEqual(['scarf_0', 'scarf_1', 'scarf_2', 'scarf_3', 'scarf_4', 'scarf_5']);
    const parent = (name: string): string | undefined => rig.bones.get(name)?.parent?.name;
    expect(['hips', 'spine', 'chest', 'neck', 'head'].map(parent)).toEqual(['root', 'hips', 'spine', 'chest', 'neck']);
    for (const side of ['left', 'right']) {
      expect(parent(`${side}Shoulder`)).toBe('chest');
      expect(parent(`${side}UpperArm`)).toBe(`${side}Shoulder`);
      expect(parent(`${side}LowerArm`)).toBe(`${side}UpperArm`);
      expect(parent(`${side}Hand`)).toBe(`${side}LowerArm`);
      expect(parent(`${side}UpperLeg`)).toBe('hips');
      expect(parent(`${side}LowerLeg`)).toBe(`${side}UpperLeg`);
      expect(parent(`${side}Foot`)).toBe(`${side}LowerLeg`);
    }
    expect(parent('scarf_0')).toBe('neck');
    expect(parent('back')).toBe('chest');
    expect(parent('headTop')).toBe('head');
  });

  it('rests in a +Z-facing T-pose with every joint world rotation identity', () => {
    for (const id of CHARACTER_IDS) {
      const rig = hero(id);
      const q = new THREE.Quaternion();
      for (const bone of rig.skeleton.bones) {
        bone.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3());
        expect(Math.abs(q.w), `${id} ${bone.name}`).toBeCloseTo(1, 9);
        expect(bone.quaternion.equals(new THREE.Quaternion()), bone.name).toBe(true);
      }
      const at = (name: string): THREE.Vector3 => rig.bones.get(name)!.getWorldPosition(new THREE.Vector3());
      // Arms straight out along ±X at one height (left = +X), legs down.
      expect(at('leftHand').x).toBeGreaterThan(at('leftLowerArm').x);
      expect(at('leftLowerArm').x).toBeGreaterThan(at('leftUpperArm').x);
      expect(at('rightHand').x).toBeLessThan(at('rightUpperArm').x);
      expect(at('leftHand').y).toBeCloseTo(at('leftUpperArm').y, 9);
      expect(at('leftFoot').y).toBeLessThan(at('leftLowerLeg').y);
      expect(at('head').y).toBeGreaterThan(at('neck').y);
      // The face plane is on the +Z side of the head.
      const pos = rig.body.geometry.getAttribute('position');
      const fx = rig.body.geometry.getAttribute('aFx');
      let faceZ = 0;
      let n = 0;
      for (let i = 0; i < fx.count; i++) {
        if (fx.getY(i) === 1) {
          faceZ += pos.getZ(i);
          n++;
        }
      }
      expect(n).toBeGreaterThan(0);
      expect(faceZ / n).toBeGreaterThan(at('head').z + 0.05);
    }
  });

  it('builds every preset with its sockets', () => {
    for (const id of ['bramblekin', 'thornspitter', 'slagshell', 'ashWisp', 'mossbackBrute'] as const) {
      const spec = modelRigSpec(id);
      const rig = build(spec);
      for (const s of RIG_SOCKETS) expect(rig.sockets.get(s), `${id} ${s}`).toBeInstanceOf(THREE.Bone);
      expect(rig.skeleton.bones.length).toBeGreaterThan(6);
      rig.dispose();
    }
    const layouts = (['quadruped', 'crab', 'stalk', 'floater'] as const).map((preset) => buildLayout({ preset, height: 1.5, headRatio: 6, shoulderScale: 1, springs: [] }));
    expect(layouts[0]!.has('leftFrontFoot')).toBe(true);
    expect(layouts[1]!.has('rightLeg2Foot')).toBe(true);
    expect(layouts[2]!.has('petal4')).toBe(true);
    expect(layouts[3]!.has('leftWing2')).toBe(true);
  });

  it('rejects chains outside 4–8 segments and unknown joints', () => {
    const base = { preset: 'humanoid' as const, height: 1.7, headRatio: 6, shoulderScale: 1 };
    expect(() => buildLayout({ ...base, springs: [{ id: 'x', parent: 'head', segments: 3, segLength: 0.1 }] })).toThrow(/4–8/);
    expect(() => buildLayout({ ...base, springs: [{ id: 'x', parent: 'tail', segments: 5, segLength: 0.1 }] })).toThrow(/unknown parent/);
    expect(() => buildRig({ ...heroRigSpec('kairen'), parts: [{ geometry: new THREE.BoxGeometry(), joint: 'wing', zone: 'primary' }] }, NODE)).toThrow(/wing/);
  });
});

describe('rig kit: merged geometry and draw calls', () => {
  it('body and outline share one geometry and one Skeleton; the outline collapses the face plane', () => {
    const rig = hero('isla');
    expect(rig.outline).toBeInstanceOf(THREE.SkinnedMesh);
    expect(rig.outline.geometry).toBe(rig.body.geometry);
    expect(rig.outline.skeleton).toBe(rig.body.skeleton);
    expect(rig.outline.skeleton).toBe(rig.skeleton);
    expect(rig.outline.material).toBe(rigOutlineMaterial());
    expect((rig.outline.material as THREE.Material).side).toBe(THREE.BackSide);
    expect((rig.outline.material as THREE.Material).customProgramCacheKey()).toBe(RIG_OUTLINE_PROGRAM_KEY);
    const vertex = patchRigOutlineVertex(THREE.ShaderLib.basic.vertexShader);
    expect(vertex).toMatch(/attribute vec2 aFx;/);
    expect(vertex).toMatch(/if \( aFx\.y > 0\.5 \) transformed = vec3\( 0\.0 \);\s*#include <project_vertex>/);
    // Two meshes to draw per rig (weapon meshes are separate).
    const meshes: THREE.Mesh[] = [];
    rig.body.traverse((o) => {
      if (o instanceof THREE.Mesh && o.userData.rigWeapon !== true && !(o.parent?.userData.rigWeapon === true)) meshes.push(o);
    });
    expect(meshes).toEqual([rig.body, rig.outline]);
  });

  it('merges parts with the aligned attribute set: rigid weight 1, chain parts smoothstepped between neighbours', () => {
    const rig = hero('kairen');
    const g = rig.body.geometry;
    expect(Object.keys(g.attributes).sort()).toEqual([...RIG_ATTRIBUTES].sort());
    const count = g.getAttribute('position').count;
    for (const name of RIG_ATTRIBUTES) expect(g.getAttribute(name).count, name).toBe(count);
    expect(g.getIndex()).not.toBeNull();
    const si = g.getAttribute('skinIndex');
    const sw = g.getAttribute('skinWeight');
    const names = rig.skeleton.bones.map((b) => b.name);
    let split = 0;
    for (let i = 0; i < count; i++) {
      expect(sw.getX(i) + sw.getY(i) + sw.getZ(i) + sw.getW(i)).toBeCloseTo(1, 6);
      expect(sw.getZ(i) + sw.getW(i)).toBe(0);
      if (sw.getY(i) > 0) {
        split++;
        const a = names[si.getX(i)]!;
        const b = names[si.getY(i)]!;
        expect(a).toMatch(/^scarf_\d$/);
        expect(Math.abs(Number(b.slice(6)) - Number(a.slice(6)))).toBe(1);
      } else {
        expect(sw.getX(i)).toBe(1);
      }
    }
    expect(split).toBeGreaterThan(0);
    const layout = buildLayout({ ...heroRigSpec('kairen') });
    const chain = layout.chains.get('scarf')!;
    const at = (s: number): readonly [number, number, number] => {
      const p = chain.points[0]!;
      return [p[0] + chain.dir[0] * s * 0.1, p[1] + chain.dir[1] * s * 0.1, p[2] + chain.dir[2] * s * 0.1];
    };
    const mid = chainWeights(chain, at(2));
    expect([mid[0], mid[2]]).toEqual([1, 2]);
    expect(mid[1]).toBeCloseTo(0.5, 9);
    expect(mid[3]).toBeCloseTo(0.5, 9);
    expect(chainWeights(chain, at(2.5))).toEqual([2, 1, 2, 0]);
    const near = chainWeights(chain, at(2.2));
    expect(near[0]).toBe(1);
    expect(near[3]).toBeGreaterThan(0.5);
    expect(near[3]).toBeLessThan(1);
  });

  it('winds the shape builders outward, consistent with their normals', () => {
    const agree = (g: THREE.BufferGeometry): number => {
      const pos = g.getAttribute('position');
      const nrm = g.getAttribute('normal');
      const index = g.getIndex()!;
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const c = new THREE.Vector3();
      const n = new THREE.Vector3();
      let ok = 0;
      let total = 0;
      for (let i = 0; i < index.count; i += 3) {
        a.fromBufferAttribute(pos, index.getX(i));
        b.fromBufferAttribute(pos, index.getX(i + 1));
        c.fromBufferAttribute(pos, index.getX(i + 2));
        const face = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
        if (face.lengthSq() < 1e-14) continue;
        n.fromBufferAttribute(nrm, index.getX(i)).add(new THREE.Vector3().fromBufferAttribute(nrm, index.getX(i + 1))).add(new THREE.Vector3().fromBufferAttribute(nrm, index.getX(i + 2)));
        total++;
        if (face.dot(n) > 0) ok++;
      }
      return ok / total;
    };
    const g = prepareRig(heroRigSpec('kairen')).geometry;
    expect(agree(g)).toBeGreaterThan(0.97);
    // Normals point away from the body axis for most of the body (not inside-out).
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    let outward = 0;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getX(i)) > 0.15 || pos.getY(i) < 0.3 || pos.getY(i) > 1.3) continue; // torso band
      if (pos.getX(i) * nrm.getX(i) + pos.getZ(i) * nrm.getZ(i) > 0) outward++;
      else outward--;
    }
    expect(outward).toBeGreaterThan(0);
  });

  it('is deterministic: the same spec builds identical attributes', () => {
    for (const id of CHARACTER_IDS) {
      const a = prepareRig(heroRigSpec(id)).geometry;
      const b = prepareRig(heroRigSpec(id)).geometry;
      for (const name of RIG_ATTRIBUTES) {
        expect(Array.from(a.getAttribute(name).array), `${id} ${name}`).toEqual(Array.from(b.getAttribute(name).array));
      }
      expect(Array.from(a.getIndex()!.array)).toEqual(Array.from(b.getIndex()!.array));
    }
  });

  it('builds all the rigs of a boot well inside the 200 ms loading budget', () => {
    // Every model of a boot: 4 heroes, 8 enemies, 6 Elites, 7 NPCs and Caelith (design "Rig kit": 200 ms in total).
    // The faster of two passes, so a busy parallel test run does not decide it.
    const pass = (): number => {
      const t0 = performance.now();
      for (const id of CHARACTER_IDS) buildRig(heroRigSpec(id), NODE).dispose();
      for (const id of VISUAL_ENTITY_IDS) {
        if (!isCharacterId(id)) buildRig(modelRigSpec(id), NODE).dispose();
      }
      return performance.now() - t0;
    };
    expect(Math.min(pass(), pass())).toBeLessThan(200);
  });

  it('uses one rig program whose uniforms drive the face cell, glow and flash', () => {
    const rig = hero('wren');
    const material = rig.material;
    expect(material.customProgramCacheKey()).toBe(RIG_PROGRAM_KEY);
    expect(hero('talus').material.customProgramCacheKey()).toBe(RIG_PROGRAM_KEY);
    const u = rigUniformsOf(material)!;
    rig.setFaceCell(2, 1);
    expect(u.faceCell.value.toArray()).toEqual([1, 2]);
    expect(u.uGlow.value).toBeCloseTo(0.3, 9);
    rig.setGlow(1);
    expect(u.uGlow.value).toBe(1);
    rig.setFlash(0.5, 0xff0000);
    expect(u.uFlash.value).toBe(0.5);
    // The patch applies on top of the toon patch (the chunks it needs survive).
    const shader = {
      uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.toon.uniforms),
      vertexShader: THREE.ShaderLib.toon.vertexShader,
      fragmentShader: THREE.ShaderLib.toon.fragmentShader,
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.uniforms.faceCell).toBe(u.faceCell);
    expect(shader.fragmentShader).toMatch(/texture2D\( faceMap/);
    expect(shader.fragmentShader).toMatch(/uGlowColor \* \( vRigFx\.x \* uGlow/);
    expect(shader.vertexShader).toMatch(/vRigFx = aFx;/);
    expect(() => patchRigFragment(patchToonFragment(THREE.ShaderLib.toon.fragmentShader))).not.toThrow();
    expect(() => patchRigVertex(THREE.ShaderLib.toon.vertexShader)).not.toThrow();
  });
});

describe('heroes (task 19.2)', () => {
  const box = (rig: RigBuild): THREE.Box3 => {
    rig.body.geometry.computeBoundingBox();
    return rig.body.geometry.boundingBox!.clone();
  };

  it('stand on the collision capsule bottom at their visual heights (Kairen 1.72, Isla 1.80, Wren 1.45, Talus 2.05 m)', () => {
    expect(CAPSULE_RADIUS).toBe(0.4);
    expect(CAPSULE_HEIGHT).toBe(1.75);
    const heights: Record<CharacterId, number> = { kairen: 1.72, isla: 1.8, wren: 1.45, talus: 2.05 };
    for (const id of CHARACTER_IDS) {
      const b = box(hero(id));
      expect(HERO_LOOKS[id].height).toBe(heights[id]);
      expect(b.min.y, id).toBeGreaterThanOrEqual(-0.005);
      expect(b.min.y, id).toBeLessThan(0.03);
      expect(b.max.y / heights[id], id).toBeGreaterThan(0.97);
      expect(b.max.y / heights[id], id).toBeLessThan(1.06);
    }
  });

  it('differ in width (Talus ≥ 1.5× everyone), silhouette accent chains and main colour', () => {
    const shoulders = (id: CharacterId): number => {
      const layout = buildLayout(heroRigSpec(id));
      return layout.pos('leftUpperArm')[0] - layout.pos('rightUpperArm')[0];
    };
    for (const id of ['kairen', 'isla', 'wren'] as const) expect(shoulders('talus') / shoulders(id), id).toBeGreaterThanOrEqual(1.5);
    const chains = (id: CharacterId): Record<string, number> => Object.fromEntries(heroRigSpec(id).springs.map((s) => [s.id, s.segments]));
    expect(chains('kairen')).toEqual({ scarf: 6 });
    expect(chains('isla')).toMatchObject({ ponytail: 7 });
    expect(chains('wren')).toHaveProperty('cape');
    const hues = CHARACTER_IDS.map((id) => new THREE.Color(HERO_LOOKS[id].palette.primary).getHSL({ h: 0, s: 0, l: 0 }).h * 360);
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const d = Math.abs(hues[i]! - hues[j]!);
        expect(Math.min(d, 360 - d), `${CHARACTER_IDS[i]} vs ${CHARACTER_IDS[j]}`).toBeGreaterThan(20);
      }
    }
    // Every hero has Element glow lines (aFx.x > 0) in its element colour zone.
    for (const id of CHARACTER_IDS) {
      const fx = hero(id).body.geometry.getAttribute('aFx');
      let glowing = 0;
      for (let i = 0; i < fx.count; i++) if (fx.getX(i) > 0) glowing++;
      expect(glowing, id).toBeGreaterThan(20);
    }
  });

  it('stay inside the character triangle budget (≈ 6k without the outline)', () => {
    for (const id of CHARACTER_IDS) {
      const { triangles } = prepareRig(heroRigSpec(id));
      expect(triangles, id).toBeGreaterThan(2500);
      expect(triangles, id).toBeLessThan(7500);
    }
  });

  it('hold their weapons in the design sockets and stow them on the back', () => {
    const expected: Record<CharacterId, [string, string]> = {
      kairen: ['weaponR', 'rightHand'], isla: ['weaponL', 'leftHand'], wren: ['weaponR', 'rightHand'], talus: ['weaponL', 'leftLowerArm'],
    };
    for (const id of CHARACTER_IDS) {
      const rig = hero(id);
      const weapon = createWeapon(HERO_LOOKS[id].weapon, rig.spec.palette, rig.material);
      rig.equip(weapon);
      const [socket, parent] = expected[id];
      expect(weapon.mesh.parent).toBe(rig.sockets.get(socket as 'weaponR'));
      expect(weapon.mesh.parent?.parent?.name).toBe(parent);
      expect(weapon.outline.parent).toBe(weapon.mesh);
      expect(weapon.outline.geometry).toBe(weapon.mesh.geometry);
      const attrs = Object.keys(weapon.mesh.geometry.attributes).sort();
      expect(attrs).toEqual(['aFx', 'color', 'normal', 'position', 'uv']);
      expect(weapon.anchors.tip.distanceTo(weapon.anchors.base)).toBeGreaterThan(0.3);
      rig.stowWeapon(true);
      expect(weapon.mesh.parent).toBe(rig.sockets.get('back'));
      rig.stowWeapon(false);
      expect(weapon.mesh.parent).toBe(rig.sockets.get(socket as 'weaponR'));
      // attachWeapon replaces the socket's children.
      const other = createWeapon({ shape: 'curvedSword', length: 1.2 }, rig.spec.palette, rig.material);
      rig.equip(other);
      expect(rig.sockets.get(socket as 'weaponR')!.children).toEqual([other.mesh]);
      rig.dispose();
    }
  });

  it('draws the bow string toward the drawing hand', () => {
    const rig = hero('isla');
    const bow = createWeapon({ shape: 'recurveBow' }, rig.spec.palette, rig.material);
    rig.equip(bow);
    rig.root.updateMatrixWorld(true);
    const line = bow.mesh.children.find((c) => c.name === 'bowString') as THREE.Line;
    const mid = (): THREE.Vector3 => new THREE.Vector3().fromBufferAttribute(line.geometry.getAttribute('position') as THREE.BufferAttribute, 1);
    const rest = mid();
    const hand = rig.bones.get('rightHand')!.getWorldPosition(new THREE.Vector3());
    bow.update?.(hand);
    expect(bow.mesh.localToWorld(mid()).distanceTo(hand)).toBeLessThan(1e-6);
    bow.update?.(null);
    expect(mid().distanceTo(rest)).toBeLessThan(1e-9);
  });
});
