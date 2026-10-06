// Dialogue_System scene adapter (design.md "Dialogue_System", task 13.1; Req 3.8, 14.4–14.7, 37.7). Headless: it
// owns the playing dialogue and its window cursor; the Dialogue screen (src/ui/dialogueScreen.ts) only draws view().
// - Start: an 'interact' on an NPC target (EventDispatch) picks the dialogue with the pure selectDialogue from
//   GameState, turns the NPC toward the Active_Character (NpcSystem.beginTalk, within 0.5 s) and opens the window
//   (`onChange`: the session pushes the Dialogue screen, whose `dialogue` context sets the input context and PauseMode
//   'dialogue'; the simulation freezes enemies and the player while `open`).
// - Windows: text types at 45 characters per second of game time. An advance press (`interact`, `jump`, `attack`:
//   F, Space, left click by default) completes a window still typing, else moves to the next one (Req 14.6). Every
//   window shown publishes 'dialogue:line' (speaker, dialogueId, line) for the speaker's voice blip (Req 37.7).
// - End: after the last window the `onEnd` effects run through the Quest_System's effect path (companion joinParty,
//   Side_Quest acceptQuest), a one-shot reaction turns its `seen_<id>` flag on, the NPC turns back, 'dialogue:ended'
//   (npcId, dialogueId) goes out (Quest `talk`, Tutorial) and `onChange(null)` restores the context. Pip's and Old
//   Bram's talks then publish 'interact' with targetKind 'shop' / 'echoAltar' (their screens' owners open them).
// - Stage briefings (Req 3.8): when a Main_Quest stage starts (New Game's ms1 through beginNewGame, the others on
//   'quest:stageCompleted') its stage-start dialogue waits until the party can listen (`ready`: standing, out of
//   combat, no fade or cinematic) and plays by itself; it is dropped if the stage has moved on by then.
// Pure TypeScript: no three.js / DOM.

import type { GameEventBus } from '../core/gameEvents';
import type { Vec3 } from '../core/types';
import {
  DIALOGUE_RULES, dialogueDefsFor, seenFlag, speakerName, STAGE_DIALOGUES, type DialogueDef, type DialogueLine, type Speaker,
  type StageDialogueDef,
} from '../data/dialogue';
import type { MainStageId } from '../data/ids';
import { QUESTS } from '../data/quests';
import { npcPlacement } from '../data/village';
import { advanceDialogue, isOneShot, selectDialogue, visibleChars, type DialogueCursor } from '../logic/dialogue';
import type { QuestDef, QuestEffect } from '../logic/quest/types';
import type { GameState } from '../logic/save/gameState';

/** Advance inputs (Req 14.6); the `dialogue` input context lets exactly these through. */
export const DIALOGUE_ADVANCE_ACTIONS = ['interact', 'jump', 'attack'] as const;
type AdvanceAction = (typeof DIALOGUE_ADVANCE_ACTIONS)[number];

/** What the Dialogue screen draws. */
export interface DialogueView {
  readonly dialogueId: string;
  /** The NPC talked to; null for a stage briefing. */
  readonly npc: Speaker | null;
  readonly speaker: Speaker;
  readonly speakerName: string;
  /** The whole window text and how many characters of it show now. */
  readonly text: string;
  readonly visible: number;
  /** The window is fully shown (the next advance moves on). */
  readonly complete: boolean;
  /** Window index and count. */
  readonly line: number;
  readonly count: number;
}

export interface DialogueSystemOptions {
  bus: GameEventBus;
  /** Read by selectDialogue; `seen_` flags are raised through `quests`. */
  state: GameState;
  /** The Quest_System: `onEnd` effects, flags and the Main_Quest stage for briefings. */
  quests: {
    applyEffects(effects: readonly QuestEffect[]): void;
    raiseFlag(flag: string): void;
    objectiveView(id: 'main'): { readonly stageId: string } | null;
  };
  /** NPC facing and presence (src/world/npcSystem.ts). */
  npcs: { beginTalk(id: Speaker, player: Readonly<Vec3>): void; endTalk(id: Speaker): void; present(id: Speaker): boolean };
  /** The Active_Character's feet (the NPC turns toward it). */
  player: () => Readonly<Vec3>;
  /** Whether a stage briefing may start now (standing, out of combat, no fade or cinematic). Default always. */
  ready?: () => boolean;
  /** Quest content (selection and the Side_Quest branches). Default QUESTS. */
  questDefs?: readonly QuestDef[];
  /** Default dialogueDefsFor(questDefs). */
  defs?: readonly DialogueDef[];
  /** Default STAGE_DIALOGUES. */
  stageDialogues?: readonly StageDialogueDef[];
  /** A dialogue opened (its first window) or closed (null). */
  onChange?: (view: DialogueView | null) => void;
}

interface Session {
  readonly id: string;
  readonly npc: Speaker | null;
  readonly lines: readonly DialogueLine[];
  readonly def: DialogueDef | null;
  cursor: DialogueCursor;
}

export class DialogueSystem {
  private readonly o: DialogueSystemOptions;
  private readonly questDefs: readonly QuestDef[];
  private readonly defs: readonly DialogueDef[];
  private readonly stageDialogues: readonly StageDialogueDef[];
  private readonly unsubscribe: (() => void)[] = [];
  private session: Session | null = null;
  /** A stage briefing waiting for its moment, and how long the party has been ready for it. */
  private pendingStage: MainStageId | string | null = null;
  private pendingReady = 0;

