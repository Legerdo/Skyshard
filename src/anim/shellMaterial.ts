/*
 * The Element shell (design.md "적·Elite·NPC 구성" Element_Shield, "Caelith 구성" Starshell; Req 6.4, 25.10): one
 * shader for every Element_Shield (Slagshell, Aether Sentinel, Sentinel Prime) and Caelith's Starshell, sized to its
 * owner. A translucent icosphere (detail 3) in the current Element's colour with a fresnel rim and the Element's icon
 * repeated six times round the equator (colour and shape, never colour alone, Req 35.7). A new Element crossfades
 * colour and icon over 0.3 s; a break shatters the shell (its cells fall out as it swells, 0.45 s) while the VFX pool
 * throws the shards. One draw call per shell; every shell shares one program (SHELL_PROGRAM_KEY).
 */
import * as THREE from 'three';
import { ELEMENT_DEFS, type ElementIconShape } from '../data/elements';
import type { ElementId } from '../data/ids';
import type { V3 } from './rigTypes';

export const SHELL_PROGRAM_KEY = 'skyshard-element-shell-v1';
/** Colour / icon crossfade when the Element changes (Req 6.4: 0.3 s). */
export const SHELL_CROSSFADE_SECONDS = 0.3;
/** The shatter after a break. */
export const SHELL_SHATTER_SECONDS = 0.45;
/** Icon index in the shader per Element icon silhouette. */
export const SHELL_ICON_INDEX: Readonly<Record<ElementIconShape, number>> = { triFlame: 0, ringWaves: 1, spiral: 2, hexCrystal: 3 };

export const SHELL_VERTEX = /* glsl */ `
uniform float uBreak;
varying vec3 vShellObjN;
varying vec3 vShellViewN;
varying vec3 vShellViewDir;
void main() {
	vShellObjN = normalize( position );
	vec3 p = position * ( 1.0 + 0.25 * uBreak );
	vec4 mv = modelViewMatrix * vec4( p, 1.0 );
	vShellViewN = normalize( normalMatrix * normal );
	vShellViewDir = -mv.xyz;
	gl_Position = projectionMatrix * mv;
}`;

