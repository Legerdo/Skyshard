/*
 * Region atmosphere particles (design.md "대기 효과·환경 생물"; Req 39.4): one GPU point cloud per Region kind —
 * Verdant petals and fireflies, Ember embers and ash, Azure cloud mist and light motes — in a 40 m box around the
 * camera. The vertex shader wraps each particle's drifting world position into the box (period 40 m), so particles
 * leaving one side reappear on the other and the cloud never has to be refilled; they fade near the box edge. The
 * cloud of a Region shows with that Region's grading weight at the Active_Character (fading across borders) and fades
 * out indoors. Counts follow the quality preset's particle scale (0.5 / 1 / 1.5 ×) through the draw range of a
 * buffer allocated once for the largest scale.
 */
import * as THREE from 'three';
import { createRng } from '../core/rng';

/** Edge of the wrap box around the camera (m). */
export const ATMOSPHERE_BOX = 40;
/** Largest particle scale of the presets (high 1.5 ×): the buffers are allocated for it. */
const MAX_SCALE = 1.5;

export type AtmosphereRegion = 'verdant' | 'ember' | 'azure';

interface ParticleKind {
  readonly color: number;
  /** World size (m). */
  readonly size: number;
  readonly alpha: number;
  /** Drift (m/s). */
  readonly drift: readonly [number, number, number];
  /** Side-to-side flutter amplitude (m). */
  readonly wobble: number;
  /** 0 steady … 1 twinkling. */
  readonly twinkle: number;
  /** Colour multiplier (above 1 reaches the bloom threshold). */
  readonly glow: number;
}

interface AtmosphereDef {
  /** Particles at particle scale 1. */
  readonly count: number;
  /** Share of kind B. */
  readonly split: number;
  readonly a: ParticleKind;
  readonly b: ParticleKind;
}

export const ATMOSPHERE_DEFS: Readonly<Record<AtmosphereRegion, AtmosphereDef>> = {
  // Petals drifting down on the wind; fireflies hovering and blinking.
  verdant: {
    count: 520, split: 0.35,
    a: { color: 0xffc7dc, size: 0.12, alpha: 0.85, drift: [0.55, -0.35, 0.25], wobble: 0.6, twinkle: 0, glow: 1 },
    b: { color: 0xe8ff9a, size: 0.09, alpha: 0.9, drift: [0.05, 0.04, -0.03], wobble: 0.35, twinkle: 1, glow: 2.2 },
  },
  // Embers rising from the canyon; grey ash falling.
  ember: {
    count: 560, split: 0.45,
    a: { color: 0xff8a3d, size: 0.08, alpha: 0.95, drift: [0.15, 0.8, 0.1], wobble: 0.4, twinkle: 0.6, glow: 2.4 },
    b: { color: 0x8a8480, size: 0.1, alpha: 0.55, drift: [0.25, -0.45, 0.15], wobble: 0.5, twinkle: 0, glow: 1 },
  },
  // Cloud mist puffs rolling past; small cold light motes.
  azure: {
    count: 420, split: 0.6,
    a: { color: 0xeef4ff, size: 2.6, alpha: 0.12, drift: [0.9, 0.02, 0.3], wobble: 0.8, twinkle: 0, glow: 1 },
    b: { color: 0xb9d8ff, size: 0.07, alpha: 0.95, drift: [0.05, 0.18, 0.05], wobble: 0.3, twinkle: 0.8, glow: 2 },
  },
};

