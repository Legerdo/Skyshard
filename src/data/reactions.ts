// Table B reactions, their effect numbers and Element_Mark constants (design "Element·Reactions", Req 25).
// Pure data. Times are seconds, distances metres, ratios fractions (1.5 = 150%).

import { ELEMENT_IDS, REACTION_NAMES, type ElementId, type ReactionId, type SfxId } from './ids';

/** Learning rule; the tutorial and the codex use this exact sentence. */
export const LEARNING_RULE = 'Ember와 Tide는 폭발한다 / Terra는 땅을 바꾼다 / Gale은 다른 속성을 퍼뜨린다';

/** Element_Mark lifetime (Req 25.2). */
export const MARK_DURATION = 8;
/** Minimum time between two occurrences of the same reaction on one target (Req 25.8). */
export const SAME_REACTION_COOLDOWN = 1;
/** Active_Character shield from Terra reactions; repeats refresh it instead of stacking (Req 25.12). */
export const TERRA_REACTION_SHIELD = { pctMaxHp: 0.08, seconds: 5 } as const;

/** Effect while a mark is held (Req 25.4). */
export interface MarkEffect {
  /** dot: pct × the applier's ATK per second · slow: move speed −pct · *Up: amount received +pct. */
  kind: 'dot' | 'slow' | 'knockbackUp' | 'staggerUp';
  pct: number;
}

export const MARK_EFFECTS: Readonly<Record<ElementId, MarkEffect>> = {
  ember: { kind: 'dot', pct: 0.05 },
  tide: { kind: 'slow', pct: 0.2 },
  gale: { kind: 'knockbackUp', pct: 0.5 },
  terra: { kind: 'staggerUp', pct: 0.5 },
};

/** Table B: unordered pair (elements in ELEMENT_IDS order, joined by '+') → reaction. */
export const REACTION_PAIRS = {
  'ember+tide': 'steamBurst',
  'ember+terra': 'lavaRift',
  'tide+terra': 'mudBind',
  'ember+gale': 'flameSpread',
  'tide+gale': 'mistSpread',
  'gale+terra': 'sandGust',
} as const satisfies Partial<Record<`${ElementId}+${ElementId}`, ReactionId>>;

export type ElementPairKey = keyof typeof REACTION_PAIRS;

/** Symmetric table B lookup; null exactly when a === b. */
export function reactionFor(a: ElementId, b: ElementId): ReactionId | null {
  if (a === b) return null;
  const [lo, hi] = ELEMENT_IDS.indexOf(a) < ELEMENT_IDS.indexOf(b) ? [a, b] : [b, a];
  return REACTION_PAIRS[`${lo}+${hi}` as ElementPairKey];
}

/**
 * Effect parameters (design "Reaction 효과"). burst `bonusMul` / `splashMul` scale the trigger hit's
 * final damage (target / nearby enemies); `tickAtkMul` / `atkMul` are ATK multipliers of the reacting
 * character for computeDamage (`atkMul` null: no damage).
 */
export type ReactionEffect =
  | { kind: 'burst'; bonusMul: number; splashMul: number; stagger: number; hitStop: number }
  | { kind: 'zone'; seconds: number; tickInterval: number; tickAtkMul: number }
  | { kind: 'root'; seconds: number }
  | { kind: 'spread'; atkMul: number | null; slow: { pct: number; seconds: number } | null };

export interface ReactionDef {
  id: ReactionId;
  /** Table B combination (unordered). */
  pair: readonly [ElementId, ElementId];
  /** Korean name shown at the target (Req 25.9). */
  name: string;
  /** Effect radius around the target. */
  radius: number;
  /** Element passed on to other enemies within `radius` (the non-Gale one); null if not a spread. */
  spreads: ElementId | null;
  /** Grants TERRA_REACTION_SHIELD (Req 25.12). */
  terraShield: boolean;
  effect: ReactionEffect;
}

