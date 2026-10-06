/*
 * Quest_System scene adapter (design.md "Quest·Dialogue·Tutorial"). During EventDispatch it turns the
 * EventBus events into `QuestEvent`s in delivery (emit) order, runs the pure `questReducer`, stores
 * the result as `GameState.quests` and applies the returned effects in order: HUD, World, Party,
 * Inventory / Progression and Cinematic through the injected sinks, `save` as `'save:request'`.
 *
 * Event mapping: `dialogue:ended` → talk (npcId), `area:entered` → reach, `camp:cleared` /
 * `boss:defeated` → defeat (group / boss id), `interact` / `altar:activated` → interact,
 * `puzzle:solved` → solve, `skyshard:acquired` → skyshard ('1'–'3'), `cinematic:ended` → cinematic,
 * `item:granted` → collect (count = amount held after the grant). An `interact` on the altar is left
 * to `altar:activated`, which the World emits once the activation actually happens. Individual
 * `enemy:defeated` events are not quest input. A `flag` event is made when a GameState flag
 * (`world.flags`) turns on, including flags set by the quests' own `setFlag` effects.
 *
 * Per matching event the adapter also publishes `quest:objectiveCompleted` and, when a stage ends,
 * `quest:stageCompleted`, ahead of the effects' own events (so before `save:request`).
 */
import type { GameEventBus, GameEventName, GameEvents } from '../core/gameEvents';
import { isMainStageId, SIDE_QUEST_IDS, type CharacterId, type ItemId, type SideQuestId } from '../data/ids';
import { RESONANCE_ALTAR_ID } from '../data/starlitStair';
import { acceptSideQuest, questReducer, setTracked } from '../logic/quest/questReducer';
import type { ObjectiveDef, QuestDef, QuestEffect, QuestEvent, QuestId, QuestState, RewardRef } from '../logic/quest/types';
import type { GameState } from '../logic/save/gameState';

/** Interact target id of the single Resonance_Altar (`altar:activated` has no payload). */
export const RESONANCE_ALTAR_TARGET = RESONANCE_ALTAR_ID;

/** The tracked quest's current objective as the HUD, Compass and map show it. */
export interface ObjectiveView {
  questId: QuestId;
  stageId: string;
  stageName: string;
  objective: ObjectiveDef;
}

/**
 * Where effects go; each is optional until its system exists. Calls happen in the reducer's effect
 * order, synchronously inside the EventDispatch step (so the HUD text changes in the same tick).
 */
export interface QuestSinks {
  /** Every applied effect, in order, before its specific sink (harness, debug log). */
  effect?(e: QuestEffect): void;
  /** `hud:objective`: the tracked quest's current objective, null once it is done. */
  objective?(view: ObjectiveView | null): void;
  /** `hud:stageComplete`: the 3 s banner with the stage name and its rewards. */
  stageComplete?(stage: string, rewards: readonly RewardRef[]): void;
  /** `grant`: Glim / XP / items (Inventory, Progression). */
  grant?(reward: RewardRef): void;
  /** `setFlag`, after `world.flags[flag]` is on: World visual changes. */
  setFlag?(flag: string): void;
  /** `spawnGroup`: World activates an encounter group; it reports `camp:cleared` when wiped out. */
  spawnGroup?(groupId: string): void;
  startCinematic?(id: string): void;
  /** `joinParty`: Party_System adds the companion and emits `party:joined`. */
  joinParty?(character: CharacterId): void;
  /**
   * `acceptQuest` (task 13.3), after the Side_Quest turned 'active': the World re-sends progress it already holds (a
   * cleared camp, a solved puzzle) so a pre-completed Objective completes at once (design "Side_Quest").
   */
  accepted?(quest: SideQuestId): void;
  log?(message: string): void;
}

export interface QuestSystemOptions {
  bus: GameEventBus;
  /** Quest_System owns `quests`; it reads `inventory.items` and turns on `world.flags` for setFlag. */
  state: GameState;
  defs: readonly QuestDef[];
  sinks?: QuestSinks;
}

/** Amount of an item held right now. */
type HeldCount = (itemId: ItemId) => number;
type QuestInput<K extends GameEventName> = (payload: GameEvents[K], held: HeldCount) => QuestEvent | null;

