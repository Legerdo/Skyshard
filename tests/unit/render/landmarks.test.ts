import * as THREE from 'three';
import { afterAll, describe, expect, it } from 'vitest';
import { LANDMARK_IDS } from '../../../src/data/ids';
import { RENDER_QUALITY_PRESETS, renderQualityFor } from '../../../src/data/renderQuality';
import { RESONANCE_ALTAR } from '../../../src/data/starlitStair';
import { LandmarkView } from '../../../src/render/landmarks';
import { isToonMaterial, toonFogCap } from '../../../src/render/toonMaterial';

// Task 18.3: Landmark visibility (far plane, LOD, fog cap, never culled) and the Astral Sanctum seal ring / altar
// light pillar, as three.js objects in Node (no WebGL).

const ground = (x: number, z: number): number => 20 + 0.02 * x - 0.01 * z;
const view = new LandmarkView({ heightAt: ground });
const scene = new THREE.Scene();
scene.add(view.object);
scene.updateMatrixWorld(true);
afterAll(() => view.dispose());

function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) out.push(o);
  });
  return out;
}

function triangles(root: THREE.Object3D): number {
  let n = 0;
  for (const m of meshesOf(root)) {
    const g = m.geometry;
    n += (g.index?.count ?? g.getAttribute('position').count) / 3;
  }
  return n;
}

/** Farthest point of the level's meshes from `eye` (world bounding spheres). */
function farthest(level: THREE.Object3D, eye: THREE.Vector3): number {
  let d = 0;
  for (const m of meshesOf(level)) {
    m.geometry.computeBoundingSphere();
    const s = (m.geometry.boundingSphere as THREE.Sphere).clone().applyMatrix4(m.matrixWorld);
    d = Math.max(d, eye.distanceTo(s.center) + s.radius);
  }
  return d;
}

/** Sample eyes: the four world corners (ground and high), the centre, the Sanctum and a spot next to every Landmark. */
function samples(): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const x of [-560, 560]) for (const z of [-560, 560]) for (const y of [2, 260]) out.push(new THREE.Vector3(x, y, z));
  out.push(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, 195, 20), new THREE.Vector3(-300, 40, 300), new THREE.Vector3(300, 30, -300));
  for (const lod of view.landmarks.values()) {
    const at = lod.getWorldPosition(new THREE.Vector3());
    out.push(new THREE.Vector3(at.x + 12, Math.max(ground(at.x, at.z), at.y - 30) + 2, at.z + 12));
  }
  return out;
}

describe('Landmark visibility', () => {
  it('builds every Landmark as a THREE.LOD (near 0 m, far low-poly at 400 m) marked as never culled or unloaded', () => {
    expect([...view.landmarks.keys()].sort()).toEqual([...LANDMARK_IDS].sort());
    for (const id of LANDMARK_IDS) {
      const lod = view.landmarks.get(id) as THREE.LOD;
      expect(lod).toBeInstanceOf(THREE.LOD);
      expect(lod.name).toBe(id);
      expect(lod.userData.landmark).toBe(id);
      expect(lod.levels.map((l) => l.distance)).toEqual([0, 400]);
      const [near, far] = lod.levels.map((l) => l.object) as [THREE.Object3D, THREE.Object3D];
      expect(triangles(far)).toBeGreaterThan(0);
      expect(triangles(far)).toBeLessThan(triangles(near));
      // Landmark-only toon instances with fogCap 0.55 on every lit surface.
      for (const m of meshesOf(lod)) {
        const material = m.material as THREE.Material;
        expect(isToonMaterial(material)).toBe(true);
        expect(toonFogCap(material)).toBe(0.55);
      }
      // The far level keeps the outline: its bounds match the near level's within 25 %.
      const nearBox = new THREE.Box3().setFromObject(near);
      const farBox = new THREE.Box3().setFromObject(far);
      const nearSize = nearBox.getSize(new THREE.Vector3());
      const farSize = farBox.getSize(new THREE.Vector3());
      const extent = Math.max(nearSize.x, nearSize.y, nearSize.z);
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(Math.abs(farSize[axis] - nearSize[axis]), `${id} ${axis}`).toBeLessThanOrEqual(0.25 * extent);
      }
      expect(nearBox.getCenter(new THREE.Vector3()).distanceTo(farBox.getCenter(new THREE.Vector3())), id).toBeLessThanOrEqual(0.25 * extent);
    }
  });

  it('keeps every Landmark in the scene and inside the far plane from every sample position, in all three quality presets', () => {
    for (const preset of RENDER_QUALITY_PRESETS) {
      const q = renderQualityFor(preset);
      const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, q.cameraFar);
      expect(camera.far).toBe(2200);
      for (const eye of samples()) {
        camera.position.copy(eye);
        camera.updateMatrixWorld(true);
        for (const id of LANDMARK_IDS) {
          const lod = scene.getObjectByName(id) as THREE.LOD;
          expect(lod).toBe(view.landmarks.get(id));
          expect(lod.visible).toBe(true);
          expect(lod.levels.map((l) => l.distance)).toEqual([0, q.landmarkLodDistance]);
          lod.update(camera);
          const shown = lod.levels.filter((l) => l.object.visible);
          expect(shown).toHaveLength(1);
          const d = eye.distanceTo(lod.getWorldPosition(new THREE.Vector3()));
          if (Math.abs(d - q.landmarkLodDistance) > 20) expect(lod.getCurrentLevel()).toBe(d > q.landmarkLodDistance ? 1 : 0);
          const level = (shown[0] as { object: THREE.Object3D }).object;
          expect(farthest(level, eye)).toBeLessThan(q.cameraFar);
          for (const m of meshesOf(level)) expect(toonFogCap(m.material as THREE.Material)).toBe(q.landmarkFogCap);
        }
      }
    }
  });
});

