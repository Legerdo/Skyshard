/*
 * Reads a PlaySim into the HudModel's input (task 14.3): the party slots with their tier cooldowns, Energy and
 * reaction previews, the enemies with the Lock-on target and the Element_Mark clock, In_Combat and the party level.
 * Read only; kept apart from ./hudModel so the model's rules stay testable without a simulation.
 */
import type { Vec3 } from '../core/types';
import { abilityAtTier, CHARACTERS } from '../data/characters';
import { SWITCH_LOCK_SECONDS } from '../logic/party';
import type { PlaySim } from '../playSim';
import type { HudInput, HudPartyInput } from './hudModel';

export interface HudSourceOptions {
  /** Bound key labels of the Skill and Burst. */
  readonly skillKey: string;
  readonly burstKey: string;
  /** Render camera position and the frame's interpolation alpha. */
  readonly camera: Readonly<Vec3>;
  readonly alpha: number;
}

/** This frame's HudInput from `sim`. */
export function hudInputOf(sim: PlaySim, options: HudSourceOptions): HudInput {
  const { gameState, runtime } = sim;
  const previews = sim.reactionPreviews();
  const party: HudPartyInput[] = sim.party.slots().map((s, i) => {
    const def = CHARACTERS[s.id];
    const tier = gameState.party.upgrades[s.id]?.skill ?? 0;
    return {
      id: s.id,
      slot: s.slot,
      name: s.name,
      element: def.element,
      joined: s.joined,
      downed: s.downed,
      active: s.active,
      hp: s.hp,
      maxHp: s.maxHp,
      skillRemaining: s.skillCooldown,
      skillCooldown: abilityAtTier(def.skill, tier).cooldown ?? def.skill.cooldown,
      energy: runtime.energy[s.id],
      energyCost: def.burst.energyCost,
      shakeSeq: s.shakeSeq,
      preview: previews[i]?.reaction ?? null,
    };
  });
  return {
    inCombat: runtime.inCombat,
    level: gameState.party.level,
    party,
    switchLock: SWITCH_LOCK_SECONDS > 0 ? sim.party.lockRemaining / SWITCH_LOCK_SECONDS : 0,
    skillKey: options.skillKey,
    burstKey: options.burstKey,
    enemies: runtime.enemies.values(),
    lockTarget: runtime.lockTarget,
    now: sim.enemies.simTime,
    camera: options.camera,
    alpha: options.alpha,
  };
}
