// VFX catalog (design "VFX 시스템", "타격 피드백", "속성·반응별 연출", "월드·진행 연출"; Req 26, 25.9, 23.7, 24.9,
// 10.6): the sprite list of the atlas, the particle burst recipe (`BurstSpec`) and every effect's recipe by id, so
// the VfxSystem only places them. Plain data plus a few pure helpers: no three.js / DOM.
//
// Colours: Element colours come from ELEMENT_DEFS (Ember #FF7A45, Tide #3FA7F5, Gale #5ED3A5, Terra #D9A441); the
// Telegraph decals use a redder red-orange (#FF4A2A) and the boss gold-red (#FFC247 outline, #E03A2A fill) so they
// never read as an Ember effect (Req 35.7). `essential` recipes keep their full count on every quality preset.

import type { Vec3 } from '../core/types';
import type { ChestTier } from '../core/gameEvents';
import { ELEMENT_DEFS } from '../data/elements';
import { ELEMENT_IDS, REACTION_IDS, type ElementId, type ReactionId } from '../data/ids';
import { REACTION_DEFS, REACTION_PRESENTATION } from '../data/reactions';

/** Atlas cells, row-major in the 3 × 3 grid. */
export const SPRITE_IDS = ['circle', 'spark', 'petal', 'ember', 'droplet', 'leaf', 'shard', 'star', 'ring'] as const;
export type SpriteId = (typeof SPRITE_IDS)[number];

export function spriteIndex(id: SpriteId): number {
  return SPRITE_IDS.indexOf(id);
}

/** Where a burst's particles start around its point. */
export type BurstLayout = 'ball' | 'ring' | 'disc' | 'hex' | 'column';

/**
 * One particle burst. `count` is scaled by the quality preset (at least 1) unless `essential`. Speeds are m/s along
 * the cone around the burst direction when `cone` (half angle, degrees) is set, else outward from the spawn offset.
 */
export interface BurstSpec {
  sprite: SpriteId;
  blend: 'add' | 'alpha';
  count: number;
  color: number;
  speed: readonly [number, number];
  life: readonly [number, number];
  size: readonly [number, number];
  /** Downward acceleration (m/s²). */
  gravity?: number;
  /** Turn rate about the vertical axis through the burst point (rad/s). */
  swirl?: number;
  /** Half angle (°) of the emission cone around the burst direction (default straight up). */
  cone?: number;
  essential?: boolean;
  /** Spawn radius (m) around the point, laid out by `layout` (default 'ball'). */
  radius?: number;
  layout?: BurstLayout;
  /** Column height (m) for `layout: 'column'`. */
  height?: number;
  /** Extra upward speed (m/s). */
  lift?: number;
  /** Velocity damping (1/s). */
  drag?: number;
  /** Start opacity (default 1). */
  alpha?: number;
  /** End size as a fraction of the start size (default 0.4). */
  shrink?: number;
  /** Birth delay range (s) after the burst call. */
  delay?: readonly [number, number];
}

// ── Palette ─────────────────────────────────────────────────────────────────

export const ELEMENT_COLORS: Readonly<Record<ElementId, number>> = {
  ember: ELEMENT_DEFS.ember.color,
  tide: ELEMENT_DEFS.tide.color,
  gale: ELEMENT_DEFS.gale.color,
  terra: ELEMENT_DEFS.terra.color,
};

/** Element sprite of the hit impact cone (Req 26.1); a hit without an Element throws white sparks only. */
export const ELEMENT_SPRITES: Readonly<Record<ElementId, SpriteId>> = {
  ember: 'ember',
  tide: 'droplet',
  gale: 'leaf',
  terra: 'shard',
};

/** Telegraph decal colours (Req 26.5, 35.7). */
export const TELEGRAPH_COLORS = {
  enemy: { edge: 0xff4a2a, fill: 0xff4a2a },
  boss: { edge: 0xffc247, fill: 0xe03a2a },
} as const;

const WHITE = 0xffffff;
const GOLD = 0xffd98a;
const DUST = 0xc9b48a;

// ── Hits (Req 26.1, 26.2) ───────────────────────────────────────────────────

/** Half angle (°) of the impact cone around the hit direction. */
export const IMPACT_CONE_DEG = 35;
/** White sparks per hit: 8 normally, 14 on a crit. */
export const IMPACT_SPARKS = { normal: 8, crit: 14 } as const;
/** Hit flash: `uHitFlash` falls from 1 to 0 over this long (s). */
export const HIT_FLASH_SECONDS = 0.1;

