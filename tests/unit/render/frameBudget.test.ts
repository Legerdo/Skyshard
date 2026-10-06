import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CAMERA_FOV_DEG, DEFAULT_DISTANCE, DEFAULT_PITCH, SHOULDER_HEIGHT } from '../../../src/camera/constants';
import { UiCommandQueue } from '../../../src/core/uiCommands';
import { CAMERA_FAR_PLANE, CAMERA_NEAR_PLANE } from '../../../src/data/renderQuality';
import { LOCATIONS } from '../../../src/data/worldLayout';
import { InputState } from '../../../src/input/inputState';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { PlaySim } from '../../../src/playSim';
import { EnvironmentView } from '../../../src/render/environmentView';
import { LandmarkView } from '../../../src/render/landmarks';
import { prefabMaterial } from '../../../src/render/prefabs/kit';
import { DEFAULT_FRAME_COST, FRAME_BUDGET, postConfigFor, postPassCount } from '../../../src/render/qualityApplier';
import { SHADOW_HALF_EXTENT, SHADOW_SUN_DISTANCE } from '../../../src/render/shadows';
import { TempAirVolumeView } from '../../../src/render/tempAirVolumeView';
import { TempChallengeAreaView } from '../../../src/render/tempChallengeAreaView';
import { TempPoiView } from '../../../src/render/tempPoiView';
import { TempPuzzleView } from '../../../src/render/tempPuzzleView';
import { TempRouteView } from '../../../src/render/tempRouteView';
import { TempSanctumView } from '../../../src/render/tempSanctumView';
import { TempVillageView } from '../../../src/render/tempVillageView';
import { TempWaystoneView } from '../../../src/render/tempWaystoneView';
import { createTerrainView } from '../../../src/render/terrainView';
import { WorldEdgeView } from '../../../src/render/worldEdgeView';
import { WorldObjectsView } from '../../../src/render/worldObjectsView';
import { createWorldScene } from '../../../src/render/worldScene';
import { defaultSettings, SettingsStore } from '../../../src/settings/settings';
import { buildTerrain } from '../../../src/world/terrain';

// Task 18.4 / 18.6 budget (design "성능 예산 (Default_Quality)"; Req 38.3, 38.5): a headless estimate of the draw calls
// and triangles at the worst viewpoints, from the scene graph the page builds (world scene, terrain view, the static
// world views), seen through the gameplay camera (60° fov, 16:9, 5.5 m behind the shoulder, 15° down) in 8 headings.
// It mirrors three.js' own counting: visible Mesh / Line / Points / Sprite under visible parents, LODs updated for the
// camera, per-object frustum culling where `frustumCulled`, one call per drawn material group, instanced meshes one
// call for all their instances; the shadow pass counts the casters inside the 80 m character shadow box. The actors
// (heroes, NPC stand-ins outside the village, enemies, Caelith), the VFX and the composer passes are not in this scene;
// the design's allowances stand in for them (the actors counted twice: body pass and shadow pass).

const SEED = 20240601; // main.ts WORLD_SEED
const terrain = buildTerrain(SEED);
const gameState = createNewGameState(SEED);
const sim = new PlaySim({
  gameState, terrain, input: new InputState(), commands: new UiCommandQueue(), sinks: { partyWipe: () => undefined, ending: () => undefined },
});
const world = createWorldScene();
const scene = world.scene;
const settings = new SettingsStore(defaultSettings()); // Default_Quality ('medium')
const view = createTerrainView(terrain, { settings });
const heightAt = (x: number, z: number): number => terrain.heightAt(x, z);
const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 16 / 9, CAMERA_NEAR_PLANE, CAMERA_FAR_PLANE);
const route = new TempRouteView(sim.route, sim.stubs);
const sanctum = new TempSanctumView(sim.sanctum);
const puzzles = new TempPuzzleView(sim.puzzles);
const area = new TempChallengeAreaView(sim.challenge, sim.pillars, scene);
const village = new TempVillageView({ village: sim.village, npcs: sim.npcs, sideQuests: sim.sideQuests, heightAt, player: () => sim.player.state.pos });
const landmarks = new LandmarkView({ heightAt });
const pois = new TempPoiView({ chests: sim.chests, pois: sim.pois, state: gameState, heightAt });
const edge = new WorldEdgeView();
const waystones = new TempWaystoneView(sim.waystones);
const objects = new WorldObjectsView();
const air = new TempAirVolumeView();
const env = new EnvironmentView({
  terrain, bus: sim.bus, camera, progress: () => gameState, player: () => sim.player.state, enemies: () => [], npcs: () => [],
  projectiles: () => [], challengeArea: () => sim.challenge.current, quality: () => 'medium',
});
const GROUPS: Readonly<Record<string, THREE.Object3D>> = {
  terrain: view.terrain.object, vegetation: view.vegetation?.object ?? new THREE.Group(), terrainProps: view.props, sky: world.sky.mesh,
  route: route.object, sanctum: sanctum.object, puzzles: puzzles.object, area: area.object, village: village.object, landmarks: landmarks.object,
  pois: pois.object, edge: edge.object, waystones: waystones.object, objects: objects.object, air: air.object, env: env.object,
};
scene.add(view.object);
for (const [name, o] of Object.entries(GROUPS)) if (o.parent === null && name !== 'sky') scene.add(o);