/** name, spreads and terraShield follow from the pair. */
function def(
  id: ReactionId,
  pair: readonly [ElementId, ElementId],
  radius: number,
  effect: ReactionEffect,
): ReactionDef {
  const spreads = pair[0] === 'gale' ? pair[1] : pair[1] === 'gale' ? pair[0] : null;
  return { id, pair, name: REACTION_NAMES[id], radius, spreads, terraShield: pair.includes('terra'), effect };
}

export const REACTION_DEFS: Readonly<Record<ReactionId, ReactionDef>> = {
  steamBurst: def('steamBurst', ['ember', 'tide'], 3, {
    kind: 'burst',
    bonusMul: 1.5,
    splashMul: 0.6,
    stagger: 1,
    hitStop: 0.07,
  }),
  lavaRift: def('lavaRift', ['ember', 'terra'], 3, {
    kind: 'zone',
    seconds: 4,
    tickInterval: 0.5,
    tickAtkMul: 0.25,
  }),
  mudBind: def('mudBind', ['tide', 'terra'], 4, { kind: 'root', seconds: 2.5 }),
  flameSpread: def('flameSpread', ['gale', 'ember'], 5, { kind: 'spread', atkMul: 0.8, slow: null }),
  mistSpread: def('mistSpread', ['gale', 'tide'], 5, {
    kind: 'spread',
    atkMul: null,
    slow: { pct: 0.4, seconds: 3 },
  }),
  sandGust: def('sandGust', ['gale', 'terra'], 5, { kind: 'spread', atkMul: 0.8, slow: null }),
};

/** Whether Terra is part of the reaction (lavaRift, mudBind, sandGust). */
export function terraInvolved(r: ReactionId): boolean {
  return REACTION_DEFS[r].pair.includes('terra');
}

/** "연쇄 x{n}" shows for `seconds` once one application chains at least `minCount` reactions (Req 25.7). */
export const CHAIN_DISPLAY = { minCount: 2, seconds: 1.5 } as const;

/** Icon silhouettes of the reactions (HUD reaction preview, codex, name popups). */
export type ReactionIconShape = 'steamCloud' | 'lavaCrack' | 'mudChain' | 'flameSwirl' | 'mistSwirl' | 'sandSwirl';

/** Presentation keys of a reaction: its own VFX, sound and icon (Req 25.9, 23.9). */
export interface ReactionPresentation {
  /** Visual effect played at the target. */
  vfx: `vfx_${string}`;
  /** Sound played at the target (the Audio_System maps it, task 16). */
  sfx: SfxId;
  icon: ReactionIconShape;
  /** 0xRRGGBB of the VFX, the name text and the icon. */
  color: number;
}

export const REACTION_PRESENTATION: Readonly<Record<ReactionId, ReactionPresentation>> = {
  steamBurst: { vfx: 'vfx_reaction_steam_burst', sfx: 'sfx_reaction_steam_burst', icon: 'steamCloud', color: 0xeaf6ff },
  lavaRift: { vfx: 'vfx_reaction_lava_rift', sfx: 'sfx_reaction_lava_rift', icon: 'lavaCrack', color: 0xff5a1f },
  mudBind: { vfx: 'vfx_reaction_mud_bind', sfx: 'sfx_reaction_mud_bind', icon: 'mudChain', color: 0x9a7444 },
  flameSpread: { vfx: 'vfx_reaction_flame_spread', sfx: 'sfx_reaction_flame_spread', icon: 'flameSwirl', color: 0xff9a3c },
  mistSpread: { vfx: 'vfx_reaction_mist_spread', sfx: 'sfx_reaction_mist_spread', icon: 'mistSwirl', color: 0x8fd8ff },
  sandGust: { vfx: 'vfx_reaction_sand_gust', sfx: 'sfx_reaction_sand_gust', icon: 'sandSwirl', color: 0xe0c07a },
};
