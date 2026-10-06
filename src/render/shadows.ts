/*
 * Character shadow map (design.md "그림자"; Req 39.9, 38.2): the sun's one directional shadow follows the
 * Active_Character in an 80 m box. The map is 1024 (shadows 'low'), 2048 ('high') or not made at all ('off', the low
 * preset's default, where blob shadows take over, src/render/blobShadows.ts). The shadow camera is snapped to whole
 * texels in light space, so the shadow edges do not crawl while the character moves.
 *
 * Casters stay limited to characters, NPCs, enemies, Caelith and large structures (their meshes set castShadow);
 * terrain, vegetation and props only receive. A size change disposes the map and sets it to null, so three.js
 * allocates the new `mapSize` on the next frame; switching on / off also toggles `renderer.shadowMap.enabled` and
 * recompiles the shared toon materials (the light hash change recompiles every other lit material as well).
 *
 * `CHARACTER_SHADOW` is the page-wide state the blob shadows read (enabled, box centre and half extent).
 */
import * as THREE from 'three';
import type { Vec3 } from '../core/types';
import { refreshSharedMaterials } from './toonMaterial';

export type ShadowQuality = 'off' | 'low' | 'high';

/** Edge of the square shadow box around the Active_Character (m). */
export const SHADOW_BOX_SIZE = 80;
export const SHADOW_HALF_EXTENT = SHADOW_BOX_SIZE / 2;
/** Shadow map size per setting; 0: no map. */
export const SHADOW_MAP_SIZES: Readonly<Record<ShadowQuality, number>> = { off: 0, low: 1024, high: 2048 };
/** The shadow camera sits this far from the box centre toward the sun; its depth range covers twice that. */
export const SHADOW_SUN_DISTANCE = 150;

/** The map size of a shadow setting (unknown settings read as 'low', the default). */
export function shadowMapSizeFor(quality: string): number {
  return (SHADOW_MAP_SIZES as Readonly<Record<string, number | undefined>>)[quality] ?? SHADOW_MAP_SIZES.low;
}

/** World size of one shadow-map texel (m). */
export function shadowTexelSize(mapSize: number, boxSize = SHADOW_BOX_SIZE): number {
  return mapSize > 0 ? boxSize / mapSize : 0;
}

export interface ShadowBasis {
  readonly right: Vec3;
  readonly up: Vec3;
  /** Unit vector from the box centre toward the light. */
  readonly back: Vec3;
}

const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 };

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  return len > 0 ? { x: v.x / len, y: v.y / len, z: v.z / len } : { x: 0, y: 1, z: 0 };
}

const dot = (a: Readonly<Vec3>, b: Readonly<Vec3>): number => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * The shadow camera's axes as `Object3D.lookAt` builds them for a camera at `centre + lightDir` looking at `centre`
 * with +Y up (the DirectionalLightShadow camera): z = lightDir, x = up × z, y = z × x.
 */
export function shadowBasis(lightDir: Readonly<Vec3>): ShadowBasis {
  let back = normalize(lightDir);
  let right = cross(WORLD_UP, back);
  if (Math.hypot(right.x, right.y, right.z) < 1e-9) {
    // Straight up or down: Matrix4.lookAt nudges z the same way.
    back = normalize({ x: back.x, y: back.y, z: back.z + 0.0001 });
    right = cross(WORLD_UP, back);
  }
  right = normalize(right);
  const up = cross(back, right);
  return { right, up, back };
}

/**
 * The box centre for `focus`, moved within the light plane so that its light-space x / y are whole multiples of
 * `texel`: the orthographic frustum then starts on the same texel grid every frame (no edge shimmer while moving).
 * The offset from `focus` is at most half a texel on each light-plane axis and nothing along the light.
 */
export function snapShadowCenter(focus: Readonly<Vec3>, lightDir: Readonly<Vec3>, texel: number): Vec3 {
  if (!(texel > 0)) return { x: focus.x, y: focus.y, z: focus.z };
  const { right, up } = shadowBasis(lightDir);
  const a = dot(focus, right);
  const b = dot(focus, up);
  const da = Math.round(a / texel) * texel - a;
  const db = Math.round(b / texel) * texel - b;
  return {
    x: focus.x + right.x * da + up.x * db,
    y: focus.y + right.y * da + up.y * db,
    z: focus.z + right.z * da + up.z * db,
  };
}

