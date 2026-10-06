/*
 * Blight visuals (design.md "Blight"; Req 4.7, 18.1, 39.4).
 * - One Blight material: the shared toon instance `sharedMaterial('blight')`, patched once so that every Blight
 *   surface (crystal clusters, thorn vines, the ground patches, the Blight_Barrier walls) reads the same shader and the
 *   same uniforms. Each vertex carries `aBlight` = (mask, strength slot, seed); its visible amount is mask × the slot's
 *   strength (`BLIGHT_UNIFORMS.uBlightStrength`, one per Region plus the barriers' constant slot). Where the amount
 *   falls under a noise threshold the fragment is discarded with a glowing lilac edge: crystals dissolve and the
 *   patches recede from their rims as a Region is purified. The veils (`veil_ember`, `veil_azure`) are translucent
 *   variants of the same material (a translucent curtain cannot share the opaque instance's blend state) with the
 *   shimmer switched on: waves along the curtain and drifting bright bands.
 * - BlightView: one crystal InstancedMesh, one vine InstancedMesh (the Region slot per instance) and one merged
 *   ground-patch mesh (the slot per vertex) for all sites of src/render/blightLayout.ts: three draw calls; strengths
 *   from BlightState (instant on load, 3 s after 'skyshard:acquired', all Regions on the ending's `blight_cleared`),
 *   sparkles rising from the sites near the camera while a Region is purified.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GameEventBus } from '../core/gameEvents';
import type { Vec3 } from '../core/types';
import { REGION_IDS, type RegionId } from '../data/ids';
import { SKYSHARD_REGION } from '../logic/worldChange';
import type { BurstSpec } from '../vfx/catalog';
import { blightLayout, VINE_ARCH_HEIGHT, type BlightSite, type BlightTerrain } from './blightLayout';
import { BLIGHT_BARRIER_INDEX, BLIGHT_REGION_INDEX, BLIGHT_SLOTS, BlightState, type BlightProgress } from './blightState';
import { sharedMaterial, sharedMaterialVariant } from './toonMaterial';

/** Program cache key of every Blight material (its injected code never differs between them). */
export const BLIGHT_PROGRAM_KEY = 'skyshard-blight-v1';

/** Uniforms shared by every Blight material. */
export const BLIGHT_UNIFORMS = {
  uBlightStrength: { value: new Array<number>(BLIGHT_SLOTS).fill(1) },
  uBlightTime: { value: 0 },
};

/** The Blight swatch (src/data/palettes.ts: one look everywhere). */
export const BLIGHT_COLOR = 0x8a4dd6;
const CRYSTAL_BASE = new THREE.Color(0x3c1a68);
const CRYSTAL_TIP = new THREE.Color(0xd2a8ff);
const VINE_COLOR = new THREE.Color(0x2a1238);
const THORN_COLOR = new THREE.Color(0x5a2c80);
const PATCH_CORE = new THREE.Color(0x2c1240);
const PATCH_RIM = new THREE.Color(0x6a36a0);

function replaceOnce(source: string, search: string, replacement: string): string {
  const at = source.indexOf(search);
  if (at < 0) throw new Error(`blight: ${search} not found in the shader (three.js chunk layout changed?)`);
  return source.slice(0, at) + replacement + source.slice(at + search.length);
}

const VERTEX_PARS = /* glsl */ `#include <common>
attribute vec3 aBlight;
uniform float uBlightStrength[ ${BLIGHT_SLOTS} ];
uniform float uBlightTime;
uniform float uVeil;
varying vec3 vBlightWorld;
varying float vBlightAmount;
varying float vBlightStrength;
varying float vBlightSeed;`;

const VERTEX_WAVE = /* glsl */ `#include <begin_vertex>
if ( uVeil > 0.5 ) {
	// Veil shimmer: slow waves along the curtain.
	float wave = sin( position.x * 0.12 + uBlightTime * 1.3 ) * 0.7 + sin( position.y * 0.045 - uBlightTime * 0.8 + position.x * 0.03 ) * 0.5;
	transformed += normalize( objectNormal + vec3( 1e-6 ) ) * wave;
}`;

const VERTEX_WORLD = /* glsl */ `#include <project_vertex>
{
	vec4 blightWorld = vec4( transformed, 1.0 );
	#ifdef USE_INSTANCING
		blightWorld = instanceMatrix * blightWorld;
	#endif
	vBlightWorld = ( modelMatrix * blightWorld ).xyz;
	int blightSlot = int( aBlight.y + 0.5 );
	vBlightStrength = uBlightStrength[ blightSlot ];
	vBlightAmount = aBlight.x * vBlightStrength;
	vBlightSeed = aBlight.z;
}`;

