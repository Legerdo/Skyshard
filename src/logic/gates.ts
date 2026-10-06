/*
 * Progress gate rules (design.md "진행 게이트", "진행 게이트 요약"; Req 4.5, 4.6, 4.9, 5.2, 5.3, 2.7).
 * Everything is derived from GameState's Skyshard count and altar flag on every call, never stored,
 * so a load gives the same barriers, Region locks, altar state and stair as before the save.
 *
 * Pure: no three.js, DOM or Math.random.
 */

import { BARRIERS, type BarrierDef, type BarrierRequirement } from '../data/barriers';
import { BARRIER_IDS, type BarrierId, type RegionId } from '../data/ids';

/** The GameState fields the gates are derived from. */
export interface WorldProgress {
  readonly skyshards: number;
  readonly altarActivated: boolean;
}

/** Skyshards the Resonance_Altar needs (Req 5.2, 5.4). */
export const ALTAR_SKYSHARDS = 3;

/** Whether `req` is met: enough Skyshards and, when required, the activated altar. */
export function requirementMet(req: BarrierRequirement, p: WorldProgress): boolean {
  return p.skyshards >= req.skyshards && (!req.altar || p.altarActivated);
}

/** Whether a barrier is open under `p`: gate_ember / veil_ember from 1 Skyshard, the azure pair from 2, the seal once the altar is activated. */
export function isBarrierOpen(id: BarrierId, p: WorldProgress, defs: Readonly<Record<BarrierId, BarrierDef>> = BARRIERS): boolean {
  return requirementMet(defs[id].requires, p);
}

/** Barriers open under `p`, in registry order. */
export function openBarrierIds(p: WorldProgress, defs: Readonly<Record<BarrierId, BarrierDef>> = BARRIERS): BarrierId[] {
  return BARRIER_IDS.filter((id) => isBarrierOpen(id, p, defs));
}

/**
 * Whether a Region can be entered: every barrier guarding it is open. Verdant Reach and Shardfall
 * Crater have none and are open from the start (A8).
 */
export function regionUnlocked(region: RegionId, p: WorldProgress, defs: Readonly<Record<BarrierId, BarrierDef>> = BARRIERS): boolean {
  return BARRIER_IDS.every((id) => defs[id].region !== region || isBarrierOpen(id, p, defs));
}

/** "Skyshard n/필요 수" for a closed barrier (Req 4.9): the held count against the count it needs. */
export function barrierPromptText(def: BarrierDef, p: WorldProgress): string {
  return `Skyshard ${Math.min(p.skyshards, def.requires.skyshards)}/${def.requires.skyshards}`;
}

/** Resonance_Altar state: gathering Skyshards, ready to activate, or activated. */
export type AltarStatus = 'charging' | 'ready' | 'activated';

export function altarStatus(p: WorldProgress): AltarStatus {
  if (p.altarActivated) return 'activated';
  return p.skyshards >= ALTAR_SKYSHARDS ? 'ready' : 'charging';
}

/** The altar's status line (Req 5.2): "Skyshard n/3" until all three are held. */
export function altarPromptText(p: WorldProgress): string {
  return altarStatus(p) === 'charging' ? `Skyshard ${p.skyshards}/${ALTAR_SKYSHARDS}` : '공명시키기';
}

/** The light pillar over the altar shows from Skyshard 3 on (Req 5.3). */
export function altarPillarVisible(p: WorldProgress): boolean {
  return p.skyshards >= ALTAR_SKYSHARDS;
}
