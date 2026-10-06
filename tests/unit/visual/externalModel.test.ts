import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnimRequest } from '../../../src/anim/animator';
import type { PoseClip } from '../../../src/anim/clip';
import { modelRigSpec } from '../../../src/anim/models';
import { RIG_HUMANOID_BONES } from '../../../src/anim/rigLayout';
import type { VisualEntityId } from '../../../src/data/ids';
import { VISUAL_MANIFEST, type HumanoidBoneName, type VisualSpec } from '../../../src/data/visualManifest';
import { ExternalVisualProvider, type ExternalProviderOptions } from '../../../src/visual/externalLoaders';
import { fxUniformsOf } from '../../../src/visual/externalMaterials';
import {
  buildExternalTemplate, ExternalVisualTemplate, type ClipContext, type LoadedModel, type VrmInstanceParts, type VrmModelInfo,
} from '../../../src/visual/externalModel';
import { positionInRoot, rotationInRoot } from '../../../src/visual/humanoidRetarget';
import { checkModelFormat, ModelLoadError, resolveModelUrl, sniffModelContainer } from '../../../src/visual/modelFormat';
import { ProceduralVisualInstance } from '../../../src/visual/proceduralProvider';
import { VISUAL_LOAD_TIMEOUT_MS, VisualLibrary } from '../../../src/visual/visualLibrary';
import {
  alongBone, directionBetween, fbxBytes, FIXTURE_BONES, glbBytes, humanoidFixture, loadedOf, textBytes, type FixtureOptions,
} from './externalFixtures';

// Task 19.8: the glTF / FBX / VRM adapter path with stubbed loaders (no network, no WebGL): format and URL checks, the
// 15 s limit, the required-bone check and the procedural fallback with one warning, normalisation, retargeting of the
// instance, mixer clips, generic root motion, materials and VRM parts.

const RIG = { faceAtlas: false } as const;
const quiet = { warn: (): void => undefined, log: (): void => undefined };

const gltfSpec = (over: Partial<VisualSpec> = {}): VisualSpec => ({ source: { kind: 'gltf', url: 'assets/models/kairen.glb' }, rig: 'humanoid', ...over });

type Fetch = NonNullable<ExternalProviderOptions['fetch']>;
const serve = (bytes: ArrayBuffer, status = 200): Fetch => async () => ({ ok: status < 400, status, arrayBuffer: async () => bytes });

function template(id: VisualEntityId, spec: VisualSpec, fixture: FixtureOptions = {}, kind: LoadedModel['kind'] = spec.source.kind === 'procedural' ? 'gltf' : spec.source.kind, vrm?: VrmModelInfo): ExternalVisualTemplate {
  return buildExternalTemplate(id, spec, loadedOf(humanoidFixture(fixture), kind, vrm), quiet);
}

