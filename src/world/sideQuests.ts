// Side_Quest scene adapter in the World (design.md "Side_Quest", task 13.3; Req 15.1–15.5).
// - Quest-only objects exist only while their QuestDef does: sq_tamsin's kite on the Breezewatch windmill top is an
//   interaction target (kind 'questItem') only with sq_tamsin defined, and it can be taken only while sq_tamsin is
//   'active' at its kite Objective (the Quest_System turns the 'interact' into the `interact sq_tamsin_kite` trigger).
//   sq_durga's braziers are Puzzle_Mechanisms placed only for defined Side_Quests (src/data/sideQuests.ts
//   sideQuestPuzzles, PlaySim's puzzle list).
// - Acceptance re-send: progress the World already holds when a Side_Quest is accepted (a cleared Enemy_Camp in
//   GameState.world.camps, a solved puzzle in world.puzzles) is sent again as the quest event of its current Objective,
//   so a pre-completed Objective completes at once. The re-send waits for the accepting dialogue's 'dialogue:ended' to
//   be handled first (without a talk, for the second tick after the acceptance), so the offer talk itself never also
//   counts as the hand-in talk.
// - World changes (the kite over the village, the field's flowers, the relit forge) are GameState flags set by the
//   quests' `onComplete`; the village look reads them (src/logic/village.ts), so a load restores them.
// Pure TypeScript: no three.js / DOM.

import type { GameEventBus } from '../core/gameEvents';
import type { Vec3 } from '../core/types';
import { KITE_HEIGHT, KITE_POS, KITE_RADIUS, KITE_TARGET_ID } from '../data/sideQuests';
import type { SideQuestId } from '../data/ids';
import { currentObjective } from '../logic/quest/questReducer';
import type { QuestDef, QuestEvent } from '../logic/quest/types';
import type { GameState } from '../logic/save/gameState';
import type { InteractTarget } from '../player/interaction';

/** Where the kite is: on the windmill blade tip, carried (taken, not yet handed in), or flying over the village. */
export type KiteState = 'hanging' | 'carried' | 'flying' | 'none';

/** Longest chain of pre-completed Objectives one acceptance can complete (a guard; the quests have two). */
const MAX_RESENDS = 8;

export interface SideQuestWorldOptions {
  bus: GameEventBus;
  /** Read: quests, world.camps, world.puzzles, inventory. */
  state: GameState;
  /** The quest content in play (a dropped Side_Quest has no objects). */
  questDefs: readonly QuestDef[];
  /** The Quest_System's event entry (QuestSystem.handle). */
  quests: { handle(ev: QuestEvent): void };
}

export class SideQuestWorld {
  private readonly o: SideQuestWorldOptions;
  private readonly unsubscribe: () => void;
  /** Accepted Side_Quests waiting for their re-send, with the sim ticks begun since the acceptance. */
  private readonly pending: { quest: SideQuestId; ticks: number }[] = [];

  constructor(options: SideQuestWorldOptions) {
    this.o = options;
    // Subscribed after the Quest_System, so the accepting talk's 'dialogue:ended' is handled before the re-send.
    this.unsubscribe = options.bus.on('dialogue:ended', () => this.flush());
  }

  /** Whether Side_Quest `id` is defined in this session's content. */
  defined(id: SideQuestId): boolean {
    return this.o.questDefs.some((q) => q.id === id);
  }

  /** The kite's place for the view; 'none' without sq_tamsin. */
  kiteState(): KiteState {
    if (!this.defined('sq_tamsin')) return 'none';
    const side = this.o.state.quests.side.sq_tamsin;
    if (side.status === 'done') return 'flying';
    if (side.status === 'active' && this.currentObjectiveId('sq_tamsin') !== 'sq_tamsin_kite') return 'carried';
    return 'hanging';
  }

  /** The kite (only with sq_tamsin defined). */
  interactTargets(): InteractTarget[] {
    if (!this.defined('sq_tamsin')) return [];
    const pos: Vec3 = { ...KITE_POS };
    return [{
      kind: 'questItem', id: KITE_TARGET_ID, name: 'Tamsin의 연', a: pos, b: pos, radius: KITE_RADIUS, height: KITE_HEIGHT,
      detail: () => '되찾기',
      available: () => this.kiteCollectable(),
    }];
  }

  /** The kite can be taken only while sq_tamsin is 'active' at its kite Objective (Req 15.2). */
  kiteCollectable(): boolean {
    return this.o.state.quests.side.sq_tamsin.status === 'active' && this.currentObjectiveId('sq_tamsin') === 'sq_tamsin_kite';
  }

  /** QuestSinks.accepted: remember the quest; its held progress is re-sent once the accepting talk is handled. */
  accepted(quest: SideQuestId): void {
    if (!this.pending.some((p) => p.quest === quest)) this.pending.push({ quest, ticks: 0 });
  }

  /**
   * Once per sim tick (before EventDispatch): re-sends for an acceptance that came without a talk. It waits for the
   * second tick after the acceptance, so an accepting talk that ended between ticks has its 'dialogue:ended' handled
   * (in the first tick's EventDispatch) before the re-send, never after it as the hand-in.
   */
  tick(): void {
    for (const p of this.pending) p.ticks++;
    this.flush((p) => p.ticks >= 2);
  }

  dispose(): void {
    this.unsubscribe();
  }

  private currentObjectiveId(id: SideQuestId): string | null {
    return currentObjective(this.o.state.quests, this.o.questDefs, id)?.id ?? null;
  }

  /** Re-sends the pending acceptances `due` selects (all by default), in acceptance order. */
  private flush(due: (p: { quest: SideQuestId; ticks: number }) => boolean = () => true): void {
    const ready = this.pending.filter(due);
    if (ready.length === 0) return;
    for (const p of ready) this.pending.splice(this.pending.indexOf(p), 1);
    for (const p of ready) this.resend(p.quest);
  }

  /** Sends the quest event of each current Objective the World already satisfies, until one is not satisfied. */
  private resend(quest: SideQuestId): void {
    const { state, questDefs, quests } = this.o;
    for (let i = 0; i < MAX_RESENDS; i++) {
      const objective = currentObjective(state.quests, questDefs, quest);
      if (objective === null) return;
      const ev = this.heldEvent(objective.trigger);
      if (ev === null) return;
      quests.handle(ev);
      if (currentObjective(state.quests, questDefs, quest) === objective) return; // not taken: stop
    }
  }

  /** The quest event of progress the World holds for `trigger`, or null. */
  private heldEvent(trigger: NonNullable<ReturnType<typeof currentObjective>>['trigger']): QuestEvent | null {
    const { world, inventory } = this.o.state;
    switch (trigger.kind) {
      case 'defeat':
        return world.camps.includes(trigger.groupId) ? { kind: 'defeat', id: trigger.groupId } : null;
      case 'solve':
        return world.puzzles.includes(trigger.puzzleId) ? { kind: 'solve', id: trigger.puzzleId } : null;
      case 'collect': {
        const held = inventory.items[trigger.itemId as keyof typeof inventory.items] ?? 0;
        return held >= trigger.count ? { kind: 'collect', id: trigger.itemId, count: held } : null;
      }
      case 'flag':
        return world.flags[trigger.flag] === true ? { kind: 'flag', id: trigger.flag } : null;
      default:
        return null;
    }
  }
}
