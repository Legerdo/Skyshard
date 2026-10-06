// Test_Harness snapshot (design "Test_Harness" HarnessSnapshot, Req 42.2): the fields a bot needs to decide its next
// input and to judge a run, read from the live session and page between frames (= the last finished tick). Every value
// is plain JSON-safe data; the harness clones and freezes the result (./harness). Reading never changes anything.

import { SHOULDER_HEIGHT } from '../camera/constants';
import { judgeTime, type AttackPlayback } from '../combat/attackRuntime';
import type { Vec3 } from '../core/types';
import { CHARACTERS } from '../data/characters';
import { PARTY_SLOTS } from '../logic/party';
import type { PlaySim } from '../playSim';
import type { HarnessEventLog, RecentReaction } from './harness';

/** Enemies farther than this from the Active_Character are left out (m). */
export const HARNESS_ENEMY_RADIUS = 60;

export interface HarnessSnapshot {
  readonly version: 1;
  /** `seq` of the newest event-log entry (poll events() from here). */
  readonly seq: number;
  readonly tick: number;
  readonly simTime: number;
  readonly playTimeSec: number;
  /** ScreenManager stack from the bottom up and its top. */
  readonly screens: readonly string[];
  readonly screen: string | null;
  readonly inputContext: string;
  readonly pauseMode: string;
  readonly pointerLocked: boolean;
  readonly fps: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly debugUsed: boolean;
  readonly mainStage: string;
  readonly mainDone: boolean;
  readonly objective: { readonly questId: string; readonly stageId: string; readonly objectiveId: string; readonly text: string } | null;
  readonly skyshards: number;
  readonly altarActivated: boolean;
  readonly bossDefeated: boolean;
  readonly gameCompleted: boolean;
  readonly activeCharacter: string;
  readonly level: number;
  readonly glim: number;
  readonly party: readonly {
    readonly id: string; readonly joined: boolean; readonly active: boolean; readonly hp: number; readonly maxHp: number;
    readonly downed: boolean; readonly skillCooldown: number; readonly energy: number; readonly energyMax: number;
  }[];
  readonly player: {
    readonly pos: Vec3; readonly vel: Vec3; readonly yaw: number; readonly mode: string; readonly grounded: boolean;
    readonly stamina: number; readonly staminaMax: number; readonly exhausted: boolean;
  };
  /** Render camera: position, heading (core/math yaw of the view), pitch (positive looks down), distance to the shoulder. */
  readonly camera: { readonly pos: Vec3; readonly yaw: number; readonly pitch: number; readonly distance: number } | null;
  readonly inCombat: boolean;
  /** Living enemies within 60 m, nearest first. */
  readonly enemies: readonly {
    readonly id: string; readonly kind: string;
    /** Task 24.4: the Enemy_Camp or encounter group it belongs to, or null (a roaming spawner). */
    readonly camp: string | null;
    readonly pos: Vec3; readonly state: string; readonly hp: number; readonly maxHp: number;
    readonly distance: number; readonly mark: string | null; readonly shield: string | null; readonly attack: string | null;
    /** Seconds of Telegraph left before the attack's first hit, or null. */
    readonly telegraph: number | null;
  }[];
  /**
   * Caelith while the encounter is on (intro or fight), else null. Task 24.4: its feet, the Telegraph areas (the
   * floor shapes a player sees), the Astral Sweep ring, the starShards in flight, the Shard_Crystals and the Starshell,
   * so the playthrough bot can read the fight the way a player reads the arena.
   */
  readonly boss: {
    readonly phase: number; readonly hp: number; readonly maxHp: number; readonly hpRatio: number; readonly state: string;
    readonly vulnerable: boolean; readonly attack: string | null; readonly telegraphRemaining: number;
    readonly telegraphs: readonly {
      readonly attack: string; readonly shape: string; readonly remaining: number; readonly strong: boolean;
      readonly center: Vec3; readonly yaw: number; readonly radius: number; readonly angleDeg: number; readonly length: number;
      readonly width: number; readonly sector: number;
    }[];
    readonly pos: Vec3;
    readonly yaw: number;
    /** Seconds left of the current stagger / disabled / transition / recovery, else 0. */
    readonly stateRemaining: number;
    readonly ring: { readonly center: Vec3; readonly radius: number; readonly thickness: number; readonly height: number } | null;
    readonly shards: readonly Vec3[];
    readonly crystals: readonly { readonly element: string; readonly hp: number; readonly pos: Vec3; readonly reaction: string | null; readonly caelithNear: boolean }[];
    readonly starshell: { readonly element: string; readonly durability: number; readonly max: number } | null;
  } | null;
  /**
   * Task 24.4: every placed puzzle's progress (sequence step, solved, its target open) and its parts' device states
   * (a Heat_Crystal 'cooled' / 'hot', a bramble 'burnt', …: what the player sees on them).
   */
  readonly puzzles: readonly {
    readonly id: string; readonly step: number; readonly solved: boolean; readonly open: boolean;
    readonly parts: readonly { readonly id: string; readonly state: string }[];
  }[];
  readonly cinematic: {
    readonly id: string; readonly t: number; readonly duration: number; readonly skippable: boolean;
    readonly skipAvailable: boolean; readonly skipProgress: number;
  } | null;
  /** The interaction prompt target. */
  readonly interact: { readonly kind: string; readonly id: string; readonly name: string } | null;
  readonly dialogue: { readonly dialogueId: string; readonly speaker: string; readonly line: number; readonly lines: number; readonly complete: boolean } | null;
  /** Recovery fade running now, and how many recoveries started per reason on this page. */
  readonly recovery: { readonly active: boolean; readonly reason: string | null; readonly counts: Readonly<Record<string, number>> };
  readonly recentReactions: readonly RecentReaction[];
  /** AudioEngine.debugState() (musicBusGain, sfxBusGain, …), or null without Web Audio. */
  readonly audio: unknown;
}