/** The design's allowances for what this scene leaves out. */
const actors = DEFAULT_FRAME_COST.find((i) => i.id === 'actors') as { drawCalls: number; triangles: number };
const vfx = DEFAULT_FRAME_COST.find((i) => i.id === 'vfx') as { drawCalls: number; triangles: number };
const POST = postPassCount(postConfigFor(settings.get()));
const ALLOWANCE = { drawCalls: actors.drawCalls * 2 + vfx.drawCalls + POST, triangles: actors.triangles * 2 + vfx.triangles + POST };

interface Tally { calls: number; triangles: number }

function drawsOf(o: THREE.Object3D): Tally {
  const mesh = o as THREE.Mesh;
  const g = mesh.geometry as THREE.BufferGeometry;
  const instances = o instanceof THREE.InstancedMesh ? o.count : 1;
  if (instances === 0) return { calls: 0, triangles: 0 }; // three.js skips empty instanced draws
  const count = g.index !== null ? g.index.count : (g.getAttribute('position')?.count ?? 0);
  const triangles = mesh.isMesh ? count / 3 : 0;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  if (Array.isArray(mesh.material) && g.groups.length > 0) {
    const out = { calls: 0, triangles: 0 };
    for (const group of g.groups) {
      if (materials[group.materialIndex ?? 0]?.visible !== true) continue;
      out.calls++;
      out.triangles += (mesh.isMesh ? group.count / 3 : 0) * instances;
    }
    return out;
  }
  return materials[0]?.visible === false ? { calls: 0, triangles: 0 } : { calls: 1, triangles: triangles * instances };
}

/** Draws of `root` for `cam` (the shadow pass: casters only, no sprites). */
function tally(root: THREE.Object3D, cam: THREE.Camera, frustum: THREE.Frustum, shadow: boolean, out: Tally): void {
  if (!root.visible) return;
  if (root instanceof THREE.LOD && root.autoUpdate) root.update(cam);
  const o = root as THREE.Mesh & THREE.Points & THREE.Line & THREE.Sprite;
  const drawable = o.isMesh === true || o.isLine === true || o.isPoints === true || (o.isSprite === true && !shadow);
  if (drawable && (!shadow || root.castShadow) && (!root.frustumCulled || frustum.intersectsObject(root))) {
    const d = drawsOf(root);
    out.calls += d.calls;
    out.triangles += d.triangles;
  }
  for (const c of root.children) tally(c, cam, frustum, shadow, out);
}

const SUN = new THREE.Vector3(0.5, 0.62, 0.35).normalize(); // an afternoon sun (the shadow box's depth covers any)
const sun = new THREE.DirectionalLight();
{
  const box = sun.shadow.camera;
  box.left = -SHADOW_HALF_EXTENT;
  box.right = SHADOW_HALF_EXTENT;
  box.top = SHADOW_HALF_EXTENT;
  box.bottom = -SHADOW_HALF_EXTENT;
  box.near = 1;
  box.far = SHADOW_SUN_DISTANCE * 2;
  box.updateProjectionMatrix();
}

