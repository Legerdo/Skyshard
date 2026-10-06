/*
 * Shared toon materials (design.md "렌더러와 재질", Req 39.1). STABLE API used by every art module (terrain, props,
 * rigs, enemies, landmarks): `createToonMaterial(opts)`, `sharedMaterial(kind)`, `createOutlineMaterial()` and
 * `toonGradient()`; everything else here is additive.
 *
 * A toon material is a MeshToonMaterial with the 3-step (shadow · mid · light) NearestFilter gradient map, white
 * `color` and `vertexColors: true` (the geometry's `color` attribute is the albedo, so broad colour fields need no
 * texture), and `onBeforeCompile` additions:
 * - fresnel rim light `uRimColor`·`uRimPower`·`uRimStrength` (one uniform set shared by every toon material, driven
 *   each frame by the Region grading blend and the time-of-day preset), scaled per material by `uRimScale`;
 * - `fogCap`: the fog_fragment chunk is replaced so that `fogFactor = min(fogFactor, fogCap)` (default 1.0; Landmarks
 *   use 0.55);
 * - the post-processing-off grading: `uGradeTint`·`uGradeSaturation` (neutral while the GradingPass runs).
 * Every toon material returns the same `customProgramCacheKey`, so all of them compile to the same few programs
 * (one per three.js feature combination such as fog / skinning / flat shading) however many meshes and instances
 * exist: per-material values are uniforms, never defines.
 *
 * The outline material is the inverted hull: back faces only, vertices pushed along the (skinned) normal by
 * 0.02–0.05 m in proportion to the camera distance, drawn ≈ 35 % as bright as the base colour. Attach it with
 * src/render/outline.ts, only to characters, NPCs, enemies, Caelith and the weapons they hold.
 *
 * Geometry drawn with a `vertexColors: true` material must have a `color` attribute (a missing attribute reads as
 * black in WebGL); pass `vertexColors: false` and a `color` for single-colour meshes.
 */
import * as THREE from 'three';

/** The fixed set of shared instances (design "공유 instance"). */
export const SHARED_MATERIAL_KINDS = [
  'terrain', 'foliage', 'bark', 'rock', 'wood', 'stone', 'crystal', 'blight', 'water', 'character', 'enemy',
] as const;
export type SharedMaterialKind = (typeof SHARED_MATERIAL_KINDS)[number];

export interface ToonMaterialOptions {
  /** Albedo tint multiplied with the vertex colors; default white (vertex colors as albedo). */
  color?: THREE.ColorRepresentation;
  /** Use the geometry's `color` attribute as albedo; default true. */
  vertexColors?: boolean;
  /** Upper bound of the fog factor (landmarks 0.55); default 1.0. */
  fogCap?: number;
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  /** Faceted normals (rocks, crystals); default false. */
  flatShading?: boolean;
  /** Multiplier of the shared rim strength for this material; default 1. */
  rimScale?: number;
  /** Depth writes; default true (transparent water and glows may turn it off). */
  depthWrite?: boolean;
}

/** Program cache key shared by every toon material (its injected code never differs between materials). */
export const TOON_PROGRAM_KEY = 'skyshard-toon-v1';
/** Program cache key shared by every outline material. */
export const OUTLINE_PROGRAM_KEY = 'skyshard-outline-v1';

/**
 * Uniforms shared by every toon material (one object each, referenced from every program): the rim from the Region
 * grading blend and the preset, and the grading fallback used while post-processing is off.
 */
export const TOON_UNIFORMS = {
  uRimColor: { value: new THREE.Color(0xffe69a) },
  uRimPower: { value: 3.0 },
  uRimStrength: { value: 0.35 },
  uGradeTint: { value: new THREE.Color(1, 1, 1) },
  uGradeSaturation: { value: 1.0 },
};

/** Outline thickness (m) grows with the camera distance at `perMetre` inside [min, max] (design: 0.02–0.05 m). */
export const OUTLINE_UNIFORMS = {
  uOutlineMin: { value: 0.02 },
  uOutlineMax: { value: 0.05 },
  uOutlinePerMetre: { value: 0.004 },
};

/** The outline push (m) at `viewDistance` m from the camera: the same formula as the outline vertex shader. */
export function outlineWidthAt(viewDistance: number): number {
  const d = Number.isFinite(viewDistance) ? Math.max(0, viewDistance) : 0;
  const u = OUTLINE_UNIFORMS;
  return Math.min(u.uOutlineMax.value, Math.max(u.uOutlineMin.value, d * u.uOutlinePerMetre.value));
}

/** Per-material uniforms kept in `material.userData.toon`. */
interface ToonMaterialUniforms {
  fogCap: { value: number };
  uRimScale: { value: number };
}

let gradient: THREE.DataTexture | null = null;

