/*
 * Crossfade times (design.md "레이어와 블렌드", Req 39.8): every layer entry / exit and every clip change inside a layer
 * blends over 0.1–0.25 s. Default 0.15 s; attack chains, Dodge and windup → strike 0.1 s; entering the glide or a swim
 * 0.25 s. A Vitest test keeps every value inside the range.
 */

/** Allowed crossfade range (s). */
export const BLEND_RANGE = { min: 0.1, max: 0.25 } as const;

export const BLEND_TIMES = {
  /** Anything not listed below. */
  default: 0.15,
  /** One attack clip into the next (the Normal_Attack chain, Charged / Skill / Burst after a hit). */
  attackChain: 0.1,
  /** Into or out of the Dodge. */
  dodge: 0.1,
  /** An enemy / Caelith windup into its strike. */
  windupToStrike: 0.1,
  /** Into the hurt flinch (reads at once). */
  hurt: 0.1,
  /** Into the glider (deploy or glide). */
  glideEnter: 0.25,
  /** Into the swim. */
  swimEnter: 0.25,
} as const satisfies Readonly<Record<string, number>>;

const HERO_ATTACK = /^(kairen|isla|wren|talus)_(n\d|charged|skill|burst)$/;

/** Crossfade from clip / blend `from` to `to` (null: the layer is entering or leaving). */
export function blendTime(from: string | null, to: string | null): number {
  if (to === 'swim') return BLEND_TIMES.swimEnter;
  if (to === 'glide' || to === 'glideDeploy') return BLEND_TIMES.glideEnter;
  if (from === 'dodge' || to === 'dodge') return BLEND_TIMES.dodge;
  if (from !== null && from.endsWith('_windup')) return BLEND_TIMES.windupToStrike;
  if (from !== null && to !== null && HERO_ATTACK.test(from) && HERO_ATTACK.test(to)) return BLEND_TIMES.attackChain;
  if (to !== null && (to === 'hurt' || to.endsWith('_hurt'))) return BLEND_TIMES.hurt;
  return BLEND_TIMES.default;
}
