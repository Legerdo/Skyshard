// The Active_Character as a HitReceiver for enemy attacks (design "공격·피격·Stagger", Req 28.10, 24.8).
// Enemy hits resolve with kind 'enemy' and critChance 0 through computeDamage, against the character's DEF.
// Dodge i-frames, the Burst cut-in (and 0 HP) make hits pass through; a hit volume overlapping the character during the i-frames is
// reported through `onEvade` (Perfect_Dodge, src/combat/perfectDodge). The damage lowers the character's current HP in GameState
// and emits 'player:damaged'; HP stops at 0, where the Party_System (src/party) marks the character Downed after
// the tick's hits, and a Downed Active_Character takes no further hits until the automatic switch. A hit with a
// knockback hands its push (direction away from the attacker, distance) to `onKnockback`, which the composition
// root turns into the controller's knockback slide.

import type { Vec3 } from '../core/types';
import type { GameEventBus } from '../core/gameEvents';
import { CHARACTERS } from '../data/characters';
import type { EntityId } from '../data/ids';
import type { GameState } from '../logic/save/gameState';
import { statsAt } from '../logic/progression';
import { CAPSULE_HEIGHT, CAPSULE_RADIUS } from '../player/core/constants';
import type { ControllerState } from '../player/core/types';
import type { HitReceiver, ResolvedHit, TargetSample } from './attackRuntime';

/** Entity id of the Active_Character in combat (the switchable body is always "the player"). */
export const PLAYER_ENTITY_ID = 'player';

export interface PlayerReceiverOptions {
  gameState: GameState;
  bus: GameEventBus;
  /** The Active_Character's controller state after this tick's movement. */
  body: () => Readonly<Pick<ControllerState, 'pos' | 'iFrames'>>;
  /** A hit volume overlapped the character during Dodge i-frames (Perfect_Dodge check, Req 24.9). */
  onEvade?: (attackerId: EntityId, iFrames: number) => void;
  /** Invulnerable outside Dodge i-frames (the Burst cut-in, Req 24.6); such evasions are no Perfect_Dodge. */
  invulnerable?: () => boolean;
  /** A landed hit pushes the character `distance` m along the horizontal unit `direction` (the hit's knockback). */
  onKnockback?: (direction: Readonly<Vec3>, distance: number) => void;
}

export function createPlayerReceiver({
  gameState, bus, body, onEvade, invulnerable, onKnockback,
}: PlayerReceiverOptions): HitReceiver {
  const { party } = gameState;
  const down = (): boolean => party.hp[party.active] <= 0 || party.downed.includes(party.active);
  return {
    id: PLAYER_ENTITY_ID,
    hurtVolume: () => ({ pos: body().pos, radius: CAPSULE_RADIUS, height: CAPSULE_HEIGHT }),
    immune: () => body().iFrames > 0 || down() || (invulnerable?.() ?? false),
    evade: (attackerId) => {
      const iFrames = body().iFrames;
      if (iFrames > 0 && !down()) onEvade?.(attackerId, iFrames);
    },
    sample: (): TargetSample => ({
      def: statsAt(CHARACTERS[party.active].baseStats, party.level).def,
      frontGuard: false,
      shieldElement: null,
      vulnerable: false,
      terraMarked: false,
    }),
    receive: (hit: ResolvedHit) => {
      const id = party.active;
      party.hp[id] = Math.max(0, party.hp[id] - hit.amount);
      // `direction` points from the attacker to the character; the HUD wants the way back to the attacker.
      const fromDirection: Vec3 = { x: 0 - hit.direction.x, y: 0, z: 0 - hit.direction.z };
      bus.emit('player:damaged', { characterId: id, amount: hit.amount, fromDirection });
      if (hit.knockback > 0) onKnockback?.(hit.direction, hit.knockback);
    },
  };
}
