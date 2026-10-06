/*
 * SaveEnvelope (design "저장 키와 형식", Req 36.1, 36.9): the one JSON document stored under the main and backup keys.
 * `state` is the canonical GameState; `checksum` is FNV-1a 32-bit hex of `JSON.stringify(state)`, recomputed from the
 * parsed state on load (JSON.parse keeps key order, so an unchanged document gives the same string). Pure.
 */
import { fnv1a32Hex } from './checksum';
import { canonicalizeGameState, SAVE_VERSION, type DeepReadonly, type GameState } from './gameState';

export const SAVE_FORMAT = 'skyshard-save';

export interface SaveEnvelope {
  format: typeof SAVE_FORMAT;
  version: number;
  /** ISO 8601 UTC. */
  savedAt: string;
  playTimeSec: number;
  checksum: string;
  state: GameState;
}

/** Checksum of a state value as the envelope stores it. */
export function stateChecksum(state: unknown): string {
  return fnv1a32Hex(JSON.stringify(state));
}

/** The envelope JSON for `gs` (canonical form) after `playTimeSec` of play; `savedAt` defaults to now. */
export function serializeSave(gs: DeepReadonly<GameState>, playTimeSec: number, savedAt: string = new Date().toISOString()): string {
  const state = canonicalizeGameState(gs);
  const envelope: SaveEnvelope = {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    savedAt,
    playTimeSec: Number.isFinite(playTimeSec) && playTimeSec > 0 ? playTimeSec : 0,
    checksum: stateChecksum(state),
    state,
  };
  return JSON.stringify(envelope);
}