export function impactSparks(crit: boolean): BurstSpec {
  return {
    sprite: 'spark', blend: 'add', count: crit ? IMPACT_SPARKS.crit : IMPACT_SPARKS.normal, color: WHITE,
    speed: [5, 9], life: [0.12, 0.26], size: [0.14, 0.24], cone: IMPACT_CONE_DEG, drag: 6, gravity: 4,
  };
}

export function impactElement(element: ElementId): BurstSpec {
  return {
    sprite: ELEMENT_SPRITES[element], blend: element === 'ember' ? 'add' : 'alpha', count: 4, color: ELEMENT_COLORS[element],
    speed: [3, 6], life: [0.25, 0.45], size: [0.18, 0.3], cone: IMPACT_CONE_DEG, drag: 4, gravity: 6, essential: true,
  };
}

// ── Element marks (element:applied) ─────────────────────────────────────────

export interface ElementFx {
  readonly bursts: readonly BurstSpec[];
  /** Ground ripple ring (Tide). */
  readonly ring?: { readonly radius: number; readonly seconds: number };
}

export const ELEMENT_FX: Readonly<Record<ElementId, ElementFx>> = {
  // Flame tongues licking the body and embers drifting up.
  ember: {
    bursts: [
      { sprite: 'ember', blend: 'add', count: 14, color: ELEMENT_COLORS.ember, speed: [0.1, 0.4], life: [0.35, 0.6], size: [0.35, 0.55],
        layout: 'column', radius: 0.35, height: 1.2, lift: 1.6, swirl: 1.5, shrink: 0.2, essential: true },
      { sprite: 'spark', blend: 'add', count: 10, color: 0xffc27a, speed: [0.3, 0.8], life: [0.6, 1.0], size: [0.08, 0.14],
        layout: 'column', radius: 0.4, height: 1.4, lift: 2.4, drag: 1 },
    ],
  },
  // Droplets thrown up and a ripple ring spreading at the feet.
  tide: {
    bursts: [
      { sprite: 'droplet', blend: 'alpha', count: 12, color: ELEMENT_COLORS.tide, speed: [2.5, 4], life: [0.5, 0.8], size: [0.12, 0.2],
        cone: 50, gravity: 9.8, radius: 0.3, essential: true },
    ],
    ring: { radius: 1.4, seconds: 0.5 },
  },
  // A spiral climbing around the body and scattered leaves.
  gale: {
    bursts: [
      { sprite: 'spark', blend: 'add', count: 16, color: ELEMENT_COLORS.gale, speed: [0.1, 0.3], life: [0.5, 0.8], size: [0.12, 0.2],
        layout: 'column', radius: 0.6, height: 0.4, lift: 2.2, swirl: 6, essential: true },
      { sprite: 'leaf', blend: 'alpha', count: 6, color: 0x7fdcae, speed: [1, 2], life: [0.9, 1.3], size: [0.16, 0.24],
        radius: 0.5, swirl: 2, gravity: 0.8, drag: 1.5, shrink: 0.8 },
    ],
  },
  // Stone chips and dust along a hexagon outline.
  terra: {
    bursts: [
      { sprite: 'shard', blend: 'alpha', count: 8, color: ELEMENT_COLORS.terra, speed: [2.5, 4], life: [0.5, 0.8], size: [0.14, 0.22],
        cone: 60, gravity: 9.8, radius: 0.2, shrink: 0.8, essential: true },
      { sprite: 'circle', blend: 'alpha', count: 12, color: DUST, speed: [0.4, 0.8], life: [0.6, 0.9], size: [0.4, 0.7],
        layout: 'hex', radius: 0.9, lift: 0.4, drag: 2, alpha: 0.55, shrink: 1.4 },
    ],
  },
};

// ── Reactions (reaction) ────────────────────────────────────────────────────

export interface ReactionFx {
  /** Korean name shown over the target for REACTION_LABEL_SECONDS (Req 25.9). */
  readonly label: string;
  readonly color: number;
  readonly bursts: readonly BurstSpec[];
  /** Shock ring spreading to `radius` m. */
  readonly ring?: { readonly radius: number; readonly seconds: number };
  /** Explosion sphere swelling to `radius` m. */
  readonly sphere?: { readonly radius: number; readonly seconds: number };
  /** Ground puddle decal under the target (drawn below the Telegraphs). */
  readonly puddle?: { readonly kind: 'lava' | 'mud'; readonly radius: number; readonly seconds: number };
  /** Vines around the ankles of enemies in the radius (진흙 속박). */
  readonly vines?: { readonly seconds: number };
  /** Flame arcs (quadratic Bézier) to the enemies within the radius (불꽃 확산). */
  readonly arcs?: boolean;
  /** Heat haze rising over the lava while it burns (particles per second). */
  readonly haze?: number;
}

