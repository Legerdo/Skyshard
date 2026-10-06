/*
 * Gameplay HUD layout (design "HUD 레이아웃 (1920×1080 기준)", Req 32.1, 32.4): the placement table as data. Sizes are
 * px at UI scale 100 % on the 1920 × 1080 reference screen; circles count as their bounding square. The same table
 * feeds the area budget (unit-tested: always-on ≈ 5.7 %, with the conditional Stamina ring and prompt ≈ 6.5 %, and
 * still ≤ 15 % at UI scale 130 %) and the view: `hudLayoutCssVars()` turns every box into `--hud-*` custom
 * properties in rem (1 rem = ROOT_FONT_PX at scale 1, and the root font follows `--ui-scale`), which GameplayHud sets
 * on its root and the HUD stylesheets read, so data and view cannot drift apart. Pure: no DOM.
 */
import { ROOT_FONT_PX } from './styles/tokens';

/** The reference screen of the table (px). */
export const HUD_REFERENCE = { width: 1920, height: 1080 } as const;
/** Largest share of the reference screen the exploration HUD may cover (Req 32.4). */
export const HUD_AREA_LIMIT = 0.15;
/** Settings "UI 배율" range (Req 35.6); the budget must hold at the top of it. */
export const HUD_UI_SCALE_RANGE = { min: 0.8, max: 1.3 } as const;

export type HudElementId =
  | 'compass' | 'objective' | 'skyshard' | 'party' | 'vitals' | 'skill' | 'burst' | 'stamina' | 'prompt';

/**
 * Where a box sits. `x` / `y` are px from the anchored screen edges (for `top` / `bottom` the box is centred
 * horizontally; `center` offsets the box's top-left corner from the screen centre; `world` offsets the box's centre
 * from the projected world point).
 */
export type HudAnchor = 'top' | 'topLeft' | 'topRight' | 'bottom' | 'bottomLeft' | 'bottomRight' | 'center' | 'world';

export interface HudBox {
  readonly id: HudElementId;
  /** The table's row name. */
  readonly label: string;
  readonly anchor: HudAnchor;
  readonly x: number;
  readonly y: number;
  /** Circles are drawn round and counted as their bounding square (width = height = diameter). */
  readonly shape: 'rect' | 'circle';
  readonly width: number;
  readonly height: number;
  /** Identical boxes in the row (4 party slots). */
  readonly count: number;
  /** Shown only at times (Stamina below max, an interaction target in reach). */
  readonly conditional: boolean;
}

/** Margin between the HUD and the screen edges (px). */
export const HUD_EDGE = 24;
/** Gap between two party slots, and between the Skill and Burst icons (px). */
export const HUD_SLOT_GAP = 8;
export const HUD_ABILITY_GAP = 16;
/** Portrait inside a party slot (px). */
export const HUD_PORTRAIT = 64;

const SKILL_D = 76;
const BURST_D = 92;
const BURST_RIGHT = 32;

/** The placement table (design "HUD 레이아웃"), in table order. */
export const HUD_LAYOUT: readonly HudBox[] = [
  { id: 'compass', label: 'Compass', anchor: 'top', x: 0, y: HUD_EDGE, shape: 'rect', width: 560, height: 40, count: 1, conditional: false },
  { id: 'objective', label: 'Objective', anchor: 'topLeft', x: HUD_EDGE, y: HUD_EDGE, shape: 'rect', width: 420, height: 64, count: 1, conditional: false },
  { id: 'skyshard', label: 'Skyshard 진행 n/3', anchor: 'topRight', x: HUD_EDGE, y: HUD_EDGE, shape: 'rect', width: 180, height: 48, count: 1, conditional: false },
  { id: 'party', label: '파티 슬롯', anchor: 'bottomLeft', x: HUD_EDGE, y: HUD_EDGE, shape: 'rect', width: 72, height: 92, count: 4, conditional: false },
  { id: 'vitals', label: 'Active_Character HP·레벨', anchor: 'bottom', x: 0, y: HUD_EDGE, shape: 'rect', width: 480, height: 40, count: 1, conditional: false },
  {
    id: 'skill', label: 'Skill 아이콘', anchor: 'bottomRight', x: BURST_RIGHT + BURST_D + HUD_ABILITY_GAP, y: HUD_EDGE,
    shape: 'circle', width: SKILL_D, height: SKILL_D, count: 1, conditional: false,
  },
  { id: 'burst', label: 'Burst 아이콘', anchor: 'bottomRight', x: BURST_RIGHT, y: HUD_EDGE, shape: 'circle', width: BURST_D, height: BURST_D, count: 1, conditional: false },
  { id: 'stamina', label: 'Stamina 게이지', anchor: 'world', x: 59, y: 0, shape: 'circle', width: 48, height: 48, count: 1, conditional: true },
  { id: 'prompt', label: '상호작용 prompt', anchor: 'center', x: 80, y: 64, shape: 'rect', width: 320, height: 48, count: 1, conditional: true },
];

