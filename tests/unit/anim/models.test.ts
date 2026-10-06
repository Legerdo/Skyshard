import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CAELITH_CAPE, CAELITH_HALO, capeRootJoint } from '../../../src/anim/caelithRig';
import { DRONE_RIG_SPEC, eliteRigSpec, enemyModelHeight, enemyRigSpec, SENTINEL_RINGS } from '../../../src/anim/enemyRigs';
import { modelRigSpec } from '../../../src/anim/models';
import { prepareRig, RIG_ATTRIBUTES } from '../../../src/anim/rigKit';
import { RIG_AURA_PROGRAM_KEY, rigUniformsOf } from '../../../src/anim/rigMaterial';
import { ElementShell, SHELL_CROSSFADE_SECONDS, SHELL_ICON_INDEX, SHELL_PROGRAM_KEY, SHELL_SHATTER_SECONDS } from '../../../src/anim/shellMaterial';
import { ELEMENT_DEFS } from '../../../src/data/elements';
import { ELITE_SIZE } from '../../../src/data/enemies';
import { ELITE_IDS, ENEMY_IDS, NPC_IDS, type EliteId } from '../../../src/data/ids';
import { CaelithView, STARSHELL_RADIUS, type CaelithViewInput } from '../../../src/visual/caelithView';
import { ProceduralVisualInstance } from '../../../src/visual/proceduralProvider';
import { VisualLibrary } from '../../../src/visual/visualLibrary';

// Task 19.3: the enemy, Elite, NPC and Caelith models (Node: no WebGL, no canvas).

const library = (): VisualLibrary => new VisualLibrary({ warn: () => undefined, rig: { faceAtlas: false } });

/** Draw calls of an object tree: visible meshes, lines and points (an InstancedMesh is one). */
function drawCalls(root: THREE.Object3D): number {
  let n = 0;
  root.traverseVisible((o) => {
    if ((o as THREE.Mesh).isMesh === true || (o as THREE.Line).isLine === true || (o as THREE.Points).isPoints === true) n++;
  });
  return n;
}

/** Joint indices the body geometry is skinned to. */
function skinnedJoints(id: Parameters<typeof modelRigSpec>[0]): Set<string> {
  const p = prepareRig(modelRigSpec(id));
  const index = p.geometry.getAttribute('skinIndex');
  const weight = p.geometry.getAttribute('skinWeight');
  const out = new Set<string>();
  for (let i = 0; i < index.count; i++) {
    for (let c = 0; c < 4; c++) if (weight.getComponent(i, c) > 0) out.add(p.layout.joints[index.getComponent(i, c)]!.name);
  }
  return out;
}

describe('enemy models (8 kinds)', () => {
  it('uses the design preset per kind with its fixed parts merged: one enemy is 2 draw calls', () => {
    const presets: Record<string, string> = {
      bramblekin: 'quadruped', thornspitter: 'stalk', mossbackBrute: 'humanoid', cinderHound: 'quadruped',
      slagshell: 'crab', ashWisp: 'floater', windcutter: 'floater', aetherSentinel: 'floater',
    };
    const lib = library();
    for (const id of ENEMY_IDS) {
      const spec = enemyRigSpec(id);
      expect(spec.preset, id).toBe(presets[id]);
      const prepared = prepareRig(spec);
      expect(prepared.triangles, `${id} triangles`).toBeLessThanOrEqual(4000);
      for (const a of RIG_ATTRIBUTES) expect(prepared.geometry.getAttribute(a), `${id} ${a}`).toBeDefined();
      const view = lib.createView(id);
      expect(drawCalls(view.object), `${id} draw calls`).toBe(2);
      const rig = (view.instance as ProceduralVisualInstance).rig;
      expect(rig.outline.geometry).toBe(rig.body.geometry);
      expect(rig.outline.skeleton).toBe(rig.skeleton);
      view.dispose();
    }
  });

  it('gives each kind the bones its parts move on', () => {
    const joints = (id: (typeof ENEMY_IDS)[number]) => new Set(prepareRig(enemyRigSpec(id)).layout.joints.map((j) => j.name));
    for (let i = 0; i < 5; i++) expect(skinnedJoints('thornspitter').has(`petal${i}`)).toBe(true); // 5 petals, own bones
    for (const r of SENTINEL_RINGS) expect(skinnedJoints('aetherSentinel').has(r)).toBe(true); // 3 rings, a bone each
    const crab = joints('slagshell');
    expect([...crab].filter((n) => /^(left|right)Leg\dUpper$/.test(n))).toHaveLength(6);
    expect([...crab].filter((n) => /^(left|right)Claw$/.test(n))).toHaveLength(2);
    expect(skinnedJoints('ashWisp').has('leftWingB0')).toBe(true); // the second wing pair
    expect(skinnedJoints('windcutter').has('rightWing2')).toBe(true);
    // Mossback Brute: long arms, short legs.
    const mb = prepareRig(enemyRigSpec('mossbackBrute')).layout;
    const armLen = mb.pos('leftUpperArm')[0] - mb.pos('leftHand')[0];
    const legLen = mb.pos('leftUpperLeg')[1] - mb.pos('leftFoot')[1];
    expect(Math.abs(armLen)).toBeGreaterThan(legLen);
    // Slagshell's shell cracks glow (aFx.x > 0 on its lava lines).
    const fx = prepareRig(enemyRigSpec('slagshell')).geometry.getAttribute('aFx');
    let glowing = 0;
    for (let i = 0; i < fx.count; i++) if (fx.getX(i) > 0.5) glowing++;
    expect(glowing).toBeGreaterThan(50);
  });

  it('builds deterministically', () => {
    for (const id of ['bramblekin', 'slagshell', 'aetherSentinel'] as const) {
      const a = prepareRig(enemyRigSpec(id)).geometry;
      const b = prepareRig(enemyRigSpec(id)).geometry;
      expect(Array.from(a.getAttribute('position').array)).toEqual(Array.from(b.getAttribute('position').array));
    }
  });
});

