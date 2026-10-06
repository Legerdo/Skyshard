/*
 * Render quality presets (design.md "품질 프리셋", "Landmark 가시성"; Req 38.1, 9.2). What each of the three quality
 * steps sets for the Render_System, and the values no step may change: the camera far plane, the Landmark LOD
 * distance and the Landmark fog cap stay the same in every preset, so a Landmark reads from anywhere at any quality.
 *
 * The four player-overridable fields (render scale, shadows, vegetation, post-processing) live in Settings
 * (src/settings/settings.ts, QUALITY_PRESETS); this table holds the rest. Pure data: no three.js or DOM.
 */

/** Same union as Settings' `QualityPreset` (kept local so the data layer depends on nothing above it). */
export type RenderQualityPreset = 'low' | 'medium' | 'high';

export const RENDER_QUALITY_PRESETS: readonly RenderQualityPreset[] = ['low', 'medium', 'high'];

/** Render camera clip range (m): the far plane is longer than the 1,120 m world's diagonal (≈ 1,584 m). */
export const CAMERA_NEAR_PLANE = 0.1;
export const CAMERA_FAR_PLANE = 2200;
/** Landmarks switch to their far low-poly level beyond this camera distance (m); no quality scale applies. */
export const LANDMARK_LOD_DISTANCE = 400;
/** Upper bound of the fog factor on Landmark materials: at least 45 % of the colour survives the thickest fog. */
export const LANDMARK_FOG_CAP = 0.55;

export interface RenderQualityDef {
  /** Device pixel ratio cap: pixel ratio = min(devicePixelRatio, dprCap) × render scale. */
  readonly dprCap: number;
  /** Instanced particle counts × this. */
  readonly particleScale: number;
  /** Terrain chunk LOD distances (160 / 400 m) × this. Landmarks ignore it. */
  readonly terrainLodScale: number;
  /** Bloom resolution relative to the screen (post-processing on). */
  readonly bloomScale: number;
  /** Fixed in every preset (Req 9.2). */
  readonly cameraFar: number;
  readonly landmarkLodDistance: number;
  readonly landmarkFogCap: number;
}

const FIXED = { cameraFar: CAMERA_FAR_PLANE, landmarkLodDistance: LANDMARK_LOD_DISTANCE, landmarkFogCap: LANDMARK_FOG_CAP } as const;

export const RENDER_QUALITY: Readonly<Record<RenderQualityPreset, RenderQualityDef>> = {
  low: { dprCap: 1, particleScale: 0.5, terrainLodScale: 0.7, bloomScale: 0.5, ...FIXED },
  medium: { dprCap: 1, particleScale: 1, terrainLodScale: 1, bloomScale: 0.5, ...FIXED },
  high: { dprCap: 1.5, particleScale: 1.5, terrainLodScale: 1.3, bloomScale: 1, ...FIXED },
};

/** The preset's render values; an unknown preset reads as 'medium' (Default_Quality). */
export function renderQualityFor(preset: string): RenderQualityDef {
  return (RENDER_QUALITY as Readonly<Record<string, RenderQualityDef | undefined>>)[preset] ?? RENDER_QUALITY.medium;
}