const FRAGMENT_PARS = /* glsl */ `#include <common>
uniform float uBlightTime;
uniform float uVeil;
varying vec3 vBlightWorld;
varying float vBlightAmount;
varying float vBlightStrength;
varying float vBlightSeed;
float blightHash( vec3 p ) {
	p = fract( p * 0.3183099 + 0.1 );
	p *= 17.0;
	return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float blightNoise( vec3 p ) {
	vec3 i = floor( p );
	vec3 f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	return mix(
		mix( mix( blightHash( i ), blightHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( blightHash( i + vec3( 0, 1, 0 ) ), blightHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
		mix( mix( blightHash( i + vec3( 0, 0, 1 ) ), blightHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( blightHash( i + vec3( 0, 1, 1 ) ), blightHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ),
		f.z );
}`;

/*
 * Mask × strength against a noise threshold: at full strength nothing inside a mask of 1 is cut; as the strength
 * falls the crystals dissolve in noisy holes and the patches shrink from the rim. The edge band glows.
 */
const FRAGMENT_MASK = /* glsl */ `#include <color_fragment>
float blightN = blightNoise( vBlightWorld * 1.7 + vBlightSeed );
float blightCut = 0.02 + 0.9 * blightN;
float blightEdge = 0.0;
if ( uVeil < 0.5 ) {
	if ( vBlightAmount < blightCut ) discard;
	blightEdge = 1.0 - smoothstep( 0.0, 0.12, vBlightAmount - blightCut );
} else {
	// Drifting bright bands up the curtain.
	float bands = 0.5 + 0.5 * sin( vBlightWorld.y * 0.11 - uBlightTime * 1.6 + blightN * 5.0 + vBlightWorld.x * 0.02 + vBlightWorld.z * 0.02 );
	diffuseColor.a *= 0.55 + 0.45 * bands;
	blightEdge = smoothstep( 0.7, 1.0, bands ) * 0.5;
}`;

const FRAGMENT_GLOW = /* glsl */ `#include <emissivemap_fragment>
{
	float pulse = 0.8 + 0.2 * sin( uBlightTime * 1.7 + dot( vBlightWorld, vec3( 0.13, 0.07, 0.11 ) ) );
	#ifdef USE_COLOR
		totalEmissiveRadiance += vColor.rgb * 0.9 * vBlightAmount * pulse;
	#endif
	totalEmissiveRadiance *= pulse;
	// A faint rim at full strength; the dissolving edge glows while the Region is purified.
	totalEmissiveRadiance += vec3( 1.6, 1.0, 2.4 ) * blightEdge * ( 0.1 + 0.9 * ( 1.0 - vBlightStrength ) );
}`;

/** The Blight additions to a (toon-patched) vertex shader (exported for tests). */
export function patchBlightVertex(vertex: string): string {
  let out = replaceOnce(vertex, '#include <common>', VERTEX_PARS);
  out = replaceOnce(out, '#include <begin_vertex>', VERTEX_WAVE);
  return replaceOnce(out, '#include <project_vertex>', VERTEX_WORLD);
}

/** The Blight additions to a (toon-patched) fragment shader (exported for tests). */
export function patchBlightFragment(fragment: string): string {
  let out = replaceOnce(fragment, '#include <common>', FRAGMENT_PARS);
  out = replaceOnce(out, '#include <color_fragment>', FRAGMENT_MASK);
  return replaceOnce(out, '#include <emissivemap_fragment>', FRAGMENT_GLOW);
}

/** Adds the Blight patch after the toon patch; `veil` switches the shimmer on. */
function makeBlight(material: THREE.MeshToonMaterial, veil: boolean): THREE.MeshToonMaterial {
  const toonCompile = material.onBeforeCompile;
  const own = { uVeil: { value: veil ? 1 : 0 } };
  material.onBeforeCompile = (shader, renderer) => {
    toonCompile.call(material, shader, renderer);
    Object.assign(shader.uniforms, BLIGHT_UNIFORMS, own);
    shader.vertexShader = patchBlightVertex(shader.vertexShader);
    shader.fragmentShader = patchBlightFragment(shader.fragmentShader);
  };
  material.customProgramCacheKey = () => BLIGHT_PROGRAM_KEY;
  material.emissive.set(0x4a2082);
  material.emissiveIntensity = 0.45;
  Object.defineProperty(material.userData, 'blight', { value: own, enumerable: false, configurable: true });
  material.needsUpdate = true;
  return material;
}

