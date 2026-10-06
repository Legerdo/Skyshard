/*
 * UiCommand queue (design.md "상태 계층", "UI 구조"): UI handlers never change GameState or RuntimeState
 * themselves. A screen button that changes game state queues a UiCommand; at the start of the next fixed
 * tick the owning simulation system validates and applies it, and the UI reads the result back from the
 * read-only state. Pure data, no DOM, so simulation systems may depend on it (src/ui may not be imported
 * from simulation code).
 *
 * The full command vocabulary is declared here up front (tasks 12–22) so the owning systems and screens can be
 * built independently; PlaySim.apply routes each kind to its owner (unhandled kinds are ignored there).
 */
import type { CharacterId, ItemId, SideQuestId, WaystoneId } from '../data/ids';

/** Defeat Screen choice (design `DefeatChoice`): normal wipe, or the two Caelith options (Req 27.3, 6.13). */
export type DefeatChoice = 'respawn' | 'retryPhase' | 'returnToWaystone';

/** Equipment slot a Weapon / Charm (per character) or the party Relic goes into (Req 30.2). */
export type EquipSlot = 'weapon' | 'charm' | 'relic';

/** Upgradable ability at the Echo Altar (Req 29.4). */
export type UpgradeAbility = 'skill' | 'burst';

/** Debug_Tools panel operation (Req 41.1): applied on the next tick through the normal public methods. */
export type DebugAction =
  | { readonly op: 'invincible'; readonly on: boolean }
  | { readonly op: 'joinAll' }
  | { readonly op: 'grantGlim'; readonly amount: number }
  | { readonly op: 'grantSkyshard' }
  | { readonly op: 'teleport'; readonly x: number; readonly z: number }
  | { readonly op: 'bossDirect' }
  | { readonly op: 'showAi'; readonly on: boolean };

export type UiCommand =
  /** Defeat Screen button: restart at the respawn point, retry the current Caelith Phase, or go to the Waystone. */
  | { readonly kind: 'defeatChoice'; readonly choice: DefeatChoice }
  /** Victory Screen "탐험 계속" (Req 7.5): back to Thistlewick in the post-ending world. */
  | { readonly kind: 'continueExploring' }
  /** Pip's shop (Req 14.11, 14.12): Inventory_System validates with `purchase` next tick. */
  | { readonly kind: 'purchase'; readonly itemId: ItemId }
  /** Equip (itemId) or unequip (null) a slot (Req 30.2, 30.3); `characterId` is ignored for the party Relic. */
  | { readonly kind: 'equip'; readonly characterId: CharacterId; readonly slot: EquipSlot; readonly itemId: ItemId | null }
  /** Echo Altar (Req 29.4–29.6): Progression_System re-validates with `canUpgrade` next tick. */
  | { readonly kind: 'upgradeAbility'; readonly characterId: CharacterId; readonly ability: UpgradeAbility }
  /** Inventory item use; the Ember Feather needs a Downed `target` (Req 27.6). */
  | { readonly kind: 'useItem'; readonly itemId: ItemId; readonly target?: CharacterId }
  /** Map Waystone fast travel (Req 11.4, 11.5): refused In_Combat. */
  | { readonly kind: 'fastTravel'; readonly waystoneId: WaystoneId }
  /** Pause "끼임 해제" (Req 20.8): the automatic stuck-recovery path. */
  | { readonly kind: 'unstuck' }
  /** Quest screen: the tracked Side_Quest (`QuestState.tracked`), or none (Req 15.4). */
  | { readonly kind: 'trackQuest'; readonly questId: SideQuestId | null }
  /** Debug_Tools panel (`?debug=1` only, Req 41.1, 41.2). */
  | { readonly kind: 'debug'; readonly action: DebugAction };

/** FIFO of UI commands waiting for the next tick. */
export class UiCommandQueue {
  private queue: UiCommand[] = [];

  /** Commands waiting for the next tick. */
  get size(): number {
    return this.queue.length;
  }

  push(command: UiCommand): void {
    this.queue.push(command);
  }

  /** Takes every waiting command in push order and empties the queue. */
  drain(): UiCommand[] {
    const commands = this.queue;
    this.queue = [];
    return commands;
  }

  /** Drops every waiting command (the session they were meant for has ended). */
  clear(): void {
    this.queue = [];
  }
}
