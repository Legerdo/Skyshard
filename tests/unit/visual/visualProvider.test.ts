import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CHARACTER_IDS } from '../../../src/data/ids';
import { VISUAL_ENTITY_IDS, VISUAL_MANIFEST, type VisualSpec } from '../../../src/data/visualManifest';
import { EntityView } from '../../../src/visual/entityView';
import { HERO_CAST_GLOW, HERO_IDLE_GLOW, HeroViews, HURT_SECONDS, type HeroViewState } from '../../../src/visual/heroViews';
import { ProceduralVisualInstance, ProceduralVisualProvider } from '../../../src/visual/proceduralProvider';
import type { VisualInstance, VisualProvider, VisualTemplate } from '../../../src/visual/types';
import { VisualLibrary } from '../../../src/visual/visualLibrary';
import { rigUniformsOf } from '../../../src/anim/rigMaterial';

// Task 19.7: VisualProvider / VisualTemplate / VisualInstance, the procedural provider, the library and live swaps;
// task 19.2: the hero views that replaced the capsule. Node: no WebGL, no canvas.

const RIG = { faceAtlas: false } as const;
const silent = { warn: () => undefined, rig: RIG };

describe('ProceduralVisualProvider', () => {
  it('serves every VisualEntityId, one cached template each, instances sharing geometry but not skeletons', async () => {
    const provider = new ProceduralVisualProvider(RIG);
    for (const id of VISUAL_ENTITY_IDS) {
      const template = await provider.load(id, VISUAL_MANIFEST[id]!);
      expect(template.kind).toBe('procedural');
      expect(template.height).toBeGreaterThan(0.5);
      expect(await provider.load(id, VISUAL_MANIFEST[id]!)).toBe(template);
    }
    const t = provider.template('kairen');
    const a = t.instantiate();
    const b = t.instantiate();
    expect(a.rig.body.geometry).toBe(b.rig.body.geometry);
    expect(a.rig.skeleton).not.toBe(b.rig.skeleton);
    expect(a.rig.material).not.toBe(b.rig.material);
    expect(a.root).not.toBe(b.root);
    // Humanoid pose target = the raw bones (normalized = raw for procedural rigs).
    expect(a.humanoid?.bones.get('leftUpperArm')).toBe(a.rig.bones.get('leftUpperArm'));
    expect(a.humanoid?.restHipsHeight).toBeCloseTo(0.53 * 1.72, 6);
    expect([...a.sockets.keys()].sort()).toEqual(['back', 'headTop', 'weaponL', 'weaponR']);
    expect(a.mixer).toBeNull();
    // Heroes hold their weapon; disposing one instance leaves the shared geometry to the template.
    expect(a.rig.weapon?.mesh.parent).toBe(a.sockets.get('weaponR'));
    a.dispose();
    expect(b.rig.body.geometry.getAttribute('position').count).toBeGreaterThan(0);
    provider.dispose();
  });

  it('drives the face through uniforms only (blink, talk)', () => {
    const instance = new ProceduralVisualProvider(RIG).template('isla').instantiate();
    const u = rigUniformsOf(instance.rig.material)!;
    const positionAttr = (): THREE.BufferAttribute => instance.rig.body.geometry.getAttribute('position') as THREE.BufferAttribute;
    const version = positionAttr().version;
    instance.setExpression('talk', 1);
    const mouths = new Set<number>();
    for (let i = 0; i < 6; i++) {
      instance.update(0.1);
      mouths.add(u.faceCell.value.x);
    }
    expect([...mouths].sort()).toEqual([0, 1, 2]);
    instance.setExpression('talk', 0);
    instance.setExpression('blink', 1);
    instance.update(0.06);
    expect(u.faceCell.value.y).toBeGreaterThan(0);
    expect(positionAttr().version).toBe(version);
  });
});