interface FrameEstimate {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly shadowCalls: number;
  readonly byGroup: Readonly<Record<string, number>>;
}

/** One gameplay frame with the Active_Character's feet at `feet`, the camera heading `yaw` (rad). */
function frame(feet: Readonly<{ x: number; y: number; z: number }>, yaw: number): FrameEstimate {
  const target = new THREE.Vector3(feet.x, feet.y + SHOULDER_HEIGHT, feet.z);
  const forward = new THREE.Vector3(Math.sin(yaw) * Math.cos(DEFAULT_PITCH), -Math.sin(DEFAULT_PITCH), Math.cos(yaw) * Math.cos(DEFAULT_PITCH));
  camera.position.copy(target).addScaledVector(forward, -DEFAULT_DISTANCE);
  camera.lookAt(target.clone().addScaledVector(forward, 10));
  camera.updateMatrixWorld();
  const pos = sim.player.state.pos;
  pos.x = feet.x;
  pos.y = feet.y;
  pos.z = feet.z;
  view.prewarm(camera, feet);
  route.update(0);
  sanctum.update(0);
  puzzles.update(0);
  area.update(0, 1 / 60, feet);
  objects.update({ barriers: sim.gates.views(), stairActive: sim.stair.active, pillarVisible: sim.altar.pillarVisible }, 0);
  waystones.update(0);
  village.update(0, 1 / 60);
  landmarks.update(0, 1 / 60, { skyshards: gameState.skyshards, pillarVisible: sim.altar.pillarVisible });
  pois.update(0);
  edge.update(0);
  env.update(1 / 60, feet);
  world.sky.mesh.position.copy(camera.position);
  scene.updateMatrixWorld(true);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  sun.position.set(feet.x, feet.y, feet.z).addScaledVector(SUN, SHADOW_SUN_DISTANCE);
  sun.target.position.set(feet.x, feet.y, feet.z);
  sun.updateMatrixWorld();
  sun.target.updateMatrixWorld();
  sun.shadow.updateMatrices(sun);
  const shadowFrustum = sun.shadow.getFrustum();
  const byGroup: Record<string, number> = {};
  let drawCalls = 0;
  let triangles = 0;
  let shadowCalls = 0;
  for (const [name, root] of Object.entries(GROUPS)) {
    const main = { calls: 0, triangles: 0 };
    tally(root, camera, frustum, false, main);
    const cast = { calls: 0, triangles: 0 };
    if (name !== 'sky') tally(root, sun.shadow.camera, shadowFrustum, true, cast);
    byGroup[name] = main.calls;
    drawCalls += main.calls + cast.calls;
    triangles += main.triangles + cast.triangles;
    shadowCalls += cast.calls;
  }
  return { drawCalls, triangles, shadowCalls, byGroup };
}

const HEADINGS = Array.from({ length: 8 }, (_, k) => (k * Math.PI) / 4);

/** The worst of the 8 headings at `feet`. */
function worst(feet: Readonly<{ x: number; y: number; z: number }>): FrameEstimate & { readonly yawDeg: number } {
  let best: (FrameEstimate & { yawDeg: number }) | null = null;
  for (const yaw of HEADINGS) {
    const f = frame(feet, yaw);
    if (best === null || f.drawCalls > best.drawCalls) best = { ...f, yawDeg: Math.round((yaw * 180) / Math.PI) };
  }
  return best as FrameEstimate & { yawDeg: number };
}

const ground = (id: keyof typeof LOCATIONS): { x: number; y: number; z: number } => {
  const l = LOCATIONS[id];
  return { x: l.x, y: heightAt(l.x, l.z), z: l.z };
};

/** Standing on a location's own ground height (windmill top, mesa, peak, floating island …). */
const at = (id: keyof typeof LOCATIONS): { x: number; y: number; z: number } => {
  const l = LOCATIONS[id];
  return { x: l.x, y: l.groundY, z: l.z };
};

/**
 * The worst viewpoints: the village, the Ember canyon below Cinderspire and its summit, the Sanctum arena, the crater
 * floor, and the high views over the whole map (the Regions' Vista_Points and the Observatory, the bot's Landmark
 * vista stops).
 */