function rootBox(t: { root: THREE.Object3D }): THREE.Box3 {
  t.root.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(t.root, true);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('model file checks', () => {
  it('resolves same-origin relative paths under BASE_URL and refuses anything else', () => {
    expect(resolveModelUrl('assets/models/a.glb', '/')).toBe('/assets/models/a.glb');
    expect(resolveModelUrl('./a.glb', '/skyshard')).toBe('/skyshard/a.glb');
    expect(resolveModelUrl('/models/a.glb', '/skyshard/', 'https://game.example')).toBe('/models/a.glb');
    for (const bad of ['https://evil.example/a.glb', '//evil.example/a.glb', 'data:model/gltf-binary;base64,AAAA', 'a\\b.glb', 'a b.glb']) {
      expect(() => resolveModelUrl(bad, '/', 'https://game.example'), bad).toThrow(ModelLoadError);
    }
  });

  it('recognises GLB, glTF JSON, binary and ASCII FBX by their bytes and matches them to the kind', () => {
    expect(sniffModelContainer(glbBytes())).toBe('glb');
    expect(sniffModelContainer(textBytes('\uFEFF \n{"asset":{"version":"2.0"}}'))).toBe('gltf-json');
    expect(sniffModelContainer(fbxBytes())).toBe('fbx-binary');
    expect(sniffModelContainer(textBytes('; FBX 7.4.0 project file\nFBXHeaderExtension: {'))).toBe('fbx-ascii');
    expect(sniffModelContainer(textBytes('solid cube\nfacet normal'))).toBeNull();
    expect(checkModelFormat('vrm', glbBytes())).toBe('glb');
    expect(() => checkModelFormat('vrm', textBytes('{"asset":{}}'))).toThrow(/not a 'vrm' model/);
    expect(() => checkModelFormat('gltf', fbxBytes())).toThrow(/not a 'gltf' model/);
    expect(() => checkModelFormat('fbx', glbBytes())).toThrow(/not a 'fbx' model/);
    expect(() => checkModelFormat('gltf', textBytes('PNG'))).toThrow(/unsupported file format/);
  });
});

describe('ExternalVisualProvider', () => {
  it('fetches the URL under BASE_URL, checks it, parses it and logs the bone table once', async () => {
    const urls: string[] = [];
    const logs: string[] = [];
    const parser = vi.fn(async () => loadedOf(humanoidFixture()));
    const provider = new ExternalVisualProvider({
      baseUrl: '/skyshard/', origin: 'https://game.example', warn: () => undefined, log: (m) => logs.push(m),
      fetch: async (url, init) => {
        urls.push(url);
        expect(init.signal.aborted).toBe(false);
        return { ok: true, status: 200, arrayBuffer: async () => glbBytes() };
      },
      parsers: { gltf: parser },
    });
    const t = await provider.load('kairen', gltfSpec());
    expect(t).toBeInstanceOf(ExternalVisualTemplate);
    expect(t.kind).toBe('gltf');
    expect(urls).toEqual(['/skyshard/assets/models/kairen.glb']);
    expect(parser).toHaveBeenCalledTimes(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('hips ← mixamorigHips [auto]');
    expect(logs[0]).toContain('leftUpperArm ← mixamorigLeftArm [auto]');
  });

  it('rejects unsupported formats, other origins, HTTP errors and parse errors before any template is built', async () => {
    const parser = vi.fn(async () => loadedOf(humanoidFixture()));
    const cases: [string, VisualSpec, ArrayBuffer, number, RegExp][] = [
      ['text file as glTF', gltfSpec(), textBytes('hello'), 200, /unsupported file format/],
      ['FBX bytes as glTF', gltfSpec(), fbxBytes(), 200, /not a 'gltf' model/],
      ['GLB bytes as FBX', gltfSpec({ source: { kind: 'fbx', url: 'a.fbx' } }), glbBytes(), 200, /not a 'fbx' model/],
      ['glTF JSON as VRM', gltfSpec({ source: { kind: 'vrm', url: 'a.vrm' } }), textBytes('{"asset":{"version":"2.0"}}'), 200, /not a 'vrm' model/],
      ['cross-origin URL', gltfSpec({ source: { kind: 'gltf', url: 'https://evil.example/a.glb' } }), glbBytes(), 200, /same-origin/],
      ['cross-origin buffer', gltfSpec(), glbBytes({ asset: { version: '2.0' }, buffers: [{ uri: 'https://evil.example/b.bin', byteLength: 4 }] }), 200, /outside the page origin/],
      ['cross-origin image', gltfSpec(), glbBytes({ asset: { version: '2.0' }, images: [{ uri: '//evil.example/t.png' }] }), 200, /outside the page origin/],
      ['HTTP 404', gltfSpec(), glbBytes(), 404, /HTTP 404/],
    ];
    for (const [label, spec, bytes, status, reason] of cases) {
      const fetch = vi.fn(serve(bytes, status));
      const provider = new ExternalVisualProvider({ ...quiet, origin: 'https://game.example', fetch, parsers: { gltf: parser, fbx: parser, vrm: parser } });
      const error = await provider.load('kairen', spec).then(() => null, (e: unknown) => e);
      expect(error, label).toBeInstanceOf(ModelLoadError);
      expect((error as Error).message, label).toMatch(reason);
      if (label === 'cross-origin URL') expect(fetch).not.toHaveBeenCalled();
    }
    expect(parser).not.toHaveBeenCalled();
    const broken = new ExternalVisualProvider({ ...quiet, fetch: serve(glbBytes()), parsers: { gltf: async () => { throw new Error('bad accessor'); } } });
    await expect(broken.load('kairen', gltfSpec())).rejects.toThrow(/parse error: bad accessor/);
  });

  it('gives up after 15 s (fetch aborted)', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const provider = new ExternalVisualProvider({ ...quiet, fetch: (_url, init) => { signal = init.signal; return new Promise(() => undefined); } });
    let outcome: unknown = 'pending';
    void provider.load('kairen', gltfSpec()).then(() => { outcome = 'loaded'; }, (e: unknown) => { outcome = e; });
    await vi.advanceTimersByTimeAsync(VISUAL_LOAD_TIMEOUT_MS - 1);
    expect(outcome).toBe('pending');
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(ModelLoadError);
    expect((outcome as Error).message).toBe('timed out after 15 s');
    expect(signal?.aborted).toBe(true);
    expect(VISUAL_LOAD_TIMEOUT_MS).toBe(15_000);
  });
});

describe('procedural fallback through the VisualLibrary', () => {
  function library(provider: ExternalVisualProvider, spec: VisualSpec, warnings: string[]): VisualLibrary {
    return new VisualLibrary({ manifest: { ...VISUAL_MANIFEST, kairen: spec }, rig: RIG, warn: (m) => warnings.push(m), providers: { gltf: provider, fbx: provider, vrm: provider } });
  }

  it('keeps the procedural model with exactly one warning when required humanoid bones are missing', async () => {
    const warnings: string[] = [];
    const provider = new ExternalVisualProvider({ ...quiet, fetch: serve(glbBytes()), parsers: { gltf: async () => loadedOf(humanoidFixture({ omit: ['leftFoot', 'leftToes'] })) } });
    const lib = library(provider, gltfSpec(), warnings);
    const view = lib.createView('kairen');
    expect(await lib.externalTemplate('kairen')).toBeNull();
    await Promise.resolve();
    expect(view.instance).toBeInstanceOf(ProceduralVisualInstance);
    expect(warnings).toEqual([expect.stringMatching(/^visual kairen: could not load assets\/models\/kairen\.glb \(missing humanoid bones: leftFoot\); keeping the procedural model$/)]);
    // Loaded once: another view neither reloads nor warns again.
    lib.createView('kairen');
    await lib.externalTemplate('kairen');
    expect(warnings).toHaveLength(1);
    // The same file as a generic (non-humanoid) model needs no bones.
    const generic = new ExternalVisualProvider({ ...quiet, fetch: serve(glbBytes()), parsers: { gltf: async () => loadedOf(humanoidFixture({ omit: ['leftFoot', 'leftToes'] })) } });
    expect(await generic.load('bramblekin', gltfSpec({ rig: 'generic' }))).toBeInstanceOf(ExternalVisualTemplate);
  });

  it('loads a model detection cannot read through a manual boneMap; a wrong name is part of the one warning', async () => {
    const names = Object.fromEntries(FIXTURE_BONES.map((b, i) => [b, `joint_${i}`])) as Record<(typeof FIXTURE_BONES)[number], string>;
    const boneMap = Object.fromEntries(FIXTURE_BONES.map((b) => [b, names[b]])) as VisualSpec['boneMap'];
    const unreadable = () => loadedOf(humanoidFixture({ names }));
    // Without the map nothing is found.
    expect(() => buildExternalTemplate('kairen', gltfSpec(), unreadable(), quiet)).toThrow(/missing humanoid bones: hips, spine, head/);
    const t = buildExternalTemplate('kairen', gltfSpec({ boneMap }), unreadable(), quiet);
    expect(t.bones.missing).toEqual([]);
    expect(t.bones.sources.get('leftUpperArm')).toBe('manual');
    expect(t.humanoidNodes!.get('rightFoot')!.name).toBe(names.rightFoot);
    // A misspelt required bone: the load fails once, naming the bone and the bad map entry.
    const warnings: string[] = [];
    const provider = new ExternalVisualProvider({ ...quiet, fetch: serve(glbBytes()), parsers: { gltf: async () => unreadable() } });
    const lib = library(provider, gltfSpec({ boneMap: { ...boneMap, leftFoot: 'joint_typo' } }), warnings);
    expect(await lib.externalTemplate('kairen')).toBeNull();
    expect(warnings).toEqual([expect.stringMatching(/missing humanoid bones: leftFoot; boneMap\.leftFoot: no node named 'joint_typo'/)]);
  });

  it('keeps the procedural model with one warning for an unsupported format or a cross-origin resource', async () => {
    for (const [bytes, reason] of [[textBytes('<html>'), /unsupported file format/], [glbBytes({ buffers: [{ uri: 'https://cdn.example/b.bin' }] }), /outside the page origin/]] as const) {
      const warnings: string[] = [];
      const provider = new ExternalVisualProvider({ ...quiet, fetch: serve(bytes), parsers: { gltf: async () => loadedOf(humanoidFixture()) } });
      const lib = library(provider, gltfSpec(), warnings);
      const view = lib.createView('kairen');
      expect(await lib.externalTemplate('kairen')).toBeNull();
      expect(view.instance).toBeInstanceOf(ProceduralVisualInstance);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(reason);
    }
  });

  it('refuses a cross-origin model URL in the manifest itself: one warning, no request, procedural model', async () => {
    const warnings: string[] = [];
    const fetch = vi.fn(serve(glbBytes()));
    const provider = new ExternalVisualProvider({ ...quiet, fetch, parsers: { gltf: async () => loadedOf(humanoidFixture()) } });
    const load = vi.spyOn(provider, 'load');
    const lib = library(provider, gltfSpec({ source: { kind: 'gltf', url: 'https://cdn.example/kairen.glb' } }), warnings);
    expect(lib.spec('kairen').source.kind).toBe('procedural');
    const view = lib.createView('kairen');
    expect(await lib.externalTemplate('kairen')).toBeNull();
    expect(view.instance).toBeInstanceOf(ProceduralVisualInstance);
    expect(warnings).toEqual([expect.stringMatching(/kairen.*https:\/\/cdn\.example\/kairen\.glb.*not a same-origin relative path/)]);
    expect(load).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the procedural model with one warning after the 15 s limit, ignoring a late answer', async () => {
    vi.useFakeTimers();
    const warnings: string[] = [];
    const late: Fetch = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, arrayBuffer: async () => glbBytes() }), 20_000));
    const provider = new ExternalVisualProvider({ ...quiet, fetch: late, parsers: { gltf: async () => loadedOf(humanoidFixture()) } });
    const lib = library(provider, gltfSpec(), warnings);
    const view = lib.createView('kairen');
    let settled = false;
    const pending = lib.externalTemplate('kairen').then((t) => { settled = true; return t; });
    await vi.advanceTimersByTimeAsync(VISUAL_LOAD_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeNull();
    expect(warnings).toEqual([expect.stringMatching(/kairen.*timed out after 15 s.*keeping the procedural model/)]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(view.instance).toBeInstanceOf(ProceduralVisualInstance);
    expect(warnings).toHaveLength(1);
  });
});

