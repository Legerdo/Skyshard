// EquipEffects at run time (design "장비", "효과 표현"; Req 30.1, 30.3). The modifiers are read from GameState's
// loadout on every call (logic/equipment equipModifiers), so an equip or unequip applied by the Inventory_System at
// the start of a tick is in force for the rest of that tick and a removed item stops at once.
// Handled here:
// - perfectDodgeHeal (이슬방울 부적): on 'perfectDodge', the dodging character heals `pct` × max HP.
// - reactionEnergyToParty (메아리 소라): on 'reaction' (credited to the Active_Character, as the combat system's own
//   Reaction Energy is), every joined, living standby member gains `amount` Energy, clamped to its Burst cost.
// - outOfCombatRegen (새싹 씨앗, party Relic): while not In_Combat, every joined living member heals `pctPerSec` ×
//   max HP per second (whole HP points; fractions carry over).
// - dodgeStaminaMul (깃털 방울): dodgeRefund() is the Stamina PlaySim gives back to the controller after a Dodge starts.
// Read by other systems through modifiers(): crit chance, Reaction damage and the pillar bonus (PlayerCombat),
// the Chest Compass radius (HUD, chestCompassRadius). Pure TypeScript: no three.js / DOM.

import type { GameEventBus } from '../core/gameEvents';
import { CHARACTERS } from '../data/characters';
import { CHARACTER_IDS, type CharacterId } from '../data/ids';
import { addEnergy } from '../logic/energy';
import { DODGE_STAMINA_COST, staminaMultiplier } from '../logic/stamina';
import { equipModifiers, type EquipModifiers } from '../logic/equipment';
import type { GameState } from '../logic/save/gameState';
import type { PartySystem } from '../party/partySystem';
import type { RuntimeState } from '../save/runtimeState';

export interface EquipmentEffectsOptions {
  bus: GameEventBus;
  /** Reads the loadout, the joined / Downed members and the Active_Character. */
  state: Pick<GameState, 'party'>;
  /** Energy per character (changed here) and the In_Combat flag. */
  runtime: Pick<RuntimeState, 'energy' | 'inCombat'>;
  party: Pick<PartySystem, 'heal' | 'restoreHp' | 'maxHp'>;
}

export class EquipmentEffects {
  private readonly o: EquipmentEffectsOptions;
  private readonly unsubscribe: (() => void)[];
  /** Regenerated HP not yet applied (below one point), per character. */
  private readonly regen = new Map<CharacterId, number>();

  constructor(options: EquipmentEffectsOptions) {
    this.o = options;
    this.unsubscribe = [
      options.bus.on('perfectDodge', (p) => this.perfectDodge(p.characterId)),
      options.bus.on('reaction', () => this.reaction()),
    ];
  }

  /** `characterId`'s modifiers now: its Weapon and Charm, and the party Relic. */
  modifiers(characterId: CharacterId): EquipModifiers {
    return equipModifiers(this.o.state.party, characterId);
  }

  /** Radius (m) within which unopened Chests show on the Compass; 0 without the compass Relic (HUD). */
  get chestCompassRadius(): number {
    return this.modifiers(this.o.state.party.active).chestCompassRadius;
  }

  /**
   * dodgeStaminaMul (깃털 방울): the Stamina to give back after a Dodge started this tick by the Active_Character paid
   * its full cost, so it costs DODGE_STAMINA_COST × passive × mul in the end; 0 without the Charm.
   */
  dodgeRefund(): number {
    const id = this.o.state.party.active;
    const mul = this.modifiers(id).dodgeStaminaMul;
    return mul < 1 ? DODGE_STAMINA_COST * staminaMultiplier(id, 'dodge') * (1 - Math.max(0, mul)) : 0;
  }

  /** Out-of-combat regeneration for `dt` s (after In_Combat is known for the tick). */
  tick(dt: number): void {
    if (!(Number.isFinite(dt) && dt > 0)) return;
    const { party } = this.o.state;
    const rate = this.modifiers(party.active).outOfCombatRegenPctPerSec; // the Relic is party-wide
    if (rate <= 0 || this.o.runtime.inCombat) {
      this.regen.clear();
      return;
    }
    for (const id of CHARACTER_IDS) {
      if (!party.joined.includes(id) || party.downed.includes(id)) continue;
      const max = this.o.party.maxHp(id);
      if (party.hp[id] >= max || party.hp[id] <= 0) {
        this.regen.delete(id);
        continue;
      }
      const pending = (this.regen.get(id) ?? 0) + max * rate * dt;
      const whole = Math.floor(pending + 1e-9); // a float sum of ticks lands a hair under whole points
      this.regen.set(id, Math.max(0, pending - whole));
      if (whole >= 1) this.o.party.restoreHp(id, whole);
    }
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  private perfectDodge(id: CharacterId): void {
    const pct = this.modifiers(id).perfectDodgeHealPct;
    if (pct > 0) this.o.party.heal(id, pct);
  }

  private reaction(): void {
    const { party } = this.o.state;
    const amount = this.modifiers(party.active).reactionEnergyToParty;
    if (amount <= 0) return;
    const { energy } = this.o.runtime;
    for (const id of CHARACTER_IDS) {
      if (id === party.active || !party.joined.includes(id) || party.downed.includes(id)) continue;
      energy[id] = addEnergy(energy[id], CHARACTERS[id].burst.energyCost, amount);
    }
  }
}