const VIEWPOINTS: readonly { readonly name: string; readonly feet: { x: number; y: number; z: number } }[] = [
  { name: 'Thistlewick plaza', feet: ground('thistlewick') },
  { name: 'Ember canyon (ws_ember)', feet: ground('ws_ember') },
  { name: 'Cinderspire base', feet: ground('cinderspire_base') },
  { name: 'Cinderspire summit', feet: at('cinderspire_summit') },
  { name: 'Sanctum arena', feet: at('sanctum_arena') },
  { name: 'Shardfall Crater (ws_crater)', feet: ground('ws_crater') },
  { name: 'Verdant Vista_Point (windmill top)', feet: at('vista_verdant') },
  { name: 'Ember Vista_Point (mesa)', feet: at('vista_ember') },
  { name: 'Azure Vista_Point (peak)', feet: at('vista_azure') },
  { name: 'Starfall Observatory entrance', feet: at('observatory_entrance') },
];

describe('frame budget at the worst viewpoints (Default_Quality)', () => {
  it.each(VIEWPOINTS)('$name stays within 500 draw calls and 1.5 M triangles with the actor / VFX / post allowances', ({ feet }) => {
    const w = worst(feet);
    const detail = `${JSON.stringify(w.byGroup)} shadow ${w.shadowCalls} (heading ${w.yawDeg}°)`;
    expect(w.drawCalls + ALLOWANCE.drawCalls, detail).toBeLessThanOrEqual(FRAME_BUDGET.drawCalls);
    expect(w.triangles + ALLOWANCE.triangles, detail).toBeLessThanOrEqual(FRAME_BUDGET.triangles);
    // The design's per-item figures: terrain ≈ 60 calls (merged far LOD groups), vegetation ≈ 140 (chunk × kind near,
    // far blocks beyond 120 m), and small casters kept out of the shadow pass.
    expect(w.byGroup.terrain, detail).toBeLessThanOrEqual(60);
    expect(w.byGroup.vegetation, detail).toBeLessThanOrEqual(140);
    expect(w.shadowCalls, detail).toBeLessThanOrEqual(40);
  });

  it('draws the key-location prefabs of the world views with the shared toon material, one mesh each', () => {
    const names = ['prefab:windmill', 'prefab:bridge', 'area:hollowroot:prefab', 'area:cinderspire:prefab', 'area:observatory:prefab', 'sanctum:prefab'];
    for (const name of names) {
      const found: THREE.Mesh[] = [];
      scene.traverse((o) => {
        if (o.name === name && o instanceof THREE.Mesh) found.push(o);
      });
      expect(found, name).toHaveLength(1);
      expect((found[0] as THREE.Mesh).material, name).toBe(prefabMaterial());
    }
    const houses = village.object.children.filter((o) => o.name.startsWith('village:static:')) as THREE.Mesh[];
    expect(houses.length).toBeGreaterThan(0);
    for (const m of houses) expect(m.material).toBe(prefabMaterial());
  });

  it('hides small POI, puzzle and Challenge_Area details far away but keeps them near', () => {
    const near = worst(ground('thistlewick'));
    const far = worst(at('sanctum_arena'));
    expect(far.byGroup.pois).toBeLessThanOrEqual(near.byGroup.pois);
    // From the Sanctum (170 m up) no chest, tablet or herb is within reach; the Challenge_Area prefabs stay (landmark-like).
    expect(far.byGroup.puzzles).toBe(0);
    expect(near.byGroup.pois).toBeGreaterThan(0);
    // The village NPC rigs (2–4 calls each) hide beyond NPC_CULL_DISTANCE of the camera; the merged chunks stay.
    const shown = (o: THREE.Object3D | undefined): boolean => {
      for (let p: THREE.Object3D | null | undefined = o; p !== null && p !== undefined; p = p.parent) if (!p.visible) return false;
      return o !== undefined;
    };
    expect(far.byGroup.village).toBeLessThan(near.byGroup.village);
    expect(shown(village.npcObject('maren'))).toBe(false);
    worst(ground('thistlewick'));
    expect(shown(village.npcObject('maren'))).toBe(true);
  });
});
