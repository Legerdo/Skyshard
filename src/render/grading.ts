/*
 * Region colour grading blend (design.md "Region 팔레트와 color grading"; Req 39.2). The player's position gives one
 * weight per Region (40 m smoothstep bands, normalised to sum 1); the Regions' grading values (src/data/palettes.ts)
 * are blended by those weights in linear colour:
 * - the rim colour goes to every shared toon material (`TOON_UNIFORMS.uRimColor`),
 * - the fog tint multiplies the time-of-day fog colour (scene.fog and the sky dome's haze share the result),
 * - saturation, contrast and the Region tint go to `GRADING_UNIFORMS` for the GradingPass of the post-processing
 *   task; while no GradingPass runs (post-processing off or not built yet) the toon materials' `uGradeTint` /
 *   `uGradeSaturation` apply tint and saturation instead.
 */
import * as THREE from 'three';
import { REGION_IDS, type RegionId } from '../data/ids';
import { REGION_PALETTES } from '../data/palettes';
import { REGIONS } from '../data/worldLayout';
import { regionWeightsAt, REGION_BLEND_WIDTH } from '../world/terrain';
import { TOON_UNIFORMS } from './toonMaterial';

export type RegionWeights = Record<RegionId, number>;

/** How strongly the Region tint colours the frame (the fog uses the full tint). */
export const GRADE_TINT_STRENGTH = 0.35;

/** Uniforms for the GradingPass (task 18.6): the blended Region tint, saturation and contrast. */
export const GRADING_UNIFORMS = {
  uGradeTint: { value: new THREE.Color(1, 1, 1) },
  uGradeSaturation: { value: 1.0 },
  uGradeContrast: { value: 1.0 },
};

const SANCTUM = REGIONS.sanctum;
const SANCTUM_RADIUS = SANCTUM.bounds.kind === 'circle' ? SANCTUM.bounds.radius : 55;
const SANCTUM_CENTER = SANCTUM.bounds.kind === 'circle' ? SANCTUM.bounds.center : { x: 0, z: 0 };
const SANCTUM_MIN_Y = SANCTUM.altitude?.minY ?? 170;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Region weights at a position, summing to 1. The ground Regions use the terrain's masks (40 m smoothstep bands at
 * the borders, the crater circle); the floating Sanctum takes over within its circle from 40 m below its floor band,
 * fading out over 40 m outside its radius, so the whole island and arena read as the Sanctum.
 */
export function regionWeights(pos: { readonly x: number; readonly y: number; readonly z: number }): RegionWeights {
  const x = Number.isFinite(pos.x) ? pos.x : 0;
  const z = Number.isFinite(pos.z) ? pos.z : 0;
  const y = Number.isFinite(pos.y) ? pos.y : 0;
  const ground = regionWeightsAt(x, z);
  const r = Math.hypot(x - SANCTUM_CENTER.x, z - SANCTUM_CENTER.z);
  const sanctum = (1 - smoothstep(SANCTUM_RADIUS, SANCTUM_RADIUS + REGION_BLEND_WIDTH, r))
    * smoothstep(SANCTUM_MIN_Y - REGION_BLEND_WIDTH, SANCTUM_MIN_Y, y);
  const rest = 1 - sanctum;
  const w: RegionWeights = {
    verdant: ground.verdant * rest,
    ember: ground.ember * rest,
    azure: ground.azure * rest,
    crater: ground.crater * rest,
    sanctum,
  };
  // Normalise against rounding (and any mask that does not sum to exactly 1).
  let sum = 0;
  for (const id of REGION_IDS) sum += w[id];
  if (!(sum > 0)) return { verdant: 0, ember: 0, azure: 0, crater: 1, sanctum: 0 };
  for (const id of REGION_IDS) w[id] /= sum;
  return w;
}

/** The grading values blended by `weights` (colours linear). */
export interface GradingBlend {
  readonly fogTint: THREE.Color;
  readonly rimColor: THREE.Color;
  saturation: number;
  contrast: number;
}

/** Linear-space copies of the Region grading colours, made once. */
const LINEAR = Object.fromEntries(
  REGION_IDS.map((id) => {
    const g = REGION_PALETTES[id].grading;
    return [id, { fogTint: new THREE.Color(g.fogTint), rimColor: new THREE.Color(g.rimColor), saturation: g.saturation, contrast: g.contrast }];
  }),
) as Record<RegionId, { fogTint: THREE.Color; rimColor: THREE.Color; saturation: number; contrast: number }>;

/** Blends the Region grading values into `out` (allocation-free per frame when `out` is reused). */
export function blendGrading(weights: Readonly<RegionWeights>, out?: GradingBlend): GradingBlend {
  const result = out ?? { fogTint: new THREE.Color(), rimColor: new THREE.Color(), saturation: 0, contrast: 0 };
  result.fogTint.setRGB(0, 0, 0);
  result.rimColor.setRGB(0, 0, 0);
  result.saturation = 0;
  result.contrast = 0;
  for (const id of REGION_IDS) {
    const w = weights[id];
    if (!(w > 0)) continue;
    const g = LINEAR[id];
    result.fogTint.r += g.fogTint.r * w;
    result.fogTint.g += g.fogTint.g * w;
    result.fogTint.b += g.fogTint.b * w;
    result.rimColor.r += g.rimColor.r * w;
    result.rimColor.g += g.rimColor.g * w;
    result.rimColor.b += g.rimColor.b * w;
    result.saturation += g.saturation * w;
    result.contrast += g.contrast * w;
  }
  return result;
}

/**
 * Per-frame grading state: `update(pos)` blends the Regions at the player and pushes the rim colour and the grading
 * uniforms. `gradingPassActive` is set by the post-processing composer while its GradingPass runs; the toon fallback
 * then goes neutral so the grade is not applied twice.
 */
export class RegionGrading {
  readonly blend: GradingBlend = { fogTint: new THREE.Color(1, 1, 1), rimColor: new THREE.Color(1, 1, 1), saturation: 1, contrast: 1 };
  weights: RegionWeights = { verdant: 1, ember: 0, azure: 0, crater: 0, sanctum: 0 };
  gradingPassActive = false;
  private readonly tint = new THREE.Color();

  update(pos: { readonly x: number; readonly y: number; readonly z: number }): void {
    this.weights = regionWeights(pos);
    blendGrading(this.weights, this.blend);
    TOON_UNIFORMS.uRimColor.value.copy(this.blend.rimColor);
    this.tint.setRGB(1, 1, 1).lerp(this.blend.fogTint, GRADE_TINT_STRENGTH);
    GRADING_UNIFORMS.uGradeTint.value.copy(this.tint);
    GRADING_UNIFORMS.uGradeSaturation.value = this.blend.saturation;
    GRADING_UNIFORMS.uGradeContrast.value = this.blend.contrast;
    if (this.gradingPassActive) {
      TOON_UNIFORMS.uGradeTint.value.setRGB(1, 1, 1);
      TOON_UNIFORMS.uGradeSaturation.value = 1;
    } else {
      TOON_UNIFORMS.uGradeTint.value.copy(this.tint);
      TOON_UNIFORMS.uGradeSaturation.value = this.blend.saturation;
    }
  }

  /** The Region with the largest weight now. */
  get dominant(): RegionId {
    let best: RegionId = 'verdant';
    for (const id of REGION_IDS) if (this.weights[id] > this.weights[best]) best = id;
    return best;
  }
}