/** Page-wide shadow state (read by the blob shadows each frame). */
export interface CharacterShadowState {
  enabled: boolean;
  readonly center: Vec3;
  readonly halfExtent: number;
}

export const CHARACTER_SHADOW: CharacterShadowState = { enabled: true, center: { x: 0, y: 0, z: 0 }, halfExtent: SHADOW_HALF_EXTENT };

/**
 * Whether `pos` gets a real shadow: shadows are on and it lies well inside the box. The box footprint on the ground
 * is at least the box's cross-section, so a circle `margin` m inside the half extent is always covered.
 */
export function insideShadowBox(pos: Readonly<Vec3>, state: Readonly<CharacterShadowState> = CHARACTER_SHADOW, margin = 4): boolean {
  if (!state.enabled) return false;
  const r = state.halfExtent - margin;
  const dx = pos.x - state.center.x;
  const dz = pos.z - state.center.z;
  return dx * dx + dz * dz <= r * r;
}

/** The sun's shadow configured and moved for the Active_Character. */
export class CharacterShadow {
  private quality: ShadowQuality | null = null;
  private readonly lightDir = new THREE.Vector3();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly sun: THREE.DirectionalLight,
    private readonly state: CharacterShadowState = CHARACTER_SHADOW,
  ) {
    const box = sun.shadow.camera;
    box.left = -SHADOW_HALF_EXTENT;
    box.right = SHADOW_HALF_EXTENT;
    box.top = SHADOW_HALF_EXTENT;
    box.bottom = -SHADOW_HALF_EXTENT;
    box.near = 1;
    box.far = SHADOW_SUN_DISTANCE * 2;
    box.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
  }

  get current(): ShadowQuality | null {
    return this.quality;
  }

  /**
   * Applies a shadow setting: a new size frees the old map (three.js allocates `mapSize` on the next frame); on / off
   * toggles the renderer's shadow pass and recompiles the shared materials. Returns what was rebuilt.
   */
  setQuality(quality: ShadowQuality): { reallocated: boolean; toggled: boolean } {
    const prev = this.quality;
    if (prev === quality) return { reallocated: false, toggled: false };
    this.quality = quality;
    const size = SHADOW_MAP_SIZES[quality];
    const on = size > 0;
    const wasOn = prev === null ? this.renderer.shadowMap.enabled && this.sun.castShadow : SHADOW_MAP_SIZES[prev] > 0;
    const shadow = this.sun.shadow;
    const reallocated = on && shadow.mapSize.x !== size;
    if (!on || reallocated) this.freeMap();
    if (on) {
      shadow.mapSize.set(size, size);
      // About half a texel of normal offset against acne on the toon terrain.
      shadow.normalBias = shadowTexelSize(size) * 0.6;
    }
    this.renderer.shadowMap.enabled = on;
    this.sun.castShadow = on;
    this.state.enabled = on;
    const toggled = on !== wasOn;
    if (toggled) refreshSharedMaterials();
    return { reallocated, toggled };
  }

  /** Centres the texel-snapped box on `focus` with the sun along `sunDir` (after the world scene placed the sun). */
  follow(focus: Readonly<Vec3>, sunDir: Readonly<Vec3>): void {
    const size = this.sun.shadow.mapSize.x;
    const center = snapShadowCenter(focus, sunDir, shadowTexelSize(size));
    this.lightDir.set(sunDir.x, sunDir.y, sunDir.z);
    if (this.lightDir.lengthSq() < 1e-12) this.lightDir.set(0, 1, 0);
    this.lightDir.normalize();
    this.sun.target.position.set(center.x, center.y, center.z);
    this.sun.position.set(center.x, center.y, center.z).addScaledVector(this.lightDir, SHADOW_SUN_DISTANCE);
    const c = this.state.center;
    c.x = center.x;
    c.y = center.y;
    c.z = center.z;
  }

  /** Context restore: the map is recreated on the next frame. */
  resetMap(): void {
    this.freeMap();
  }

  dispose(): void {
    this.freeMap();
  }

  private freeMap(): void {
    const shadow = this.sun.shadow;
    if (shadow.map !== null) {
      shadow.map.dispose();
      shadow.map = null;
    }
  }
}