/** Whether `material` carries the Blight patch. */
export function isBlightMaterial(material: THREE.Material): boolean {
  return (material.userData as { blight?: unknown }).blight !== undefined;
}

/** The one Blight material of every opaque Blight surface (the shared 'blight' toon instance). Never dispose it. */
export function blightSurfaceMaterial(): THREE.MeshToonMaterial {
  const material = sharedMaterial('blight');
  if (!isBlightMaterial(material)) makeBlight(material, false);
  return material;
}

/** A translucent veil variant of the Blight material (same program and uniforms; its own opacity). */
export function createBlightVeilMaterial(opacity = 0.34): THREE.MeshToonMaterial {
  const material = sharedMaterialVariant('blight', { transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, rimScale: 0.6 });
  material.name = 'toon:blight:veil';
  return makeBlight(material, true);
}

/**
 * Gives `geometry` the attributes the Blight material reads: `color` (a colour or a per-vertex function of the local
 * position) and `aBlight` = (mask, strength slot, seed). The barrier walls use the constant barrier slot.
 */
export function addBlightAttributes(
  geometry: THREE.BufferGeometry,
  color: THREE.ColorRepresentation | ((x: number, y: number, z: number, out: THREE.Color) => void),
  slot: number = BLIGHT_BARRIER_INDEX,
  mask = 1,
  seed = 0,
): THREE.BufferGeometry {
  const pos = geometry.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const blight = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const fixed = typeof color === 'function' ? null : new THREE.Color(color);
  for (let i = 0; i < pos.count; i++) {
    if (fixed !== null) c.copy(fixed);
    else (color as (x: number, y: number, z: number, out: THREE.Color) => void)(pos.getX(i), pos.getY(i), pos.getZ(i), c);
    colors.set([c.r, c.g, c.b], i * 3);
    blight.set([mask, slot, seed], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aBlight', new THREE.BufferAttribute(blight, 3));
  return geometry;
}

// ── Geometry ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A unit crystal shard: six-sided bipyramid, tip at y 1, the lower point buried at y −0.25. */
export function crystalGeometry(): THREE.BufferGeometry {
  const sides = 6;
  const ring = 0.22;
  const pos: number[] = [];
  const at = (k: number): [number, number, number] => {
    const a = (k / sides) * Math.PI * 2;
    return [Math.cos(a) * (0.85 + 0.15 * (k % 2)), ring, Math.sin(a) * (0.85 + 0.15 * (k % 2))];
  };
  for (let k = 0; k < sides; k++) {
    const a = at(k);
    const b = at((k + 1) % sides);
    pos.push(...a, 0, 1, 0, ...b); // upper face (counter-clockwise seen from outside)
    pos.push(...b, 0, -0.25, 0, ...a); // lower face
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** A unit thorn vine: an arch 1 m long and VINE_ARCH_HEIGHT m high with four thorns. */
export function vineGeometry(): THREE.BufferGeometry {
  const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(-0.5, -0.02, 0), new THREE.Vector3(0.05, VINE_ARCH_HEIGHT * 2, 0.08), new THREE.Vector3(0.5, -0.02, -0.04));
  const parts: THREE.BufferGeometry[] = [new THREE.TubeGeometry(curve, 10, 0.03, 4, false)];
  for (let i = 1; i <= 4; i++) {
    const t = i / 5;
    const p = curve.getPoint(t);
    const tangent = curve.getTangent(t);
    const outward = new THREE.Vector3(0, 1, 0).addScaledVector(tangent, -tangent.y).normalize();
    const thorn = new THREE.ConeGeometry(0.025, 0.09, 4);
    thorn.translate(0, 0.045, 0);
    thorn.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), outward.applyAxisAngle(tangent, (i % 2 ? 1 : -1) * 0.9)));
    thorn.translate(p.x, p.y, p.z);
    parts.push(thorn);
  }
  const merged = mergeGeometries(parts.map((g) => {
    const n = g.toNonIndexed();
    n.deleteAttribute('uv');
    g.dispose();
    return n;
  }));
  return merged;
}

/**
 * Every site's ground patch merged into one mesh: polar grids draped on the terrain, mask 1 at the centre → 0 at the
 * rim, each vertex carrying its site's Region strength slot.
 */