describe('VisualLibrary and EntityView', () => {
  const fakeInstance = (height = 1): VisualInstance => ({
    root: new THREE.Group(), humanoid: null, mixer: null, sockets: new Map(), joints: new Map(), height,
    setOpacity: vi.fn(), setFlash: vi.fn(), setExpression: vi.fn(), setGlow: vi.fn(), stowWeapon: vi.fn(),
    resetSecondary: vi.fn(), update: vi.fn(), dispose: vi.fn(),
  });
  const fakeTemplate = (instance: VisualInstance): VisualTemplate => ({ kind: 'gltf', height: 1.7, instantiate: () => instance });

  it('shows the procedural model now and swaps live to a loaded external model (state carried over, old disposed)', async () => {
    const external = fakeInstance(1.7);
    const provider: VisualProvider = { load: vi.fn(async () => fakeTemplate(external)) };
    const manifest = { ...VISUAL_MANIFEST, kairen: { source: { kind: 'gltf', url: 'assets/models/kairen.glb' }, rig: 'humanoid' } satisfies VisualSpec };
    const library = new VisualLibrary({ ...silent, manifest, providers: { gltf: provider } });
    const view = library.createView('kairen');
    const first = view.instance;
    expect(first).toBeInstanceOf(ProceduralVisualInstance);
    expect(view.object.children).toContain(first.root);
    view.setOpacity(0.5);
    view.setGlow(1);
    const swapped = vi.fn();
    view.onSwap(swapped);
    await library.externalTemplate('kairen');
    await Promise.resolve();
    expect(view.instance).toBe(external);
    expect(view.object.children).toEqual([external.root]);
    expect(external.setOpacity).toHaveBeenCalledWith(0.5);
    expect(external.setGlow).toHaveBeenCalledWith(1);
    expect(external.resetSecondary).toHaveBeenCalled();
    expect(swapped).toHaveBeenCalledWith(view, external, first);
    expect(provider.load).toHaveBeenCalledTimes(1);
    // A second view of the same id reuses the loaded template.
    library.createView('kairen');
    await library.externalTemplate('kairen');
    expect(provider.load).toHaveBeenCalledTimes(1);
  });

  it('keeps the procedural model with one warning for invalid entries, missing loaders, load errors and timeouts', async () => {
    const warnings: string[] = [];
    const manifest = {
      ...VISUAL_MANIFEST,
      isla: { source: { kind: 'gltf', url: 'https://elsewhere.example/isla.glb' }, rig: 'humanoid' },
      wren: { source: { kind: 'fbx', url: 'assets/models/wren.fbx' }, rig: 'humanoid' },
      talus: { source: { kind: 'vrm', url: 'assets/models/talus.vrm' }, rig: 'humanoid' },
      pip: { source: { kind: 'gltf', url: 'assets/models/pip.glb' }, rig: 'humanoid' },
    };
    const library = new VisualLibrary({
      manifest, rig: RIG, warn: (m) => warnings.push(m), timeoutMs: 20,
      providers: {
        vrm: { load: () => Promise.reject(new Error('404')) },
        gltf: { load: () => new Promise<VisualTemplate>(() => undefined) },
      },
    });
    expect(library.spec('isla').source).toEqual({ kind: 'procedural' });
    expect(warnings.filter((w) => w.includes('isla'))).toHaveLength(1);
    const views = (['wren', 'talus', 'pip'] as const).map((id) => library.createView(id));
    await Promise.all((['wren', 'talus', 'pip'] as const).map((id) => library.externalTemplate(id)));
    for (const view of views) expect(view.instance).toBeInstanceOf(ProceduralVisualInstance);
    expect(warnings.filter((w) => w.includes('wren'))).toEqual([expect.stringMatching(/no loader for 'fbx'/)]);
    expect(warnings.filter((w) => w.includes('talus'))).toEqual([expect.stringMatching(/404/)]);
    expect(warnings.filter((w) => w.includes('pip'))).toEqual([expect.stringMatching(/timed out/)]);
    library.createView('talus');
    await library.externalTemplate('talus');
    expect(warnings.filter((w) => w.includes('talus'))).toHaveLength(1);
  });

  it('disposes a model that finishes loading after its view is gone', () => {
    const view = new EntityView('bram', fakeInstance());
    const late = fakeInstance();
    view.dispose();
    view.swapVisual(late);
    expect(late.dispose).toHaveBeenCalled();
  });
});

