/*
 * Landmark visibility (design.md "Landmark 가시성"; Req 9.1, 9.2, 4.4, 5.1, 5.3). Every Landmark (`lm_*`) is a THREE.LOD
 * named after its id: the near level up to LANDMARK_LOD_DISTANCE (400 m, never scaled by the quality preset) and a
 * far low-poly level with the same outline beyond it. They are never distance-culled or unloaded (userData.landmark
 * marks them for the chunk systems) and use landmark-only toon material instances with fogCap 0.55, so at least 45 %
 * of their colour survives the thickest fog and each silhouette reads from anywhere in the world (camera far 2,200 m).
 *
 * The shapes are procedural (vertex-coloured merged parts, one draw call per material per level):
 * - lm_elderbough: the ≈ 70 m old tree, trunk just north-west of the location so the glide landing stays clear;
 * - lm_breezewatch: the windmill's tapered tower shell over the climb tower and its turning sails (east face, below
 *   the Vista_Point platform);
 * - lm_waterfall: the falls from the y 60 shelf into pond_verdant between two rock columns;
 * - lm_cinderspire: giant orange crystal spires east of the climbing cluster (clear of its glide lines);
 * - lm_observatory: a floating star crystal and halo above the dome;
 * - lm_floating_isles: floating ruin islands (y 135–190);
 * - lm_arch_azure: the natural stone arch over its location;
 * - lm_astral_sanctum: the floating island's rock underside under the Sanctum's floors and its seal ring of three
 *   segments, one lit gold per Skyshard (animated inside the acquisition cinematic, as many lit as held after a load).
 * The Resonance_Altar light pillar (additive, no depth writes, no fog, never culled) rises from Skyshard 3.
 * The walkable structures stay with their gameplay views (Challenge_Areas, the Sanctum, the windmill stand-in).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { OBSERVATORY_DOME_CENTER, OBSERVATORY_Y } from '../data/challengeAreas';
import { LANDMARK_IDS, type LandmarkId } from '../data/ids';
import { REGION_PALETTES } from '../data/palettes';
import { LANDMARK_FOG_CAP, LANDMARK_LOD_DISTANCE } from '../data/renderQuality';
import { RESONANCE_ALTAR } from '../data/starlitStair';
import { LOCATIONS } from '../data/worldLayout';
import { POND_VERDANT } from '../world/terrain';
import { createToonMaterial, sharedMaterialOptions, type ToonMaterialOptions } from './toonMaterial';

/** A landmark-only toon material: the shared options plus fogCap 0.55 (design "landmark 전용 instance"). */
export function createLandmarkMaterial(opts: ToonMaterialOptions = {}): THREE.MeshToonMaterial {
  const material = createToonMaterial({ ...sharedMaterialOptions('stone'), ...opts, fogCap: LANDMARK_FOG_CAP });
  material.name = 'toon:landmark';
  return material;
}

/** LOD hysteresis: ±3 % around 400 m, so a camera on the boundary does not flicker between levels. */
const LOD_HYSTERESIS = 0.03;
/** Seal ring: seconds for a segment to light inside the acquisition cinematic, and its lit emissive. */
const SEAL_LIGHT_SECONDS = 1.5;
const SEAL_LIT_INTENSITY = 1.5;
const SEAL_UNLIT_COLOR = 0x7d84b8;
const SEAL_LIT_COLOR = new THREE.Color(0xffe7a0);
/** Light pillar rise (s) after Skyshard 3. */
const PILLAR_RISE_SECONDS = 2.5;

const PAL = {
  verdant: REGION_PALETTES.verdant.swatches,
  ember: REGION_PALETTES.ember.swatches,
  azure: REGION_PALETTES.azure.swatches,
  sanctum: REGION_PALETTES.sanctum.swatches,
};

// ── Deterministic noise (no Math.random: every session builds the same shapes) ───────────────────────────────────

function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth 3D value noise in [0, 1]. */
function noise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number): number => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number): number => hash3(ix + dx, iy + dy, iz + dz);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), ux), l(c(0, 1, 0), c(1, 1, 0), ux), uy),
    l(l(c(0, 0, 1), c(1, 0, 1), ux), l(c(0, 1, 1), c(1, 1, 1), ux), uy),
    uz,
  );
}

// ── Parts: vertex-coloured, uv-free, non-indexed geometry in the landmark's frame ─────────────────────────────────

type ColorFn = (x: number, y: number, z: number) => number;

interface PartOptions {
  /** A swatch, or a function of the vertex position (after the transform) for bands. */
  color: number | ColorFn;
  /** Displacement amplitude (m, local space) and its direction: radial from the local origin, horizontal only, or along the normal. */
  noise?: number;
  noiseMode?: 'radial' | 'radialXZ' | 'normal';
  /** Noise frequency (per local metre). */
  noiseScale?: number;
  /** Faceted normals (always on for displaced parts). */
  flat?: boolean;
  /** Per-face brightness variation ± this (default 0.06). */
  jitter?: number;
  /** Twist about local Y (rad per metre of height). */
  twist?: number;
}

const scratchColor = new THREE.Color();