export function patchGeometry(sites: readonly BlightSite[], heightAt: (x: number, z: number) => number): THREE.BufferGeometry | null {
  if (sites.length === 0) return null;
  const rings = 4;
  const segments = 12;
  const positions: number[] = [];
  const colors: number[] = [];
  const blight: number[] = [];
  const index: number[] = [];
  const c = new THREE.Color();
  for (const site of sites) {
    const base = positions.length / 3;
    const slot = BLIGHT_REGION_INDEX[site.region];
    const push = (x: number, z: number, mask: number): void => {
      positions.push(x, heightAt(x, z) + 0.07, z);
      c.copy(PATCH_RIM).lerp(PATCH_CORE, mask);
      colors.push(c.r, c.g, c.b);
      blight.push(mask, slot, site.seed % 97);
    };
    push(site.x, site.z, 1);
    for (let r = 1; r <= rings; r++) {
      for (let s = 0; s < segments; s++) {
        const a = (s / segments) * Math.PI * 2 + r * 0.37;
        const wobble = 0.8 + 0.35 * Math.sin(a * 3 + site.seed) * Math.cos(a * 2 - site.seed * 0.5);
        const rr = (r / rings) * site.radius * wobble;
        const t = r / rings;
        push(site.x + Math.cos(a) * rr, site.z + Math.sin(a) * rr, r === rings ? 0 : 1 - t * t * 0.85);
      }
    }
    for (let s = 0; s < segments; s++) index.push(base, base + 1 + ((s + 1) % segments), base + 1 + s);
    for (let r = 1; r < rings; r++) {
      const inner = base + 1 + (r - 1) * segments;
      const outer = base + 1 + r * segments;
      for (let s = 0; s < segments; s++) {
        const s1 = (s + 1) % segments;
        index.push(inner + s, inner + s1, outer + s);
        index.push(inner + s1, outer + s1, outer + s);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setAttribute('aBlight', new THREE.Float32BufferAttribute(blight, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

function crystalColor(_x: number, y: number, _z: number, out: THREE.Color): void {
  out.copy(CRYSTAL_BASE).lerp(CRYSTAL_TIP, Math.min(1, Math.max(0, (y + 0.25) / 1.25)) ** 1.5);
}

function vineColor(_x: number, y: number, _z: number, out: THREE.Color): void {
  out.copy(VINE_COLOR).lerp(THORN_COLOR, Math.min(1, Math.max(0, y / (VINE_ARCH_HEIGHT * 1.4))));
}

// ── View ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Sparkles rising from a purified site (quality-scaled by the VFX pool). */
export const PURIFY_SPARKLES: BurstSpec = {
  sprite: 'star', blend: 'add', count: 10, color: 0xf0dcff, speed: [0.4, 1.2], life: [0.9, 1.6], size: [0.16, 0.3],
  layout: 'disc', radius: 5, lift: 1.8, drag: 0.6, delay: [0, 2.4], shrink: 0.3,
};
/** Sites within this distance of the camera sparkle when their Region is purified (m). */
const SPARKLE_RANGE = 140;
const SPARKLE_SITES = 14;

export interface BlightViewOptions {
  terrain: BlightTerrain;
  bus: GameEventBus;
  /** GameState (read-only): Skyshards and the completion flag. */
  progress(): BlightProgress;
  /** VfxSystem.burst (omitted: no sparkles). */
  burst?(spec: Readonly<BurstSpec>, at: Readonly<Vec3>): void;
}

/**
 * An InstancedMesh of `base` (vertex colours from `color`) whose per-instance `aBlight` = (1, the site's Region slot,
 * seed) replaces the vertex attribute, so every Region shares one draw call.
 */
function instancedBlight<T>(
  base: THREE.BufferGeometry,
  color: (x: number, y: number, z: number, out: THREE.Color) => void,
  items: readonly { readonly item: T; readonly region: RegionId }[],
  material: THREE.Material,
  place: (item: T, m: THREE.Matrix4) => void,
): THREE.InstancedMesh {
  const g = addBlightAttributes(base, color);
  g.deleteAttribute('aBlight');
  const blight = new Float32Array(items.length * 3);
  const mesh = new THREE.InstancedMesh(g, material, items.length);
  const m = new THREE.Matrix4();
  items.forEach(({ item, region }, i) => {
    blight.set([1, BLIGHT_REGION_INDEX[region], (i * 7.13) % 17], i * 3);
    place(item, m);
    mesh.setMatrixAt(i, m);
  });
  g.setAttribute('aBlight', new THREE.InstancedBufferAttribute(blight, 3));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
}

export class BlightView {
  readonly object = new THREE.Group();
  readonly state: BlightState;
  readonly sites: readonly BlightSite[];
  /** Crystals, vines and ground patches of every Region: three draw calls in all. */
  readonly meshes: readonly THREE.Mesh[];
  /** The Regions that have Blight sites. */
  private readonly regions: readonly RegionId[];
  private readonly disposables: { dispose(): void }[] = [];
  private readonly unsubscribe: (() => void)[] = [];
  private readonly camPos = new THREE.Vector3();
  private time = 0;

  constructor(private readonly o: BlightViewOptions) {
    this.object.name = 'blight';
    this.state = new BlightState(o.progress());
    this.sites = blightLayout(o.terrain);
    this.regions = REGION_IDS.filter((r) => this.sites.some((s) => s.region === r));
    const material = blightSurfaceMaterial();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const meshes: THREE.Mesh[] = [];
    const crystals = this.sites.flatMap((site) => site.crystals.map((item) => ({ item, region: site.region })));
    if (crystals.length > 0) {
      const mesh = instancedBlight(crystalGeometry(), crystalColor, crystals, material, (c, m) => {
        e.set(c.tiltX, c.yaw, c.tiltZ);
        m.compose(p.set(c.x, c.y, c.z), q.setFromEuler(e), s.set(c.radius, c.height, c.radius));
      });
      mesh.name = 'blight:crystals';
      meshes.push(mesh);
    }
    const vines = this.sites.flatMap((site) => site.vines.map((item) => ({ item, region: site.region })));
    if (vines.length > 0) {
      const mesh = instancedBlight(vineGeometry(), vineColor, vines, material, (v, m) => {
        m.compose(p.set(v.x, v.y, v.z), q.setFromAxisAngle(up, v.yaw), s.setScalar(v.scale));
      });
      mesh.name = 'blight:vines';
      meshes.push(mesh);
    }
    const patches = patchGeometry(this.sites, (x, z) => o.terrain.heightAt(x, z));
    if (patches !== null) {
      const mesh = new THREE.Mesh(patches, material);
      mesh.name = 'blight:patches';
      mesh.receiveShadow = true;
      meshes.push(mesh);
    }
    for (const mesh of meshes) {
      this.track(mesh.geometry);
      mesh.castShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.object.add(mesh);
    }
    this.meshes = meshes;
    this.unsubscribe.push(
      o.bus.on('skyshard:acquired', (e2) => this.sparkle(SKYSHARD_REGION[e2.index])),
      o.bus.on('cinematic:event', (e2) => {
        if (e2.kind === 'worldChange' && e2.key === 'blight_cleared') {
          this.state.clearAll();
          for (const r of REGION_IDS) if (this.state.strength(r) > 0) this.sparkle(r);
        }
      }),
    );
    this.applyUniforms();
  }

  /** Crystal instances of a Region (tests, budget). */
  instanceCount(region: RegionId): number {
    return this.sites.reduce((n, site) => n + (site.region === region ? site.crystals.length : 0), 0);
  }

  /** One render frame: strengths toward GameState (3 s fades), uniforms, and hidden meshes for purified Regions. */
  update(realDt: number, camera: THREE.Camera): void {
    const dt = Number.isFinite(realDt) && realDt > 0 ? Math.min(realDt, 0.25) : 0;
    this.time += dt;
    camera.getWorldPosition(this.camPos);
    this.state.update(dt, this.o.progress());
    this.applyUniforms();
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    for (const d of this.disposables.splice(0)) d.dispose();
    for (const mesh of this.meshes) if (mesh instanceof THREE.InstancedMesh) mesh.dispose();
    this.object.clear();
  }

  /** Strength uniforms; the meshes hide (no draw calls) once every Region with Blight is purified. */
  private applyUniforms(): void {
    const u = BLIGHT_UNIFORMS.uBlightStrength.value;
    for (let i = 0; i < this.state.strengths.length; i++) u[i] = this.state.strengths[i];
    BLIGHT_UNIFORMS.uBlightTime.value = this.time;
    const visible = this.regions.some((r) => this.state.strength(r) > 0);
    for (const mesh of this.meshes) mesh.visible = visible;
  }

  /** Sparkles over the Region's sites nearest the camera. */
  private sparkle(region: RegionId): void {
    const burst = this.o.burst;
    if (burst === undefined) return;
    const near = this.sites
      .filter((site) => site.region === region)
      .map((site) => ({ site, d: Math.hypot(site.x - this.camPos.x, site.z - this.camPos.z) }))
      .filter((x) => x.d <= SPARKLE_RANGE)
      .sort((a, b) => a.d - b.d)
      .slice(0, SPARKLE_SITES);
    for (const { site } of near) burst({ ...PURIFY_SPARKLES, radius: site.radius }, { x: site.x, y: site.y + 0.3, z: site.z });
  }

  private track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }
}