describe('HeroViews (the capsule replacement)', () => {
  function heroes() {
    const state: { active: HeroViewState['active']; mode: string; vel: { x: number; y: number; z: number } } = {
      active: 'kairen', mode: 'grounded', vel: { x: 0, y: 0, z: 0 },
    };
    const views = new HeroViews({ library: new VisualLibrary(silent), state: () => state });
    return { views, state };
  }

  it('shows only the Active_Character, feet at the pose position, and switches with rest springs', () => {
    const { views, state } = heroes();
    views.setPose({ x: 3, y: 2, z: -1 }, 0.5);
    views.update(1 / 60);
    const visible = CHARACTER_IDS.filter((id) => views.view(id).object.visible);
    expect(visible).toEqual(['kairen']);
    expect(views.view('kairen').object.position.toArray()).toEqual([3, 2, -1]);
    expect(views.view('kairen').object.rotation.y).toBe(0.5);
    state.active = 'talus';
    const reset = vi.spyOn(views.view('talus').instance, 'resetSecondary');
    views.setPose({ x: 3, y: 2, z: -1 }, 0.5);
    views.update(1 / 60);
    expect(CHARACTER_IDS.filter((id) => views.view(id).object.visible)).toEqual(['talus']);
    expect(reset).toHaveBeenCalledTimes(1);
    views.dispose();
  });

  it('glows at 1.0 while casting and 0.3 otherwise, rocks back for 0.4 s when hurt, stows the weapon to climb', () => {
    const { views, state } = heroes();
    const glow = (): number => rigUniformsOf((views.view('kairen').instance as ProceduralVisualInstance).rig.material)!.uGlow.value;
    views.setPose({ x: 0, y: 0, z: 0 }, 0);
    views.update(1 / 60);
    expect(glow()).toBeCloseTo(HERO_IDLE_GLOW, 9);
    views.cast('kairen', 0.7);
    expect(glow()).toBe(HERO_CAST_GLOW);
    for (let i = 0; i < 30; i++) views.update(1 / 60);
    expect(glow()).toBe(HERO_CAST_GLOW);
    for (let i = 0; i < 20; i++) views.update(1 / 60);
    expect(glow()).toBeCloseTo(HERO_IDLE_GLOW, 9);
    // Task 19.4: a hit plays the 0.4 s upper-body `hurt` clip on the action layer with a red flush.
    const flash = (): number => rigUniformsOf((views.view('kairen').instance as ProceduralVisualInstance).rig.material)!.uFlash.value;
    views.hurt();
    views.update(HURT_SECONDS / 2);
    expect(views.animation('kairen').animator?.current('action')).toBe('hurt');
    expect(flash()).toBeGreaterThan(0.1);
    views.update(HURT_SECONDS);
    expect(views.hurtRemaining).toBe(0);
    for (let i = 0; i < 20; i++) views.update(1 / 60);
    expect(views.animation('kairen').animator?.current('action')).toBeNull();
    expect(flash()).toBe(0);
    const instance = views.view('kairen').instance as ProceduralVisualInstance;
    state.mode = 'climb';
    views.update(1 / 60);
    expect(instance.rig.weapon?.mesh.parent).toBe(instance.sockets.get('back'));
    state.mode = 'grounded';
    state.vel = { x: 0, y: 0, z: 5 };
    views.update(1 / 60);
    expect(instance.rig.weapon?.mesh.parent).toBe(instance.sockets.get('weaponR'));
    // Running moves the legs (the locomotion blend).
    for (let i = 0; i < 10; i++) views.update(1 / 60);
    expect(instance.rig.bones.get('leftUpperLeg')!.quaternion.equals(new THREE.Quaternion())).toBe(false);
    views.dispose();
  });

  it('drives the attack clip from the sim attack clock and feeds the weapon trail between trail:on and trail:off', () => {
    const state: HeroViewState & { attack: { def: { clip: string }; t: number } | null } = {
      active: 'kairen', mode: 'grounded', vel: { x: 0, y: 0, z: 0 }, attack: null,
    };
    const views = new HeroViews({ library: new VisualLibrary(silent), state: () => state });
    const samples: string[] = [];
    const ends: string[] = [];
    views.trailSink = { sample: (key) => samples.push(key), end: (key) => ends.push(key) };
    views.setPose({ x: 0, y: 0, z: 0 }, 0);
    views.update(1 / 60);
    state.attack = { def: { clip: 'kairen_n1' }, t: 0 };
    for (let i = 1; i <= 27; i++) {
      state.attack = { def: { clip: 'kairen_n1' }, t: i / 60 };
      views.update(1 / 60);
      const inWindow = i / 60 > 0.1 + 1e-9 && i / 60 < 0.26 - 1e-9;
      if (inWindow) expect(samples.length, `tick ${i}`).toBeGreaterThan(0);
    }
    expect(views.animation('kairen').animator?.current('action')).toBe('kairen_n1');
    expect(views.animation('kairen').animator?.time('action')).toBeCloseTo(27 / 60, 9);
    expect(samples.every((k) => k === 'hero:kairen')).toBe(true);
    expect(ends).toEqual(['hero:kairen']); // closed at trail:off (0.26 s)
    // A cut-off attack closes an open trail at once.
    state.attack = { def: { clip: 'kairen_n2' }, t: 0.15 };
    views.update(1 / 60);
    state.attack = null;
    views.update(1 / 60);
    expect(ends).toHaveLength(2);
    views.dispose();
  });

  it('faces along the controller yaw (0 = +Z, positive toward +X) and is the model VFX afterimages copy', () => {
    const { views } = heroes();
    views.setPose({ x: 10, y: 5, z: -3 }, 0.8);
    views.update(1 / 60);
    const view = views.view('kairen');
    view.object.updateMatrixWorld(true);
    const hips = view.instance.joints.get('hips')!.getWorldPosition(new THREE.Vector3());
    const headTop = view.instance.joints.get('headTop')!.getWorldPosition(new THREE.Vector3());
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(view.object.quaternion);
    expect(forward.x).toBeCloseTo(Math.sin(0.8), 9);
    expect(forward.z).toBeCloseTo(Math.cos(0.8), 9);
    expect(hips.y).toBeGreaterThan(5.7);
    expect(headTop.y).toBeLessThan(5 + 1.72 + 0.05);
    // Only the Active_Character's meshes are visible under `object` (body, outline, weapon and its outline).
    const visible: THREE.Mesh[] = [];
    views.object.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh === true) visible.push(o as THREE.Mesh); });
    const rig = (view.instance as ProceduralVisualInstance).rig;
    expect(visible).toContain(rig.body);
    expect(visible.filter((m) => (m as THREE.SkinnedMesh).isSkinnedMesh === true).every((m) => (m as THREE.SkinnedMesh).skeleton === rig.skeleton)).toBe(true);
    views.dispose();
  });

  it('fades with the camera near-fade, recompiling only when blending switches, and hides the outlines meanwhile', () => {
    const { views, state } = heroes();
    views.setPose({ x: 0, y: 0, z: 0 }, 0);
    views.update(1 / 60);
    const rig = (views.view('kairen').instance as ProceduralVisualInstance).rig;
    const version = rig.material.version;
    views.setOpacity(1);
    expect([rig.material.transparent, rig.material.version, rig.outline.visible]).toEqual([false, version, true]);
    views.setOpacity(0.35);
    expect([rig.material.transparent, rig.material.opacity, rig.material.version, rig.outline.visible]).toEqual([true, 0.35, version + 1, false]);
    expect(rig.weapon?.outline.visible).toBe(false);
    views.setOpacity(0.6);
    expect([rig.material.opacity, rig.material.version]).toEqual([0.6, version + 1]);
    views.setOpacity(1);
    expect([rig.material.transparent, rig.material.opacity, rig.outline.visible, rig.weapon?.outline.visible]).toEqual([false, 1, true, true]);
    // A switch carries the current fade to the new Active_Character.
    views.setOpacity(0.5);
    state.active = 'talus';
    views.setPose({ x: 0, y: 0, z: 0 }, 0);
    views.update(1 / 60);
    expect((views.view('talus').instance as ProceduralVisualInstance).rig.material.opacity).toBe(0.5);
    views.dispose();
  });
});