/** Where the page's values come from. */
export interface HarnessSources {
  /** The running session's simulation, or null. */
  sim(): PlaySim | null;
  screens(): readonly string[];
  inputContext(): string;
  pauseMode(): string;
  pointerLocked(): boolean;
  clock(): { readonly tick: number; readonly simTime: number; readonly playTimeSec: number };
  /** Render camera position and unit view direction, or null. */
  camera(): { readonly pos: Readonly<Vec3>; readonly dir: Readonly<Vec3> } | null;
  render(): { readonly fps: number; readonly drawCalls: number; readonly triangles: number };
  audio(): unknown;
  log: HarnessEventLog;
  recoveries: RecoveryCounter;
}

/** Counts recovery starts per reason; the page calls observe() after every tick. */
export class RecoveryCounter {
  private readonly counts: Record<string, number> = {};
  private last: string | null = null;

  observe(reason: string | null): void {
    if (reason !== null && reason !== this.last) this.counts[reason] = (this.counts[reason] ?? 0) + 1;
    this.last = reason;
  }

  snapshot(): Record<string, number> {
    return { ...this.counts };
  }
}

const v3 = (p: Readonly<Vec3>): Vec3 => ({ x: p.x, y: p.y, z: p.z });
const finite = (n: number): number => (Number.isFinite(n) ? n : 0);