  constructor(options: DialogueSystemOptions) {
    this.o = options;
    this.questDefs = options.questDefs ?? QUESTS;
    this.defs = options.defs ?? dialogueDefsFor(this.questDefs);
    this.stageDialogues = options.stageDialogues ?? STAGE_DIALOGUES;
    this.unsubscribe.push(
      options.bus.on('interact', ({ targetKind, targetId }) => {
        if (targetKind === 'npc') this.talk(targetId as Speaker);
      }),
      options.bus.on('quest:stageCompleted', (p) => {
        if (p.questId !== 'main' || p.questDone) return;
        const next = options.quests.objectiveView('main')?.stageId;
        if (next !== undefined) this.queueStage(next);
      }),
    );
  }

  /** A dialogue window is open: the game holds the player and enemies, input goes to the dialogue. */
  get open(): boolean {
    return this.session !== null;
  }

  /** The dialogue playing now (its id), or null. */
  get playing(): string | null {
    return this.session?.id ?? null;
  }

  /** New Game: ms1's briefing plays once the party can listen. */
  beginNewGame(): void {
    const stage = this.o.quests.objectiveView('main')?.stageId;
    if (stage !== undefined) this.queueStage(stage);
  }

  /** What the Dialogue screen draws now, or null when closed. */
  view(): DialogueView | null {
    const s = this.session;
    if (s === null) return null;
    const line = s.lines[s.cursor.line];
    if (line === undefined) return null;
    const visible = s.cursor.completed ? line.text.length : visibleChars(line.text, s.cursor.elapsed);
    return {
      dialogueId: s.id, npc: s.npc, speaker: line.speaker, speakerName: speakerName(line.speaker), text: line.text, visible,
      complete: visible >= line.text.length, line: s.cursor.line, count: s.lines.length,
    };
  }

  /**
   * One sim tick (the ContextGate step, before the player moves): types the window, reads this tick's advance press,
   * and starts a waiting stage briefing when the party is ready. `input` is the tick's InputState.
   */
  tick(dt: number, input: { pressed(action: AdvanceAction): boolean }): void {
    const s = this.session;
    if (s !== null) {
      s.cursor = { ...s.cursor, elapsed: s.cursor.elapsed + (Number.isFinite(dt) && dt > 0 ? dt : 0) };
      if (DIALOGUE_ADVANCE_ACTIONS.some((a) => input.pressed(a))) this.advance(s);
      return;
    }
    this.tickStage(dt);
  }

  /** An advance press (tests and the harness may call it directly). */
  advanceNow(): void {
    if (this.session !== null) this.advance(this.session);
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  private queueStage(stage: string): void {
    if (!this.stageDialogues.some((d) => d.stage === stage)) return;
    this.pendingStage = stage;
    this.pendingReady = 0;
  }

  private tickStage(dt: number): void {
    const stage = this.pendingStage;
    if (stage === null) return;
    if (this.o.quests.objectiveView('main')?.stageId !== stage) {
      this.pendingStage = null; // the stage moved on before its briefing could play
      return;
    }
    if (!(this.o.ready?.() ?? true)) {
      this.pendingReady = 0;
      return;
    }
    this.pendingReady += Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (this.pendingReady + 1e-9 < DIALOGUE_RULES.stageDelaySeconds) return;
    this.pendingStage = null;
    const def = this.stageDialogues.find((d) => d.stage === stage);
    if (def !== undefined && def.lines.length > 0) this.start({ id: def.id, npc: null, lines: def.lines, def: null });
  }

  /** 'interact' on an NPC: its dialogue by the selection rules. Ignored while one plays or when it is not there. */
  private talk(npc: Speaker): void {
    if (this.session !== null || !this.o.npcs.present(npc)) return;
    const def = selectDialogue(npc, this.o.state, this.defs, this.questDefs);
    if (def.lines.length === 0) {
      this.finish({ id: def.id, npc, lines: def.lines, def, cursor: { line: 0, elapsed: 0, completed: false } });
      return;
    }
    this.o.npcs.beginTalk(npc, this.o.player());
    this.start({ id: def.id, npc, lines: def.lines, def });
  }

  private start(s: Omit<Session, 'cursor'>): void {
    const session: Session = { ...s, cursor: { line: 0, elapsed: 0, completed: false } };
    this.session = session;
    this.announce(session);
    this.o.onChange?.(this.view());
  }

  /** 'dialogue:line' for the window at the cursor (the voice blip). */
  private announce(s: Session): void {
    const line = s.lines[s.cursor.line];
    if (line !== undefined) this.o.bus.emit('dialogue:line', { speaker: line.speaker, dialogueId: s.id, line: s.cursor.line });
  }

  private advance(s: Session): void {
    const result = advanceDialogue(s.lines, s.cursor);
    if (result.kind === 'end') {
      this.finish(s);
      return;
    }
    s.cursor = result.cursor;
    if (result.kind === 'next') this.announce(s);
  }

  /** After the last window: onEnd, the one-shot flag, the NPC turns back, 'dialogue:ended', the context returns. */
  private finish(s: Session): void {
    this.session = null;
    const { def, npc } = s;
    if (def?.onEnd !== undefined && def.onEnd.length > 0) this.o.quests.applyEffects(def.onEnd);
    if (def !== null && isOneShot(def)) this.o.quests.raiseFlag(seenFlag(def.id));
    const speaker = npc ?? s.lines[0]?.speaker ?? 'kairen';
    if (npc !== null) this.o.npcs.endTalk(npc);
    this.o.bus.emit('dialogue:ended', { npcId: speaker, dialogueId: s.id });
    const opens = npc === null ? undefined : npcPlacement(npc)?.opens;
    if (npc !== null && opens !== undefined) this.o.bus.emit('interact', { targetKind: opens, targetId: npc });
    this.o.onChange?.(null);
  }
}
