/*
 * Materials of external models (design.md "toon 재질", "원본 재질", "효과 공통 경로"; Req 43.6, 40.5).
 *
 * - `toon`: every mesh material becomes the shared toon material (createToonMaterial: 3-step ramp, rim, fog cap) that
 *   keeps the original base colour map, colour, alpha and side.
 * - `original`: the file's materials stay (VRM's default: MToon).
 * - Either way each instance gets its own material copies patched through `onBeforeCompile` with one set of effect
 *   uniforms: hit flash (additive colour), opacity (camera near-fade, multiplies the output alpha) and the death
 *   dissolve (noise over the model-root-frame position, or rising from the feet, with a glowing edge) — the same
 *   looks as the procedural rig material. The patch appends to the end of `main()`, so it fits built-in materials and
 *   ShaderMaterials such as MToon alike; the program cache key gets a suffix so patched and plain programs never mix.
 * - `outline: true`: an inverted-hull outline SkinnedMesh sharing each mesh's geometry and Skeleton (render/outline),
 *   hidden while the body is see-through or dissolving (like the procedural rigs).
 */
import * as THREE from 'three';
import { createOutlineMaterial, createToonMaterial } from '../render/toonMaterial';

export const EXTERNAL_FX_PROGRAM_KEY = 'skyshard-external-fx-v1';

/** Per-instance effect uniforms, shared by all of the instance's materials. */
export interface ExternalFxUniforms {
  uFxFlash: { value: number };
  uFxFlashColor: { value: THREE.Color };
  uFxOpacity: { value: number };
  uFxDissolve: { value: number };
  uFxDissolveRise: { value: number };
  uFxDissolveColor: { value: THREE.Color };
  /** Model height (m): scales the dissolve noise and normalises the rising dissolve. */
  uFxHeight: { value: number };
  /** World → model root frame (feet at the origin), updated every frame by the instance. */
  uFxRootInverse: { value: THREE.Matrix4 };
}

export function createFxUniforms(height: number): ExternalFxUniforms {
  return {
    uFxFlash: { value: 0 },
    uFxFlashColor: { value: new THREE.Color(0xffffff) },
    uFxOpacity: { value: 1 },
    uFxDissolve: { value: 0 },
    uFxDissolveRise: { value: 0 },
    uFxDissolveColor: { value: new THREE.Color(0xcfe8ff) },
    uFxHeight: { value: Number.isFinite(height) && height > 0 ? height : 1.8 },
    uFxRootInverse: { value: new THREE.Matrix4() },
  };
}

const FX_VERTEX_PARS = /* glsl */ `uniform mat4 uFxRootInverse;
varying vec3 vFxPos;
`;

const FX_VERTEX_POS = /* glsl */ `
	vFxPos = ( uFxRootInverse * modelMatrix * vec4( transformed, 1.0 ) ).xyz;`;

const fxFragmentPars = (hasPos: boolean): string => /* glsl */ `uniform float uFxFlash;
uniform vec3 uFxFlashColor;
uniform float uFxOpacity;
uniform float uFxDissolve;
uniform float uFxDissolveRise;
uniform vec3 uFxDissolveColor;
uniform float uFxHeight;
${hasPos ? 'varying vec3 vFxPos;' : ''}
float fxHash( vec3 p ) {
	p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
	p += dot( p, p.yxz + 33.33 );
	return fract( ( p.x + p.y ) * p.z );
}
float fxNoise( vec3 p ) {
	vec3 i = floor( p );
	vec3 f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	float a = mix( mix( fxHash( i ), fxHash( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ), mix( fxHash( i + vec3( 0.0, 1.0, 0.0 ) ), fxHash( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y );
	float b = mix( mix( fxHash( i + vec3( 0.0, 0.0, 1.0 ) ), fxHash( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ), mix( fxHash( i + vec3( 0.0, 1.0, 1.0 ) ), fxHash( i + vec3( 1.0 ) ), f.x ), f.y );
	return mix( a, b, f.z );
}
`;

const fxFragmentEnd = (hasPos: boolean): string => /* glsl */ `
	{
		${hasPos ? 'vec3 fxP = vFxPos;' : 'vec3 fxP = vec3( gl_FragCoord.xy * 0.02, 0.0 );'}
		float fxEdge = 0.0;
		if ( uFxDissolve > 0.0 ) {
			float fxH = max( uFxHeight, 0.5 );
			float fxN = fxNoise( fxP * ( 6.0 / fxH ) + 1.7 ) * 0.7 + fxNoise( fxP * ( 17.0 / fxH ) ) * 0.3;
			float fxRise = clamp( fxP.y / fxH, 0.0, 1.0 );
			float fxT = mix( fxN, fxRise * 0.85 + fxN * 0.15, uFxDissolveRise ) * 0.92 + 0.08;
			if ( fxT < uFxDissolve ) discard;
			fxEdge = 1.0 - smoothstep( 0.0, 0.08, fxT - uFxDissolve );
		}
		gl_FragColor.rgb += uFxFlashColor * uFxFlash + uFxDissolveColor * ( fxEdge * 2.5 );
		gl_FragColor.a *= uFxOpacity;
	}
`;