/** The 3-step (shadow · mid · light) gradient map, NearestFilter. */
export function toonGradient(): THREE.DataTexture {
  if (gradient !== null) return gradient;
  const data = new Uint8Array([90, 90, 90, 255, 170, 170, 170, 255, 255, 255, 255, 255]);
  gradient = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

function replaceOnce(source: string, search: string, replacement: string, what: string): string {
  const at = source.indexOf(search);
  if (at < 0) throw new Error(`toonMaterial: ${what} not found in the shader (three.js chunk layout changed?)`);
  return source.slice(0, at) + replacement + source.slice(at + search.length);
}

const TOON_FRAGMENT_PARS = /* glsl */ `#include <common>
uniform vec3 uRimColor;
uniform float uRimPower;
uniform float uRimStrength;
uniform float uRimScale;
uniform vec3 uGradeTint;
uniform float uGradeSaturation;
uniform float fogCap;`;

const TOON_FRAGMENT_RIM = /* glsl */ `{
	// Fresnel rim (task 18.1): brightest where the surface turns away from the camera, tinted by the albedo a little.
	float rimNdV = clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 );
	float rimTerm = pow( 1.0 - rimNdV, uRimPower ) * uRimStrength * uRimScale;
	outgoingLight += uRimColor * rimTerm * ( 0.5 + 0.5 * diffuseColor.rgb );
	// Grading fallback while post-processing is off (neutral values otherwise).
	float gradeLuma = dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) );
	outgoingLight = max( mix( vec3( gradeLuma ), outgoingLight, uGradeSaturation ), 0.0 ) * uGradeTint;
}
#include <opaque_fragment>`;

/** fog_fragment with the fog factor capped per material. */
const TOON_FOG_FRAGMENT = /* glsl */ `#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	fogFactor = min( fogFactor, fogCap );
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;

/** The toon fragment shader with the rim, grading fallback and fog cap injected (exported for tests). */
export function patchToonFragment(fragment: string): string {
  let out = replaceOnce(fragment, '#include <common>', TOON_FRAGMENT_PARS, 'common chunk');
  out = replaceOnce(out, '#include <opaque_fragment>', TOON_FRAGMENT_RIM, 'opaque_fragment chunk');
  out = replaceOnce(out, '#include <fog_fragment>', TOON_FOG_FRAGMENT, 'fog_fragment chunk');
  return out;
}

const OUTLINE_VERTEX_PARS = /* glsl */ `#include <common>
uniform float uOutlineMin;
uniform float uOutlineMax;
uniform float uOutlinePerMetre;`;

/*
 * After skinning, so a SkinnedMesh outline sharing the body's geometry and Skeleton pushes the posed vertices. The
 * push is divided by the object's scale so the world thickness stays within 0.02–0.05 m.
 */
const OUTLINE_VERTEX_PUSH = /* glsl */ `#include <skinning_vertex>
{
	#ifdef USE_SKINNING
		vec3 outlineNormal = objectNormal;
	#else
		vec3 outlineNormal = normal;
	#endif
	vec4 outlineView = modelViewMatrix * vec4( transformed, 1.0 );
	float outlineWidth = clamp( - outlineView.z * uOutlinePerMetre, uOutlineMin, uOutlineMax );
	float outlineScale = max( length( modelMatrix[ 0 ].xyz ), 1e-4 );
	transformed += normalize( outlineNormal + vec3( 1e-6 ) ) * ( outlineWidth / outlineScale );
}`;

/** The basic-material vertex shader with the inverted-hull push injected (exported for tests). */
export function patchOutlineVertex(vertex: string): string {
  const out = replaceOnce(vertex, '#include <common>', OUTLINE_VERTEX_PARS, 'common chunk');
  return replaceOnce(out, '#include <skinning_vertex>', OUTLINE_VERTEX_PUSH, 'skinning_vertex chunk');
}

function toonUniformsOf(material: THREE.Material): ToonMaterialUniforms | undefined {
  return (material.userData as { toon?: ToonMaterialUniforms }).toon;
}

/** A new toon material (MeshToonMaterial + 3-step gradient, rim, fog cap, grading fallback). */
export function createToonMaterial(opts: ToonMaterialOptions = {}): THREE.MeshToonMaterial {
  const material = new THREE.MeshToonMaterial({
    color: opts.color ?? 0xffffff,
    vertexColors: opts.vertexColors ?? true,
    gradientMap: toonGradient(),
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    side: opts.side ?? THREE.FrontSide,
  });
  // MeshToonMaterial's typings lack flatShading; the renderer still reads it (FLAT_SHADED define).
  if (opts.flatShading === true) (material as THREE.MeshToonMaterial & { flatShading: boolean }).flatShading = true;
  if (opts.depthWrite === false) material.depthWrite = false;
  const uniforms: ToonMaterialUniforms = {
    fogCap: { value: clampFogCap(opts.fogCap ?? 1.0) },
    uRimScale: { value: Number.isFinite(opts.rimScale) ? Math.max(0, opts.rimScale as number) : 1 },
  };
  // userData stays JSON-clonable: the uniform objects are read by reference in onBeforeCompile.
  material.userData.fogCap = uniforms.fogCap.value;
  Object.defineProperty(material.userData, 'toon', { value: uniforms, enumerable: false, writable: true, configurable: true });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, TOON_UNIFORMS, uniforms);
    shader.fragmentShader = patchToonFragment(shader.fragmentShader);
  };
  material.customProgramCacheKey = () => TOON_PROGRAM_KEY;
  return material;
}

function clampFogCap(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

/** The material's fog cap (1 for materials that are not toon materials). */
export function toonFogCap(material: THREE.Material): number {
  return toonUniformsOf(material)?.fogCap.value ?? 1;
}

/** Changes a toon material's fog cap (a uniform: no recompile). */
export function setToonFogCap(material: THREE.Material, fogCap: number): void {
  const uniforms = toonUniformsOf(material);
  if (uniforms === undefined) return;
  uniforms.fogCap.value = clampFogCap(fogCap);
  material.userData.fogCap = uniforms.fogCap.value;
}

/** Whether `material` was made by createToonMaterial. */
export function isToonMaterial(material: THREE.Material): material is THREE.MeshToonMaterial {
  return toonUniformsOf(material) !== undefined;
}

/** The options each shared instance is made with; per-rig variants use the same (see sharedMaterialVariant). */
export function sharedMaterialOptions(kind: SharedMaterialKind): ToonMaterialOptions {
  switch (kind) {
    case 'terrain':
      return { rimScale: 0.45 };
    case 'foliage':
      return { rimScale: 0.7 };
    case 'rock':
    case 'crystal':
      return { flatShading: true };
    case 'water':
      return { transparent: true, opacity: 0.85 };
    case 'blight':
      return { rimScale: 1.2 };
    case 'character':
    case 'enemy':
      return { rimScale: 1.3 };
    default:
      return {};
  }
}

const shared = new Map<SharedMaterialKind, THREE.MeshToonMaterial>();

/** One shared instance per kind, so meshes batch by material and no new shader program appears. */
export function sharedMaterial(kind: SharedMaterialKind): THREE.MeshToonMaterial {
  let material = shared.get(kind);
  if (material === undefined) {
    material = createToonMaterial(sharedMaterialOptions(kind));
    material.name = `toon:${kind}`;
    shared.set(kind, material);
  }
  return material;
}

/**
 * A separate instance with a shared kind's options, for a rig or enemy species that needs its own emissive / face
 * values: same program as the shared instance (Req 39.1).
 */
export function sharedMaterialVariant(kind: SharedMaterialKind, overrides: ToonMaterialOptions = {}): THREE.MeshToonMaterial {
  const material = createToonMaterial({ ...sharedMaterialOptions(kind), ...overrides });
  material.name = `toon:${kind}:variant`;
  return material;
}

/** Marks every toon material created so far for recompilation (shadow on / off, Req 38.2). */
export function refreshSharedMaterials(): void {
  for (const material of shared.values()) material.needsUpdate = true;
}

/** `base` at ≈ 35 % brightness (sRGB), the outline tint. */
export function outlineColorFor(base: THREE.ColorRepresentation): THREE.Color {
  const c = new THREE.Color(base);
  const rgb = c.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
  return c.setRGB(rgb.r * 0.35, rgb.g * 0.35, rgb.b * 0.35, THREE.SRGBColorSpace);
}

export interface OutlineMaterialOptions {
  /** Multiply the geometry's vertex colours (then `color` is the 35 % factor); default false. */
  vertexColors?: boolean;
}

/**
 * Inverted-hull outline: back faces only, pushed 0.02–0.05 m along the normal by camera distance, dark tint
 * (≈ 35 % of the base color: pass `outlineColorFor(base)`, or `vertexColors: true` with the default 35 % factor).
 */
export function createOutlineMaterial(
  color?: THREE.ColorRepresentation,
  opts: OutlineMaterialOptions = {},
): THREE.MeshBasicMaterial {
  const vertexColors = opts.vertexColors === true;
  const tint = color ?? (vertexColors ? outlineColorFor(0xffffff) : 0x1a1420);
  const material = new THREE.MeshBasicMaterial({ color: tint, side: THREE.BackSide, vertexColors });
  material.name = 'outline';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, OUTLINE_UNIFORMS);
    shader.vertexShader = patchOutlineVertex(shader.vertexShader);
  };
  material.customProgramCacheKey = () => OUTLINE_PROGRAM_KEY;
  return material;
}