describe('normalisation (height, feet, front)', () => {
  it('scales the rest bounding box to `height` (FBX centimetres too), puts the feet at y = 0 and adds `offset`', () => {
    const fbx = template('kairen', gltfSpec({ source: { kind: 'fbx', url: 'a.fbx' }, height: 1.6 }), { unit: 100, bottom: 0.2, top: 1.8 }, 'fbx');
    const box = rootBox(fbx);
    expect(box.max.y - box.min.y).toBeCloseTo(1.6, 9);
    expect(box.min.y).toBeCloseTo(0, 9);
    expect(fbx.scale).toBeCloseTo(1.6 / 160, 12);
    expect(fbx.height).toBe(1.6);
    // Default height: the procedural model's.
    const plain = template('kairen', gltfSpec(), { bottom: 0.1, top: 1.2 });
    expect(plain.height).toBe(modelRigSpec('kairen').height);
    expect(rootBox(plain).max.y).toBeCloseTo(modelRigSpec('kairen').height, 9);
    const moved = template('kairen', gltfSpec({ height: 1.5, offset: [0.1, 0.05, -0.2] }));
    const mb = rootBox(moved);
    expect(mb.min.y).toBeCloseTo(0.05, 9);
    expect(mb.max.y - mb.min.y).toBeCloseTo(1.5, 9);
    expect((mb.min.x + mb.max.x) / 2).toBeCloseTo(0.1, 9);
    expect((mb.min.z + mb.max.z) / 2).toBeCloseTo(-0.2, 9);
  });

  it('turns the front with yawDeg (VRM 0.x defaults to 180°, VRM 1.0 and glTF to 0°)', () => {
    const leftHandX = (t: ExternalVisualTemplate): number => positionInRoot(t.humanoidNodes!.get('leftHand')!, t.root).x;
    // A model facing −Z has its left hand on −X until turned.
    expect(leftHandX(template('kairen', gltfSpec(), { faceBack: true }))).toBeLessThan(-0.3);
    const turned = template('kairen', gltfSpec({ yawDeg: 180 }), { faceBack: true });
    expect(turned.yawDeg).toBe(180);
    expect(leftHandX(turned)).toBeGreaterThan(0.3);
    const vrmOf = (version: '0' | '1', fixture: FixtureOptions) => {
      const f = humanoidFixture(fixture);
      return buildExternalTemplate('isla', gltfSpec({ source: { kind: 'vrm', url: 'a.vrm' } }), loadedOf(f, 'vrm', vrmInfo(version, f.bones)), quiet);
    };
    const vrm0 = vrmOf('0', { faceBack: true });
    expect(vrm0.yawDeg).toBe(180);
    expect(leftHandX(vrm0)).toBeGreaterThan(0.3);
    const vrm1 = vrmOf('1', {});
    expect(vrm1.yawDeg).toBe(0);
    expect(leftHandX(vrm1)).toBeGreaterThan(0.3);
  });
});

