import { describe, expect, it } from 'vitest';
import { REGION_IDS } from '../../../src/data/ids';
import { nearestSwatch, REGION_PALETTES, SWATCH_KEYS } from '../../../src/data/palettes';
import {
  CAMERA_FAR_PLANE, LANDMARK_FOG_CAP, LANDMARK_LOD_DISTANCE, RENDER_QUALITY, RENDER_QUALITY_PRESETS, renderQualityFor,
} from '../../../src/data/renderQuality';
import {
  progressTimeOfDay, sunDirection, TIME_OF_DAY_BLEND_CINEMATICS, TIME_OF_DAY_BLEND_SECONDS, TIME_OF_DAY_IDS, TIME_OF_DAY_PRESETS,
  timeOfDayFor,
} from '../../../src/data/timeOfDay';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { QUALITY_PRESETS } from '../../../src/settings/settings';

// Tasks 18.1–18.3: render data tables (design "하늘·조명·시간대", "Region 팔레트와 color grading", "Landmark 가시성").

/** sRGB luminance of a hex colour (0–1). */
function luma(hex: number): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((hex >> 16) & 255) + 0.7152 * lin((hex >> 8) & 255) + 0.0722 * lin(hex & 255);
}

describe('time-of-day presets', () => {
  it('has the six presets with the design table values', () => {
    expect(TIME_OF_DAY_IDS).toEqual(['morning', 'noon', 'afternoon', 'dusk', 'starNight', 'sunrise']);
    const table: Record<string, [number, number, number, number, number]> = {
      morning: [18, 0xffe4bc, 0x6db6f2, 0xffe8cc, 0xd2e6f4],
      noon: [62, 0xfff8e8, 0x3d9bf2, 0xc4e6ff, 0xd8edff],
      afternoon: [36, 0xffe3a8, 0x4e97e0, 0xffe2aa, 0xeadfc2],
      dusk: [7, 0xff9658, 0x5a5cb4, 0xffb27a, 0xe8a58c],
      starNight: [48, 0xb4c6ff, 0x0e1a46, 0x34488a, 0x2a3a68],
      sunrise: [5, 0xffc690, 0x8fa8e6, 0xffc9a0, 0xf4c8b8],
    };
    for (const id of TIME_OF_DAY_IDS) {
      const p = TIME_OF_DAY_PRESETS[id];
      expect([p.sunElevationDeg, p.sunColor, p.skyTop, p.skyHorizon, p.fogColor]).toEqual(table[id]);
      expect(p.fogNear).toBeLessThan(p.fogFar);
      expect(p.fogFar).toBeLessThan(CAMERA_FAR_PLANE);
      const d = sunDirection(p);
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 12);
      expect(d.y).toBeGreaterThan(0); // the key light is always above the horizon
    }
    expect(TIME_OF_DAY_PRESETS.starNight.moon).toBe(true);
    expect(TIME_OF_DAY_BLEND_SECONDS).toBe(4);
    expect(TIME_OF_DAY_BLEND_CINEMATICS).toEqual(['cin_skyshard_1', 'cin_skyshard_2', 'cin_skyshard_3', 'cin_altar']);
  });

  it('keeps the starlit night hemisphere at 60 % of noon or more (intensity and lit sky)', () => {
    const night = TIME_OF_DAY_PRESETS.starNight;
    const noon = TIME_OF_DAY_PRESETS.noon;
    expect(night.hemiIntensity).toBeGreaterThanOrEqual(0.6 * noon.hemiIntensity);
    expect(night.hemiIntensity * luma(night.hemiSky)).toBeGreaterThanOrEqual(0.6 * noon.hemiIntensity * luma(noon.hemiSky));
    expect(night.stars).toBe(1);
  });

  it('picks the preset from GameState: Skyshards, the activated altar, the ending, then the Caelith arena', () => {
    const gs = createNewGameState(1);
    expect(progressTimeOfDay(gs)).toBe('morning');
    const seen = ([0, 1, 2, 3] as const).map((n) => progressTimeOfDay({ ...gs, skyshards: n }));
    expect(seen).toEqual(['morning', 'noon', 'afternoon', 'dusk']);
    gs.skyshards = 3;
    gs.altarActivated = true;
    expect(progressTimeOfDay(gs)).toBe('starNight');
    expect(timeOfDayFor(gs, 'dusk')).toBe('dusk'); // arena Phases 1–2
    expect(timeOfDayFor(gs, 'starNight')).toBe('starNight'); // Final Phase
    expect(timeOfDayFor(gs, null)).toBe('starNight');
    gs.bossDefeated = true;
    gs.gameCompleted = true;
    expect(progressTimeOfDay(gs)).toBe('sunrise');
    expect(timeOfDayFor(gs, 'starNight')).toBe('sunrise');
    expect(progressTimeOfDay({ skyshards: Number.NaN, altarActivated: false, gameCompleted: false })).toBe('morning');
  });
});