const reactionColor = (r: ReactionId): number => REACTION_PRESENTATION[r].color;

export const REACTION_FX: Readonly<Record<ReactionId, ReactionFx>> = {
  steamBurst: {
    label: REACTION_DEFS.steamBurst.name, color: reactionColor('steamBurst'),
    bursts: [
      { sprite: 'circle', blend: 'alpha', count: 40, color: 0xf4f8ff, speed: [3, 5.5], life: [0.8, 1.3], size: [1.0, 1.8],
        radius: 0.6, drag: 2.2, lift: 0.6, alpha: 0.8, shrink: 1.6, essential: true },
      { sprite: 'spark', blend: 'add', count: 16, color: 0xfff1d6, speed: [6, 10], life: [0.2, 0.4], size: [0.15, 0.25], drag: 4 },
    ],
    ring: { radius: REACTION_DEFS.steamBurst.radius, seconds: 0.45 },
    sphere: { radius: REACTION_DEFS.steamBurst.radius, seconds: 0.35 },
  },
  lavaRift: {
    label: REACTION_DEFS.lavaRift.name, color: reactionColor('lavaRift'),
    bursts: [
      { sprite: 'ember', blend: 'add', count: 18, color: reactionColor('lavaRift'), speed: [1, 3], life: [0.5, 0.9], size: [0.25, 0.4],
        layout: 'disc', radius: 2, lift: 2, gravity: 2, essential: true },
    ],
    puddle: { kind: 'lava', radius: REACTION_DEFS.lavaRift.radius, seconds: 4 },
    haze: 14,
  },
  mudBind: {
    label: REACTION_DEFS.mudBind.name, color: reactionColor('mudBind'),
    bursts: [
      { sprite: 'circle', blend: 'alpha', count: 14, color: 0x7a5a34, speed: [0.5, 1.5], life: [0.4, 0.7], size: [0.3, 0.5],
        layout: 'disc', radius: 2, lift: 2, gravity: 8, essential: true },
    ],
    puddle: { kind: 'mud', radius: REACTION_DEFS.mudBind.radius, seconds: 2.5 },
    vines: { seconds: 2.5 },
  },
  flameSpread: {
    label: REACTION_DEFS.flameSpread.name, color: reactionColor('flameSpread'),
    bursts: [
      { sprite: 'ember', blend: 'add', count: 12, color: reactionColor('flameSpread'), speed: [1.5, 3], life: [0.4, 0.7], size: [0.3, 0.5],
        radius: 0.4, lift: 1, essential: true },
    ],
    arcs: true,
  },
  mistSpread: {
    label: REACTION_DEFS.mistSpread.name, color: reactionColor('mistSpread'),
    bursts: [
      { sprite: 'circle', blend: 'alpha', count: 36, color: reactionColor('mistSpread'), speed: [4, 5.2], life: [1.0, 1.3], size: [1.2, 2],
        layout: 'ring', radius: 0.5, drag: 0.8, alpha: 0.6, shrink: 1.5, essential: true },
    ],
    ring: { radius: REACTION_DEFS.mistSpread.radius, seconds: 0.6 },
  },
  sandGust: {
    label: REACTION_DEFS.sandGust.name, color: reactionColor('sandGust'),
    bursts: [
      { sprite: 'circle', blend: 'alpha', count: 30, color: reactionColor('sandGust'), speed: [0.4, 1], life: [0.8, 1.2], size: [0.6, 1],
        layout: 'column', radius: 1.2, height: 0.6, lift: 2, swirl: 5, alpha: 0.65, shrink: 1.2, essential: true },
      { sprite: 'shard', blend: 'alpha', count: 10, color: 0xb89a5a, speed: [0.5, 1.2], life: [0.7, 1.1], size: [0.12, 0.2],
        layout: 'column', radius: 1, height: 1.2, lift: 1.5, swirl: 5 },
    ],
  },
};

// ── Floating text (Req 26.1, 26.2, 26.8, 25.9) ─────────────────────────────

export const DAMAGE_NUMBER_POOL_SIZE = 24;
export const DAMAGE_NUMBER_SECONDS = 0.8;
export const REACTION_LABEL_SECONDS = 1.0;
/** Crit numbers are this much larger than normal ones. */
export const CRIT_NUMBER_SCALE = 1.5;

// ── Combat moments ──────────────────────────────────────────────────────────

