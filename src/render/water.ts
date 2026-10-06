/*
 * Water (design.md "물"; Req 39.4). Every water body of src/world/terrain/waterBodies.ts (lake_azure, pond_verdant,
 * river_verdant) is a flat (lake, pond) or sloped (river) surface mesh with one toon water ShaderMaterial:
 * - depth: a 561 × 561 half-float height texture made from `TerrainField.heights` gives the ground under each
 *   fragment; shallow water is bright, deep water dark (two toon steps), and the same depth draws the foam band along
 *   the shore;
 * - fresnel: the sky's zenith / horizon colours (the world scene's dome uniforms) reflect more at grazing angles, plus
 *   a stepped sun glint;
 * - scrolling noise normals (two layers) for the small waves;
 * - up to 8 ripple rings (centre, start time, strength) as a uniform array, raised by the Active_Character wading or
 *   swimming and by projectiles hitting the surface (RippleRings keeps the newest 8).
 * The waterfall at lm_waterfall gets three downward-scrolling foam sheets in front of the Landmark's water sheet, and
 * mist particles at its foot through the VFX pool.
 */
import * as THREE from 'three';
import type { Vec3 } from '../core/types';
import { REGION_PALETTES } from '../data/palettes';
import { LOCATIONS, TERRAIN_GRID } from '../data/worldLayout';
import type { BurstSpec } from '../vfx/catalog';
import { WATER_BODIES, type WaterBody } from '../world/terrain';

export const MAX_RIPPLES = 8;
/** A ring spreads and fades over this long (s). */
export const RIPPLE_SECONDS = 2.2;

/** The newest MAX_RIPPLES ripple rings as vec4 (x, z, start time, strength); a new ring replaces the oldest. */
export class RippleRings {
  readonly rings: THREE.Vector4[] = Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, -1e6, 0));
  private next = 0;

  add(x: number, z: number, time: number, strength = 1): void {
    // Reuse an expired slot first, else the oldest.
    let slot = -1;
    let oldest = Infinity;
    for (let i = 0; i < MAX_RIPPLES; i++) {
      const r = this.rings[i];
      if (r.w <= 0 || time - r.z > RIPPLE_SECONDS) {
        slot = i;
        break;
      }
      if (r.z < oldest) {
        oldest = r.z;
        slot = i;
      }
    }
    if (slot < 0) slot = this.next;
    this.rings[slot].set(x, z, time, Math.max(0, Math.min(1.5, strength)));
    this.next = (slot + 1) % MAX_RIPPLES;
  }

  /** Rings still spreading at `time`. */
  active(time: number): number {
    let n = 0;
    for (const r of this.rings) if (r.w > 0 && time - r.z >= 0 && time - r.z <= RIPPLE_SECONDS) n++;
    return n;
  }
}

/** The heightfield as a 561 × 561 single-channel half-float texture (linear filtering, clamped). */
export function createHeightTexture(heights: Float32Array): THREE.DataTexture {
  const n = TERRAIN_GRID.samplesPerSide;
  const data = new Uint16Array(n * n);
  for (let i = 0; i < n * n; i++) data[i] = THREE.DataUtils.toHalfFloat(heights[i] ?? 0);
  const texture = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.HalfFloatType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.name = 'terrainHeight';
  texture.needsUpdate = true;
  return texture;
}