describe('Elite models (6)', () => {
  const bases: Record<EliteId, (typeof ENEMY_IDS)[number] | null> = {
    oldMossback: 'mossbackBrute', emberjaw: 'cinderHound', galeclaw: 'windcutter', rootboundWarden: null,
    cinderAlpha: 'cinderHound', sentinelPrime: 'aetherSentinel',
  };

  it('scales the base model 1.4× and merges extra armour parts; an additive fresnel aura adds one draw call', () => {
    const lib = library();
    for (const id of ELITE_IDS) {
      const base = bases[id];
      const spec = eliteRigSpec(id);
      if (base !== null) {
        expect(spec.height, id).toBeCloseTo(enemyRigSpec(base).height * ELITE_SIZE, 9);
        expect(spec.preset).toBe(enemyRigSpec(base).preset);
        expect(prepareRig(spec).triangles, `${id} extra parts`).toBeGreaterThan(prepareRig(enemyRigSpec(base)).triangles);
      }
      expect(enemyModelHeight(id)).toBeCloseTo(spec.height, 9);
      const view = lib.createView(id);
      const rig = (view.instance as ProceduralVisualInstance).rig;
      const aura = rig.aura!;
      expect(aura).not.toBeNull();
      expect(aura.geometry).toBe(rig.body.geometry);
      expect(aura.skeleton).toBe(rig.skeleton);
      const m = aura.material as THREE.ShaderMaterial;
      expect([m.blending, m.depthWrite, m.customProgramCacheKey()]).toEqual([THREE.AdditiveBlending, false, RIG_AURA_PROGRAM_KEY]);
      expect(drawCalls(view.object), `${id} draw calls`).toBe(3);
      // Dissolving hides the outline and the aura (they cannot dissolve per rig).
      view.setDissolve(0.5);
      expect(rigUniformsOf(rig.material)!.uDissolve.value).toBe(0.5);
      expect(drawCalls(view.object)).toBe(1);
      view.dispose();
    }
  });

  it('gives rootboundWarden its own model: a torso rising from a root mound, glowing back roots, no legs', () => {
    const spec = eliteRigSpec('rootboundWarden');
    expect([spec.preset, spec.height]).toEqual(['humanoid', 4.2]);
    const used = skinnedJoints('rootboundWarden');
    expect([...used].some((j) => /UpperLeg|LowerLeg|Foot$/.test(j))).toBe(false);
    expect(used.has('root')).toBe(true); // the mound
    const p = prepareRig(spec);
    const pos = p.geometry.getAttribute('position');
    const fx = p.geometry.getAttribute('aFx');
    let backGlow = 0;
    for (let i = 0; i < pos.count; i++) if (fx.getX(i) > 0.9 && pos.getZ(i) < -0.2) backGlow++;
    expect(backGlow).toBeGreaterThan(30);
  });

  it("gives sentinelPrime's drones the eye and a single ring", () => {
    const layout = prepareRig(DRONE_RIG_SPEC).layout;
    expect(layout.has('ring0')).toBe(true);
    expect(layout.has('ring1')).toBe(false);
    expect(DRONE_RIG_SPEC.height).toBeLessThan(enemyRigSpec('aetherSentinel').height / 2);
  });
});

describe('NPC models (7)', () => {
  it('tells the villagers apart by proportions, outfit and palette, each with a face atlas', () => {
    const heights = NPC_IDS.map((id) => modelRigSpec(id).height);
    const primaries = new Set(NPC_IDS.map((id) => modelRigSpec(id).palette.primary));
    expect(primaries.size).toBe(7);
    expect(modelRigSpec('tamsin').height).toBeCloseTo(1.2, 9);
    expect(Math.min(...heights)).toBe(1.2);
    for (const id of NPC_IDS) {
      const spec = modelRigSpec(id);
      expect(spec.preset).toBe('humanoid');
      expect(spec.face, id).toBeDefined();
      const p = prepareRig(spec);
      expect(p.triangles, `${id} triangles`).toBeLessThanOrEqual(6000);
      const fx = p.geometry.getAttribute('aFx');
      let face = 0;
      for (let i = 0; i < fx.count; i++) if (fx.getY(i) === 1) face++;
      expect(face, `${id} face plane`).toBeGreaterThan(0);
    }
    // Held tools are merged into the body on the hand (still 2 draw calls).
    expect(skinnedJoints('hobb').has('rightHand')).toBe(true);
    const view = library().createView('maren');
    expect(drawCalls(view.object)).toBe(2);
    view.dispose();
  });
});

