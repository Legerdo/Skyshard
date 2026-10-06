/*
 * Region palettes and grading values (design.md "Region 팔레트와 color grading"; Req 39.2). Each Region has a fixed
 * vertex-colour swatch set that procedural assets are painted with (and imported models are snapped to), and grading
 * values: the fog tint, the toon rim colour, saturation and contrast. The Render_System blends the grading values by
 * the Region weights at the player (40 m smoothstep bands), so crossing a border never cuts the look.
 *
 * Colours are sRGB hex. Pure data and queries: no three.js or DOM.
 */

import type { RegionId } from './ids';

export const SWATCH_KEYS = [
  'grass', 'grassLight', 'foliage', 'foliageLight', 'bark', 'rock', 'rockDark', 'stone', 'wood', 'roof', 'accent', 'glow',
  'crystal', 'water', 'blight',
] as const;
export type SwatchKey = (typeof SWATCH_KEYS)[number];

export interface RegionGradingDef {
  /** Multiplies the time-of-day fog colour (and tints the frame through the grading). */
  readonly fogTint: number;
  /** Fresnel rim colour of the shared toon materials. */
  readonly rimColor: number;
  readonly saturation: number;
  readonly contrast: number;
}

export interface RegionPaletteDef {
  /** One-line mood from the design table. */
  readonly mood: string;
  readonly swatches: Readonly<Record<SwatchKey, number>>;
  readonly grading: RegionGradingDef;
}

/** Blight is one look everywhere, so every Blight surface reads as the same non-climbable material. */
const BLIGHT = 0x8a4dd6;

export const REGION_PALETTES: Readonly<Record<RegionId, RegionPaletteDef>> = {
  verdant: {
    mood: '따뜻한 초록·황금빛',
    swatches: {
      grass: 0x7fb24a, grassLight: 0xa9cf5a, foliage: 0x5f9e3c, foliageLight: 0x9ccf52, bark: 0x7a5234, rock: 0x9c9484,
      rockDark: 0x6f6a5e, stone: 0xcfc4a8, wood: 0xa8743e, roof: 0xc4583a, accent: 0xf2c14e, glow: 0xffe69a,
      crystal: 0x9fe0ff, water: 0x5fb0d8, blight: BLIGHT,
    },
    grading: { fogTint: 0xf0f6d2, rimColor: 0xffe69a, saturation: 1.1, contrast: 1.0 },
  },
  ember: {
    mood: '녹슨 붉은색·숯색·주황 발광',
    swatches: {
      grass: 0x8f7a45, grassLight: 0xb09050, foliage: 0x6f6a3a, foliageLight: 0x9a8a44, bark: 0x3e2f28, rock: 0x8a4a36,
      rockDark: 0x3a302c, stone: 0xa8674a, wood: 0x6e4a32, roof: 0x8a3a2a, accent: 0xff8a3d, glow: 0xffb050,
      crystal: 0xff7a3a, water: 0x6a8a96, blight: BLIGHT,
    },
    grading: { fogTint: 0xf0c4a8, rimColor: 0xff8a3d, saturation: 1.05, contrast: 1.12 },
  },
  azure: {
    mood: '차가운 청색·흰 석재·보라빛 황혼',
    swatches: {
      grass: 0x7aa88a, grassLight: 0x9cc4a8, foliage: 0x3e6e78, foliageLight: 0x6f9aa8, bark: 0x5a4e5a, rock: 0x8a94a8,
      rockDark: 0x5a6278, stone: 0xe8e6f0, wood: 0x8a7a6e, roof: 0x5a6ab4, accent: 0xc9b8ff, glow: 0xb9d8ff,
      crystal: 0x9fc4ff, water: 0x4a8ac8, blight: BLIGHT,
    },
    grading: { fogTint: 0xdce8fa, rimColor: 0xc9b8ff, saturation: 0.95, contrast: 1.05 },
  },
  crater: {
    mood: '먼지 낀 금빛·Blight 보라',
    swatches: {
      grass: 0xa89a62, grassLight: 0xc4b478, foliage: 0x7a7a4a, foliageLight: 0xa09a58, bark: 0x6a5238, rock: 0xb09a70,
      rockDark: 0x7a6a50, stone: 0xd8c89a, wood: 0x9a7a4a, roof: 0x7a4a8a, accent: 0xc286ff, glow: 0xe9c46a,
      crystal: 0xb06aff, water: 0x6aa0b8, blight: BLIGHT,
    },
    grading: { fogTint: 0xe8d6ae, rimColor: 0xc286ff, saturation: 0.92, contrast: 1.15 },
  },
  sanctum: {
    mood: '남색·금색 별빛',
    swatches: {
      grass: 0x5a68a8, grassLight: 0x8a98d8, foliage: 0x4a5a9a, foliageLight: 0x7a8ad0, bark: 0x3a3a5a, rock: 0x4a4f78,
      rockDark: 0x2c3060, stone: 0xc9cce6, wood: 0x59618f, roof: 0x2c3f7a, accent: 0xffd66b, glow: 0xfff1c4,
      crystal: 0x9fb6ff, water: 0x4a5aa8, blight: BLIGHT,
    },
    grading: { fogTint: 0xc8cef0, rimColor: 0xffd66b, saturation: 1.05, contrast: 1.1 },
  },
};

/** The Region swatch nearest to `color` (sRGB distance): imported models snap their base colours to it (Req 40.5). */
export function nearestSwatch(region: RegionId, color: number): { key: SwatchKey; color: number } {
  const swatches = REGION_PALETTES[region].swatches;
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  let best: SwatchKey = SWATCH_KEYS[0];
  let bestD = Infinity;
  for (const key of SWATCH_KEYS) {
    const c = swatches[key];
    const d = (((c >> 16) & 255) - r) ** 2 + (((c >> 8) & 255) - g) ** 2 + ((c & 255) - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = key;
    }
  }
  return { key: best, color: swatches[best] };
}