describe('Astral Sanctum seal ring and Resonance_Altar light pillar', () => {
  const litSegments = (v: LandmarkView): number => v.sealSegments.filter((m) => m.emissiveIntensity > 0).length;

  it('has three segments per ring level, segment k lit by Skyshard k + 1', () => {
    const sanctum = view.landmarks.get('lm_astral_sanctum') as THREE.LOD;
    for (const level of sanctum.levels) {
      const segments: THREE.Mesh[] = [];
      level.object.traverse((o) => {
        if (o instanceof THREE.Mesh && o.name.startsWith('seal_segment_')) segments.push(o);
      });
      expect(segments.map((s) => s.name).sort()).toEqual(['seal_segment_1', 'seal_segment_2', 'seal_segment_3']);
      for (const s of segments) expect(s.material).toBe(view.sealSegments[Number(s.name.slice(-1)) - 1]);
    }
  });

  it('after a load lights as many segments as Skyshards held, without animation', () => {
    for (const held of [0, 1, 2, 3]) {
      const v = new LandmarkView({ heightAt: ground });
      v.update(10, 0.016, { skyshards: held, pillarVisible: held >= 3 });
      expect(litSegments(v)).toBe(held);
      expect([0, 1, 2].map((k) => v.sealGlow(k))).toEqual([0, 1, 2].map((k) => (k < held ? 1 : 0)));
      expect(v.pillar.visible).toBe(held >= 3);
      if (held >= 3) expect(v.pillar.scale.y).toBe(1);
      for (const k of [0, 1, 2]) {
        const m = v.sealSegments[k] as THREE.MeshToonMaterial;
        if (k < held) expect(m.emissive.getHex()).toBe(0xffd66b); // gold
      }
      v.dispose();
    }
  });

  it('lights the new segment inside the acquisition cinematic and raises the pillar from Skyshard 3', () => {
    const v = new LandmarkView({ heightAt: ground });
    v.update(0, 0.016, { skyshards: 2, pillarVisible: false });
    expect(litSegments(v)).toBe(2);
    // 'skyshard:acquired' (index 3) arrives in the tick before the frame that shows the new count.
    v.skyshardAcquired(3);
    v.update(0.5, 0.5, { skyshards: 3, pillarVisible: true });
    expect(v.sealGlow(2)).toBeCloseTo(1 / 3, 6);
    expect(v.pillar.visible).toBe(true);
    expect(v.pillar.scale.y).toBeGreaterThan(0);
    expect(v.pillar.scale.y).toBeLessThan(1);
    v.update(1.5, 1.0, { skyshards: 3, pillarVisible: true });
    expect(v.sealGlow(2)).toBe(1);
    v.update(3, 1.5, { skyshards: 3, pillarVisible: true });
    expect(v.pillar.scale.y).toBe(1);
    v.dispose();
  });

  it('draws the pillar additive, without depth writes or fog, never culled, over the altar', () => {
    const p = view.pillar;
    expect(p.position.toArray()).toEqual([RESONANCE_ALTAR.pos.x, RESONANCE_ALTAR.pos.y, RESONANCE_ALTAR.pos.z]);
    const meshes = meshesOf(p);
    expect(meshes.length).toBeGreaterThan(0);
    for (const m of meshes) {
      const material = m.material as THREE.MeshBasicMaterial;
      expect([material.blending, material.depthWrite, material.fog, material.transparent]).toEqual([THREE.AdditiveBlending, false, false, true]);
      expect(m.frustumCulled).toBe(false);
      // Fades toward the top: vertex alpha 1 − t.
      const color = m.geometry.getAttribute('color');
      expect(color.itemSize).toBe(4);
    }
    expect(p.parent).toBe(view.object);
  });
});