function part(source: THREE.BufferGeometry, matrix: THREE.Matrix4, opts: PartOptions): THREE.BufferGeometry {
  const g = source.index !== null ? source.toNonIndexed() : source.clone();
  source.dispose();
  g.deleteAttribute('uv');
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  const amp = opts.noise ?? 0;
  const twist = opts.twist ?? 0;
  if (amp > 0 || twist !== 0) {
    const scale = opts.noiseScale ?? 0.25;
    const mode = opts.noiseMode ?? 'radial';
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i);
      let y = pos.getY(i);
      let z = pos.getZ(i);
      if (amp > 0) {
        const n = (noise3(x * scale + 3.1, y * scale + 7.7, z * scale + 1.3) - 0.5) * 2 * amp;
        let dx: number;
        let dy: number;
        let dz: number;
        if (mode === 'normal') {
          dx = nor.getX(i);
          dy = nor.getY(i);
          dz = nor.getZ(i);
        } else if (mode === 'radialXZ') {
          dx = x;
          dy = 0;
          dz = z;
        } else {
          dx = x;
          dy = y;
          dz = z;
        }
        const len = Math.hypot(dx, dy, dz);
        if (len > 1e-6) {
          x += (dx / len) * n;
          y += (dy / len) * n;
          z += (dz / len) * n;
        }
      }
      if (twist !== 0) {
        const a = y * twist;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const tx = x * c - z * s;
        z = x * s + z * c;
        x = tx;
      }
      pos.setXYZ(i, x, y, z);
    }
  }
  g.applyMatrix4(matrix);
  if (amp > 0 || twist !== 0 || opts.flat === true) g.computeVertexNormals(); // non-indexed: face normals
  const jitter = opts.jitter ?? 0.06;
  const colors = new Float32Array(pos.count * 3);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let f = 0; f < p.count; f += 3) {
    const cx = (p.getX(f) + p.getX(f + 1) + p.getX(f + 2)) / 3;
    const cy = (p.getY(f) + p.getY(f + 1) + p.getY(f + 2)) / 3;
    const cz = (p.getZ(f) + p.getZ(f + 1) + p.getZ(f + 2)) / 3;
    const hex = typeof opts.color === 'number' ? opts.color : opts.color(cx, cy, cz);
    scratchColor.set(hex).multiplyScalar(1 + (hash3(cx, cy, cz) - 0.5) * 2 * jitter);
    for (let k = 0; k < 3 && f + k < p.count; k++) {
      colors[(f + k) * 3] = scratchColor.r;
      colors[(f + k) * 3 + 1] = scratchColor.g;
      colors[(f + k) * 3 + 2] = scratchColor.b;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

const m4 = (): THREE.Matrix4 => new THREE.Matrix4();
/** Translation · rotation (Euler XYZ) · scale. */
function trs(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  return m4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
}

/** A matrix placing local +Y along `dir` (unit) with the base at `base`. */
function alongDir(base: THREE.Vector3, dir: THREE.Vector3, scale = 1): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return m4().compose(base, q, new THREE.Vector3(scale, scale, scale));
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (g === null) throw new Error('landmarks: parts could not be merged');
  g.computeBoundingSphere();
  return g;
}

/** Colour bands by height (strata), `step` m each. */
const bands = (colors: readonly number[], step: number, offset = 0): ColorFn => (_x, y) =>
  colors[((Math.floor((y + offset) / step) % colors.length) + colors.length) % colors.length] ?? 0xffffff;

// ── The view ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LandmarkViewOptions {
  /** Terrain height, for the parts that stand on the ground. */
  heightAt(x: number, z: number): number;
}

export interface LandmarkViewState {
  /** Skyshards held: that many seal ring segments are lit. */
  readonly skyshards: number;
  /** The Resonance_Altar light pillar (from Skyshard 3). */
  readonly pillarVisible: boolean;
}

interface LevelParts {
  /** Merged geometry per material key. */
  readonly [material: string]: THREE.BufferGeometry[];
}

type MaterialKey = 'body' | 'water' | 'glowEmber' | 'glowAzure' | 'glowGold';

export class LandmarkView {
  readonly object = new THREE.Group();
  /** One LOD per Landmark id. */
  readonly landmarks = new Map<LandmarkId, THREE.LOD>();
  /** The seal ring segment materials, segment k lit by Skyshard k + 1. */
  readonly sealSegments: readonly THREE.MeshToonMaterial[];
  /** The Resonance_Altar light pillar. */
  readonly pillar: THREE.Group;
  /** Landmark materials (fogCap 0.55). */
  readonly materials: ReadonlyMap<MaterialKey, THREE.MeshToonMaterial>;
  private readonly sails: THREE.Object3D;
  private readonly beacon: THREE.Object3D;
  private readonly sealRing: THREE.Object3D[] = [];
  private readonly pillarMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly glow = [0, 0, 0];
  private readonly lighting = new Set<number>();
  private pillarRise = 0;
  private pillarAnimating = false;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly heightAt: (x: number, z: number) => number;

