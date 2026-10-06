/*
 * Built-in judges for the `signal` Tutorial_Hints (design "Tutorial_System" table): each publishes
 * 'tutorial:trigger' with its hint id when the hint's situation first holds. They stand in for the owning systems
 * (Map_System, Waystones, Echo Altar, ...); a system that judges the situation itself may publish the same signal,
 * which queues the hint once either way.
 *
 * - Event judges (installEventSignals): the first enemy Telegraph → tut_dodge; the first Vista_Point reached
 *   (its `vista_*` area) → tut_map.
 * - Tick probes (simTutorialSources): a fight with a companion in the party → tut_skill (backing up its
 *   `enemy:alerted` trigger); Ember mark + Isla ready to switch in → tut_reaction (Req 34.6); full Energy →
 *   tut_burst; an inactive Waystone in interaction reach → tut_waystone; an Elite or 3+ engaged enemies →
 *   tut_lockon; HP under 50 % → tut_heal; Starmote held at an Echo Altar → tut_upgrade; an unsolved puzzle part
 *   within 8 m → tut_puzzle.
 */

import type { GameEventBus } from '../core/gameEvents';
import type { Vec3 } from '../core/types';
import { CHARACTERS } from '../data/characters';
import { isEliteId, type CharacterId, type ReactionId } from '../data/ids';
import type { GameState } from '../logic/save/gameState';
import type { InteractPrompt } from '../player/interaction';
import type { MoveMode } from '../player/core/types';
import type { EnemyRuntime, RuntimeState } from '../save/runtimeState';
import type { TutorialProbes, TutorialWorld } from './tutorialSystem';

/** Enemy AI states that count as engaged in a fight. */
const ENGAGED: ReadonlySet<string> = new Set(['alert', 'chase', 'attack', 'recovery', 'stagger']);
/** Engaged enemies that make a fight a Lock-on lesson (with any Elite). */
const LOCKON_CROWD = 3;
/** Horizontal reach (m) of a puzzle part that counts as approached, and its vertical tolerance. */
const PUZZLE_REACH = 8;
const PUZZLE_HEIGHT = 5;
/** The steam burst Isla's Tide sets off on an Ember mark (Req 34.6). */
const REACTION_LESSON: { readonly character: CharacterId; readonly reaction: ReactionId } = { character: 'isla', reaction: 'steamBurst' };

/**
 * Subscribes the event-driven judges; returns the unsubscribe functions. `settled(id)` says the hint no longer needs
 * its signal (queued, current or completed).
 */
export function installEventSignals(bus: GameEventBus, settled: (hintId: string) => boolean): (() => void)[] {
  const signal = (hintId: string): void => {
    if (!settled(hintId)) bus.emit('tutorial:trigger', { hintId });
  };
  return [
    bus.on('enemy:telegraph', () => signal('tut_dodge')),
    bus.on('area:entered', (p) => {
      if (p.areaId.startsWith('vista_')) signal('tut_map');
    }),
  ];
}

/** The PlaySim parts the tutorial reads (PlaySim satisfies this structurally). */
export interface TutorialSimView {
  readonly gameState: GameState;
  readonly runtime: Pick<RuntimeState, 'energy' | 'enemies' | 'inCombat'>;
  readonly player: { readonly state: { readonly pos: Vec3; readonly mode: MoveMode } };
  readonly cinematics: { readonly playing: string | null };
  readonly party: { maxHp(id: CharacterId): number };
  readonly interaction: { readonly prompt: InteractPrompt | null };
  readonly puzzles: { views(): readonly { readonly id: string; readonly solved: boolean; readonly parts: readonly { readonly pos: Vec3 }[] }[] };
  /** The NPCs' live positions (src/world/npcSystem.ts); null for an id that is no NPC. */
  readonly npcs: { position(id: string): Readonly<Vec3> | null };
  reactionPreviews(): readonly { readonly characterId: CharacterId; readonly reaction: ReactionId | null }[];
}

/** The tutorial's world view and signal probes over a play session. */
export function simTutorialSources(sim: TutorialSimView): { world: TutorialWorld; probes: TutorialProbes } {
  const gs = sim.gameState;
  let puzzleParts: { readonly puzzleId: string; readonly pos: Vec3 }[] | null = null;
  const world: TutorialWorld = {
    playerPos: () => sim.player.state.pos,
    playerMode: () => sim.player.state.mode,
    cinematicPlaying: () => sim.cinematics.playing !== null,
    // An NPC offered as the interaction prompt is within its 2.5 m reach wherever it walks; otherwise where it stands now.
    locate: (id) => {
      const prompt = sim.interaction.prompt;
      if (prompt !== null && prompt.kind === 'npc' && prompt.id === id) return sim.player.state.pos;
      return sim.npcs.position(id);
    },
  };
  const engaged = (): EnemyRuntime[] => [...sim.runtime.enemies.values()].filter((e) => ENGAGED.has(e.state));
  const probes: TutorialProbes = {
    // Backs up the `enemy:alerted` trigger: a fight whose enemies all alerted before the companion joined.
    tut_skill: () => gs.party.joined.length >= 2 && sim.runtime.inCombat,
    tut_reaction: () =>
      gs.party.joined.includes(REACTION_LESSON.character) &&
      sim.reactionPreviews().some((s) => s.characterId === REACTION_LESSON.character && s.reaction === REACTION_LESSON.reaction),
    tut_burst: () => {
      const active = gs.party.active;
      return sim.runtime.energy[active] >= CHARACTERS[active].burst.energyCost;
    },
    tut_waystone: () => {
      const prompt = sim.interaction.prompt;
      return prompt !== null && prompt.kind === 'waystone' && !(gs.world.waystones as readonly string[]).includes(prompt.id);
    },
    tut_lockon: () => {
      if (!sim.runtime.inCombat) return false;
      const fighting = engaged();
      return fighting.length >= LOCKON_CROWD || fighting.some((e) => isEliteId(e.def));
    },
    tut_heal: () => {
      const active = gs.party.active;
      const hp = gs.party.hp[active];
      return hp > 0 && hp < 0.5 * sim.party.maxHp(active);
    },
    tut_upgrade: () => {
      const prompt = sim.interaction.prompt;
      // Old Bram runs the Echo Altar (task 13.2): his talk prompt counts as standing at it.
      const atAltar = prompt !== null && (prompt.kind === 'echoAltar' || (prompt.kind === 'npc' && prompt.id === 'bram'));
      return atAltar && (gs.inventory.items.mat_starmote ?? 0) > 0;
    },
    tut_puzzle: () => {
      // Part positions are fixed: read them once.
      puzzleParts ??= sim.puzzles.views().flatMap((v) => v.parts.map((p) => ({ puzzleId: v.id, pos: { ...p.pos } })));
      const feet = sim.player.state.pos;
      return puzzleParts.some(
        (p) =>
          !gs.world.puzzles.includes(p.puzzleId) &&
          Math.hypot(p.pos.x - feet.x, p.pos.z - feet.z) <= PUZZLE_REACH &&
          Math.abs(p.pos.y - feet.y) <= PUZZLE_HEIGHT,
      );
    },
  };
  return { world, probes };
}
