/*
 * Ambient creatures (design.md "대기 효과·환경 생물"; Req 39.4):
 * - Birds: one boids-lite flock of 8–12 per Region (Verdant, Ember, Azure; src/render/boids.ts). Each flock circles
 *   the anchor of its Region nearest the Active_Character and moves to another anchor as the player travels; a
 *   sprint close by scatters it. All birds are one InstancedMesh (dark silhouettes, wings flapped in the vertex
 *   shader per instance), one draw call.
 * - Butterflies: three around each flower patch (the village flower beds and the herb bushes) within 60 m of the
 *   camera, fluttering on seeded Lissajous paths; one InstancedMesh with per-instance colours.
 */
import * as THREE from 'three';
import { createRng } from '../core/rng';
import type { Vec3 } from '../core/types';
import { POIS } from '../data/pois';
import { FLOWER_BEDS } from '../data/village';
import { LOCATIONS, type LocationId } from '../data/worldLayout';
import { createFlock, stepFlock, type Flock, type FlockThreat } from './boids';

export type FlockRegion = 'verdant' | 'ember' | 'azure';

/** Places each Region's flock circles (it picks the one nearest the Active_Character). */
export const FLOCK_ANCHORS: Readonly<Record<FlockRegion, readonly LocationId[]>> = {
  verdant: ['thistlewick', 'breezewatch', 'lm_elderbough', 'lm_waterfall'],
  ember: ['camp_durga', 'broken_bridge', 'cinderspire_base', 'vista_ember'],
  azure: ['camp_oriel', 'lm_arch_azure', 'lake_azure', 'observatory_entrance'],
};

const FLAP_PROGRAM = 'skyshard-flap-v1';

/** A basic material whose `aWing` vertices flap per instance (`uFlapTime`, speed and amount per material). */
function flapMaterial(color: number, speed: number, amount: number, fold: number, instanceColors: boolean): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, fog: true });
  const uniforms = { uFlapTime: { value: 0 }, uFlapSpeed: { value: speed }, uFlapAmount: { value: amount }, uFlapFold: { value: fold } };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aWing;