const QUEST_INPUTS: { [K in QuestInputEvent]: QuestInput<K> } = {
  'dialogue:ended': (p) => ({ kind: 'talk', id: p.npcId }),
  'area:entered': (p) => ({ kind: 'reach', id: p.areaId }),
  'camp:cleared': (p) => ({ kind: 'defeat', id: p.campId }),
  'boss:defeated': (p) => ({ kind: 'defeat', id: p.bossId }),
  'interact': (p) => (p.targetKind === 'altar' ? null : { kind: 'interact', id: p.targetId }),
  'altar:activated': () => ({ kind: 'interact', id: RESONANCE_ALTAR_TARGET }),
  'puzzle:solved': (p) => ({ kind: 'solve', id: p.puzzleId }),
  'skyshard:acquired': (p) => ({ kind: 'skyshard', id: String(p.index) }),
  'cinematic:ended': (p) => ({ kind: 'cinematic', id: p.cinematicId }),
  'item:granted': (p, held) => ({ kind: 'collect', id: p.itemId, count: held(p.itemId) }),
};

/** Bus events the Quest_System listens to. */
export type QuestInputEvent =
  | 'dialogue:ended' | 'area:entered' | 'camp:cleared' | 'boss:defeated' | 'interact' | 'altar:activated'
  | 'puzzle:solved' | 'skyshard:acquired' | 'cinematic:ended' | 'item:granted';

export const QUEST_INPUT_EVENTS = Object.keys(QUEST_INPUTS) as readonly QuestInputEvent[];

/** The quest input for one bus event, or null when the event is not quest input. */
export function toQuestEvent<K extends QuestInputEvent>(type: K, payload: GameEvents[K], held: HeldCount): QuestEvent | null {
  const map: QuestInput<K> = QUEST_INPUTS[type];
  return map(payload, held);
}

/** Main, then side quests in registry order (the reducer's order). */
const QUEST_IDS: readonly QuestId[] = ['main', ...SIDE_QUEST_IDS];

/** Stage and objective indices a quest is at; null when it is not in progress. */
function progressOf(q: QuestState, id: QuestId): { stage: number; objective: number } | null {
  if (id === 'main') return q.main.done ? null : q.main;
  const side = q.side[id];
  return side?.status === 'active' ? side : null;
}

export class QuestSystem {
  private readonly bus: GameEventBus;
  private readonly state: GameState;
  private readonly defs: readonly QuestDef[];
  private readonly sinks: QuestSinks;
  private readonly unsubscribe: (() => void)[] = [];
  /** Quest events waiting while another one is being processed (flag events raised by effects). */
  private readonly pending: QuestEvent[] = [];
  private draining = false;

  constructor({ bus, state, defs, sinks = {} }: QuestSystemOptions) {
    this.bus = bus;
    this.state = state;
    this.defs = defs;
    this.sinks = sinks;
    const held: HeldCount = (itemId) => state.inventory.items[itemId] ?? 0;
    for (const type of QUEST_INPUT_EVENTS) this.listen(type, held);
  }

  /**
   * New Game: applies the first stage's `onStart` (the reducer only emits a stage's `onStart` when
   * the previous one completes) and shows the first objective.
   */
  startNewGame(): void {
    const first = this.mainDef()?.stages[0];
    this.applyEffects([...(first?.onStart ?? []), { kind: 'hud:objective' }]);
  }

  /** Continue: shows the tracked objective; the World restores its own state from GameState. */
  resume(): void {
    this.applyEffects([{ kind: 'hud:objective' }]);
  }

  /**
   * Runs one quest event (bus events arrive here; tests and debug tools may call it). While another
   * event's effects are being applied, it waits until they are done.
   */
  handle(ev: QuestEvent): void {
    this.pending.push(ev);
    this.drain();
  }

  /**
   * Applies effects in order through the same path as the reducer's effects (dialogue `onEnd` uses
   * it, e.g. for `joinParty`). Flag events they raise run once these effects are done.
   */
  applyEffects(effects: readonly QuestEffect[]): void {
    for (const e of effects) this.apply(e);
    this.drain();
  }

  /** Turns a GameState flag on; the first time, a `flag` quest event follows. */
  raiseFlag(flag: string): void {
    if (this.state.world.flags[flag] === true) return;
    this.state.world.flags[flag] = true;
    this.handle({ kind: 'flag', id: flag });
  }

  /**
   * `trackQuest` UiCommand (task 13.3, Req 15.4): tracks an 'active' Side_Quest, or the Main_Quest for `'main'`; any
   * other request changes nothing. A change re-shows the tracked Objective (HUD, Compass, map). Returns whether it changed.
   */
  track(id: QuestId): boolean {
    const before = this.state.quests;
    const after = setTracked(before, id);
    if (after === before) return false;
    this.state.quests = after;
    this.applyEffects([{ kind: 'hud:objective' }]);
    return true;
  }