  constructor(options: LandmarkViewOptions) {
    this.object.name = 'landmarks';
    this.heightAt = (x, z) => {
      const h = options.heightAt(x, z);
      return Number.isFinite(h) ? h : 0;
    };
    const materials = new Map<MaterialKey, THREE.MeshToonMaterial>([
      ['body', this.track(createLandmarkMaterial())],
      ['water', this.track(createLandmarkMaterial({ transparent: true, opacity: 0.82, depthWrite: false, rimScale: 0.6 }))],
      ['glowEmber', this.track(createLandmarkMaterial({ emissive: 0xff7a2a, emissiveIntensity: 0.55 }))],
      ['glowAzure', this.track(createLandmarkMaterial({ emissive: 0x8fb8ff, emissiveIntensity: 0.9 }))],
      ['glowGold', this.track(createLandmarkMaterial({ emissive: 0xffd66b, emissiveIntensity: 0.8 }))],
    ]);
    this.materials = materials;
    this.sealSegments = [0, 1, 2].map(() =>
      this.track(createLandmarkMaterial({ vertexColors: false, color: SEAL_UNLIT_COLOR, emissive: 0xffd66b, emissiveIntensity: 0 })));

    this.addLandmark('lm_elderbough', ...this.elderbough());
    const breezewatch = this.breezewatch();
    this.sails = breezewatch.sails;
    this.addLandmark('lm_breezewatch', breezewatch.anchor, breezewatch.near, breezewatch.far, [breezewatch.sails]);
    this.addLandmark('lm_waterfall', ...this.waterfall());
    this.addLandmark('lm_cinderspire', ...this.cinderspire());
    const observatory = this.observatory();
    this.beacon = observatory.beacon;
    this.addLandmark('lm_observatory', observatory.anchor, observatory.near, observatory.far, [observatory.beacon]);
    this.addLandmark('lm_floating_isles', ...this.floatingIsles());
    this.addLandmark('lm_arch_azure', ...this.arch());
    const sanctum = this.sanctum();
    this.addLandmark('lm_astral_sanctum', sanctum.anchor, sanctum.near, sanctum.far, [sanctum.ringNear], [sanctum.ringFar]);
    this.sealRing.push(sanctum.ringNear, sanctum.ringFar);

    this.pillar = this.createPillar();
    this.object.add(this.pillar);
  }

  /** 'skyshard:acquired': segment `index` lights over 1.5 s (inside its cinematic); Skyshard 3 raises the pillar. */
  skyshardAcquired(index: number): void {
    const k = Math.floor(index) - 1;
    if (k >= 0 && k < 3) this.lighting.add(k);
    if (index >= 3) {
      this.pillarAnimating = true;
      this.pillarRise = 0;
    }
  }

  /** Mirrors the seal ring and the pillar; `time` (s) turns the sails, the beacon and the ring. */
  update(time: number, realDt: number, state: LandmarkViewState): void {
    const dt = Number.isFinite(realDt) && realDt > 0 ? realDt : 0;
    const held = Number.isFinite(state.skyshards) ? state.skyshards : 0;
    for (let k = 0; k < 3; k++) {
      const lit = k < held;
      if (!lit) {
        this.glow[k] = 0;
        this.lighting.delete(k);
      } else if (this.lighting.has(k)) {
        this.glow[k] = Math.min(1, this.glow[k] + dt / SEAL_LIGHT_SECONDS);
        if (this.glow[k] >= 1) this.lighting.delete(k);
      } else {
        this.glow[k] = 1; // after a load: as many lit as held, no animation
      }
      const g = this.glow[k];
      const material = this.sealSegments[k];
      if (material !== undefined) {
        material.emissiveIntensity = g * SEAL_LIT_INTENSITY * (0.92 + 0.08 * Math.sin(time * 1.6 + k * 2.1));
        material.color.setHex(SEAL_UNLIT_COLOR).lerp(SEAL_LIT_COLOR, g);
      }
    }
    for (const ring of this.sealRing) ring.rotation.y = time * 0.015;
    this.sails.rotation.x = time * 0.35;
    this.beacon.rotation.y = time * 0.25;
    this.beacon.position.y = Math.sin(time * 0.6) * 0.6;

    this.pillar.visible = state.pillarVisible;
    if (!state.pillarVisible) {
      this.pillarAnimating = false;
      this.pillarRise = 0;
    } else if (this.pillarAnimating) {
      this.pillarRise = Math.min(1, this.pillarRise + dt / PILLAR_RISE_SECONDS);
      if (this.pillarRise >= 1) this.pillarAnimating = false;
    } else {
      this.pillarRise = 1;
    }
    const rise = this.pillarRise;
    this.pillar.scale.set(1, Math.max(0.001, rise * rise * (3 - 2 * rise)), 1);
    const pulse = 0.9 + 0.1 * Math.sin(time * 1.7);
    for (const m of this.pillarMaterials) m.opacity = pulse * (m.userData.baseOpacity as number);
  }

  /** Seal ring segment glow 0–1 (tests, HUD-free checks). */
  sealGlow(k: number): number {
    return this.glow[k] ?? 0;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.object.clear();
    this.landmarks.clear();
  }

