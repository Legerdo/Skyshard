/*
 * Interior lighting (design.md "대기 효과·환경 생물", "구조물과 실내 공간"; Req 9.7): while the Active_Character is inside
 * an InteriorVolume (the Challenge_Area volumes Hollowroot Shrine, Cinderspire and the Observatory, and the Astral
 * Sanctum's connecting hall) the fog, the ambient (hemisphere) light and the exposure blend to the interior look over
 * 1 s, and back to the outdoor values over the same time on leaving.
 *
 * The session names the volume it stands in (`interiorLookFor`); the page's render pipeline advances the blend and
 * applies it after the world scene has written the time-of-day values, so the two never fight over the fog.
 */
import * as THREE from 'three';
import type { Vec3 } from '../core/types';
import type { ChallengeAreaDef } from '../data/challengeAreas';
import { SANCTUM } from '../data/sanctum';

/** Blend time into and out of an interior (s). */
export const INTERIOR_BLEND_SECONDS = 1;

/** An interior preset. Colours are linear. */
export interface InteriorLook {
  readonly id: string;
  readonly fogColor: THREE.Color;
  readonly fogNear: number;
  readonly fogFar: number;
  /** Hemisphere (ambient) intensity × this. */
  readonly ambient: number;
  /** renderer.toneMappingExposure. */
  readonly exposure: number;
}

/** Ambient and exposure per volume (the fog comes from the Challenge_Area's lighting data). */
const VOLUME_LIGHT: Readonly<Record<string, { ambient: number; exposure: number }>> = {
  hollowroot: { ambient: 0.55, exposure: 1.15 },
  cinderspire: { ambient: 0.9, exposure: 1.02 },
  observatory: { ambient: 0.78, exposure: 1.08 },
};

/** The Sanctum hall: a starlit indigo room (feet on its floor box). */
const SANCTUM_HALL_LOOK: InteriorLook = {
  id: 'sanctum_hall', fogColor: new THREE.Color(0x2c3266), fogNear: 30, fogFar: 260, ambient: 0.85, exposure: 1.05,
};
const HALL = SANCTUM.hall;
/** Feet up to this far above the hall floor count as inside it (m). */
const HALL_HEADROOM = 4;

const areaLooks = new Map<string, InteriorLook>();

/** The interior look of a Challenge_Area (made once per area). */
export function areaInteriorLook(area: Pick<ChallengeAreaDef, 'id' | 'lighting'>): InteriorLook {
  let look = areaLooks.get(area.id);
  if (look === undefined) {
    const light = VOLUME_LIGHT[area.id] ?? { ambient: 0.8, exposure: 1.05 };
    look = {
      id: area.id, fogColor: new THREE.Color(area.lighting.fogColor), fogNear: area.lighting.fogNear, fogFar: area.lighting.fogFar, ...light,
    };
    areaLooks.set(area.id, look);
  }
  return look;
}

/** Whether feet at `pos` stand in the Sanctum's connecting hall. */
export function inSanctumHall(pos: Readonly<Vec3>): boolean {
  return pos.x >= HALL.min.x && pos.x <= HALL.max.x && pos.z >= HALL.min.z && pos.z <= HALL.max.z
    && pos.y >= HALL.min.y && pos.y <= HALL.max.y + HALL_HEADROOM;
}

/** The InteriorVolume look at the Active_Character: the Challenge_Area it is in, else the Sanctum hall, else none. */
export function interiorLookFor(area: Pick<ChallengeAreaDef, 'id' | 'lighting'> | null, feet: Readonly<Vec3>): InteriorLook | null {
  if (area !== null) return areaInteriorLook(area);
  return inSanctumHall(feet) ? SANCTUM_HALL_LOOK : null;
}

/**
 * The 0..1 interior weight: moves linearly toward 1 inside and 0 outside at 1 / INTERIOR_BLEND_SECONDS per second;
 * `eased` is its smoothstep. The last look entered is kept while fading out.
 */
export class InteriorBlend {
  weight = 0;
  look: InteriorLook | null = null;

  update(dt: number, target: InteriorLook | null): number {
    const step = Number.isFinite(dt) && dt > 0 ? dt / INTERIOR_BLEND_SECONDS : 0;
    if (target !== null) {
      if (this.look !== null && this.look !== target && this.weight > 0) {
        // Another volume straight away: fade from the current mix (rare; the volumes do not touch).
        this.weight = Math.max(0, this.weight - step);
        if (this.weight === 0) this.look = target;
      } else {
        this.look = target;
        this.weight = Math.min(1, this.weight + step);
      }
    } else {
      this.weight = Math.max(0, this.weight - step);
      if (this.weight === 0) this.look = null;
    }
    return this.eased;
  }

  get eased(): number {
    const t = this.weight;
    return t * t * (3 - 2 * t);
  }
}

/** What the blend writes: the world scene's fog, background, dome haze and hemisphere, and the exposure. */
export interface InteriorTargets {
  readonly fog: THREE.Fog;
  readonly background: THREE.Color;
  readonly haze: THREE.Color;
  readonly hemi: THREE.HemisphereLight;
  readonly renderer: { toneMappingExposure: number };
}

/** Applies `look` at weight `t` over the outdoor values the world scene wrote this frame. */
export function applyInterior(targets: InteriorTargets, look: InteriorLook | null, t: number): void {
  if (look === null || !(t > 0)) {
    targets.renderer.toneMappingExposure = 1;
    return;
  }
  const { fog } = targets;
  fog.color.lerp(look.fogColor, t);
  fog.near += (look.fogNear - fog.near) * t;
  fog.far += (look.fogFar - fog.far) * t;
  targets.background.lerp(look.fogColor, t);
  targets.haze.lerp(look.fogColor, t);
  targets.hemi.intensity *= 1 + (look.ambient - 1) * t;
  targets.renderer.toneMappingExposure = 1 + (look.exposure - 1) * t;
}