describe('Region palettes and grading', () => {
  it('has every swatch for every Region and the design grading values', () => {
    const table: Record<string, [number, number, number, number]> = {
      verdant: [0xf0f6d2, 0xffe69a, 1.1, 1.0],
      ember: [0xf0c4a8, 0xff8a3d, 1.05, 1.12],
      azure: [0xdce8fa, 0xc9b8ff, 0.95, 1.05],
      crater: [0xe8d6ae, 0xc286ff, 0.92, 1.15],
      sanctum: [0xc8cef0, 0xffd66b, 1.05, 1.1],
    };
    expect(Object.keys(REGION_PALETTES).sort()).toEqual([...REGION_IDS].sort());
    for (const id of REGION_IDS) {
      const p = REGION_PALETTES[id];
      expect(Object.keys(p.swatches).sort()).toEqual([...SWATCH_KEYS].sort());
      for (const key of SWATCH_KEYS) expect(Number.isInteger(p.swatches[key]) && p.swatches[key] >= 0 && p.swatches[key] <= 0xffffff).toBe(true);
      const g = p.grading;
      expect([g.fogTint, g.rimColor, g.saturation, g.contrast]).toEqual(table[id]);
    }
    // One Blight look everywhere (Req 18.1).
    expect(new Set(REGION_IDS.map((id) => REGION_PALETTES[id].swatches.blight)).size).toBe(1);
  });

  it('snaps a colour to the nearest Region swatch', () => {
    expect(nearestSwatch('verdant', REGION_PALETTES.verdant.swatches.roof)).toEqual({ key: 'roof', color: REGION_PALETTES.verdant.swatches.roof });
    expect(nearestSwatch('ember', 0xff8a3e).key).toBe('accent');
  });
});

describe('render quality presets', () => {
  it('never changes the far plane, the Landmark LOD distance or the Landmark fog cap', () => {
    expect(RENDER_QUALITY_PRESETS).toEqual(['low', 'medium', 'high']);
    expect(Object.keys(QUALITY_PRESETS).sort()).toEqual([...RENDER_QUALITY_PRESETS].sort());
    for (const p of RENDER_QUALITY_PRESETS) {
      const q = RENDER_QUALITY[p];
      expect([q.cameraFar, q.landmarkLodDistance, q.landmarkFogCap]).toEqual([2200, 400, 0.55]);
    }
    expect([CAMERA_FAR_PLANE, LANDMARK_LOD_DISTANCE, LANDMARK_FOG_CAP]).toEqual([2200, 400, 0.55]);
    // Longer than the 1,120 m square world's diagonal.
    expect(CAMERA_FAR_PLANE).toBeGreaterThan(Math.hypot(1120, 1120));
  });

  it('holds the design DPR caps, particle and terrain LOD scales', () => {
    expect(RENDER_QUALITY_PRESETS.map((p) => RENDER_QUALITY[p].dprCap)).toEqual([1, 1, 1.5]);
    expect(RENDER_QUALITY_PRESETS.map((p) => RENDER_QUALITY[p].particleScale)).toEqual([0.5, 1, 1.5]);
    expect(RENDER_QUALITY_PRESETS.map((p) => RENDER_QUALITY[p].terrainLodScale)).toEqual([0.7, 1, 1.3]);
    expect(renderQualityFor('nonsense')).toBe(RENDER_QUALITY.medium);
  });
});