uniform float uFlapTime;
uniform float uFlapSpeed;
uniform float uFlapAmount;
uniform float uFlapFold;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
	float flapPhase = uFlapTime * uFlapSpeed + float( gl_InstanceID ) * 1.93;
	float flap = sin( flapPhase );
	float span = abs( transformed.x );
	transformed.y += aWing * flap * uFlapAmount * span;
	transformed.x *= 1.0 - aWing * uFlapFold * ( 0.5 + 0.5 * flap );
}`);
  };
  material.customProgramCacheKey = () => FLAP_PROGRAM;
  if (instanceColors) material.color.set(0xffffff);
  Object.defineProperty(material.userData, 'flap', { value: uniforms, enumerable: false });
  return material;
}

function flapUniforms(material: THREE.Material): { uFlapTime: { value: number } } {
  return (material.userData as { flap: { uFlapTime: { value: number } } }).flap;
}

/** A small bird: a slim body along +z and two wings (aWing 1 at the tips). */
export function birdGeometry(): THREE.BufferGeometry {
  const pos = [
    // body (two crossed slivers)
    0, 0, 0.32, 0, 0.05, -0.28, 0, -0.04, -0.3,
    0, 0, 0.32, 0.05, 0, -0.28, -0.05, 0, -0.28,
    // left wing
    0, 0, 0.12, -0.55, 0.02, -0.08, 0, 0, -0.14,
    // right wing
    0, 0, 0.12, 0, 0, -0.14, 0.55, 0.02, -0.08,
    // tail
    0, 0, -0.26, -0.12, 0, -0.44, 0.12, 0, -0.44,
  ];
  const wing = [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
  g.computeVertexNormals();
  return g;
}

/** A butterfly: two wing pairs spanning ±0.09 m (aWing 1 away from the body). */
export function butterflyGeometry(): THREE.BufferGeometry {
  const pos = [
    0, 0, 0.02, -0.09, 0.01, 0.05, -0.08, 0, -0.02,
    0, 0, 0.02, 0.08, 0, -0.02, 0.09, 0.01, 0.05,
    0, 0, -0.01, -0.07, 0, -0.03, -0.05, 0, -0.07,
    0, 0, -0.01, 0.05, 0, -0.07, 0.07, 0, -0.03,
  ];
  const wing = [0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
  g.computeVertexNormals();
  return g;
}

interface RegionFlock {
  readonly region: FlockRegion;
  readonly flock: Flock;
  anchor: LocationId;
}

const BIRD_CAPACITY = 36;

export class BirdFlocks {
  readonly mesh: THREE.InstancedMesh;
  private readonly flocks: RegionFlock[];
  private readonly material: THREE.MeshBasicMaterial;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  constructor(private readonly groundAt: (x: number, z: number) => number, seed = 0xb1d5) {
    this.flocks = (Object.keys(FLOCK_ANCHORS) as FlockRegion[]).map((region, i) => {
      const anchor = FLOCK_ANCHORS[region][0];
      const at = LOCATIONS[anchor];
      return { region, anchor, flock: createFlock(seed + i * 131, { x: at.x, y: at.groundY, z: at.z }, groundAt(at.x, at.z)) };
    });
    this.material = flapMaterial(0x2b2a3a, 11, 0.55, 0, false);
    this.mesh = new THREE.InstancedMesh(birdGeometry(), this.material, BIRD_CAPACITY);
    this.mesh.name = 'birds';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.count = 0;
  }

  /** Birds per Region (8–12 each). */
  sizes(): Record<FlockRegion, number> {
    return Object.fromEntries(this.flocks.map((f) => [f.region, f.flock.birds.length])) as Record<FlockRegion, number>;
  }

  update(dt: number, time: number, player: FlockThreat): void {
    for (const f of this.flocks) {
      // Circle the Region anchor nearest the Active_Character.
      let best = f.anchor;
      let bestD = Infinity;
      for (const id of FLOCK_ANCHORS[f.region]) {
        const l = LOCATIONS[id];
        const d = Math.hypot(l.x - player.pos.x, l.z - player.pos.z);
        if (d < bestD) {
          bestD = d;
          best = id;
        }
      }
      if (best !== f.anchor) {
        f.anchor = best;
        const l = LOCATIONS[best];
        f.flock.home = { x: l.x, y: l.groundY, z: l.z };
      }
      stepFlock(f.flock, dt, this.groundAt, player);
    }
    let n = 0;
    for (const f of this.flocks) {
      for (const b of f.flock.birds) {
        if (n >= BIRD_CAPACITY) break;
        const yaw = Math.atan2(b.vel.x, b.vel.z);
        const pitch = -Math.atan2(b.vel.y, Math.hypot(b.vel.x, b.vel.z));
        this.e.set(pitch, yaw, 0);
        this.q.setFromEuler(this.e);
        this.m.compose(this.p.set(b.pos.x, b.pos.y, b.pos.z), this.q, this.s.setScalar(1.3));
        this.mesh.setMatrixAt(n++, this.m);
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    flapUniforms(this.material).uFlapTime.value = time;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}

/** A flower patch butterflies circle. */
export interface FlowerPatch {
  readonly x: number;
  readonly z: number;
}

/** The village flower beds and every herb bush outside the crater and the Sanctum. */
export function flowerPatches(): FlowerPatch[] {
  const herbs = POIS.filter((p) => p.kind === 'herb' && (p.region === 'verdant' || p.region === 'azure' || p.region === 'ember'));
  return [...FLOWER_BEDS.map((b) => ({ x: b.x, z: b.z })), ...herbs.map((h) => ({ x: h.pos.x, z: h.pos.z }))];
}

const BUTTERFLIES_PER_PATCH = 3;
const BUTTERFLY_RANGE = 60;
const BUTTERFLY_CAPACITY = 30;
const BUTTERFLY_COLORS = [0xffe066, 0xfff4e0, 0x8fd0ff, 0xffa8d8, 0xffb85c];

export class Butterflies {
  readonly mesh: THREE.InstancedMesh;
  private readonly patches: readonly { x: number; y: number; z: number; seeds: readonly number[] }[];
  private readonly material: THREE.MeshBasicMaterial;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3(1.4, 1.4, 1.4);
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(groundAt: (x: number, z: number) => number, patches: readonly FlowerPatch[] = flowerPatches(), seed = 0xb077) {
    const rng = createRng(seed);
    this.patches = patches.map((p) => ({ x: p.x, y: groundAt(p.x, p.z), z: p.z, seeds: Array.from({ length: BUTTERFLIES_PER_PATCH }, () => rng.next()) }));
    this.material = flapMaterial(0xffffff, 26, 0.2, 0.75, true);
    this.mesh = new THREE.InstancedMesh(butterflyGeometry(), this.material, BUTTERFLY_CAPACITY);
    this.mesh.name = 'butterflies';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    const c = new THREE.Color();
    for (let i = 0; i < BUTTERFLY_CAPACITY; i++) this.mesh.setColorAt(i, c.set(BUTTERFLY_COLORS[i % BUTTERFLY_COLORS.length]));
    this.mesh.count = 0;
  }

  update(time: number, camera: Readonly<Vec3>): void {
    let n = 0;
    for (const patch of this.patches) {
      if (Math.hypot(patch.x - camera.x, patch.z - camera.z) > BUTTERFLY_RANGE) continue;
      for (const k of patch.seeds) {
        if (n >= BUTTERFLY_CAPACITY) break;
        const t = time * (0.35 + k * 0.3) + k * 40;
        const r = 1.2 + k * 1.6;
        const x = patch.x + Math.sin(t * 1.3) * r;
        const z = patch.z + Math.cos(t * 0.9 + k * 3) * r;
        const y = patch.y + 0.6 + 0.45 * Math.sin(t * 2.1 + k * 7) + 0.25 * Math.sin(t * 5.3);
        // Face along the path's derivative.
        const vx = Math.cos(t * 1.3) * 1.3;
        const vz = -Math.sin(t * 0.9 + k * 3) * 0.9;
        this.q.setFromAxisAngle(this.up, Math.atan2(vx, vz));
        this.m.compose(this.p.set(x, y, z), this.q, this.s);
        this.mesh.setMatrixAt(n++, this.m);
      }
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    flapUniforms(this.material).uFlapTime.value = time;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