/** World-projected bars (design "적·보스 표시"); not in the budget (they sit over the enemies, only in combat). */
export const HUD_WORLD_BARS = {
  /** DOM pool size of the enemy HP bars. */
  pool: 12,
  enemy: { width: 96, height: 8 },
  elite: { width: 128, height: 10 },
  /** Caelith, top centre below the Compass. */
  boss: { width: 720, height: 20 },
} as const;

/** The box of `id`. */
export function hudBox(id: HudElementId): HudBox {
  const box = HUD_LAYOUT.find((b) => b.id === id);
  if (box === undefined) throw new Error(`no HUD box ${id}`);
  return box;
}

/** Area of one row (all its boxes) at UI `scale` (px²): sizes scale linearly, so area by scale². */
export function hudBoxArea(box: HudBox, scale = 1): number {
  return box.width * box.height * box.count * scale * scale;
}

export interface HudAreaOptions {
  /** Count the conditional rows too (Stamina ring and prompt up together). */
  readonly conditional?: boolean;
  /** UI scale (1 = 100 %). */
  readonly scale?: number;
}

/** Summed area of the table's rows (px²). */
export function hudArea(layout: readonly HudBox[] = HUD_LAYOUT, options: HudAreaOptions = {}): number {
  const { conditional = false, scale = 1 } = options;
  return layout.reduce((sum, box) => (box.conditional && !conditional ? sum : sum + hudBoxArea(box, scale)), 0);
}

/** Share of the 1920 × 1080 reference screen those rows cover (0–1). */
export function hudAreaShare(layout: readonly HudBox[] = HUD_LAYOUT, options: HudAreaOptions = {}): number {
  return hudArea(layout, options) / (HUD_REFERENCE.width * HUD_REFERENCE.height);
}

/** px at UI scale 1 as a rem length (the root font scales with `--ui-scale`, so rem lengths do too). */
export function remOf(px: number): string {
  return `${Math.round((px / ROOT_FONT_PX) * 10000) / 10000}rem`;
}

/**
 * `--hud-{id}-w/-h/-x/-y` for every box plus the shared gaps, portrait and world bar sizes, as rem strings. The HUD
 * stylesheets size and place their elements with these (and fall back to the same values when unset).
 */
export function hudLayoutCssVars(): Record<string, string> {
  const vars: Record<string, string> = {
    '--hud-edge': remOf(HUD_EDGE),
    '--hud-slot-gap': remOf(HUD_SLOT_GAP),
    '--hud-ability-gap': remOf(HUD_ABILITY_GAP),
    '--hud-portrait': remOf(HUD_PORTRAIT),
    '--hud-enemy-bar-w': remOf(HUD_WORLD_BARS.enemy.width),
    '--hud-enemy-bar-h': remOf(HUD_WORLD_BARS.enemy.height),
    '--hud-elite-bar-w': remOf(HUD_WORLD_BARS.elite.width),
    '--hud-elite-bar-h': remOf(HUD_WORLD_BARS.elite.height),
    '--hud-boss-bar-w': remOf(HUD_WORLD_BARS.boss.width),
    '--hud-boss-bar-h': remOf(HUD_WORLD_BARS.boss.height),
  };
  for (const box of HUD_LAYOUT) {
    vars[`--hud-${box.id}-w`] = remOf(box.width);
    vars[`--hud-${box.id}-h`] = remOf(box.height);
    vars[`--hud-${box.id}-x`] = remOf(box.x);
    vars[`--hud-${box.id}-y`] = remOf(box.y);
  }
  return vars;
}