/** A VRM loader result over a fixture (humanoid definition from the fixture bones) with spy parts. */
function vrmInfo(version: '0' | '1', bones: ReadonlyMap<string, THREE.Object3D>, parts?: VrmInstanceParts, maps?: ReadonlyMap<THREE.Object3D, THREE.Object3D>[]): VrmModelInfo {
  return {
    version,
    humanBones: new Map([...bones].map(([b, n]) => [b as HumanoidBoneName, n])),
    skip: () => false,
    instantiate: (map) => {
      (maps as ReadonlyMap<THREE.Object3D, THREE.Object3D>[] | undefined)?.push(map);
      return parts ?? { setInitState() {}, update() {}, reset() {}, hasExpression: () => false, setExpression() {}, dispose() {} };
    },
    dispose: () => undefined,
  };
}

describe('ExternalVisualInstance', () => {
  const A = (axis: [number, number, number], deg: number): THREE.Quaternion =>
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), (deg * Math.PI) / 180);

  it('retargets the procedural-named pose proxies onto raw bones with other rests (directions match, hips height follows)', () => {
    const t = template('kairen', gltfSpec({ source: { kind: 'fbx', url: 'a.fbx' } }), {
      unit: 100, armature: { rotation: A([1, 0, 0], -90), scale: 0.01 }, restRotation: (b) => alongBone(b).multiply(A([0, 1, 0], 17 * (FIXTURE_BONES.indexOf(b) + 1))),
    }, 'fbx');
    const instance = t.instantiate();
    expect([...instance.humanoid!.bones.keys()]).toEqual([...RIG_HUMANOID_BONES]);
    for (const bone of RIG_HUMANOID_BONES) expect(instance.joints.get(bone)).toBe(instance.humanoid!.bones.get(bone));
    const proxy = (b: HumanoidBoneName): THREE.Object3D => instance.humanoid!.bones.get(b)!;
    const raw = (b: HumanoidBoneName): THREE.Object3D => instance.rawBones.get(b)!;
    const restHips = positionInRoot(raw('hips'), instance.root).y;
    proxy('spine').quaternion.copy(A([1, 0, 0], 20));
    proxy('leftUpperArm').quaternion.copy(A([0, 0, 1], -60));
    proxy('leftLowerArm').quaternion.copy(A([0, 1, 0], 50));
    proxy('rightUpperLeg').quaternion.copy(A([1, 0.3, 0], -40));
    proxy('rightLowerLeg').quaternion.copy(A([1, 0, 0], 70));
    proxy('head').quaternion.copy(A([0, 1, 0.2], 35));
    proxy('hips').position.y -= 0.1;
    instance.update(1 / 60);
    const pairs: [HumanoidBoneName, HumanoidBoneName][] = [
      ['spine', 'chest'], ['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'], ['rightUpperArm', 'rightLowerArm'],
      ['rightUpperLeg', 'rightLowerLeg'], ['rightLowerLeg', 'rightFoot'], ['neck', 'head'], ['leftUpperLeg', 'leftLowerLeg'],
    ];
    for (const [a, b] of pairs) {
      const got = directionBetween(raw(a), raw(b));
      const want = directionBetween(proxy(a), proxy(b));
      expect(got.distanceTo(want), `${a} → ${b}`).toBeLessThan(1e-6);
    }
    // The head (a leaf) turns like its proxy: rotation relative to rest = the proxy's normalized world rotation.
    const headQ = rotationInRoot(raw('head'), instance.root).multiply(t.rest!.bones.find((x) => x.name === 'head')!.parentRest.clone().multiply(t.rest!.bones.find((x) => x.name === 'head')!.localRest).invert());
    expect(Math.abs(headQ.dot(rotationInRoot(proxy('head'), instance.root)))).toBeCloseTo(1, 9);
    expect(positionInRoot(raw('hips'), instance.root).y).toBeCloseTo(restHips - 0.1, 9);
    instance.dispose();
  });

  it('A-pose rests become the T-pose (arms level) before the rest is stored', () => {
    const t = template('kairen', gltfSpec({ restPose: 'A' }), { aPose: true });
    const instance = t.instantiate();
    instance.update(1 / 60);
    const raw = (b: HumanoidBoneName): THREE.Object3D => instance.rawBones.get(b)!;
    expect(directionBetween(raw('leftUpperArm'), raw('leftLowerArm')).distanceTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-9);
    expect(directionBetween(raw('rightLowerArm'), raw('rightHand')).distanceTo(new THREE.Vector3(-1, 0, 0))).toBeLessThan(1e-9);
    // Without the correction the arms keep hanging.
    const hanging = template('kairen', gltfSpec(), { aPose: true }).instantiate();
    hanging.update(1 / 60);
    expect(directionBetween(hanging.rawBones.get('leftUpperArm')!, hanging.rawBones.get('leftLowerArm')!).y).toBeCloseTo(-Math.SQRT1_2, 9);
  });

  it('hangs the sockets on the mapped bones (identity rest rotation) and the procedural weapon on weaponR', () => {
    const t = template('kairen', gltfSpec(), { restRotation: alongBone });
    const instance = t.instantiate();
    instance.root.updateMatrixWorld(true);
    expect([...instance.sockets.keys()].sort()).toEqual(['back', 'headTop', 'weaponL', 'weaponR']);
    expect(instance.sockets.get('weaponR')!.parent).toBe(instance.rawBones.get('rightHand'));
    expect(instance.sockets.get('weaponL')!.parent).toBe(instance.rawBones.get('leftHand'));
    expect(instance.sockets.get('back')!.parent).toBe(instance.rawBones.get('chest'));
    expect(instance.sockets.get('headTop')!.parent).toBe(instance.rawBones.get('head'));
    for (const socket of instance.sockets.values()) expect(Math.abs(rotationInRoot(socket, instance.root).w)).toBeCloseTo(1, 9);
    expect(positionInRoot(instance.sockets.get('headTop')!, instance.root).y).toBeCloseTo(1.01 * t.height, 9);
    expect(instance.weapon?.mesh.parent).toBe(instance.sockets.get('weaponR'));
    instance.stowWeapon(true);
    expect(instance.weapon?.mesh.parent).toBe(instance.sockets.get('back'));
    // Custom socket bone; the model's own weapon hides the procedural one.
    const custom = template('kairen', gltfSpec({ sockets: { weaponR: { bone: 'mixamorigRightForeArm', offset: [0, 0.1, 0] } }, hideProceduralWeapon: true })).instantiate();
    expect(custom.sockets.get('weaponR')!.parent!.name).toBe('mixamorigRightForeArm');
    expect(custom.weapon).toBeNull();
  });

  it("plays mapped clips on an AnimationMixer, time-scaled to the attack's length, without root motion", () => {
    const hipsTrack = new THREE.VectorKeyframeTrack('mixamorigHips.position', [0, 2], [0, 0.95, 0, 0.5, 0.85, 0.3]);
    const armTrack = new THREE.QuaternionKeyframeTrack('mixamorigRightArm.quaternion', [0, 2], [0, 0, 0, 1, ...A([1, 0, 0], 90).toArray()]);
    const slash = new THREE.AnimationClip('Slash', 2, [hipsTrack, armTrack]);
    const warnings: string[] = [];
    const t = buildExternalTemplate('kairen', gltfSpec({ clips: { attack: 'Slash', walk: 'NoSuchClip' } }), loadedOf(humanoidFixture({ restRotation: () => new THREE.Quaternion(), animations: [slash] })), { ...quiet, warn: (m) => warnings.push(m) });
    expect(warnings).toEqual([expect.stringContaining("clips.walk: no clip 'NoSuchClip' in the file (Slash)")]);
    const instance = t.instantiate();
    expect(instance.mixer).toBeInstanceOf(THREE.AnimationMixer);
    const n1: PoseClip = { name: 'kairen_n1', duration: 0.5, loop: false, tracks: {}, events: [] };
    const ctx: ClipContext = { clip: (name) => (name === 'kairen_n1' ? n1 : undefined) };
    const req = (time: number | null): AnimRequest => ({ base: { clip: 'kairen_idle' }, action: time === null ? null : { clip: 'kairen_n1', time }, override: null });
    const hips = instance.rawBones.get('hips')!;
    const restX = hips.position.x;
    const restZ = hips.position.z;
    instance.animate(1 / 60, req(0.25), ctx);
    instance.update(1 / 60);
    expect(instance.mode).toBe('mixer:Slash');
    expect(instance.currentAction!.time).toBeCloseTo(1, 9); // 0.25 / 0.5 of the 2 s file clip
    expect(hips.position.x).toBeCloseTo(restX, 9);
    expect(hips.position.z).toBeCloseTo(restZ, 9);
    expect(hips.position.y).toBeCloseTo(0.9, 6);
    instance.animate(1 / 60, req(0.5), ctx);
    instance.update(1 / 60);
    expect(instance.currentAction!.time).toBeCloseTo(2, 9);
    // Back to the retargeted pose after the crossfade.
    instance.animate(1 / 60, req(null), ctx);
    for (let i = 0; i < 30; i++) instance.update(1 / 60);
    expect(instance.mode).toBe('pose');
    expect(Math.abs(instance.rawBones.get('rightUpperArm')!.quaternion.w)).toBeCloseTo(1, 9);
  });

  it('gives generic models the procedural root animation (defeat sinks, move leans)', () => {
    const t = template('bramblekin', gltfSpec({ rig: 'generic' }));
    const instance = t.instantiate();
    expect(instance.humanoid).toBeNull();
    const motion = instance.root.getObjectByName('motion')!;
    const defeat: PoseClip = { name: 'bramblekin_defeat', duration: 1, loop: false, tracks: {}, events: [] };
    for (let i = 0; i < 20; i++) {
      instance.animate(1 / 60, { base: { clip: 'bramblekin_idle' }, action: null, override: { clip: 'bramblekin_defeat', time: 0.8 } }, { clip: () => defeat });
      instance.update(1 / 60);
    }
    expect(motion.position.y).toBeCloseTo(-0.35 * t.height * 0.64, 9);
    for (let i = 0; i < 20; i++) {
      instance.animate(1 / 60, { base: { clip: 'bramblekin_move', speed: 2 }, action: null, override: null });
      instance.update(1 / 60);
    }
    expect(motion.rotation.x).toBeCloseTo((6 * Math.PI) / 180, 9);
  });

  it('swaps to the toon material with outlines by default and drives flash, opacity and dissolve through one uniform set', () => {
    const t = template('kairen', gltfSpec());
    expect([t.materials, t.outline]).toEqual(['toon', true]);
    const instance = t.instantiate();
    const body = instance.scene.getObjectByName('Body') as THREE.SkinnedMesh;
    const material = body.material as THREE.MeshToonMaterial;
    expect(material).toBeInstanceOf(THREE.MeshToonMaterial);
    expect(material.color.getHex()).toBe(0x8899aa);
    expect(fxUniformsOf(material)).toBe(instance.fx);
    const outline = body.userData.outlineMesh as THREE.SkinnedMesh;
    expect(outline).toBeInstanceOf(THREE.SkinnedMesh);
    expect(outline.skeleton).toBe(body.skeleton);
    // The shader patch: the effect uniforms and the flash / opacity / dissolve code.
    const shader = { uniforms: {} as Record<string, unknown>, vertexShader: THREE.ShaderLib.toon.vertexShader, fragmentShader: THREE.ShaderLib.toon.fragmentShader };
    material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
    expect(shader.uniforms.uFxFlash).toBe(instance.fx.uFxFlash);
    expect(shader.vertexShader).toContain('vFxPos');
    expect(shader.fragmentShader).toContain('gl_FragColor.a *= uFxOpacity');
    expect(shader.fragmentShader).toContain('if ( fxT < uFxDissolve ) discard;');
    instance.setFlash(0.7, 0xff0000);
    expect(instance.fx.uFxFlash.value).toBe(0.7);
    expect(instance.fx.uFxFlashColor.value.getHex()).toBe(0xff0000);
    instance.setOpacity(0.4);
    expect([material.transparent, instance.fx.uFxOpacity.value, outline.visible]).toEqual([true, 0.4, false]);
    instance.setOpacity(1);
    expect([material.transparent, outline.visible]).toEqual([false, true]);
    instance.setDissolve(0.5, true);
    expect([instance.fx.uFxDissolve.value, instance.fx.uFxDissolveRise.value, outline.visible]).toEqual([0.5, 1, false]);
    // 'original' keeps the file's material (a per-instance copy), without an outline unless asked.
    const original = template('kairen', gltfSpec({ materials: 'original' }));
    expect([original.materials, original.outline]).toEqual(['original', false]);
    const copy = original.instantiate().scene.getObjectByName('Body') as THREE.Mesh;
    expect(copy.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(copy.material).not.toBe((original.scene.getObjectByName('Body') as THREE.Mesh).material);
    expect(fxUniformsOf(copy.material as THREE.Material)).toBeDefined();
  });

  it('VRM: original materials, springs in scaled time on the cloned nodes, blink through the expression', () => {
    const fixture = humanoidFixture({ names: Object.fromEntries(FIXTURE_BONES.map((b, i) => [b, `node${i}`])) });
    const parts = {
      setInitState: vi.fn(), update: vi.fn(), reset: vi.fn(), hasExpression: (name: string) => name === 'blink', setExpression: vi.fn(), dispose: vi.fn(),
    } satisfies VrmInstanceParts;
    const maps: ReadonlyMap<THREE.Object3D, THREE.Object3D>[] = [];
    const t = buildExternalTemplate('isla', gltfSpec({ source: { kind: 'vrm', url: 'a.vrm' } }), loadedOf(fixture, 'vrm', vrmInfo('1', fixture.bones, parts, maps)), quiet);
    // The humanoid definition maps names detection cannot read.
    expect(t.bones.missing).toEqual([]);
    expect(t.bones.sources.get('leftUpperArm')).toBe('vrm');
    expect([t.materials, t.outline]).toEqual(['original', false]);
    const instance = t.instantiate();
    expect(parts.setInitState).toHaveBeenCalledTimes(1);
    expect(maps[0]!.get(fixture.bones.get('leftHand')!)).toBe(instance.rawBones.get('leftHand'));
    instance.update(0.1);
    expect(parts.update).toHaveBeenLastCalledWith(0.1);
    instance.update(0); // Hit_Stop: scaled time stops
    expect(parts.update).toHaveBeenLastCalledWith(0);
    instance.setExpression('blink', 1);
    instance.update(0.02);
    expect(parts.setExpression).toHaveBeenCalledWith('blink', 0.5);
    instance.resetSecondary();
    expect(parts.reset).toHaveBeenCalled();
    instance.dispose();
    expect(parts.dispose).toHaveBeenCalled();
  });
});