const WATER_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
varying vec3 vWorld;
void main() {
	vec4 world = modelMatrix * vec4( position, 1.0 );
	vWorld = world.xyz;
	vec4 mvPosition = viewMatrix * world;
	gl_Position = projectionMatrix * mvPosition;
	#include <fog_vertex>
}
`;

const WATER_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform sampler2D uHeight;
uniform float uTime;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uFoam;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec4 uRipples[ ${MAX_RIPPLES} ];
uniform float uOpacity;
varying vec3 vWorld;

float wHash( vec2 p ) {
	return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
}
float wNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( wHash( i ), wHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( wHash( i + vec2( 0.0, 1.0 ) ), wHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
vec2 wGrad( vec2 p ) {
	const float e = 0.3;
	return vec2( wNoise( p + vec2( e, 0.0 ) ) - wNoise( p - vec2( e, 0.0 ) ), wNoise( p + vec2( 0.0, e ) ) - wNoise( p - vec2( 0.0, e ) ) ) / ( 2.0 * e );
}

void main() {
	// Ground under the fragment from the 2 m heightfield (texel centres at x = −560 + 2 i).
	vec2 uv = ( ( vWorld.xz + ${TERRAIN_GRID.halfExtent.toFixed(1)} ) * ${(1 / TERRAIN_GRID.step).toFixed(4)} + 0.5 ) / ${TERRAIN_GRID.samplesPerSide.toFixed(1)};
	float ground = texture2D( uHeight, uv ).r;
	float depth = max( vWorld.y - ground, 0.0 );

	// Two scrolling noise layers for the small waves.
	vec2 g = wGrad( vWorld.xz * 0.16 + vec2( uTime * 0.05, uTime * 0.03 ) ) * 0.55
		+ wGrad( vWorld.xz * 0.47 - vec2( uTime * 0.08, -uTime * 0.05 ) ) * 0.25;

	// Ripple rings: a bright band at the spreading radius that also bends the normal.
	float ring = 0.0;
	for ( int i = 0; i < ${MAX_RIPPLES}; i ++ ) {
		vec4 r = uRipples[ i ];
		float age = uTime - r.z;
		if ( r.w <= 0.0 || age < 0.0 || age > ${RIPPLE_SECONDS.toFixed(2)} ) continue;
		vec2 d = vWorld.xz - r.xy;
		float dist = length( d );
		float radius = 0.25 + age * 1.7;
		float band = exp( - pow( ( dist - radius ) / 0.16, 2.0 ) );
		float fade = ( 1.0 - age / ${RIPPLE_SECONDS.toFixed(2)} ) * r.w;
		ring += band * fade;
		g += d / max( dist, 1e-3 ) * band * fade * 0.9;
	}

	vec3 n = normalize( vec3( - g.x, 1.0, - g.y ) );
	vec3 view = normalize( cameraPosition - vWorld );
	float fresnel = pow( 1.0 - clamp( dot( n, view ), 0.0, 1.0 ), 3.0 );

	// Two toon depth steps between shallow and deep.
	float deep = smoothstep( 0.4, 1.2, depth ) * 0.5 + smoothstep( 2.2, 3.6, depth ) * 0.5;
	vec3 water = mix( uShallow, uDeep, deep );
	vec3 refl = reflect( - view, n );
	vec3 sky = mix( uSkyHorizon, uSkyTop, clamp( refl.y * 1.4, 0.0, 1.0 ) );
	vec3 col = mix( water, sky, clamp( 0.08 + fresnel * 0.8, 0.0, 1.0 ) );

	// Stepped sun glint.
	vec3 h = normalize( normalize( uSunDir ) + view );
	col += uSunColor * step( 0.985, max( dot( n, h ), 0.0 ) ) * 0.9;

	// Foam band on the shore (wobbling edge) and the ripple rings.
	float edge = 0.35 + 0.28 * wNoise( vWorld.xz * 0.7 + vec2( uTime * 0.25, - uTime * 0.18 ) );
	float foam = 1.0 - smoothstep( edge * 0.7, edge, depth );
	col = mix( col, uFoam, clamp( foam + ring * 0.55, 0.0, 1.0 ) );

	float alpha = mix( 0.62, 0.93, deep );
	alpha = max( alpha, foam * 0.95 );
	gl_FragColor = vec4( col, alpha * uOpacity );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
}
`;