export const SHELL_FRAGMENT = /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uMix;
uniform float uIconA;
uniform float uIconB;
uniform float uIcons;
uniform float uOpacity;
uniform float uTime;
uniform float uBreak;
varying vec3 vShellObjN;
varying vec3 vShellViewN;
varying vec3 vShellViewDir;
float shellHash( vec3 p ) {
	p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
	p += dot( p, p.yxz + 33.33 );
	return fract( ( p.x + p.y ) * p.z );
}
float band( float d, float w ) { return 1.0 - smoothstep( w * 0.6, w, abs( d ) ); }
// Element icons in p ∈ [-1, 1]²: three-pronged flame, overlapping wave rings, spiral, hexagonal crystal.
float shellIcon( float id, vec2 p ) {
	if ( max( abs( p.x ), abs( p.y ) ) > 1.0 ) return 0.0;
	if ( id < 0.5 ) {
		float m = 0.0;
		for ( int i = 0; i < 3; i++ ) {
			float c = ( float( i ) - 1.0 ) * 0.38;
			float h = i == 1 ? 1.55 : 1.05;
			float y = p.y + 0.7;
			float w = 0.2 * ( 1.0 - y / h ) + 0.02;
			m = max( m, step( 0.0, y ) * step( y, h ) * ( 1.0 - smoothstep( w * 0.8, w, abs( p.x - c ) ) ) );
		}
		return m;
	}
	float r = length( p );
	if ( id < 1.5 ) return max( band( r - 0.42, 0.12 ), band( r - 0.8, 0.1 ) );
	if ( id < 2.5 ) {
		float k = ( atan( p.y, p.x ) + 3.14159265 ) / 6.2831853;
		float n = floor( ( r - 0.12 ) / 0.3 - k + 0.5 );
		return r < 0.95 ? band( r - ( 0.12 + 0.3 * ( k + n ) ), 0.09 ) : 0.0;
	}
	vec2 q = abs( p );
	float hx = max( q.x * 0.866 + q.y * 0.5, q.y );
	return max( band( hx - 0.72, 0.1 ), band( p.x, 0.06 ) * step( hx, 0.72 ) );
}
void main() {
	vec3 n = normalize( vShellObjN );
	if ( uBreak > 0.0 && shellHash( floor( n * 6.0 ) + 3.1 ) < uBreak ) discard;
	vec3 col = mix( uColorA, uColorB, uMix );
	float facing = abs( dot( normalize( vShellViewN ), normalize( vShellViewDir ) ) );
	float rim = pow( 1.0 - facing, 2.4 );
	float shimmer = 0.9 + 0.1 * sin( uTime * 2.3 + n.y * 9.0 );
	float alpha = uOpacity * ( 0.16 + 0.7 * rim ) * shimmer;
	if ( uIcons > 0.5 ) {
		float az = atan( n.x, n.z );
		float el = asin( clamp( n.y, -1.0, 1.0 ) );
		float seg = 6.2831853 / 6.0;
		float local = mod( az + seg * 0.5, seg ) - seg * 0.5;
		vec2 p = vec2( local, el ) / 0.3;
		float icon = mix( shellIcon( uIconA, p ), shellIcon( uIconB, p ), uMix );
		col = mix( col, vec3( 1.0 ), icon * 0.55 );
		alpha = max( alpha, icon * 0.8 * uOpacity );
	}
	col += vec3( uBreak * 0.8 );
	alpha *= gl_FrontFacing ? 1.0 : 0.45;
	gl_FragColor = vec4( col * ( 1.0 + rim * 0.8 ), alpha );
}`;

export interface ShellUniforms {
  uColorA: { value: THREE.Color };
  uColorB: { value: THREE.Color };
  uMix: { value: number };
  uIconA: { value: number };
  uIconB: { value: number };
  uIcons: { value: number };
  uOpacity: { value: number };
  uTime: { value: number };
  uBreak: { value: number };
}

/** A shell material (own uniforms, shared program). */
export function createShellMaterial(icons = true): THREE.ShaderMaterial {
  const uniforms: ShellUniforms = {
    uColorA: { value: new THREE.Color(0xffffff) },
    uColorB: { value: new THREE.Color(0xffffff) },
    uMix: { value: 1 },
    uIconA: { value: 0 },
    uIconB: { value: 0 },
    uIcons: { value: icons ? 1 : 0 },
    uOpacity: { value: 1 },
    uTime: { value: 0 },
    uBreak: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    name: 'shell:element',
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: SHELL_VERTEX,
    fragmentShader: SHELL_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  material.customProgramCacheKey = () => SHELL_PROGRAM_KEY;
  return material;
}

let sharedSphere: THREE.IcosahedronGeometry | null = null;

/** The unit icosphere every shell scales (IcosahedronGeometry detail 3), shared and never disposed. */
export function shellGeometry(): THREE.IcosahedronGeometry {
  if (sharedSphere === null) {
    sharedSphere = new THREE.IcosahedronGeometry(1, 3);
    sharedSphere.name = 'shell:icosphere';
  }
  return sharedSphere;
}

export interface ElementShellOptions {
  /** Radius (m), or radii per axis for an ellipsoid shell round a squat body. */
  readonly radius: number | V3;
  /** Centre in the owner's space (m). */
  readonly center: V3;
  /** Icons round the equator (default true). */
  readonly icons?: boolean;
  /** Opacity at full durability (default 1; it thins toward half as the shield wears). */
  readonly opacity?: number;
}

/** One shell: show it in an Element, crossfade on change, thin with durability, shatter on a break. */
export class ElementShell {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly u: ShellUniforms;
  private element: ElementId | null = null;
  private shown = false;
  private shatterLeft = 0;
  private readonly baseOpacity: number;

  constructor(opts: ElementShellOptions) {
    this.material = createShellMaterial(opts.icons ?? true);
    this.u = this.material.uniforms as unknown as ShellUniforms;
    this.mesh = new THREE.Mesh(shellGeometry(), this.material);
    this.mesh.name = 'shell';
    const r = opts.radius;
    if (typeof r === 'number') this.mesh.scale.setScalar(r);
    else this.mesh.scale.set(r[0], r[1], r[2]);
    this.mesh.position.set(opts.center[0], opts.center[1], opts.center[2]);
    this.mesh.renderOrder = 2; // after opaque bodies and the aura
    this.mesh.castShadow = false;
    this.mesh.visible = false;
    this.baseOpacity = opts.opacity ?? 1;
  }

  /** The Element shown (or crossfading toward), null while hidden. */
  get current(): ElementId | null {
    return this.shown ? this.element : null;
  }

  /** 0 → 1 over the 0.3 s after an Element change. */
  get crossfade(): number {
    return this.u.uMix.value;
  }

  get shattering(): boolean {
    return this.shatterLeft > 0;
  }

  /** Shows the shell in `element` at `strength` (durability / max, 0–1); a change of Element crossfades. */
  show(element: ElementId, strength = 1): void {
    const def = ELEMENT_DEFS[element];
    if (!this.shown || this.element === null) {
      // Appearing (spawn, regrowth): straight in the Element, no crossfade.
      this.u.uColorA.value.setHex(def.color);
      this.u.uColorB.value.setHex(def.color);
      this.u.uIconA.value = SHELL_ICON_INDEX[def.icon];
      this.u.uIconB.value = SHELL_ICON_INDEX[def.icon];
      this.u.uMix.value = 1;
    } else if (element !== this.element) {
      // From what is on screen now (mid-fade included) to the new Element.
      this.u.uColorA.value.lerp(this.u.uColorB.value, this.u.uMix.value);
      this.u.uIconA.value = this.u.uMix.value >= 0.5 ? this.u.uIconB.value : this.u.uIconA.value;
      this.u.uColorB.value.setHex(def.color);
      this.u.uIconB.value = SHELL_ICON_INDEX[def.icon];
      this.u.uMix.value = 0;
    }
    this.element = element;
    this.shown = true;
    this.shatterLeft = 0;
    this.u.uBreak.value = 0;
    const s = Math.min(1, Math.max(0, Number.isFinite(strength) ? strength : 1));
    this.u.uOpacity.value = this.baseOpacity * (0.5 + 0.5 * s);
    this.mesh.visible = true;
  }

  /** Gone without a break (suppressed, the owner died, the fight ended). */
  hide(): void {
    this.shown = false;
    if (this.shatterLeft <= 0) this.mesh.visible = false;
  }

  /** Broken: the cells fall out as the shell swells (the VFX pool throws the shards). */
  shatter(): void {
    this.shown = false;
    this.shatterLeft = SHELL_SHATTER_SECONDS;
    this.u.uBreak.value = 0;
    this.mesh.visible = true;
  }

  /** Advances the crossfade, the shatter and the shimmer (`dt` s). */
  update(dt: number): void {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.u.uTime.value += step;
    if (this.u.uMix.value < 1) this.u.uMix.value = Math.min(1, this.u.uMix.value + step / SHELL_CROSSFADE_SECONDS);
    if (this.shatterLeft > 0) {
      this.shatterLeft = Math.max(0, this.shatterLeft - step);
      this.u.uBreak.value = 1 - this.shatterLeft / SHELL_SHATTER_SECONDS;
      if (this.shatterLeft <= 0) {
        this.u.uBreak.value = 0;
        this.mesh.visible = this.shown;
      }
    }
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.material.dispose();
  }
}
