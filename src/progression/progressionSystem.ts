// Progression_System (design "경험치와 레벨", "능력 강화 (Echo Altar)"; Req 29.1–29.6): the party's shared XP and
// level and the Echo Altar tiers in GameState.
// - XP from any source adds up through logic/progression addXp (3,000 cap, the rest discarded) and the level always
//   follows from the total (levelFromXp). A gain that raises the level emits 'levelUp' once with the final level,
//   however many levels it crossed, plus a 'levelUp' Milestone 'save:request' (Req 36.3). The Party_System heals
//   everyone on 'levelUp' (Req 29.2); Render and Audio play its pillar of light and sound (tasks 15–16).
// - Sources (XP_SOURCES): the Loot_System grants enemy / Elite XP on 'enemy:defeated'; the Main_Quest stages and
//   Side_Quests grant theirs through their 'grant' effects (PlaySim's quest sink); this system grants Chest XP on
//   'chest:opened' (by tier), first-discovery XP on 'landmark:discovered' and 'waystone:activated', and
//   grantDiscovery() is the entry for the other first discoveries (Vista_Point, hidden place, Echo_Tablet, lore
//   stone) whose systems record them. Each Chest / discovery id pays once per session here; their owners record the
//   ids in GameState so a load never announces them again.
// - Echo Altar: upgradeAbility() (the `upgradeAbility` UiCommand, next tick) re-validates with canUpgradeAbility,
//   has the Inventory_System take the Starmote and Glim, and raises the tier (max 3). Combat reads the tier's kit
//   effects from GameState (logic/upgrades).
// Pure TypeScript: no three.js / DOM.

import type { ChestTier, GameEventBus } from '../core/gameEvents';
import type { CharacterId } from '../data/ids';
import { XP_SOURCES, type DiscoveryKind } from '../data/progression';
import { addXp, levelFromXp, upgradeCost, type UpgradeCheck } from '../logic/progression';
import type { GameState } from '../logic/save/gameState';
import { canUpgradeAbility, type UpgradeAbility } from '../logic/upgrades';

export interface ProgressionSystemOptions {
  /** Owns `party.xp`, `party.level` and `party.upgrades`. */
  state: GameState;
  bus: GameEventBus;
}

/** What upgradeAbility pays through (InventorySystem.spend). */
export interface UpgradePayer {
  /** Takes `starmote` Starmote and `glim` Glim when both are held; false (nothing taken) otherwise. */
  spend(starmote: number, glim: number): boolean;
}

/** Result of an Echo Altar upgrade request. */
export type UpgradeResult = { ok: true; tier: 1 | 2 | 3 } | { ok: false; check: UpgradeCheck };

export class ProgressionSystem {
  private readonly state: GameState;
  private readonly bus: GameEventBus;
  /** `kind:id` of the Chests and discoveries already paid this session. */
  private readonly paid = new Set<string>();
  private readonly unsubscribe: (() => void)[];

  constructor(options: ProgressionSystemOptions) {
    this.state = options.state;
    this.bus = options.bus;
    this.unsubscribe = [
      this.bus.on('chest:opened', (p) => this.grantChest(p.chestId, p.tier)),
      this.bus.on('landmark:discovered', (p) => this.grantDiscovery('landmark', p.landmarkId)),
      this.bus.on('waystone:activated', (p) => this.grantDiscovery('waystone', p.waystoneId)),
    ];
  }

  /** Adds `amount` XP (non-positive or non-finite adds nothing); returns the XP actually added. */
  grantXp(amount: number): number {
    const { party } = this.state;
    const before = party.xp;
    party.xp = addXp(before, amount);
    const level = levelFromXp(party.xp);
    if (level > party.level) {
      party.level = level;
      this.bus.emit('levelUp', { level });
      this.bus.emit('save:request', { reason: 'levelUp' });
    }
    return party.xp - before;
  }

  /** First-discovery XP of `kind` for `id` (Landmark 20, Vista_Point 30, ...), once per id; returns the XP added. */
  grantDiscovery(kind: DiscoveryKind, id: string): number {
    return this.once(`${kind}:${id}`) ? this.grantXp(XP_SOURCES.discovery[kind]) : 0;
  }

  /** Chest opening XP by tier (일반 10 · 정교한 25 · 빛나는 50), once per Chest; returns the XP added. */
  grantChest(chestId: string, tier: ChestTier): number {
    return this.once(`chest:${chestId}`) ? this.grantXp(XP_SOURCES.chest[tier]) : 0;
  }

  /**
   * Echo Altar (Req 29.4, 29.6): raises `characterId`'s `ability` one tier when canUpgradeAbility allows it and
   * `payer` takes the cost. Refused (nothing changes) with the check's missing amounts, or at tier 3.
   */
  upgradeAbility(characterId: CharacterId, ability: UpgradeAbility, payer: UpgradePayer): UpgradeResult {
    const check = canUpgradeAbility(this.state, characterId, ability);
    if (!check.ok || check.nextTier === null) return { ok: false, check };
    const cost = upgradeCost(check.nextTier);
    if (!payer.spend(cost.starmote, cost.glim)) return { ok: false, check };
    this.state.party.upgrades[characterId][ability] = check.nextTier;
    return { ok: true, tier: check.nextTier };
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  private once(key: string): boolean {
    if (this.paid.has(key)) return false;
    this.paid.add(key);
    return true;
  }
}