/** Uniforms every water material shares (time, ripples, sky, sun, the height texture). */
export interface WaterSharedUniforms {
  [name: string]: THREE.IUniform;
  uHeight: THREE.IUniform<THREE.Texture | null>;
  uTime: THREE.IUniform<number>;
  uSkyTop: THREE.IUniform<THREE.Color>;
  uSkyHorizon: THREE.IUniform<THREE.Color>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uRipples: THREE.IUniform<THREE.Vector4[]>;
}

/** A water material of one colour set, sharing `shared`. */
export function createWaterMaterial(shared: WaterSharedUniforms, shallow: THREE.ColorRepresentation, deep: THREE.ColorRepresentation): THREE.ShaderMaterial {
  const uniforms: Record<string, THREE.IUniform> = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    ...shared,
    uShallow: { value: new THREE.Color(shallow) },
    uDeep: { value: new THREE.Color(deep) },
    uFoam: { value: new THREE.Color(0xf4fbff) },
    uOpacity: { value: 1 },
  };
  return new THREE.ShaderMaterial({
    name: 'toonWater',
    uniforms,
    vertexShader: WATER_VERTEX,
    fragmentShader: WATER_FRAGMENT,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
}

/** How far (m) a surface mesh reaches past the body's edge (the terrain hides the part above the shore). */
const SURFACE_MARGIN = 6;

/** The surface mesh geometry of a water body (world coordinates). */
export function waterSurfaceGeometry(body: WaterBody): THREE.BufferGeometry {
  if (body.kind === 'circle') {
    const g = new THREE.CircleGeometry(body.r + SURFACE_MARGIN, 72);
    g.rotateX(-Math.PI / 2);
    g.translate(body.x, body.level, body.z);
    return g;
  }
  // River: a ribbon along the centreline, subdivided every ≈ 4 m, the level interpolated along it.
  const half = body.halfWidth + SURFACE_MARGIN * 0.5;
  const pos: number[] = [];
  const index: number[] = [];
  const pts = body.points;
  const samples: { x: number; z: number; level: number; dx: number; dz: number }[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(len / 4));
    for (let s = 0; s < steps || (i + 2 === pts.length && s === steps); s++) {
      const t = s / steps;
      samples.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, level: a.level + (b.level - a.level) * t, dx: (b.x - a.x) / len, dz: (b.z - a.z) / len });
    }
  }
  samples.forEach((s, i) => {
    // Extend both ends a little past the centreline's end points.
    const ext = i === 0 ? -SURFACE_MARGIN : i === samples.length - 1 ? SURFACE_MARGIN : 0;
    const cx = s.x + s.dx * ext;
    const cz = s.z + s.dz * ext;
    pos.push(cx - s.dz * half, s.level, cz + s.dx * half, cx + s.dz * half, s.level, cz - s.dx * half);
    if (i > 0) {
      const k = (i - 1) * 2;
      index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

// ── Waterfall ──────────────────────────────────────────────────────────────────────────────────────────────────

const FOAM_VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
varying vec2 vUv;
void main() {
	vUv = uv;
	vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
	gl_Position = projectionMatrix * mvPosition;
	#include <fog_vertex>
}
`;

const FOAM_FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uTime;
uniform float uSpeed;
uniform float uSeed;
uniform float uOpacity;
varying vec2 vUv;
float fHash( vec2 p ) {
	return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
}
float fNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( fHash( i ), fHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( fHash( i + vec2( 0.0, 1.0 ) ), fHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
void main() {
	// Streaks stretched along the fall, scrolling down.
	float n = fNoise( vec2( vUv.x * 26.0 + uSeed, vUv.y * 4.0 + uTime * uSpeed ) ) * 0.65
		+ fNoise( vec2( vUv.x * 60.0 - uSeed, vUv.y * 9.0 + uTime * uSpeed * 1.6 ) ) * 0.35;
	float streak = smoothstep( 0.52, 0.66, n );
	float sides = smoothstep( 0.0, 0.12, vUv.x ) * smoothstep( 0.0, 0.12, 1.0 - vUv.x );
	// Denser at the lip and the foot.
	float ends = 0.55 + 0.45 * max( smoothstep( 0.8, 1.0, vUv.y ), smoothstep( 0.2, 0.0, vUv.y ) );
	float a = streak * sides * ends * uOpacity;
	if ( a < 0.01 ) discard;
	gl_FragColor = vec4( vec3( 0.95, 0.98, 1.0 ), a );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#include <fog_fragment>
}
`;

/** Mist at the waterfall's foot (alpha blend, growing puffs). */
export const WATERFALL_MIST: BurstSpec = {
  sprite: 'circle', blend: 'alpha', count: 2, color: 0xf2f8ff, speed: [0.3, 1.1], life: [1.4, 2.4], size: [1.4, 2.4],
  layout: 'disc', radius: 5, lift: 0.9, drag: 0.8, alpha: 0.32, shrink: 1.9,
};
/** Mist puffs per second while the camera is within MIST_RANGE of the foot. */
const MIST_RATE = 7;
const MIST_RANGE = 220;

/** The waterfall frame: the Landmark sheet's foot, facing and height (same numbers as src/render/landmarks.ts). */
function waterfallFrame(): { foot: THREE.Vector3; facing: number; height: number } {
  const pond = WATER_BODIES.find((b) => b.id === 'pond_verdant');
  const top = LOCATIONS.lm_waterfall;
  if (pond === undefined || pond.kind !== 'circle') return { foot: new THREE.Vector3(top.x, top.groundY, top.z), facing: 0, height: 10 };
  const len = Math.hypot(top.x - pond.x, top.z - pond.z);
  const d = { x: (top.x - pond.x) / len, z: (top.z - pond.z) / len };
  return {
    foot: new THREE.Vector3(pond.x + d.x * 32, pond.level, pond.z + d.z * 32),
    facing: Math.atan2(-d.x, -d.z),
    height: top.groundY - pond.level + 0.6,
  };
}

export interface WaterViewOptions {
  heights: Float32Array;
  /** VfxSystem.burst for the waterfall mist (omitted: none). */
  burst?(spec: Readonly<BurstSpec>, at: Readonly<Vec3>): void;
}

/** The sky and sun every water surface reflects (linear colours). */
export interface WaterSky {
  readonly skyTop: THREE.Color;
  readonly skyHorizon: THREE.Color;
  readonly sunDir: THREE.Vector3;
  readonly sunColor: THREE.Color;
}

/**
 * Page-wide sky uniforms of the water (one set for every session's water), written each frame by the render
 * pipeline from the world scene's time-of-day values.
 */
export const WATER_SKY_UNIFORMS = {
  uSkyTop: { value: new THREE.Color(0x3d9bf2) },
  uSkyHorizon: { value: new THREE.Color(0xc4e6ff) },
  uSunDir: { value: new THREE.Vector3(0.3, 0.9, 0.2).normalize() },
  uSunColor: { value: new THREE.Color(0xfff8e8) },
};

/** Copies the current sky into WATER_SKY_UNIFORMS. */
export function updateWaterSky(sky: WaterSky): void {
  const u = WATER_SKY_UNIFORMS;
  u.uSkyTop.value.copy(sky.skyTop);
  u.uSkyHorizon.value.copy(sky.skyHorizon);
  u.uSunDir.value.copy(sky.sunDir);
  u.uSunColor.value.copy(sky.sunColor);
}

export class WaterView {
  readonly object = new THREE.Group();
  readonly ripples = new RippleRings();
  readonly shared: WaterSharedUniforms;
  private readonly heightTexture: THREE.DataTexture;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly foamUniforms: { uTime: { value: number } };
  private readonly mistAt: THREE.Vector3;
  private mistCarry = 0;
  private time = 0;
  private readonly camPos = new THREE.Vector3();

  constructor(private readonly o: WaterViewOptions) {
    this.object.name = 'water';
    this.heightTexture = this.track(createHeightTexture(o.heights));
    this.shared = {
      uHeight: { value: this.heightTexture },
      uTime: { value: 0 },
      ...WATER_SKY_UNIFORMS,
      uRipples: { value: this.ripples.rings },
    };
    const verdant = REGION_PALETTES.verdant.swatches.water;
    const azure = REGION_PALETTES.azure.swatches.water;
    const deepOf = (hex: number): THREE.Color => new THREE.Color(hex).multiplyScalar(0.35);
    const materials = {
      verdant: this.track(createWaterMaterial(this.shared, new THREE.Color(verdant).lerp(new THREE.Color(0xd8f4ff), 0.35), deepOf(verdant))),
      azure: this.track(createWaterMaterial(this.shared, new THREE.Color(azure).lerp(new THREE.Color(0xd8ecff), 0.3), deepOf(azure))),
    };
    for (const body of WATER_BODIES) {
      const material = body.id.includes('azure') ? materials.azure : materials.verdant;
      const mesh = new THREE.Mesh(this.track(waterSurfaceGeometry(body)), material);
      mesh.name = `water:${body.id}`;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 1;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.object.add(mesh);
    }
    // Waterfall foam sheets in front of the Landmark's sheet (its lean: 2.6 m back at the top).
    const frame = waterfallFrame();
    this.foamUniforms = { uTime: this.shared.uTime };
    const sheets = new THREE.Group();
    sheets.name = 'waterfall:foam';
    sheets.position.copy(frame.foot);
    sheets.rotation.y = frame.facing;
    [0.35, 0.7, 1.05].forEach((offset, i) => {
      const g = new THREE.PlaneGeometry(12 - i * 2, frame.height, 1, 8);
      const p = g.getAttribute('position') as THREE.BufferAttribute;
      for (let k = 0; k < p.count; k++) {
        const t = (p.getY(k) + frame.height / 2) / frame.height;
        p.setZ(k, -2.6 * t * t + offset);
      }
      g.translate(0, frame.height / 2 - 0.3, 0);
      const material = this.track(new THREE.ShaderMaterial({
        name: 'waterfallFoam',
        uniforms: {
          ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
          uTime: this.foamUniforms.uTime,
          uSpeed: { value: 0.9 + i * 0.35 },
          uSeed: { value: i * 17.3 },
          uOpacity: { value: 0.75 - i * 0.18 },
        },
        vertexShader: FOAM_VERTEX,
        fragmentShader: FOAM_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: true,
      }));
      const mesh = new THREE.Mesh(this.track(g), material);
      mesh.renderOrder = 2;
      sheets.add(mesh);
    });
    this.object.add(sheets);
    this.mistAt = frame.foot.clone();
    this.object.updateMatrixWorld(true);
  }

  /** One frame: the water clock and the waterfall mist near the camera (the sky comes from WATER_SKY_UNIFORMS). */
  update(realDt: number, camera: THREE.Camera): void {
    const dt = Number.isFinite(realDt) && realDt > 0 ? Math.min(realDt, 0.25) : 0;
    this.time += dt;
    this.shared.uTime.value = this.time;
    const burst = this.o.burst;
    if (burst !== undefined && dt > 0) {
      camera.getWorldPosition(this.camPos);
      if (this.camPos.distanceTo(this.mistAt) <= MIST_RANGE) {
        this.mistCarry += dt * MIST_RATE;
        while (this.mistCarry >= 1) {
          this.mistCarry -= 1;
          burst(WATERFALL_MIST, { x: this.mistAt.x, y: this.mistAt.y + 0.6, z: this.mistAt.z });
        }
      } else {
        this.mistCarry = 0;
      }
    }
  }

  /** The water clock (ripple start times are on it). */
  get clock(): number {
    return this.time;
  }

  /** A ripple ring at (x, z) now. */
  ripple(x: number, z: number, strength = 1): void {
    this.ripples.add(x, z, this.time, strength);
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
    this.object.clear();
  }

  private track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }
}