/** Party switch: a swirl in the new character's Element colour at the feet (Req 23.7). */
export const SWITCH_SWIRL_SECONDS = 0.3;
export function switchSwirl(element: ElementId): BurstSpec {
  return {
    sprite: 'spark', blend: 'add', count: 26, color: ELEMENT_COLORS[element], speed: [0.2, 0.5], life: [0.24, SWITCH_SWIRL_SECONDS],
    size: [0.14, 0.24], layout: 'ring', radius: 0.8, lift: 3, swirl: 9, essential: true,
  };
}

/** Perfect_Dodge afterimages: three frozen translucent copies fading over the 0.5 s slow motion (Req 24.9). */
export const AFTERIMAGE_COUNT = 3;
export const AFTERIMAGE_SECONDS = 0.5;
/** Real seconds between the three snapshots. */
export const AFTERIMAGE_INTERVAL = 0.06;

/** Burst cut-in flash in the Element colour (Req 24.6). */
export const BURST_FLASH_SECONDS = 0.15;

/** Stagger: three stars circling over the head (Req 26.9). */
export const STAGGER_STARS = 3;
export const STAGGER_STAR_SPIN = 4;

/** Death: the 0.4 s death motion, then `uDissolve` 0 → 1 over 1.0 s; the model is back in its pool by 1.5 s (Req 26.6). */
export const DEATH_MOTION_SECONDS = 0.4;
export const DISSOLVE_SECONDS = 1.0;
export const DEATH_RETURN_SECONDS = 1.5;

/** `uDissolve` at `seconds` after death. */
export function dissolveProgress(seconds: number): number {
  return Math.min(1, Math.max(0, (seconds - DEATH_MOTION_SECONDS) / DISSOLVE_SECONDS));
}

/** Glowing motes leaving the dissolving body (born through the dissolve). */
export function dissolveMotes(height: number): BurstSpec {
  return {
    sprite: 'circle', blend: 'add', count: 24, color: 0xcfe8ff, speed: [0.2, 0.6], life: [0.6, 1.0], size: [0.12, 0.22],
    layout: 'column', radius: 0.4, height, lift: 1.2, drag: 1, delay: [DEATH_MOTION_SECONDS, DEATH_MOTION_SECONDS + DISSOLVE_SECONDS],
  };
}

/** Element_Shield / Starshell break: crystal shards of the shield's colour. */
export const SHIELD_SHARDS = 18;

// ── World and progress moments ──────────────────────────────────────────────

export interface PillarFx {
  readonly radius: number;
  readonly height: number;
  readonly seconds: number;
  readonly color: number;
}

/** Level up: a light pillar around the Active_Character. */
export const LEVEL_UP_PILLAR: PillarFx = { radius: 0.9, height: 5, seconds: 1.4, color: GOLD };

/** Chest light burst size (m) by tier. */
export const CHEST_BURST_RADIUS: Readonly<Record<ChestTier, number>> = { common: 0.8, fine: 1.2, glowing: 1.7 };
/** Chest light pillar height by tier: a glowing Chest's is twice the common one's (Req 10.6). */
export const CHEST_PILLAR_HEIGHT: Readonly<Record<ChestTier, number>> = { common: 3, fine: 3, glowing: 6 };

export function chestPillar(tier: ChestTier): PillarFx {
  return { radius: tier === 'glowing' ? 0.8 : 0.5, height: CHEST_PILLAR_HEIGHT[tier], seconds: 1.6, color: tier === 'glowing' ? 0xfff1b0 : GOLD };
}

export function chestBurst(tier: ChestTier): BurstSpec {
  const r = CHEST_BURST_RADIUS[tier];
  return {
    sprite: 'star', blend: 'add', count: Math.round(14 * r), color: GOLD, speed: [2 * r, 4 * r], life: [0.5, 0.9], size: [0.2, 0.34],
    cone: 70, drag: 2.5, gravity: 1, essential: true,
  };
}

/** Skyshard acquired: thin light rays radiating from the shard and a spiral climbing the character (Req 4.2). */
export const SKYSHARD_RAYS = 8;
export const SKYSHARD_SECONDS = 1.8;

/** Resonance_Altar: three beams from the representative Landmarks gathering over the altar (Req 5.4). */
export const ALTAR_BEAM_SECONDS = 3;

// ── Coverage helpers (tests) ────────────────────────────────────────────────

/** Every ElementId and ReactionId has its own recipe. */
export function catalogCovers(): { elements: boolean; reactions: boolean } {
  return {
    elements: ELEMENT_IDS.every((id) => ELEMENT_FX[id].bursts.length > 0),
    reactions: REACTION_IDS.every((id) => REACTION_FX[id].bursts.length > 0 && REACTION_FX[id].label === REACTION_DEFS[id].name),
  };
}

/** A zero vector for defaults. */
export const ORIGIN: Readonly<Vec3> = { x: 0, y: 0, z: 0 };