const VERTEX = /* glsl */ `
attribute vec4 aSeed; // kind, phase, speed, size
uniform vec3 uCam;
uniform float uTime;
uniform float uPixels;
uniform float uBox;
uniform vec3 uDriftA;
uniform vec3 uDriftB;
uniform vec2 uSize;
uniform vec2 uWobble;
uniform vec2 uTwinkle;
uniform vec2 uAlpha;
varying float vAlpha;
varying float vKind;
void main() {
	float kind = aSeed.x;
	vec3 drift = mix( uDriftA, uDriftB, kind ) * ( 0.6 + 0.8 * aSeed.z );
	float wobble = mix( uWobble.x, uWobble.y, kind );
	float ph = aSeed.y * 6.2831;
	vec3 p = position + drift * uTime;
	p.x += sin( uTime * ( 0.6 + aSeed.z ) + ph ) * wobble;
	p.z += cos( uTime * ( 0.5 + aSeed.w * 0.7 ) + ph * 1.3 ) * wobble;
	p.y += sin( uTime * ( 0.8 + aSeed.z * 0.4 ) + ph * 0.7 ) * wobble * 0.5;
	// Wrap into the box around the camera.
	vec3 local = mod( p - uCam + 0.5 * uBox, uBox ) - 0.5 * uBox;
	vec3 world = uCam + local;
	vec4 mv = viewMatrix * vec4( world, 1.0 );
	gl_Position = projectionMatrix * mv;
	float size = mix( uSize.x, uSize.y, kind ) * ( 0.7 + 0.6 * aSeed.w );
	gl_PointSize = clamp( size * uPixels / max( - mv.z, 0.3 ), 0.0, 160.0 );
	float edge = 1.0 - smoothstep( 0.32 * uBox, 0.5 * uBox, length( local ) );
	float tw = mix( uTwinkle.x, uTwinkle.y, kind );
	float blink = mix( 1.0, 0.5 + 0.5 * sin( uTime * ( 2.0 + 3.0 * aSeed.z ) + ph * 3.0 ), tw );
	vAlpha = edge * blink * mix( uAlpha.x, uAlpha.y, kind ) * step( 0.0, - mv.z );
	vKind = kind;
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uStrength;
varying float vAlpha;
varying float vKind;
void main() {
	vec2 d = gl_PointCoord - 0.5;
	float r = length( d ) * 2.0;
	float soft = 1.0 - smoothstep( 0.35, 1.0, r );
	float a = soft * vAlpha * uStrength;
	if ( a < 0.004 ) discard;
	gl_FragColor = vec4( mix( uColorA, uColorB, vKind ), a );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

/** One Region's point cloud. */
class RegionCloud {
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  readonly base: number;
  private readonly capacity: number;

  constructor(readonly region: AtmosphereRegion, def: AtmosphereDef, seed: number, uniforms: { uTime: THREE.IUniform<number>; uCam: THREE.IUniform<THREE.Vector3>; uPixels: THREE.IUniform<number> }) {
    this.base = def.count;
    this.capacity = Math.ceil(def.count * MAX_SCALE);
    const rng = createRng(seed);
    const pos = new Float32Array(this.capacity * 3);
    const seeds = new Float32Array(this.capacity * 4);
    for (let i = 0; i < this.capacity; i++) {
      pos[i * 3] = rng.range(0, ATMOSPHERE_BOX * 8);
      pos[i * 3 + 1] = rng.range(0, ATMOSPHERE_BOX * 8);
      pos[i * 3 + 2] = rng.range(0, ATMOSPHERE_BOX * 8);
      seeds[i * 4] = rng.next() < def.split ? 1 : 0;
      seeds[i * 4 + 1] = rng.next();
      seeds[i * 4 + 2] = rng.next();
      seeds[i * 4 + 3] = rng.next();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    // Always around the camera: never frustum culled by the (meaningless) bounds.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const colorOf = (k: ParticleKind): THREE.Color => new THREE.Color(k.color).multiplyScalar(k.glow);
    this.material = new THREE.ShaderMaterial({
      name: `atmosphere:${region}`,
      uniforms: {
        uCam: uniforms.uCam,
        uTime: uniforms.uTime,
        uPixels: uniforms.uPixels,
        uBox: { value: ATMOSPHERE_BOX },
        uDriftA: { value: new THREE.Vector3(...def.a.drift) },
        uDriftB: { value: new THREE.Vector3(...def.b.drift) },
        uSize: { value: new THREE.Vector2(def.a.size, def.b.size) },
        uWobble: { value: new THREE.Vector2(def.a.wobble, def.b.wobble) },
        uTwinkle: { value: new THREE.Vector2(def.a.twinkle, def.b.twinkle) },
        uAlpha: { value: new THREE.Vector2(def.a.alpha, def.b.alpha) },
        uColorA: { value: colorOf(def.a) },
        uColorB: { value: colorOf(def.b) },
        uStrength: { value: 0 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.name = `atmosphere:${region}`;
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.matrixAutoUpdate = false;
    this.setScale(1);
  }

  /** Particle count for `scale` (the buffer is not reallocated). */
  setScale(scale: number): void {
    const n = Math.max(0, Math.min(this.capacity, Math.round(this.base * (Number.isFinite(scale) ? scale : 1))));
    this.points.geometry.setDrawRange(0, n);
  }

  get count(): number {
    return this.points.geometry.drawRange.count;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

export class AtmosphereParticles {
  readonly object = new THREE.Group();
  private readonly clouds: RegionCloud[];
  private readonly shared = {
    uTime: { value: 0 },
    uCam: { value: new THREE.Vector3() },
    uPixels: { value: 540 },
  };
  private scale = 1;
  private readonly size = new THREE.Vector2();

  constructor(seed = 0x417305) {
    this.object.name = 'atmosphere';
    this.clouds = (Object.keys(ATMOSPHERE_DEFS) as AtmosphereRegion[]).map((region, i) => new RegionCloud(region, ATMOSPHERE_DEFS[region], seed + i * 7919, this.shared));
    for (const c of this.clouds) {
      // The camera and the drawing-buffer height are read just before drawing (any camera, any resolution).
      c.points.onBeforeRender = (renderer, _scene, camera) => {
        camera.getWorldPosition(this.shared.uCam.value);
        renderer.getDrawingBufferSize(this.size);
        const fov = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? (camera as THREE.PerspectiveCamera).fov : 60;
        this.shared.uPixels.value = this.size.y / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
      };
      this.object.add(c.points);
    }
  }

  /** Quality particle scale (0.5 / 1 / 1.5): draw ranges only. */
  setScale(scale: number): void {
    if (scale === this.scale) return;
    this.scale = scale;
    for (const c of this.clouds) c.setScale(scale);
  }

  /** Particles drawn per Region now (tests, F3). */
  counts(): Record<AtmosphereRegion, number> {
    return Object.fromEntries(this.clouds.map((c) => [c.region, c.count])) as Record<AtmosphereRegion, number>;
  }

  /**
   * One frame: `time` (s), the Region weights at the Active_Character and the interior weight (0 outdoors … 1 inside).
   * A cloud with no weight is hidden (no draw call).
   */
  update(time: number, weights: Readonly<Record<AtmosphereRegion, number>>, interior: number): void {
    this.shared.uTime.value = time;
    const outdoors = 1 - Math.min(1, Math.max(0, interior));
    for (const c of this.clouds) {
      const w = Math.min(1, Math.max(0, weights[c.region] ?? 0)) * outdoors;
      c.material.uniforms.uStrength.value = w;
      c.points.visible = w > 0.01 && c.count > 0;
    }
  }

  dispose(): void {
    for (const c of this.clouds) c.dispose();
    this.object.clear();
  }
}