/** This moment's snapshot data (not yet cloned or frozen). */
export function buildSnapshot(src: HarnessSources): HarnessSnapshot {
  const sim = src.sim();
  const screens = [...src.screens()];
  const clock = src.clock();
  const render = src.render();
  const cam = src.camera();
  const base = {
    version: 1 as const,
    seq: src.log.lastSeq,
    tick: clock.tick,
    simTime: finite(clock.simTime),
    playTimeSec: finite(clock.playTimeSec),
    screens,
    screen: screens.length === 0 ? null : (screens[screens.length - 1] ?? null),
    inputContext: src.inputContext(),
    pauseMode: src.pauseMode(),
    pointerLocked: src.pointerLocked(),
    fps: finite(render.fps),
    drawCalls: finite(render.drawCalls),
    triangles: finite(render.triangles),
    recentReactions: src.log.recentReactions(),
    audio: src.audio() ?? null,
  };
  if (sim === null) {
    return {
      ...base, debugUsed: false, mainStage: '', mainDone: false, objective: null, skyshards: 0, altarActivated: false,
      bossDefeated: false, gameCompleted: false, activeCharacter: 'kairen', level: 1, glim: 0, party: [],
      player: { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, mode: 'grounded', grounded: true, stamina: 0, staminaMax: 0, exhausted: false },
      camera: null, inCombat: false, enemies: [], boss: null, puzzles: [], cinematic: null, interact: null, dialogue: null,
      recovery: { active: false, reason: null, counts: src.recoveries.snapshot() },
    };
  }
  const gs = sim.gameState;
  const rt = sim.runtime;
  const body = sim.player.state;
  const feet = body.pos;
  const objectiveView = sim.quests.objectiveView('main');
  const party = PARTY_SLOTS.map((id) => ({
    id,
    joined: gs.party.joined.includes(id),
    active: gs.party.active === id,
    hp: gs.party.hp[id],
    maxHp: sim.party.maxHp(id),
    downed: gs.party.downed.includes(id),
    skillCooldown: finite(rt.cooldowns[id]),
    energy: finite(rt.energy[id]),
    energyMax: CHARACTERS[id].burst.energyCost,
  }));
  const enemies = [...rt.enemies.values()]
    .filter((e) => e.state !== 'dead')
    .map((e) => ({ e, d: Math.hypot(e.pos.x - feet.x, e.pos.y - feet.y, e.pos.z - feet.z) }))
    .filter(({ d }) => d <= HARNESS_ENEMY_RADIUS)
    .sort((a, b) => a.d - b.d)
    .map(({ e, d }) => ({
      id: e.id, kind: e.def, camp: e.campId ?? null, pos: v3(e.pos), state: e.state, hp: e.hp, maxHp: e.maxHp, distance: d,
      mark: e.element.mark?.element ?? null, shield: e.element.shield?.element ?? null, attack: e.attack?.def.id ?? null,
      telegraph: telegraphRemaining(e.attack),
    }));
  const boss = sim.boss.engaged || sim.boss.state === 'dead' ? bossOf(sim) : null;
  const puzzles = sim.puzzles.views().map((v) => ({
    id: v.id, step: sim.puzzles.runtime(v.id)?.step ?? 0, solved: v.solved, open: v.open,
    parts: v.parts.map((p) => ({ id: p.id, state: p.state })),
  }));
  const cin = sim.cinematics.view();
  const prompt = sim.interaction.prompt;
  const dialogue = sim.dialogue.view();
  let camera: HarnessSnapshot['camera'] = null;
  if (cam !== null) {
    const { dir } = cam;
    const distance = Math.hypot(cam.pos.x - feet.x, cam.pos.y - (feet.y + SHOULDER_HEIGHT), cam.pos.z - feet.z);
    camera = { pos: v3(cam.pos), yaw: Math.atan2(dir.x, dir.z), pitch: Math.asin(Math.max(-1, Math.min(1, -dir.y))), distance };
  }
  return {
    ...base,
    debugUsed: gs.debugUsed,
    mainStage: objectiveView?.stageId ?? (gs.quests.main.done ? 'done' : ''),
    mainDone: gs.quests.main.done,
    objective: objectiveView === null ? null : {
      questId: objectiveView.questId, stageId: objectiveView.stageId, objectiveId: objectiveView.objective.id, text: objectiveView.objective.text,
    },
    skyshards: gs.skyshards,
    altarActivated: gs.altarActivated,
    bossDefeated: gs.bossDefeated,
    gameCompleted: gs.gameCompleted,
    activeCharacter: gs.party.active,
    level: gs.party.level,
    glim: gs.inventory.glim,
    party,
    player: {
      pos: v3(feet), vel: v3(body.vel), yaw: body.yaw, mode: body.mode, grounded: body.grounded,
      stamina: rt.stamina.value, staminaMax: rt.stamina.max, exhausted: rt.stamina.exhausted,
    },
    camera,
    inCombat: rt.inCombat,
    enemies,
    boss,
    puzzles,
    cinematic: cin === null ? null : {
      id: cin.id, t: cin.t, duration: cin.duration, skippable: cin.skippable, skipAvailable: cin.skipAvailable, skipProgress: cin.skipProgress,
    },
    interact: prompt === null ? null : { kind: prompt.kind, id: prompt.id, name: prompt.name },
    dialogue: dialogue === null ? null : {
      dialogueId: dialogue.dialogueId, speaker: dialogue.speaker, line: dialogue.line, lines: dialogue.count, complete: dialogue.complete,
    },
    recovery: { active: sim.recovery.active, reason: sim.recovery.reason, counts: src.recoveries.snapshot() },
  };
}

/** Seconds until a telegraphed attack's first judgement, while its Telegraph shows; else null. */
function telegraphRemaining(attack: AttackPlayback | null): number | null {
  const first = attack?.def.hits[0];
  if (attack === null || attack.def.telegraph === undefined || first === undefined) return null;
  const left = judgeTime(first) - attack.t;
  return left > 0 ? left : null;
}

function bossOf(sim: PlaySim): NonNullable<HarnessSnapshot['boss']> {
  const s = sim.boss.snapshot();
  return {
    phase: s.phase,
    hp: s.hp,
    maxHp: s.maxHp,
    hpRatio: s.maxHp > 0 ? s.hp / s.maxHp : 0,
    state: s.state,
    vulnerable: s.vulnerable,
    attack: s.attack,
    telegraphRemaining: s.telegraphRemaining,
    telegraphs: s.telegraphs.map((t) => ({
      attack: t.attack, shape: t.shape, remaining: t.remaining, strong: t.strong, center: v3(t.center), yaw: t.yaw, radius: t.radius,
      angleDeg: t.angleDeg, length: t.length, width: t.width, sector: t.sector,
    })),
    pos: v3(s.pos),
    yaw: s.yaw,
    stateRemaining: s.stateRemaining,
    ring: s.ring === null ? null : { center: v3(s.ring.center), radius: s.ring.radius, thickness: s.ring.thickness, height: s.ring.height },
    shards: s.shards.map(v3),
    crystals: s.crystals.map((c) => ({ element: c.element, hp: c.hp, pos: v3(c.pos), reaction: c.reaction, caelithNear: c.caelithNear })),
    starshell: s.starshell === null ? null : { element: s.starshell.element, durability: s.starshell.durability, max: s.starshell.max },
  };
}