/** Vertex patch: the model-root-frame position varying after skinning (null hook → unchanged, no varying). */
export function patchFxVertex(vertex: string): { shader: string; hasPos: boolean } {
  for (const hook of ['#include <skinning_vertex>', '#include <begin_vertex>']) {
    const at = vertex.indexOf(hook);
    if (at < 0) continue;
    const end = at + hook.length;
    return { shader: FX_VERTEX_PARS + vertex.slice(0, end) + FX_VERTEX_POS + vertex.slice(end), hasPos: true };
  }
  return { shader: vertex, hasPos: false };
}

/** Fragment patch: flash, opacity and dissolve appended to the end of main(). */
export function patchFxFragment(fragment: string, hasPos: boolean): string {
  const end = fragment.lastIndexOf('}');
  if (end < 0) throw new Error('externalMaterials: fragment shader without a main() body');
  return fxFragmentPars(hasPos) + fragment.slice(0, end) + fxFragmentEnd(hasPos) + fragment.slice(end);
}

const fxOf = new WeakMap<THREE.Material, ExternalFxUniforms>();

/** The effect uniforms a material was patched with. */
export function fxUniformsOf(material: THREE.Material): ExternalFxUniforms | undefined {
  return fxOf.get(material);
}

/** Patches `material` (once) with the instance's effect uniforms. */
export function applyFx(material: THREE.Material, uniforms: ExternalFxUniforms): void {
  if (fxOf.has(material)) return;
  fxOf.set(material, uniforms);
  const previous = material.onBeforeCompile;
  const baseKeyOf = material.customProgramCacheKey;
  const plain = previous.toString();
  // The default key is the onBeforeCompile source: keep the original one (ours is the same for every material).
  const baseKey = (): string => (baseKeyOf === THREE.Material.prototype.customProgramCacheKey ? plain : baseKeyOf.call(material));
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    const v = patchFxVertex(shader.vertexShader);
    shader.vertexShader = v.shader;
    shader.fragmentShader = patchFxFragment(shader.fragmentShader, v.hasPos);
  };
  material.customProgramCacheKey = () => `${baseKey()}|${EXTERNAL_FX_PROGRAM_KEY}`;
  material.needsUpdate = true;
}

type Textured = THREE.Material & {
  map?: THREE.Texture | null;
  color?: THREE.Color;
  alphaMap?: THREE.Texture | null;
  emissive?: THREE.Color;
  emissiveMap?: THREE.Texture | null;
  vertexColors?: boolean;
};

/** The shared toon material that keeps `source`'s base colour map and colour (`geometry` decides vertex colours). */
export function toToonMaterial(source: THREE.Material, geometry: THREE.BufferGeometry): THREE.MeshToonMaterial {
  const s = source as Textured;
  const toon = createToonMaterial({
    color: s.color instanceof THREE.Color ? s.color : 0xffffff,
    vertexColors: s.vertexColors === true && geometry.getAttribute('color') !== undefined,
    transparent: source.transparent,
    opacity: source.opacity,
    side: source.side,
    rimScale: 1.3,
  });
  toon.name = `toon:external:${source.name}`;
  if (s.map instanceof THREE.Texture) toon.map = s.map;
  if (s.alphaMap instanceof THREE.Texture) toon.alphaMap = s.alphaMap;
  if (s.emissiveMap instanceof THREE.Texture) {
    toon.emissiveMap = s.emissiveMap;
    if (s.emissive instanceof THREE.Color) toon.emissive.copy(s.emissive);
  }
  toon.alphaTest = source.alphaTest;
  return toon;
}

/** A per-instance copy of a material (the original on failure: e.g. a ShaderMaterial that cannot be cloned). */
export function cloneMaterial(material: THREE.Material): THREE.Material {
  try {
    const copy = material.clone();
    return copy instanceof THREE.Material ? copy : material;
  } catch {
    return material;
  }
}

let outlineShared: THREE.MeshBasicMaterial | null = null;

/** The dark outline of external models (one shared instance, one program with every outline). */
export function externalOutlineMaterial(): THREE.MeshBasicMaterial {
  if (outlineShared === null) {
    outlineShared = createOutlineMaterial();
    outlineShared.name = 'outline:external';
  }
  return outlineShared;
}
