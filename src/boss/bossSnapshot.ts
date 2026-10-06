// The BossEncounter snapshot (design "Boss Caelith" 인터페이스): what the HUD boss bar, the Starshell display, the
// Test_Harness and the simulation tests read of the fight (`BossSnapshot`), and the fuller `CaelithSnapshot` the
// BossEncounter (./bossEncounter) fills for the views, the VFX decals, the Audio_System and the route bot: pose,
// active Telegraphs with their shapes, the Astral Sweep ring, shards in flight, crystals with their Reaction preview,
// the Phase's music and the sky preset.
// Types only: no three.js / DOM.

import type { Vec3 } from '../core/types';
import type { CaelithAttackId } from '../data/boss';
import type { ElementId, ReactionId } from '../data/ids';
import type { BossPhase } from '../logic/boss';

/**
 * The design's states plus 'dormant': not fighting yet, or again after the party left for the Waystone (the HUD
 * hides the bar; the Test_Harness reports no boss then).
 */
export type BossState =
  | 'dormant' | 'intro' | 'idle' | 'telegraph' | 'attack' | 'recovery' | 'stagger' | 'disabled' | 'transition' | 'dead';

/** An active Starshell: its Element and durability out of the Phase's maximum (1,200 / 900). */
export interface StarshellSnapshot {
  readonly element: ElementId;
  readonly durability: number;
  readonly max: number;
}

export interface BossSnapshot {
  /** Display name (proper noun, English). */
  readonly name: string;
  readonly phase: BossPhase;
  readonly hp: number;
  readonly maxHp: number;
  /** HP ratios where Phase 2 and the Final Phase begin (0.65, 0.30): the bar's Phase notches. */
  readonly thresholds: readonly number[];
  readonly state: BossState;
  /** Attack being played, or null. */
  readonly attack: string | null;
  /** Seconds until the playing attack's next judgement (its Telegraph), 0 when none. */
  readonly telegraphRemaining: number;
  /** The Starshell while it stands (not broken, not suppressed by a vulnerable window), else null. */
  readonly starshell: StarshellSnapshot | null;
  /** Damage taken ×1.5 (the Phase 1 and Astral Sweep windows, `disabled`). */
  readonly vulnerable: boolean;
  /** Shard_Crystals standing on their pedestals. */
  readonly crystals: readonly { readonly element: ElementId; readonly hp: number }[];
}

/**
 * The area of a Telegraph, on the arena floor (`center.y` is the floor):
 * - circle: `radius` around `center` (groundSlam, starfall, the Shard_Crystal pulse);
 * - sector: `radius` / `angleDeg` in front of `yaw` from `center` (slashCombo);
 * - line: `length` × `width` from `center` along `yaw` (dash);
 * - aim: one starShards aim line, `length` × `width` from `center` along `yaw`;
 * - arenaSector: floor sector `sector` (0–7) of the arena, `angleDeg` 45 around bearing `yaw`, `radius` the arena's;
 * - ring: the Astral Sweep's warning glow around `center`; `radius` is where the ring starts (0).
 */
export type BossTelegraphShape = 'circle' | 'sector' | 'line' | 'aim' | 'arenaSector' | 'ring';

/** A Telegraph showing now (VFX decal agent, off-screen arrows, route bot). Unused fields are 0 (`sector` −1). */
export interface BossTelegraph {
  /** Unique per shown Telegraph (stable while it shows). */
  readonly id: number;
  /** The attack, or 'shardCrystal_pulse'. */
  readonly attack: CaelithAttackId | 'shardCrystal_pulse';
  readonly shape: BossTelegraphShape;
  readonly center: Readonly<Vec3>;
  /** Facing (core/math yaw) of sectors, lines and aims; an arenaSector's centre bearing as a yaw. */
  readonly yaw: number;
  readonly radius: number;
  readonly angleDeg: number;
  readonly length: number;
  readonly width: number;
  readonly sector: number;
  /** Seconds until it is judged. */
  readonly remaining: number;
  /** Its whole warning (s): ≥ 0.8 strong, ≥ 0.4 normal (Req 6.9). */
  readonly duration: number;
  readonly strong: boolean;
}

/** The Astral Sweep's expanding ring while it crosses the arena. */
export interface BossRingSnapshot {
  readonly center: Readonly<Vec3>;
  /** Outer edge now (m); the band is `thickness` wide inside it. */
  readonly radius: number;
  readonly thickness: number;
  /** Height above the floor: feet higher than this clear it (Req 6.8). */
  readonly height: number;
}

/** A standing Shard_Crystal for the views and the HUD's Reaction icon above it. */
export interface CrystalSnapshot {
  readonly element: ElementId;
  readonly hp: number;
  readonly maxHp: number;
  /** Pedestal top (the crystal's feet). */
  readonly pos: Readonly<Vec3>;
  /** Reaction its break would cause on Caelith now (same function as the standby slot preview, Req 23.9), or null. */
  readonly reaction: ReactionId | null;
  /** Caelith stands within the 6 m mark radius: breaking it now marks Caelith (the icon is highlighted). */
  readonly caelithNear: boolean;
}

/** The sky / lighting preset of the arena: dusk in Phases 1–2, the starlit night from the Final Phase (Req 6.7). */
export type BossSkyPreset = 'dusk' | 'starNight';

export interface CaelithSnapshot extends BossSnapshot {
  readonly attack: CaelithAttackId | null;
  readonly crystals: readonly CrystalSnapshot[];
  /** Caelith's feet (it floats CAELITH.hover above the floor) and facing. */
  readonly pos: Readonly<Vec3>;
  readonly yaw: number;
  /** Seconds since the playing attack started, 0 when none. */
  readonly attackTime: number;
  /** Seconds in the current state (the death fade reads it). */
  readonly stateTime: number;
  /** Seconds left of the current `stagger` / `disabled` / `transition`, else 0. */
  readonly stateRemaining: number;
  /** Telegraphs showing now (Caelith's and the crystal pulses'). */
  readonly telegraphs: readonly BossTelegraph[];
  /** The Astral Sweep ring in flight, or null. */
  readonly ring: BossRingSnapshot | null;
  /** starShards in flight. */
  readonly shards: readonly Readonly<Vec3>[];
  /** The Phase's music (Audio_System): mus_boss_p1 / p2 / p3, switched as each transition starts. */
  readonly music: 'mus_boss_p1' | 'mus_boss_p2' | 'mus_boss_p3';
  /** Arena sky / lighting (render): 'starNight' from the start of the Final Phase transition. */
  readonly skyPreset: BossSkyPreset;
  /** A Starshell exists but a vulnerable window suppresses it (it comes back as it was). */
  readonly starshellSuppressed: boolean;
  /** Starshell breaks so far in this fight (a change triggers the shard VFX / camera impulse). */
  readonly starshellBreaks: number;
  /** The fight stopped on a Party_Wipe until the Defeat choice. */
  readonly halted: boolean;
}