  private track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }

  private level(parts: LevelParts, name: string, extras: THREE.Object3D[] = []): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    for (const [key, list] of Object.entries(parts)) {
      if (list.length === 0) continue;
      const material = this.materials.get(key as MaterialKey);
      if (material === undefined) throw new Error(`landmarks: unknown material ${key}`);
      const mesh = new THREE.Mesh(this.track(merged(list)), material);
      mesh.name = `${name}:${key}`;
      mesh.castShadow = false;
      mesh.receiveShadow = key === 'body';
      if (key === 'water') mesh.renderOrder = 1;
      group.add(mesh);
    }
    if (extras.length > 0) group.add(...extras); // add() with no argument logs an error
    return group;
  }

  private addLandmark(
    id: LandmarkId, anchor: THREE.Vector3, near: LevelParts, far: LevelParts, nearExtras: THREE.Object3D[] = [], farExtras: THREE.Object3D[] = [],
  ): void {
    const lod = new THREE.LOD();
    lod.name = id;
    lod.position.copy(anchor);
    lod.userData.landmark = id; // never distance-culled or unloaded
    lod.addLevel(this.level(near, `${id}:near`, nearExtras), 0, LOD_HYSTERESIS);
    lod.addLevel(this.level(far, `${id}:far`, farExtras), LANDMARK_LOD_DISTANCE, LOD_HYSTERESIS);
    this.landmarks.set(id, lod);
    this.object.add(lod);
  }

  // ── Elderbough ────────────────────────────────────────────────────────────────────────────────────────────────

  private elderbough(): [THREE.Vector3, LevelParts, LevelParts] {
    const loc = LOCATIONS.lm_elderbough;
    const x = loc.x - 8;
    const z = loc.z - 8;
    const anchor = new THREE.Vector3(x, this.heightAt(x, z), z);
    const v = PAL.verdant;
    const barkColor: ColorFn = (_x, y) => (y < 4 ? 0x5f7a3a : y < 9 && hash3(_x, y, 0) > 0.6 ? 0x6f8a44 : v.bark);
    const leaf: ColorFn = (_x, y) => (y > 66 ? v.foliageLight : y > 56 ? 0x86bf4a : v.foliage);
    const near: THREE.BufferGeometry[] = [];
    const nearLeaf: THREE.BufferGeometry[] = [];
    near.push(part(new THREE.CylinderGeometry(3.4, 6.4, 48, 16, 10, true), trs(0, 21, 0), { color: barkColor, noise: 0.8, noiseMode: 'radialXZ', noiseScale: 0.35, twist: 0.018 }));
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2 + 0.3;
      const dir = new THREE.Vector3(Math.cos(a), -0.28, Math.sin(a)).normalize();
      near.push(part(new THREE.ConeGeometry(2.4, 13 + 3 * hash3(k, 1, 2), 7, 3, true), alongDir(new THREE.Vector3(Math.cos(a) * 3.2, 2.2, Math.sin(a) * 3.2), dir), { color: v.bark, noise: 0.35, noiseMode: 'radialXZ' }));
    }
    const branches: [number, number, number][] = [[0.2, 36, 0.9], [1.4, 38, 1.0], [2.5, 35, 0.95], [3.6, 39, 1.05], [4.7, 37, 0.9], [5.7, 40, 1.0]];
    for (const [a, y, s] of branches) {
      const dir = new THREE.Vector3(Math.cos(a), 0.8, Math.sin(a)).normalize();
      near.push(part(new THREE.CylinderGeometry(0.7, 1.7, 20 * s, 7, 3, true), alongDir(new THREE.Vector3(Math.cos(a) * 2, y, Math.sin(a) * 2), dir).multiply(trs(0, 10 * s, 0)), { color: v.bark, noise: 0.3, noiseMode: 'radialXZ' }));
    }
    const blobs: [number, number, number, number][] = [
      [0, 56, 0, 16], [15, 50, 2, 12], [-13, 52, 7, 12.5], [4, 51, -15, 12], [-6, 49, -12, 11], [10, 53, 13, 11.5], [-15, 50, -4, 11],
      [6, 64, 4, 10.5], [-5, 65, -3, 10], [1, 71, 0, 8],
    ];
    for (const [bx, by, bz, r] of blobs) {
      nearLeaf.push(part(new THREE.IcosahedronGeometry(r, 2), trs(bx, by, bz, 0, hash3(bx, by, bz) * 3, 0, 1, 0.82, 1), { color: leaf, noise: r * 0.16, noiseScale: 0.22, jitter: 0.08 }));
    }
    const far: THREE.BufferGeometry[] = [
      part(new THREE.CylinderGeometry(3.6, 6.2, 48, 8, 1, true), trs(0, 21, 0), { color: v.bark, flat: true }),
    ];
    for (const [bx, by, bz, r] of blobs.slice(0, 6)) {
      far.push(part(new THREE.IcosahedronGeometry(r * 1.08, 0), trs(bx, by, bz, 0, 0, 0, 1, 0.82, 1), { color: leaf, flat: true }));
    }
    far.push(part(new THREE.IcosahedronGeometry(10, 0), trs(2, 66, 1, 0, 0, 0, 1, 0.85, 1), { color: leaf, flat: true }));
    return [anchor, { body: [...near, ...nearLeaf] }, { body: far }];
  }

  // ── Breezewatch windmill ─────────────────────────────────────────────────────────────────────────────────────

  private breezewatch(): { anchor: THREE.Vector3; near: LevelParts; far: LevelParts; sails: THREE.Object3D } {
    const loc = LOCATIONS.breezewatch;
    const topY = LOCATIONS.vista_verdant.groundY; // 64: the platform the stand-in tower carries
    const baseY = 18;
    const anchor = new THREE.Vector3(loc.x, baseY, loc.z);
    const height = topY - 0.7 - baseY;
    const v = PAL.verdant;
    const towerColor: ColorFn = (_x, y) => (Math.abs(y - 14) < 0.9 || Math.abs(y - 30) < 0.9 ? v.wood : y < 3 ? v.rock : v.stone);
    const hubY = 33.5; // world y ≈ 51.5: the sails' tips stay under the platform
    const hubX = 2.9;
    const near: THREE.BufferGeometry[] = [
      part(new THREE.CylinderGeometry(1.9, 2.2, height, 12, 6, true), trs(0, height / 2, 0), { color: towerColor, flat: true }),
      part(new THREE.CylinderGeometry(2.4, 2.4, 0.5, 12, 1), trs(0, 14, 0), { color: v.wood, flat: true }),
      part(new THREE.CylinderGeometry(2.3, 2.3, 0.5, 12, 1), trs(0, 30, 0), { color: v.wood, flat: true }),
      part(new THREE.CylinderGeometry(0.35, 0.35, 2.2, 8, 1), trs(hubX - 1, hubY, 0, 0, 0, Math.PI / 2), { color: v.wood, flat: true }),
    ];
    // Sails: a hub and four lattice blades in the y–z plane, turned about local x in update().
    const sailParts: THREE.BufferGeometry[] = [
      part(new THREE.BoxGeometry(1.2, 1.2, 1.2), trs(0, 0, 0, Math.PI / 4, 0, 0), { color: v.wood, flat: true }),
    ];
    const farSails: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      const blade = (): THREE.Matrix4 => trs(0.45, 0, 0, a, 0, 0);
      sailParts.push(part(new THREE.BoxGeometry(0.22, 11, 0.35), blade().multiply(trs(0, 6.2, 0)), { color: v.wood, flat: true }));
      sailParts.push(part(new THREE.BoxGeometry(0.12, 9.4, 1.9), blade().multiply(trs(0.12, 6.9, 0.95)), { color: 0xf3ead2, flat: true }));
      farSails.push(part(new THREE.BoxGeometry(0.3, 11.5, 2.2), trs(hubX + 0.45, hubY, 0, a + 0.4, 0, 0).multiply(trs(0, 6.2, 0.7)), { color: 0xf3ead2, flat: true }));
    }
    const sails = new THREE.Mesh(this.track(merged(sailParts)), this.materials.get('body'));
    sails.name = 'lm_breezewatch:sails';
    sails.position.set(hubX, hubY, 0);
    const far: THREE.BufferGeometry[] = [
      part(new THREE.CylinderGeometry(1.9, 2.3, height, 6, 1, true), trs(0, height / 2, 0), { color: v.stone, flat: true }),
      ...farSails,
    ];
    return { anchor, near: { body: near }, far: { body: far }, sails };
  }

  // ── Waterfall ────────────────────────────────────────────────────────────────────────────────────────────────

  private waterfall(): [THREE.Vector3, LevelParts, LevelParts] {
    const pond = POND_VERDANT;
    const top = LOCATIONS.lm_waterfall;
    const len = Math.hypot(top.x - pond.x, top.z - pond.z);
    const d = { x: (top.x - pond.x) / len, z: (top.z - pond.z) / len };
    const across = { x: -d.z, z: d.x };
    const face = { x: pond.x + d.x * 32, z: pond.z + d.z * 32 };
    const anchor = new THREE.Vector3(face.x, pond.level, face.z);
    const v = PAL.verdant;
    const yaw = Math.atan2(across.x, across.z); // local +z along `across`
    const sheetHeight = top.groundY - pond.level + 0.6;
    const sheetColor: ColorFn = (_x, y) => (y < 3 ? 0xf4fbff : y > sheetHeight - 3 ? 0xa8dcf2 : 0x7cc4e8);
    const sheet = (segments: number): THREE.BufferGeometry => {
      const g = new THREE.PlaneGeometry(14, sheetHeight, 1, segments);
      // The top leans back to the shelf edge (≈ 2.6 m behind the foot, toward the cliff = local −z).
      const p = g.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < p.count; i++) {
        const t = (p.getY(i) + sheetHeight / 2) / sheetHeight;
        p.setZ(i, -2.6 * t * t);
      }
      return g;
    };
    // The plane faces local +z; turn it to face the pond (−d) and centre it on the face.
    const place = trs(0, sheetHeight / 2 - 0.3, 0, 0, Math.atan2(-d.x, -d.z), 0);
    const rockAt = (side: number, detail: number, noise: number): THREE.BufferGeometry => {
      const rx = face.x + across.x * 9.5 * side - anchor.x;
      const rz = face.z + across.z * 9.5 * side - anchor.z;
      const ground = this.heightAt(anchor.x + rx, anchor.z + rz) - anchor.y;
      return part(new THREE.IcosahedronGeometry(1, detail), trs(rx, ground + 16, rz, 0, yaw + side, 0, 4.5, 21, 4.5),
        { color: bands([v.rock, v.rockDark, v.rock, 0x8c8674], 5, 2), noise: noise, noiseScale: 1.4 });
    };
    const foam: THREE.BufferGeometry[] = [];
    for (let k = -2; k <= 2; k++) {
      foam.push(part(new THREE.IcosahedronGeometry(2.2 + hash3(k, 0, 1), 1), trs(across.x * k * 2.8 - d.x * 1.5, 0.3, across.z * k * 2.8 - d.z * 1.5, 0, 0, 0, 1.3, 0.35, 1.3), { color: 0xf4fbff, flat: true, jitter: 0.03 }));
    }
    return [
      anchor,
      { body: [rockAt(-1, 2, 0.25), rockAt(1, 2, 0.25)], water: [part(sheet(10), place, { color: sheetColor, jitter: 0.03 }), ...foam] },
      { body: [rockAt(-1, 0, 0), rockAt(1, 0, 0)], water: [part(sheet(2), place, { color: sheetColor, jitter: 0 })] },
    ];
  }

  // ── Cinderspire ──────────────────────────────────────────────────────────────────────────────────────────────

  private cinderspire(): [THREE.Vector3, LevelParts, LevelParts] {
    const summit = LOCATIONS.cinderspire_summit;
    const anchor = new THREE.Vector3(summit.x + 12, 0, summit.z - 12);
    anchor.y = this.heightAt(anchor.x, anchor.z);
    const e = PAL.ember;
    // East and north of the climbing cluster, clear of G1 / G2 and the summit's exit stair (south-west).
    const spires: [number, number, number, number, number, number][] = [
      [364, 86, 5.5, 118, 0.08, 0.05], [372, 118, 4.5, 92, -0.06, 0.1], [352, 64, 4, 78, 0.1, -0.08], [318, 80, 3.5, 66, -0.1, -0.06],
    ];
    const nearGlow: THREE.BufferGeometry[] = [];
    const nearRock: THREE.BufferGeometry[] = [];
    const farGlow: THREE.BufferGeometry[] = [];
    for (const [sx, sz, r, h, tx, tz] of spires) {
      const lx = sx - anchor.x;
      const lz = sz - anchor.z;
      const base = this.heightAt(sx, sz) - anchor.y - 3;
      const tilt = trs(lx, base, lz, tx, hash3(sx, sz, 1) * 2, tz);
      const crystal = (sides: number): THREE.BufferGeometry[] => [
        part(new THREE.CylinderGeometry(r * 0.78, r, h * 0.8, sides, 1, true), m4().copy(tilt).multiply(trs(0, h * 0.4, 0)), { color: e.crystal, flat: true, jitter: 0.1 }),
        part(new THREE.ConeGeometry(r * 0.78, h * 0.22, sides, 1, true), m4().copy(tilt).multiply(trs(0, h * 0.8 + h * 0.11, 0)), { color: e.glow, flat: true }),
      ];
      nearGlow.push(...crystal(6));
      farGlow.push(...crystal(6));
      for (let k = 0; k < 4; k++) {
        const a = k * 1.7 + hash3(sx, k, 3);
        const off = r * 1.6;
        const dir = new THREE.Vector3(Math.cos(a) * 0.5, 1, Math.sin(a) * 0.5).normalize();
        nearGlow.push(part(new THREE.ConeGeometry(r * 0.35, h * 0.18, 5, 1, true), alongDir(new THREE.Vector3(lx + Math.cos(a) * off, base + 1.5, lz + Math.sin(a) * off), dir), { color: e.crystal, flat: true }));
      }
      nearRock.push(part(new THREE.IcosahedronGeometry(1, 1), trs(lx, base + 2, lz, 0, hash3(sx, sz, 5) * 3, 0, r * 2.1, r * 0.9, r * 2.1), { color: e.rockDark, noise: 0.18, noiseScale: 1.3 }));
    }
    return [anchor, { body: nearRock, glowEmber: nearGlow }, { glowEmber: farGlow }];
  }

  // ── Starfall Observatory ─────────────────────────────────────────────────────────────────────────────────────

  private observatory(): { anchor: THREE.Vector3; near: LevelParts; far: LevelParts; beacon: THREE.Object3D } {
    const dome = OBSERVATORY_DOME_CENTER;
    const anchor = new THREE.Vector3(dome.x, OBSERVATORY_Y.dome + 24, dome.z);
    const a = PAL.azure;
    const beaconParts: THREE.BufferGeometry[] = [
      part(new THREE.OctahedronGeometry(1, 0), trs(0, 0, 0, 0, 0, 0, 4.2, 8.5, 4.2), { color: a.crystal, flat: true, jitter: 0.12 }),
      part(new THREE.TorusGeometry(7.5, 0.35, 6, 48), trs(0, 0, 0, Math.PI / 2 + 0.35, 0, 0.2), { color: a.glow, flat: true }),
    ];
    for (let k = 0; k < 3; k++) {
      const t = (k / 3) * Math.PI * 2;
      beaconParts.push(part(new THREE.OctahedronGeometry(1.1, 0), trs(Math.cos(t) * 10, Math.sin(t * 2) * 1.5, Math.sin(t) * 10, 0, t, 0, 1, 1.8, 1), { color: a.crystal, flat: true }));
    }
    const beacon = new THREE.Group();
    beacon.name = 'lm_observatory:beacon';
    const beaconMesh = new THREE.Mesh(this.track(merged(beaconParts)), this.materials.get('glowAzure'));
    beaconMesh.name = 'lm_observatory:beacon:glowAzure';
    beacon.add(beaconMesh);
    const far: THREE.BufferGeometry[] = [
      part(new THREE.OctahedronGeometry(1, 0), trs(0, 0, 0, 0, 0, 0, 5, 10, 5), { color: a.crystal, flat: true }),
      part(new THREE.TorusGeometry(7.5, 0.5, 4, 20), trs(0, 0, 0, Math.PI / 2 + 0.35, 0, 0.2), { color: a.glow, flat: true }),
    ];
    return { anchor, near: {}, far: { glowAzure: far }, beacon };
  }

  // ── Floating ruin isles ──────────────────────────────────────────────────────────────────────────────────────

  private floatingIsles(): [THREE.Vector3, LevelParts, LevelParts] {
    const loc = LOCATIONS.lm_floating_isles;
    const anchor = new THREE.Vector3(loc.x, 160, loc.z);
    const a = PAL.azure;
    const isles: [number, number, number, number][] = [
      [loc.x, loc.z, 176, 17], [loc.x + 28, loc.z + 18, 152, 9], [loc.x - 26, loc.z - 24, 190, 8], [loc.x + 16, loc.z - 30, 138, 7],
      [loc.x - 22, loc.z + 22, 162, 6],
    ];
    const near: THREE.BufferGeometry[] = [];
    const far: THREE.BufferGeometry[] = [];
    const topColor: ColorFn = (_x, y) => (y > 0 ? a.grass : a.rock);
    isles.forEach(([ix, iz, topY, r], i) => {
      const lx = ix - anchor.x;
      const lz = iz - anchor.z;
      const ly = topY - anchor.y;
      const cap = (sides: number): THREE.BufferGeometry => part(new THREE.CylinderGeometry(r, r * 0.92, 2.4, sides, 1), trs(lx, ly - 1.2, lz), {
        color: (x, y, z) => topColor(x, y - ly + 0.2, z), flat: true,
      });
      near.push(cap(14));
      near.push(part(new THREE.ConeGeometry(r * 0.92, r * 2.1, 12, 4, true), trs(lx, ly - 2.4 - r * 1.05, lz, Math.PI, i, 0), {
        color: bands([a.rock, a.rockDark, a.rock, 0x7a86a0], 3.5), noise: r * 0.12, noiseMode: 'radialXZ', noiseScale: 0.3,
      }));
      far.push(cap(8));
      far.push(part(new THREE.ConeGeometry(r * 0.92, r * 2.1, 7, 1, true), trs(lx, ly - 2.4 - r * 1.05, lz, Math.PI, i, 0), { color: a.rockDark, flat: true }));
      // Ruins: broken columns around the rim, an arch on the largest isle.
      const columns = Math.max(2, Math.round(r / 4));
      for (let k = 0; k < columns; k++) {
        const t = (k / columns) * Math.PI * 2 + i;
        const h = 3 + 4 * hash3(i, k, 7);
        near.push(part(new THREE.CylinderGeometry(0.55, 0.7, h, 8, 1), trs(lx + Math.cos(t) * r * 0.62, ly + h / 2, lz + Math.sin(t) * r * 0.62), { color: a.stone, flat: true }));
      }
      if (i === 0) {
        for (const side of [-1, 1]) {
          near.push(part(new THREE.BoxGeometry(1.4, 9, 1.4), trs(lx + side * 3.2, ly + 4.5, lz - 4), { color: a.stone, flat: true }));
          far.push(part(new THREE.BoxGeometry(1.6, 9, 1.6), trs(lx + side * 3.2, ly + 4.5, lz - 4), { color: a.stone, flat: true }));
        }
        near.push(part(new THREE.BoxGeometry(8.4, 1.2, 1.8), trs(lx, ly + 9.6, lz - 4), { color: a.stone, flat: true }));
        far.push(part(new THREE.BoxGeometry(8.4, 1.2, 1.8), trs(lx, ly + 9.6, lz - 4), { color: a.stone, flat: true }));
      }
    });
    return [anchor, { body: near }, { body: far }];
  }

  // ── Natural arch ─────────────────────────────────────────────────────────────────────────────────────────────

  private arch(): [THREE.Vector3, LevelParts, LevelParts] {
    const loc = LOCATIONS.lm_arch_azure;
    const anchor = new THREE.Vector3(loc.x, loc.groundY, loc.z);
    const a = PAL.azure;
    const span = 24;
    const leftY = this.heightAt(loc.x - span, loc.z) - anchor.y - 5;
    const rightY = this.heightAt(loc.x + span, loc.z) - anchor.y - 5;
    const apex = 46;
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-span, leftY, 0),
      new THREE.Vector3(-span + 2.5, leftY + 18, 0.5),
      new THREE.Vector3(-span + 8, apex - 12, 1),
      new THREE.Vector3(0, apex, 1.5),
      new THREE.Vector3(span - 8, apex - 13, 0.5),
      new THREE.Vector3(span - 2.5, rightY + 18, -0.5),
      new THREE.Vector3(span, rightY, 0),
    ]);
    const strata = bands([a.stone, 0xcfd3e2, a.rock, 0xd8dbe8], 5.5);
    const near: THREE.BufferGeometry[] = [
      part(new THREE.TubeGeometry(curve, 36, 6, 10, false), m4(), { color: strata, noise: 1.6, noiseMode: 'normal', noiseScale: 0.18 }),
    ];
    for (const [x, y] of [[-span, leftY], [span, rightY]] as const) {
      near.push(part(new THREE.IcosahedronGeometry(1, 1), trs(x, y + 4, 0, 0, x, 0, 10, 8, 9), { color: a.rock, noise: 0.2, noiseScale: 1.2 }));
    }
    const far: THREE.BufferGeometry[] = [
      part(new THREE.TubeGeometry(curve, 12, 6.2, 6, false), m4(), { color: strata, flat: true }),
      part(new THREE.IcosahedronGeometry(1, 0), trs(-span, leftY + 4, 0, 0, 0, 0, 10, 8, 9), { color: a.rock, flat: true }),
      part(new THREE.IcosahedronGeometry(1, 0), trs(span, rightY + 4, 0, 0, 0, 0, 10, 8, 9), { color: a.rock, flat: true }),
    ];
    return [anchor, { body: near }, { body: far }];
  }

  // ── Astral Sanctum ───────────────────────────────────────────────────────────────────────────────────────────

  private sanctum(): { anchor: THREE.Vector3; near: LevelParts; far: LevelParts; ringNear: THREE.Object3D; ringFar: THREE.Object3D } {
    const anchor = new THREE.Vector3(0, 190, 18);
    const s = PAL.sanctum;
    // Rock undersides kept below the Sanctum's floor slabs (arena y 181.4, hall 179.4, gate 174.4) and inside their
    // footprints, clear of the Starlit_Stair's tier 3 and Updrafts.
    const rocks: [number, number, number, number][] = [
      [32, 181.2, 33, 58], // under the arena disc (0, 30) r 32
      [-15, 179.2, 10, 34], // under the hall (z −24..−6)
      [-41, 174.2, 8, 22], // under the gate slab (z −49..−34)
    ];
    const rockColor = bands([s.rock, s.rockDark, s.rock, 0x3a4070], 4);
    const near: THREE.BufferGeometry[] = [];
    const nearGold: THREE.BufferGeometry[] = [];
    const far: THREE.BufferGeometry[] = [];
    rocks.forEach(([rz, topY, r, depth], i) => {
      const ly = topY - anchor.y;
      const lz = rz - anchor.z;
      near.push(part(new THREE.ConeGeometry(r, depth, 16, 6, true), trs(0, ly - depth / 2, lz, Math.PI, i * 0.7, 0), {
        color: rockColor, noise: r * 0.1, noiseMode: 'radialXZ', noiseScale: 0.16,
      }));
      far.push(part(new THREE.ConeGeometry(r, depth, 8, 1, true), trs(0, ly - depth / 2, lz, Math.PI, i * 0.7, 0), { color: s.rockDark, flat: true }));
      // Gold star crystals hanging under each rock.
      for (let k = 0; k < 3; k++) {
        const t = k * 2.1 + i;
        const off = r * 0.25;
        nearGold.push(part(new THREE.OctahedronGeometry(1, 0), trs(Math.cos(t) * off, ly - depth * (0.55 + 0.12 * k), lz + Math.sin(t) * off, 0, t, 0, 1.2, 2.6, 1.2), { color: s.accent, flat: true }));
      }
      far.push(part(new THREE.OctahedronGeometry(1, 0), trs(0, ly - depth * 0.7, lz, 0, 0, 0, 2, 4, 2), { color: s.accent, flat: true }));
    });
    const ringNear = this.sealRingObject(60, 1.3, 8, 40, 'near');
    const ringFar = this.sealRingObject(60, 1.6, 4, 14, 'far');
    return { anchor, near: { body: near, glowGold: nearGold }, far: { body: far }, ringNear, ringFar };
  }

  /** Three 116° arcs around the island (anchor frame, 8 m above it), one material each. */
  private sealRingObject(radius: number, tube: number, radial: number, tubular: number, name: string): THREE.Object3D {
    const ring = new THREE.Group();
    ring.name = `lm_astral_sanctum:seal_ring:${name}`;
    ring.position.set(0, 8, 0);
    ring.rotation.set(0.12, 0, 0.05);
    const gap = (4 * Math.PI) / 180;
    const arc = (Math.PI * 2) / 3 - gap;
    const inner = new THREE.Group();
    inner.rotation.x = Math.PI / 2; // the torus lies in local XY
    ring.add(inner);
    for (let k = 0; k < 3; k++) {
      const segment = new THREE.Mesh(this.track(new THREE.TorusGeometry(radius, tube, radial, tubular, arc)), this.sealSegments[k]);
      segment.name = `seal_segment_${k + 1}`;
      segment.rotation.z = k * ((Math.PI * 2) / 3) + gap / 2;
      inner.add(segment);
    }
    return ring;
  }

  // ── Resonance_Altar light pillar ─────────────────────────────────────────────────────────────────────────────

  private createPillar(): THREE.Group {
    const a = RESONANCE_ALTAR;
    const group = new THREE.Group();
    group.name = 'resonancePillar';
    group.userData.landmark = 'resonance_pillar';
    group.position.set(a.pos.x, a.pos.y, a.pos.z);
    const layers: [number, number][] = [[a.pillarRadius * 0.75, 0.85], [a.pillarRadius * 2.1, 0.28]];
    for (const [radius, opacity] of layers) {
      const geometry = this.track(new THREE.CylinderGeometry(radius, radius * 1.15, a.pillarHeight, 24, 16, true));
      geometry.translate(0, a.pillarHeight / 2, 0);
      // Vertex alpha: bright at the altar, fading out toward the top.
      const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
      const colors = new Float32Array(pos.count * 4);
      const c = new THREE.Color(0xfff1c4);
      for (let i = 0; i < pos.count; i++) {
        const t = pos.getY(i) / a.pillarHeight;
        colors.set([c.r, c.g, c.b, Math.pow(1 - t, 1.6)], i * 4);
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
      const material = this.track(new THREE.MeshBasicMaterial({
        color: 0xffffff, vertexColors: true, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        side: THREE.DoubleSide,
      }));
      material.userData.baseOpacity = opacity;
      this.pillarMaterials.push(material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = 'resonancePillar:layer';
      mesh.frustumCulled = false; // culling excluded like a Landmark
      mesh.renderOrder = 2;
      group.add(mesh);
    }
    group.visible = false;
    return group;
  }
}

/** Every Landmark id the view builds (all of LANDMARK_IDS). */
export const LANDMARK_VIEW_IDS: readonly LandmarkId[] = LANDMARK_IDS;