describe('Caelith', () => {
  const input = (over: Partial<CaelithViewInput> = {}): CaelithViewInput => ({
    state: 'idle', phase: 1, attack: null, attackTime: 0, stateTime: 0, starshell: null, starshellBreaks: 0, vulnerable: false, ...over,
  });

  it('is a ≈ 6 m star knight: body, cape, halo, greatsword and Starshell in 7 draw calls', () => {
    const view = new CaelithView(library());
    view.update(input({ phase: 2, starshell: { element: 'ember', durability: 1200, max: 1200 } }), { x: 0, y: 0.5, z: 0 }, 0, 1 / 60);
    expect(view.view.instance.height).toBe(6);
    expect(drawCalls(view.object)).toBe(7);
    const instance = view.view.instance as ProceduralVisualInstance;
    const rig = instance.rig;
    // Crystal greatsword on weaponR under the right hand; the cape shares the Skeleton; 8 halo shards.
    expect(rig.weapon?.mesh.parent?.name).toBe('weaponR');
    expect(rig.weapon?.mesh.parent?.parent?.name).toBe('rightHand');
    expect(instance.cape?.skeleton).toBe(rig.skeleton);
    expect(rig.layout.chains.size).toBe(CAELITH_CAPE.strips);
    expect(rig.layout.has(capeRootJoint(5))).toBe(true);
    expect(view.halo.count).toBe(CAELITH_HALO.count);
    expect(view.halo).toBeInstanceOf(THREE.InstancedMesh);
    // Starshell: r 3.4 icosphere (detail 3) round the body centre, in the shared shell program.
    const shell = view.starshell.mesh;
    expect(shell.scale.x).toBe(STARSHELL_RADIUS);
    expect((shell.geometry as THREE.IcosahedronGeometry).parameters.detail).toBe(3);
    expect(shell.position.y).toBeCloseTo(0.5 + 3, 9);
    expect((shell.material as THREE.ShaderMaterial).customProgramCacheKey()).toBe(SHELL_PROGRAM_KEY);
    view.dispose();
  });

  it('lights the crack lines (uGlow 0 → 1) in the Final Phase and dissolves from the feet up at death', () => {
    const view = new CaelithView(library());
    const rig = (view.view.instance as ProceduralVisualInstance).rig;
    const u = rigUniformsOf(rig.material)!;
    view.update(input({ phase: 2 }), { x: 0, y: 0, z: 0 }, 0, 1 / 60);
    expect(u.uGlow.value).toBe(0);
    for (let i = 0; i < 120; i++) view.update(input({ phase: 3 }), { x: 0, y: 0, z: 0 }, 0, 1 / 60);
    expect(u.uGlow.value).toBe(1);
    view.update(input({ phase: 3, state: 'dead', stateTime: 1.75 }), { x: 0, y: 0, z: 0 }, 0, 1 / 60);
    expect(u.uDissolveRise.value).toBe(1);
    expect(u.uDissolve.value).toBeCloseTo(0.5, 6);
    expect(view.anim.animator?.current('override')).toBe('caelith_death');
    expect((view.halo.material as THREE.MeshBasicMaterial).opacity).toBeLessThan(0.6); // the halo scatters and fades
    view.dispose();
  });
});

describe('Element shell (Element_Shield and Starshell share one shader)', () => {
  it('crossfades colour and icon over 0.3 s on an Element change and shatters on a break', () => {
    const shell = new ElementShell({ radius: [1.5, 1.0, 1.5], center: [0, 0.8, 0] });
    const u = shell.material.uniforms;
    shell.show('ember');
    expect([shell.mesh.visible, u.uMix!.value, u.uIconB!.value]).toEqual([true, 1, SHELL_ICON_INDEX[ELEMENT_DEFS.ember.icon]]);
    shell.show('tide', 0.5);
    expect(u.uMix!.value).toBe(0);
    expect(u.uIconB!.value).toBe(SHELL_ICON_INDEX[ELEMENT_DEFS.tide.icon]);
    expect((u.uColorB!.value as THREE.Color).getHex()).toBe(ELEMENT_DEFS.tide.color);
    shell.update(SHELL_CROSSFADE_SECONDS / 2);
    expect(u.uMix!.value).toBeCloseTo(0.5, 6);
    shell.update(SHELL_CROSSFADE_SECONDS);
    expect(u.uMix!.value).toBe(1);
    expect(u.uOpacity!.value).toBeCloseTo(0.75, 6); // thinner at half durability
    shell.shatter();
    shell.update(SHELL_SHATTER_SECONDS / 2);
    expect(u.uBreak!.value).toBeGreaterThan(0.4);
    shell.update(SHELL_SHATTER_SECONDS);
    expect(shell.mesh.visible).toBe(false);
    expect(shell.material.customProgramCacheKey()).toBe(SHELL_PROGRAM_KEY);
    shell.dispose();
  });
});