  /** The tracked Side_Quest's current Objective (Compass and map show it in their own colour), or null when main is tracked. */
  trackedSideObjective(): ObjectiveView | null {
    const tracked = this.state.quests.tracked;
    return tracked === 'main' ? null : this.objectiveView(tracked);
  }

  /** Current objective of `id` (default: the tracked quest), or null when it has none. */
  objectiveView(id: QuestId = this.state.quests.tracked): ObjectiveView | null {
    const at = progressOf(this.state.quests, id);
    if (at === null) return null;
    const stage = this.defs.find((d) => d.id === id)?.stages[at.stage];
    const objective = stage?.objectives[at.objective];
    return stage && objective ? { questId: id, stageId: stage.id, stageName: stage.name, objective } : null;
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  private listen<K extends QuestInputEvent>(type: K, held: HeldCount): void {
    this.unsubscribe.push(
      this.bus.on(type, (payload) => {
        const ev = toQuestEvent(type, payload, held);
        if (ev !== null) this.handle(ev);
      }),
    );
  }

  private mainDef(): QuestDef | undefined {
    return this.defs.find((d) => d.id === 'main');
  }

  /** Processes queued events in order; a nested call leaves them to the running loop. */
  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let next = this.pending.shift(); next !== undefined; next = this.pending.shift()) this.step(next);
    } finally {
      this.draining = false;
    }
  }

  /** Reducer → store → completion events → effects. The state is stored before any sink runs. */
  private step(ev: QuestEvent): void {
    const before = this.state.quests;
    const { state, effects } = questReducer(before, this.defs, ev);
    this.state.quests = state;
    if (state !== before) this.publishCompletions(before, state);
    for (const e of effects) this.apply(e);
  }

  /** `quest:objectiveCompleted` / `quest:stageCompleted` for every quest the event advanced. */
  private publishCompletions(before: QuestState, after: QuestState): void {
    for (const id of QUEST_IDS) {
      const from = progressOf(before, id);
      if (from === null) continue;
      const to = progressOf(after, id); // null: the quest is done now
      if (to !== null && to.stage === from.stage && to.objective === from.objective) continue;
      const stage = this.defs.find((d) => d.id === id)?.stages[from.stage];
      const objective = stage?.objectives[from.objective];
      if (!stage || !objective) continue;
      const stageDone = to === null || to.stage !== from.stage;
      const questDone = to === null;
      if (id === 'main') {
        if (!isMainStageId(stage.id)) continue;
        this.bus.emit('quest:objectiveCompleted', { questId: id, stageId: stage.id, objectiveId: objective.id });
        if (stageDone) this.bus.emit('quest:stageCompleted', { questId: id, stageId: stage.id, questDone });
      } else {
        this.bus.emit('quest:objectiveCompleted', { questId: id, stageId: stage.id, objectiveId: objective.id });
        if (stageDone) this.bus.emit('quest:stageCompleted', { questId: id, stageId: stage.id, questDone });
      }
    }
  }

  private apply(e: QuestEffect): void {
    const s = this.sinks;
    s.effect?.(e);
    switch (e.kind) {
      case 'hud:objective':
        s.objective?.(this.objectiveView());
        break;
      case 'hud:stageComplete':
        s.stageComplete?.(e.stage, e.rewards);
        break;
      case 'grant':
        s.grant?.(e.reward);
        break;
      case 'setFlag': {
        const fresh = this.state.world.flags[e.flag] !== true;
        this.state.world.flags[e.flag] = true;
        s.setFlag?.(e.flag);
        if (fresh) this.pending.push({ kind: 'flag', id: e.flag }); // runs after the current effects
        break;
      }
      case 'spawnGroup':
        s.spawnGroup?.(e.groupId);
        break;
      case 'startCinematic':
        s.startCinematic?.(e.id);
        break;
      case 'joinParty':
        s.joinParty?.(e.character);
        break;
      case 'save':
        this.bus.emit('save:request', { reason: e.reason });
        break;
      case 'log':
        s.log?.(e.message);
        break;
      case 'acceptQuest': {
        // Task 13.3: 'available' → 'active' only (a quest without a definition stays locked); then the World re-sends.
        const before = this.state.quests;
        if (!this.defs.some((d) => d.id === e.quest)) break;
        const after = acceptSideQuest(before, e.quest);
        if (after === before) break;
        this.state.quests = after;
        s.accepted?.(e.quest);
        break;
      }
    }
  }
}
