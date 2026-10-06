import { BossEncounter, CAELITH_ENTITY_ID } from './boss/bossEncounter'; // task 10: full Caelith encounter
import { CinematicPlayer, type AnchorFrame, type CinematicCue } from './cinematics/cinematicPlayer'; // task 21.1
import { DebugTools } from './debug/debugTools'; // task 22.1
import { PARTY_SLOTS } from './logic/party'; // task 22.1: "캐릭터 전원 합류"
import { aimPoint, type AimRay } from './combat/aim';
import type { HitReceiver, HitResult } from './combat/attackRuntime';
import { PerfectDodge, type SetTimeScale } from './combat/perfectDodge';
import { PlayerCombat } from './combat/playerCombat';
import { createPlayerReceiver, PLAYER_ENTITY_ID } from './combat/playerReceiver';
import { ReceiverField } from './element/receiverField';
import { createGameEventBus, type GameEventBus } from './core/gameEvents';
import { createRngStreams } from './core/rng';
import type { Vec3 } from './core/types';
import type { UiCommand, UiCommandQueue } from './core/uiCommands';
import { CHARACTERS } from './data/characters';
import type { CharacterId, CinematicId, EntityId, RegionId } from './data/ids';
import { puzzleDefsFor } from './data/puzzles';
import { QUESTS } from './data/quests';
import { AIR_VOLUMES, AREA_VOLUMES, DISCOVERY_VOLUMES, HAZARD_VOLUMES } from './data/volumes';
import { THISTLEWICK_HEARTH, type SpotDef } from './data/worldLayout';
import { EnemySystem } from './enemies/enemySystem';
import type { InputState } from './input/inputState';
import { InventorySystem } from './inventory/inventorySystem';
import { ConsumableSystem } from './inventory/consumableSystem'; // task 12.4
import { EquipmentEffects } from './inventory/equipmentEffects'; // task 12.4
import { LootSystem, type CampClearedNotice } from './loot/lootSystem';
import { ProgressionSystem } from './progression/progressionSystem';
import type { BossPhase } from './logic/boss';
import {
  previewTarget, reactionPreviews, type PreviewCandidate, type ReactionPreviewSlot,
} from './logic/reactionEffects';
import { regionUnlocked, type WorldProgress } from './logic/gates';
import type { RewardRef } from './logic/quest/types';
import type { GameState } from './logic/save/gameState';
import { PartySystem, switchContextFor } from './party/partySystem';
import { ColliderIdSource } from './physics/colliderIds';
import { createCollisionWorld } from './physics/collisionWorld';
import type { CollisionWorld, SurfaceMaterial } from './physics/types';
import type { ControllerEvent, ControllerVolumes } from './player/core/types';
import { InteractionSystem } from './player/interaction';
import { PlayerController, type PlayerTickInput } from './player/playerController';
import { RecoverySystem, type SafePosition } from './player/recovery';
import { QuestSystem, type ObjectiveView } from './quest/questSystem';
import { createRuntimeState, respawnSpot, type RuntimeState } from './save/runtimeState';
import { GateSystem } from './world/gateSystem';
import { ResonanceAltar } from './world/resonanceAltar';
import { RestorableRegistry } from './world/restorable';
import { RouteStubs } from './world/routeStubs';
import { SpawnerSystem } from './world/spawnerSystem';
import { StarlitStair } from './world/starlitStair';
import { SanctumSystem } from './world/sanctum';
import { TempRoute } from './world/tempRoute';
import type { TerrainField } from './world/terrain';
import { VolumeIndex } from './world/volumeIndex';
import { WorldTriggers } from './world/worldTriggers';
import { PuzzleSystem } from './world/puzzleSystem';
import { createControllerVolumes } from './world/controllerVolumes';
import { ChallengeAreaSystem } from './world/challengeArea';
import { TalusPillars } from './world/talusPillars';
import { TutorialSystem } from './tutorial/tutorialSystem'; // task 13.4: Tutorial_Hints
import { simTutorialSources } from './tutorial/tutorialSignals'; // task 13.4
import { FogSystem } from './world/fogSystem'; // task 13.5: map fog reveal
import { WaystoneSystem, type WaystoneNotice } from './world/waystoneSystem'; // task 13.7: Waystones, fast travel
import type { VistaId } from './data/vistas'; // task 13.5
// Tasks 13.1–13.3: NPCs, the Dialogue_System, Thistlewick (buildings, Hearth) and the Side_Quests' world objects.
import { DialogueSystem, type DialogueView } from './dialogue/dialogueSystem';
import { sideQuestPuzzles } from './data/sideQuests';
import type { QuestDef } from './logic/quest/types';
import { NpcSystem } from './world/npcSystem';
import { SideQuestWorld } from './world/sideQuests';
import { VillageSystem } from './world/village';
// Tasks 12.7 / 20.1–20.4: Chests, Echo_Tablets, hidden places, lore / cache / herb, the Sky Ring Trial, the world edge.
import { CHEST_TOTAL, PLACE_TOTAL, POI_AIR_VOLUMES } from './data/pois';
import { completeGame } from './logic/worldChange'; // task 21.3: the completion record
import { ChestSystem, type ChestOpenedNotice } from './loot/chestSystem';
import { PoiSystem, type PoiNotice } from './world/poiSystem';
import { addBoundaryWall } from './world/worldEdge';

/*
 * The simulation of one play session without views or DOM (split out of GameSession for task 4.9, so the whole
 * route runs headless in Vitest): GameState, RuntimeState, the event bus and every system that changes them.
 * GameSession adds the camera, the views and the HUD around it.
 *
 * Fixed tick (design "Tick 갱신 순서"): UiCommands → Cinematic_System (its playback decides the ContextGate) →
 * PartySystem (cooldowns, joins, Downed timer, switch presses) → PlayerController (skipped while a recovery fade
 * or a cinematic holds input, idle while Downed; a swim out of Stamina requests the recovery fade) → CombatSystem (hits apply Elements: reactions, spread and chains
 * run in the EnemySystem's ReactionSystem) → EnemyAI (lava rifts) → Talus's pillars, environment devices and puzzles → BossEncounter (enemies,
 * devices and boss frozen under the gate) → WorldTriggers (barriers from GameState, Region / area / Landmark entry, the Caelith fight start and
 * the arena entrance seal, the interaction prompt and 'interact') → Challenge_Areas (checkpoint runes and the recovery's checkpoint override, fall
 * judgement, combat-room locks, doors) → CollisionResolve (enemy spacing, push-out and out-of-world reset,
 * Starlit_Stair fall, recovery / lift fades) → RestorableObjects → drop pickups (3 m pull) → Downed check →
 * EventDispatch (the Loot_System grants XP, Glim and drops on 'enemy:defeated' there; the camp tally sends
 * 'camp:cleared').
 *
 * Enemies come from the spawners (src/world/spawnerSystem, design "스폰·캠프·재배치"): placed from GameState when the
 * session is built (New Game or a load), encounter groups on the quest's `spawnGroup` and current `defeat`
 * Objectives, and placed again by respawnWorld() after fast travel and the Party_Wipe restart.
 *
 * Minimal full route (task 4.9, M2): the TEMPORARY route pieces and lift pads (src/world/tempRoute), the route
 * stubs for the Skyshard pedestals (src/world/routeStubs; NPC talks are the NPCs' and the Dialogue_System's since
 * tasks 13.1–13.2), the route's encounter groups
 * (src/data/spawns), the altar activation, the cinematic stand-in and the simple Caelith connect New Game to
 * cin_ending and the Victory Screen with the quest data unchanged. The Astral Sanctum (gate, connecting hall with
 * ws_sanctum and the mural, the Caelith arena and its entrance seal) is src/world/sanctum since task 10.2.
 */

/** Cinematic whose end opens the Victory Screen (design "화면 목록" Victory). */
export const ENDING_CINEMATIC_ID: CinematicId = 'cin_ending';
/** Caelith's entrance, played on the arena's first entry only (Req 6.11). */
export const BOSS_INTRO_CINEMATIC_ID: CinematicId = 'cin_boss_intro';
/** The Caelith fight begins when this Objective is current and the Active_Character is on the arena. */
const BOSS_GROUP_ID = 'caelith';
/** Enemy ground probe: from this far above the feet down to this far below. */
const ENEMY_GROUND_LIFT = 1;
const ENEMY_GROUND_DROP = 4;
/** Task 14.2: UiCommands the menu screens send, applied at once under a menu (applyMenuCommands). */
const MENU_COMMAND_KINDS: ReadonlySet<UiCommand['kind']> = new Set(['purchase', 'equip', 'upgradeAbility', 'useItem', 'trackQuest']);

/** Where the simulation reports to the presentation. */
export interface PlaySimSinks {
  /** `hud:objective`: the tracked quest's current Objective. */
  objective?(view: ObjectiveView | null): void;
  /** `hud:stageComplete`: the 3 s stage banner. */
  stageComplete?(stage: string, rewards: readonly RewardRef[]): void;
  /** First entry into a Region: the title card. */
  regionTitle?(region: RegionId): void;
  /** A cinematic began (its id) or the last one ended (null). */
  cinematic?(playing: CinematicId | null): void;
  /** Task 21.1: a cinematic's `title` / `sfx` / `music` / `vfx` timeline cue. */
  cinematicCue?(cue: CinematicCue): void;
  /** 'party:wipe' during EventDispatch: open the Defeat Screen. */
  partyWipe(bossPhase: 1 | 2 | 3 | null): void;
  /** cin_ending ended: open the Victory Screen. */
  ending(): void;
  /** The controller's `exhausted` event: Stamina hit 0 this tick, the HUD ring starts flashing red (Req 17.3). */
  staminaExhausted?(): void;
  /** An Enemy_Camp was cleared (Loot_System, during EventDispatch): the "캠프 소탕" banner (Req 10.7). */
  campCleared?(notice: CampClearedNotice): void;
  /** A puzzle's 3rd (or later) failure: its one-line hint (Req 13.7). */
  puzzleHint?(puzzleId: string, hint: string): void;
  /**
   * Every controller tick: the glide wind loudness in [0, 1], 0 while not gliding (Req 19.10). The Audio_System's
   * setGlideWind (task 16.3) takes it; until then nothing listens.
   */
  glideWind?(intensity: number): void;
  /**
   * The controller's `footstep` event (Req 16.9: every wading step, material 'water'): the step sound and its VFX at
   * `pos`, the water surface above the feet for 'water' (the splash), else the feet. The Audio_System (task 16) takes
   * the sound; until then the session's splash view is the only listener.
   */
  footstep?(material: SurfaceMaterial, pos: Readonly<Vec3>): void;
  /** The controller's `enteredWater` event (a swim began, Req 16.10): the entry splash at the water surface `pos`. */
  enteredWater?(pos: Readonly<Vec3>): void;
  /** Task 13.7: Waystone feedback for the HUD (activation card, rest, "전투 중에는 이동할 수 없습니다", arrival). */
  waystone?(notice: WaystoneNotice): void;
  /** Task 13.5: a Vista_Point's 200 m map reveal ran (`first` on the first arrival in this save). */
  vista?(id: VistaId, first: boolean): void;
  /** Task 12.7: a Chest opened (its tier and reward list, during EventDispatch): the HUD reward lines and its VFX. */
  chestOpened?(notice: ChestOpenedNotice): void;
  /** Tasks 12.7 / 20.1: Echo_Tablet records, lore, hidden places, caches, herbs and the Sky Ring Trial. */
  poi?(notice: PoiNotice): void;
  /** Task 13.1: a dialogue window opened (its first window) or the dialogue closed (null): the Dialogue screen. */
  dialogue?(view: DialogueView | null): void;
  /** Task 13.2: the Hearth healed the party (Req 14.10). */
  hearthRested?(): void;
  /** Task 19.5: a party hit landed on an enemy (PlayerCombat onHit, inside the tick): impact VFX, camera impulse. */
  hit?(hit: HitResult): void;
  log?(message: string): void;
}

export interface PlaySimOptions {
  /** The session's persistent progress; the systems own and change it inside the fixed tick. */
  gameState: GameState;
  /** Heightfield built from `gameState.seed`. */
  terrain: TerrainField;
  input: InputState;
  /** UI commands, applied at the start of the next tick. */
  commands: UiCommandQueue;
  sinks: PlaySimSinks;
  /** GameLoop.setTimeScale (Perfect_Dodge slow motion); omitted when headless. */
  timeScale?: SetTimeScale;
  /** Task 13.3: the quest content in play (default QUESTS); tests drop a Side_Quest with it (Req 15.5). */
  questDefs?: readonly QuestDef[];
  /** Task 21.3: played seconds (the loop's play time) for the Victory record; default GameState.stats.playTimeSec. */
  playTimeSec?: () => number;
}

/** A living enemy or Caelith the camera may lock on to. */
export interface LockCandidate {
  readonly id: EntityId;
  /** Body centre. */
  readonly center: Vec3;
}

/** An attack Telegraph showing now (off-screen HUD arrows, Req 21.5). */
export interface TelegraphMarker {
  readonly entityId: EntityId;
  readonly pos: Vec3;
  readonly strong: boolean;
}

export interface PlaySimTickResult {
  /** The Active_Character was moved (recovery, lift, respawn): the camera should snap. */
  teleported: boolean;
}

export class PlaySim {
  readonly gameState: GameState;
  readonly runtime: RuntimeState;
  readonly bus: GameEventBus;
  readonly terrain: TerrainField;
  readonly collision: CollisionWorld<TerrainField>;
  readonly quests: QuestSystem;
  readonly player: PlayerController;
  readonly recovery: RecoverySystem;
  /**
   * Area, discovery and air volumes. Views read the Updrafts and Wind_Zones from it (particles, and the loop sounds'
   * emitters for the Audio_System, Req 19.8); `version` changes when the starlit Updrafts come or go.
   */
  readonly volumes: VolumeIndex;
  readonly stair: StarlitStair;
  readonly gates: GateSystem;
  readonly altar: ResonanceAltar;
  readonly interaction: InteractionSystem;
  readonly enemies: EnemySystem;
  /** Placed environment devices (ElementReceivers). */
  readonly devices: ReceiverField;
  /** Puzzle_Mechanisms over the devices. */
  readonly puzzles: PuzzleSystem;
  /** Talus's stone pillars (colliders and pressure-plate weights). */
  readonly pillars: TalusPillars;
  /** Challenge_Area rooms: doors, root lifts, checkpoints, fall judgement and combat-room locks. */
  readonly challenge: ChallengeAreaSystem;
  readonly combat: PlayerCombat;
  readonly perfectDodge: PerfectDodge;
  readonly party: PartySystem;
  readonly boss: BossEncounter;
  /** Task 21.1: the Cinematic_System (timeline, skip, once rules). */
  readonly cinematics: CinematicPlayer;
  /** Task 22.1: Debug_Tools operations from `debug` UiCommands (the panel exists only with `?debug=1`). */
  readonly debugTools: DebugTools;
  readonly route: TempRoute;
  readonly stubs: RouteStubs;
  /** The Astral Sanctum: gate, connecting hall (ws_sanctum, mural), the Caelith arena and its entrance seal. */
  readonly sanctum: SanctumSystem;
  /** Spawners, Enemy_Camps and encounter groups. */
  readonly spawners: SpawnerSystem;
  readonly progression: ProgressionSystem;
  readonly inventory: InventorySystem;
  /** Task 12.4: herb dumpling (Z, 3 s wait) and Ember Feather use. */
  readonly consumables: ConsumableSystem;
  /** Task 12.4: EquipEffects in force (modifiers for combat / HUD, Perfect_Dodge heal, Reaction Energy, regen). */
  readonly equipment: EquipmentEffects;
  readonly loot: LootSystem;
  /** Task 13.7: the six Waystones (activation, healing, respawn point) and fast travel. */
  readonly waystones: WaystoneSystem;
  /** Task 13.5: the map fog (40 m visit reveal, Vista 200 m reveal and map marks). */
  readonly fog: FogSystem;
  /** Task 12.7: the world's Chests (presence, camp locks, opening and rewards). */
  readonly chests: ChestSystem;
  /** Tasks 12.7 / 20.1: Echo_Tablets, hidden places, map POIs, lore / caches / herbs, the Sky Ring Trial, POI structures. */
  readonly pois: PoiSystem;
  /** Task 13.4: Tutorial_Hints (one at a time, done on the action or after 8 s, recorded in GameState.tutorials). */
  readonly tutorial: TutorialSystem;
  /** Task 13.3: the quest content in play (QUESTS unless a test drops a Side_Quest). */
  readonly questDefs: readonly QuestDef[];
  /** Task 13.2: the named NPCs and the companions before they join (behaviour, facing, talk targets). */
  readonly npcs: NpcSystem;
  /** Task 13.1: the dialogue playing (NPC talks and Main_Quest stage briefings), read by the Dialogue screen. */
  readonly dialogue: DialogueSystem;
  /** Task 13.2: Thistlewick's buildings, the Hearth and the progress look. */
  readonly village: VillageSystem;
  /** Task 13.3: the Side_Quests' world objects (the kite) and the acceptance re-send. */
  readonly sideQuests: SideQuestWorld;
  private readonly options: PlaySimOptions;
  /** The controller's water, Updraft and Wind_Zone view (the water surface for splashes). */
  private readonly controllerVolumes: ControllerVolumes;
  private readonly restorables: RestorableRegistry;
  private readonly triggers: WorldTriggers;
  private readonly playerTarget: HitReceiver;
  private readonly playerInput: ReturnType<PlayerCombat['gateInput']>;
  /** The controller's input while the Active_Character is Downed: nothing held or pressed (the body still falls). */
  private readonly idleInput: PlayerTickInput;
  private readonly unsubscribe: (() => void)[] = [];
  private began = false;

  constructor(options: PlaySimOptions) {
    this.options = options;
    const { gameState: gs, terrain, input, sinks } = options;
    this.gameState = gs;
    this.terrain = terrain;
    this.runtime = createRuntimeState(gs); // unsaved runtime state rebuilt from the persistent progress
    this.bus = createGameEventBus();
    const { bus, runtime } = this;
    const heightAt = (x: number, z: number): number => terrain.heightAt(x, z);
    const questDefs = options.questDefs ?? QUESTS;
    this.questDefs = questDefs;

    this.quests = new QuestSystem({
      bus,
      state: gs,
      defs: questDefs,
      sinks: {
        objective: (view) => {
          sinks.objective?.(view);
          // The world follows the Main_Quest's Objective whichever quest is tracked (task 13.3), and a tracked
          // Side_Quest's too: groups for `defeat`, a puzzle solved before its Objective was current reports again.
          const main = view?.questId === 'main' ? view : this.quests.objectiveView('main');
          for (const v of view !== null && view !== main ? [main, view] : [main]) {
            this.spawners.objectiveChanged(v);
            this.puzzles.objectiveChanged(v);
          }
        },
        accepted: (quest) => this.sideQuests.accepted(quest), // task 13.3: re-send held progress after the offer talk
        stageComplete: (stage, rewards) => sinks.stageComplete?.(stage, rewards),
        grant: (reward) => this.grantReward(reward, 'quest'), // task 12.1: stage / Side_Quest XP, Glim and items
        spawnGroup: (groupId) => this.spawners.activate(groupId),
        joinParty: (character) => this.joinParty(character),
        startCinematic: (id) => this.cinematics.play(id as CinematicId),
        log: (message) => sinks.log?.(message),
      },
    });

    // One seeded heightfield for collision and rendering, so the visible and the solid ground agree.
    const world = createCollisionWorld(terrain);
    this.collision = world;

    // Trigger and air volumes: areas, Landmark radii, the open-world Updrafts and Wind_Zones (the Starlit_Stair adds
    // its starlit Updrafts while active). The controller reads the air volumes and the terrain's water through them.
    const volumes = new VolumeIndex();
    volumes.addAll(AREA_VOLUMES);
    volumes.addAll(DISCOVERY_VOLUMES);
    volumes.addAll(AIR_VOLUMES);
    volumes.addAll(POI_AIR_VOLUMES); // task 20.1: the floating isles' Updraft to the lower deck
    volumes.addAll(HAZARD_VOLUMES); // Challenge_Area fall judgement
    this.volumes = volumes;

    const spawn: SafePosition = { pos: runtime.player.pos, yaw: runtime.player.yaw };
    this.controllerVolumes = createControllerVolumes(volumes, terrain);
    this.player = new PlayerController({
      world, volumes: this.controllerVolumes, pos: spawn.pos, yaw: spawn.yaw,
      character: gs.party.active, stamina: runtime.stamina,
      // The glide wind loudness goes to the Audio_System every tick (Req 19.10).
      glideWind: { setGlideWind: (intensity) => sinks.glideWind?.(intensity) },
    });
    // Safe_Position recovery (Req 20.4–20.6, 20.8, and 16.11 for a swim out of Stamina); the spawn is the last resort
    // until respawn points exist. A Challenge_Area's fall judgement is never a Safe_Position, and inside an area its
    // latest checkpoint comes first (ChallengeAreaSystem, Req 12.8).
    this.recovery = new RecoverySystem({
      world, initial: spawn, fallback: () => spawn, unsafeAt: (feet) => volumes.at(feet, 'hazard').length > 0,
    });
    this.restorables = new RestorableRegistry(terrain);

    // Progress objects derived from GameState's Skyshard count and altar flag (Req 2.7).
    const progress = (): WorldProgress => gs;
    const ids = new ColliderIdSource(); // one id source for every collider in `world`
    addBoundaryWall(world, ids); // task 20.4: the invisible 470 m boundary wall (Req 8.6)
    this.stair = new StarlitStair({ world, volumes, ids });
    this.gates = new GateSystem({ world, bus, ids, progress: gs, stair: this.stair });
    this.altar = new ResonanceAltar({ world, ids, progress, activation: { bus, state: gs } });
    this.interaction = new InteractionSystem(bus);
    this.interaction.add(this.altar.interactTarget());
    for (const target of this.gates.gateTargets(progress)) this.interaction.add(target);
    this.triggers = new WorldTriggers({
      bus,
      state: gs,
      volumes,
      unlocked: (region) => regionUnlocked(region, gs),
      sinks: { regionTitle: (region) => sinks.regionTitle?.(region) },
    });

    // Combat: seeded RNG streams, the Active_Character's Normal / Charged attacks with aim assist and pooled
    // projectiles swept against `world`, the Active_Character as the target of enemy hits (Perfect_Dodge during
    // Dodge i-frames), enemy AI standing on the terrain or on walkable collider tops.
    const rngs = createRngStreams(gs.seed);
    const enemyGround = (p: Readonly<Vec3>): number => {
      const hit = world.groundProbe({ x: p.x, y: p.y + ENEMY_GROUND_LIFT, z: p.z }, ENEMY_GROUND_LIFT + ENEMY_GROUND_DROP, 0.3);
      return hit !== null && hit.walkable && hit.colliderId !== null ? hit.point.y : terrain.heightAt(p.x, p.z);
    };
    // Element_System over the enemies: spread / chain reactions, their effects, the codex (Req 25.6, 25.7, 25.13).
    // Ranged enemies check their line of sight against the same world (Req 28.4).
    // Enemy projectiles fly in their own pool and stop on the same world (Req 20.3).
    this.enemies = new EnemySystem({
      enemies: runtime.enemies, terrain, ground: enemyGround, bus,
      codex: gs.codex, timeScale: options.timeScale, zones: runtime.zones, world,
      projectiles: runtime.enemyProjectiles, projectileWorld: world,
    });
    // Spawners (Req 10.7, 11.6): the camp tallies ('camp:cleared') and the cleared camps / defeated Elites in
    // gs.world; the world's enemies are placed from GameState at the end of construction.
    this.spawners = new SpawnerSystem({ bus, enemies: this.enemies, world: gs.world, heightAt, log: sinks.log });
    // Loot_System on 'enemy:defeated': XP (Progression), Glim and drops (Inventory) from the loot stream; drops lie at
    // the body until the Active_Character comes within 3 m (Req 28.13). On 'camp:cleared' it unlocks the camp's
    // Chest and raises "캠프 소탕" (Req 10.7).
    this.progression = new ProgressionSystem({ state: gs, bus });
    this.inventory = new InventorySystem({ state: gs, bus });
    this.loot = new LootSystem({
      bus, rng: rngs.loot, progression: this.progression, inventory: this.inventory, pickups: runtime.pickups,
      bodyAt: (id) => this.enemies.get(id)?.pos ?? null,
      ground: (p) => enemyGround(p),
      world: gs.world,
      campCleared: (notice) => sinks.campCleared?.(notice),
    });
    // Environment Element receivers take the party's hits through the same judgement (Req 13.1). The Puzzle
    // system places the puzzle parts among them and turns their answers and the plates into puzzle progress
    // (Req 13.3–13.7): recorded in gs.world.puzzles, 'puzzle:solved', the reward and a 'puzzle' save.
    this.devices = new ReceiverField({
      onSignal: (signal) => this.puzzles.deviceSignal(signal),
      onPlate: (part, change) => this.puzzles.plate(part, change),
    });
    // The save's puzzles: the fixed ones and the Observatory's, whose constellation order comes from the save seed.
    this.puzzles = new PuzzleSystem({
      // Task 13.3: plus the defined Side_Quests' puzzles (sq_durga's braziers), none of a dropped Side_Quest.
      bus, state: gs, field: this.devices, world, ids, heightAt, defs: [...puzzleDefsFor(gs.seed), ...sideQuestPuzzles(questDefs)],
      rewards: {
        grantXp: (amount) => this.progression.grantXp(amount),
        addGlim: (amount) => this.inventory.addGlim(amount),
        grant: (itemId, count, source) => this.inventory.grant(itemId, count, source),
      },
      hint: (puzzleId, text) => sinks.puzzleHint?.(puzzleId, text),
    });
    // Talus's Skill raises a stone pillar: a walkable-topped collider that also holds pressure plates down.
    this.pillars = new TalusPillars({ world, ids });
    // Skill cooldowns start in the combat system and count down in the Party_System; Energy per character is
    // granted by hits, Reactions and Perfect_Dodges and spent by the Burst (Req 24.4–24.7).
    this.combat = new PlayerCombat({
      bus, rng: rngs.combat, level: () => gs.party.level, character: () => gs.party.active, world, projectiles: runtime.projectiles,
      energy: runtime.energy, cooldowns: runtime.cooldowns,
      onAbilityHit: (hit) => this.pillars.abilityHit(hit),
      abilityTier: (id, ability) => gs.party.upgrades[id][ability], // task 12.3: Echo Altar tiers
      equipment: (id) => this.equipment.modifiers(id), // task 12.4: EquipEffects
      setTimeScale: options.timeScale, // task 19.6: Charged final / Burst Hit_Stop
      onHit: (hit) => sinks.hit?.(hit), // task 19.5: impact VFX and camera impulse
    });
    this.perfectDodge = new PerfectDodge({ bus, character: () => gs.party.active, setTimeScale: options.timeScale });
    this.playerTarget = createPlayerReceiver({
      gameState: gs, bus, body: () => this.player.state,
      onEvade: (attackerId, iFrames) => this.perfectDodge.evaded(attackerId, iFrames),
      // Burst cut-in (Req 24.6); task 22.1: Debug_Tools "무적" by the same immunity rule.
      invulnerable: () => this.combat.invulnerable || this.debugTools.invincible,
      onKnockback: (direction, distance) => this.player.knockback(direction, distance), // Req 28.10
    });
    this.playerInput = this.combat.gateInput(input); // attack rules on movement, jump and Dodge

    // Minimal full route (task 4.9): temporary pieces and lifts, the Skyshard pedestal stubs, encounter groups,
    // cinematics, Caelith. The NPC talk stubs gave way to the NPCs and the Dialogue_System (tasks 13.1, 13.2).
    this.route = new TempRoute({
      world, ids, bus, heightAt,
      progress: { stairActive: () => this.stair.active, puzzleSolved: (id) => gs.world.puzzles.includes(id) },
      move: (spot) => this.recovery.restorePlayer('lift', spot),
    });
    this.stubs = new RouteStubs({
      bus, state: gs, world, ids, heightAt,
      quests: { objectiveView: () => this.quests.objectiveView('main') },
    });
    // Astral Sanctum (task 10.2): gate slab, hall with ws_sanctum and the mural, the arena's disc, sectors, pedestals,
    // non-climbable rim with its ward, and the entrance seal (Req 5.7, 6.11).
    this.sanctum = new SanctumSystem({ world, ids });
    for (const target of [...this.route.interactTargets(), ...this.stubs.interactTargets(), ...this.sanctum.interactTargets()]) {
      this.interaction.add(target);
    }
    // Task 13.7: the Waystones (the five ground stones' colliders; ws_sanctum's stone is the Sanctum's piece). Every
    // interaction heals the party, clears Downed and sets the respawn point; the first one activates (Req 11.1–11.3).
    this.waystones = new WaystoneSystem({
      bus, state: gs, world, ids, heightAt,
      restoreParty: () => this.party.restoreAll(),
      notice: (notice) => sinks.waystone?.(notice),
    });
    for (const target of this.waystones.interactTargets()) this.interaction.add(target);
    // Tasks 13.1–13.3: Thistlewick's buildings and Hearth, the NPCs (and companions until they join) as talk targets,
    // the Dialogue_System over them (NPC talks and the Main_Quest stage briefings, Req 3.8), the Side_Quests' objects.
    this.village = new VillageSystem({
      bus, state: gs, world, ids, heightAt,
      restoreParty: () => this.party.restoreAll(),
      rested: () => sinks.hearthRested?.(),
    });
    this.npcs = new NpcSystem({ state: gs, heightAt });
    this.sideQuests = new SideQuestWorld({ bus, state: gs, questDefs, quests: this.quests });
    this.dialogue = new DialogueSystem({
      bus, state: gs, quests: this.quests, npcs: this.npcs, questDefs,
      player: () => this.player.state.pos,
      // A briefing waits for a calm moment: standing, out of combat, no fade / cinematic / travel, not Downed, and not
      // at an interaction target (the player's own 'interact' press there is never swallowed).
      ready: () =>
        this.player.state.mode === 'grounded' && !this.runtime.inCombat && !this.inputLocked && !this.party.inputBlocked &&
        this.interaction.prompt === null,
      onChange: (view) => sinks.dialogue?.(view),
    });
    for (const target of [...this.village.interactTargets(), ...this.npcs.interactTargets(), ...this.sideQuests.interactTargets()]) {
      this.interaction.add(target);
    }
    // Task 13.5: the map fog from GameState, revealed around the Active_Character and from the Vista_Points.
    this.fog = new FogSystem({
      state: gs,
      onVista: (id, first) => {
        if (first) this.progression.grantDiscovery('vista', id); // task 20.3: Vista_Point first-discovery XP (30)
        sinks.vista?.(id, first);
      },
    });
    // Tasks 12.7 / 20.1: the POIs (structures, tablets, lore, caches, herbs, the trial) and the Chests; built before the
    // spawners place the world's enemies so Galeclaw stands on the isles' lower deck.
    this.pois = new PoiSystem({
      bus, state: gs, world, ids, heightAt, progression: this.progression, inventory: this.inventory,
      setStaminaMax: (max) => {
        this.player.setStaminaMax(max);
        this.runtime.stamina = { ...this.player.stamina };
      },
      notice: (notice) => sinks.poi?.(notice),
    });
    this.chests = new ChestSystem({
      bus, state: gs, world, ids, heightAt, inventory: this.inventory,
      locked: (id) => this.loot.chestLocked(id),
      puzzleOpen: (target) => this.puzzles.isOpen(target),
      trialDone: (id) => this.pois.trialDone(id),
      bodyAt: (id) => this.enemies.get(id)?.pos ?? null,
      opened: (notice) => sinks.chestOpened?.(notice),
    });
    for (const target of [...this.chests.interactTargets(), ...this.pois.interactTargets()]) this.interaction.add(target);
    // Challenge_Areas (Hollowroot Shrine, Cinderspire and Starfall Observatory, tasks 9.6–9.8): walls, canopy, spires,
    // ramp, the hall, ring and dome, doors over the puzzle and room state, lifts, the Heat_Crystal wall over its device,
    // risers (exit stairs, vent ledges), checkpoint runes feeding the recovery override, fall judgement, the combat-room
    // locks and the ring corridor's waves (placed through the spawners), the ceiling constellations (Req 12.1–12.3,
    // 12.7–12.9).
    this.challenge = new ChallengeAreaSystem({
      bus, state: gs, world, ids, volumes, recovery: this.recovery, puzzles: this.puzzles, clock: this.devices,
      rooms: {
        members: (groupId) => [...runtime.enemies.values()].filter((e) => e.campId === groupId && e.state !== 'dead'),
        resetMember: (id) => {
          this.enemies.reset(id);
        },
        spawn: (groupId) => {
          this.spawners.activate(groupId);
        },
      },
    });
    for (const target of this.challenge.interactTargets()) this.interaction.add(target);
    // Task 21.1: the Cinematic_System; its skip hold reads this tick's InputState (`pause` / `jump`).
    this.cinematics = new CinematicPlayer({
      bus, runtime, seen: gs.cinematicsSeen, input,
      onChange: (id) => sinks.cinematic?.(id),
      onCue: (cue) => sinks.cinematicCue?.(cue),
    });
    // Task 10: Caelith's BossEncounter on the Sanctum arena (SANCTUM.arena, its pedestals as crystal sockets); begin()
    // heals the party, Reactions on Caelith go to the codex, the Starshell break asks for the Hit_Stop.
    this.boss = new BossEncounter({
      bus, rng: rngs.boss, world, colliderId: ids.next(), runtime,
      codex: gs.codex, setTimeScale: options.timeScale, healParty: () => this.party.restoreAll(),
      record: {
        reachedPhase: (phase) => {
          gs.boss = { reachedPhase: Math.max(gs.boss?.reachedPhase ?? 1, phase) as BossPhase };
        },
        defeated: () => {
          gs.bossDefeated = true;
        },
      },
    });
    // Party_System: a switch hands this one body to the new Active_Character (position, yaw and velocity carry
    // over) and cancels the attack in progress; projectiles, placed effects and enemy marks stay (Req 23.1, 23.6).
    this.party = new PartySystem({
      bus, state: gs, runtime,
      bossPhase: () => (this.boss.active ? this.boss.phase : null),
      onSwitch: (_from, to) => {
        this.combat.cancel();
        this.player.switchCharacter(to);
      },
    });
    // Task 12.4: consumables (Z herb dumpling, Ember Feather) and the EquipEffects the systems read from GameState.
    this.consumables = new ConsumableSystem({ state: gs, inventory: this.inventory, party: this.party });
    this.equipment = new EquipmentEffects({ bus, state: gs, runtime, party: this.party });
    this.idleInput = {
      moveVector: () => ({ x: 0, y: 0 }),
      down: () => false,
      pressed: () => false,
      isBuffered: () => false,
      get walkToggled() {
        return input.walkToggled;
      },
      consumeBuffered: () => false,
    };

    this.unsubscribe.push(
      bus.on('enemy:defeated', () => {
        gs.stats.enemiesDefeated += 1;
      }),
      // The victory opens the arena entrance.
      bus.on('boss:defeated', () => {
        gs.stats.enemiesDefeated += 1;
        this.sanctum.setSealed(false);
      }),
      // A Party_Wipe in the Caelith fight opens the entrance too; a retry seals it again (apply).
      bus.on('party:wipe', (p) => {
        if (this.boss.engaged) this.sanctum.setSealed(false);
        this.boss.halt(); // task 10.8: the fight stops (hazards cleared) until the Defeat choice
        sinks.partyWipe(p.bossPhase);
      }),
      bus.on('cinematic:ended', (p) => {
        if (p.cinematicId === ENDING_CINEMATIC_ID) {
          // Task 21.3 (Req 7.6): the game is complete and its Victory record saved before the Victory Screen opens.
          const playTimeSec = options.playTimeSec?.() ?? gs.stats.playTimeSec;
          if (completeGame(gs, { playTimeSec, placesTotal: PLACE_TOTAL, chestsTotal: CHEST_TOTAL })) {
            bus.emit('save:request', { reason: 'gameComplete' });
          }
          sinks.ending();
        }
        // The fight starts once Caelith's entrance has played (Req 6.11).
        if (p.cinematicId === BOSS_INTRO_CINEMATIC_ID && this.boss.state === 'intro') this.boss.begin(this.boss.phase);
      }),
    );

    // Task 13.4: Tutorial_System over the bus, this tick's InputState and the world (signal judges read the party,
    // enemies, prompt and puzzles); completed hints go into gs.tutorials.
    this.tutorial = new TutorialSystem({ bus, state: gs, input, ...simTutorialSources(this) });

    // Task 22.1: Debug_Tools through the systems' normal public paths (Req 41.4).
    this.debugTools = new DebugTools({
      state: gs,
      joinAll: () => {
        for (const id of PARTY_SLOTS) this.party.join(id);
      },
      addGlim: (amount) => this.inventory.addGlim(amount),
      grantSkyshard: () => this.stubs.acquireNext(),
      travelTo: (x, z) => {
        if (this.inputLocked) return false;
        const hit = world.groundProbe({ x, y: 600, z }, 800, 0.3);
        const y = hit !== null && hit.walkable ? hit.point.y : terrain.heightAt(x, z);
        return this.arriveByFastTravel({ pos: { x, y, z }, yaw: this.player.state.yaw });
      },
      bossDirect: () => {
        if (this.inputLocked || this.boss.state === 'dead') return false;
        const spot = this.sanctum.arenaEntrySpot();
        const moved = this.arriveByFastTravel(spot);
        this.cinematics.resetFight();
        this.boss.begin(1);
        this.sanctum.setSealed(true, spot.pos);
        return moved;
      },
    });

    // The world's enemies as GameState says: a New Game places them all, a load skips the cleared camps and the
    // defeated Elites (Req 11.6).
    this.spawners.rebuild();
  }

  /** Starts play of a New Game: the first stage's `onStart` and the first objective. Once only. */
  begin(): void {
    if (this.began) return;
    this.began = true;
    this.quests.startNewGame();
    this.dialogue.beginNewGame(); // task 13.1: ms1's briefing once the party can listen (Req 3.8)
  }

  /**
   * Task 15.6 Continue (Req 36.8, 2.7): play of a loaded GameState without any cinematic. The world already derived
   * itself from GameState when the session was built (barriers, altar / seal / stair, puzzles, camps, Elites); here the
   * encounter groups the current quest stages spawned at their start come back unless cleared, and the tracked
   * Objective shows (its `defeat` group is placed by the spawners). Once only; begin() and resume() exclude each other.
   */
  resume(): void {
    if (this.began) return;
    this.began = true;
    const gs = this.gameState;
    const stageGroups: string[] = [];
    for (const def of this.questDefs) {
      const pos = def.id === 'main' ? (gs.quests.main.done ? null : gs.quests.main) : gs.quests.side[def.id];
      if (pos === null || pos === undefined || ('status' in pos && pos.status !== 'active')) continue;
      for (const e of def.stages[pos.stage]?.onStart ?? []) if (e.kind === 'spawnGroup') stageGroups.push(e.groupId);
    }
    for (const id of stageGroups) if (!gs.world.camps.includes(id)) this.spawners.activate(id);
    this.quests.resume();
  }

  /**
   * Task 15.6: the pose the next Continue starts from, into GameState.lastSafe (Req 36.8): inside a Challenge_Area its
   * latest checkpoint, otherwise the newest recorded Safe_Position (the current feet before the first one).
   */
  recordSafePosition(): void {
    const checkpoint = this.recovery.checkpointOverride;
    const spot = checkpoint?.spot ?? this.recovery.safePositions[0] ?? { pos: this.player.state.pos, yaw: this.player.state.yaw };
    const { pos, yaw } = spot;
    if (![pos.x, pos.y, pos.z, yaw].every(Number.isFinite)) return;
    this.gameState.lastSafe = { pos: [pos.x, pos.y, pos.z], yaw };
  }

  /**
   * The world after fast travel or a Party_Wipe restart (design "재배치", Req 11.6, 27.4), called between ticks or from
   * a UiCommand: engaged enemies back at their spawn, idle at full HP; defeated roaming enemies and every member of
   * an uncleared camp or active encounter group placed again at full HP; cleared camps and defeated Elites stay gone.
   * Drops still lying around are removed.
   */
  respawnWorld(): void {
    this.spawners.rebuild();
    this.loot.clear();
    this.pois.regrow(); // task 20.1: caches and herb bushes are back, a running Sky Ring Trial is dropped
  }

  /** Input is held: a recovery or lift fade, a fast travel (task 13.7), a cinematic, or a dialogue (task 13.1). */
  get inputLocked(): boolean {
    return this.recovery.active || this.cinematics.playing !== null || this.waystones.travelling || this.dialogue.open;
  }

  /** Movement mode and position for the F3 panel. */
  debugInfo(): Record<string, string> {
    const { pos, mode } = this.player.state;
    return { mode, pos: `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}` };
  }

  /** The Active_Character as a hit target (its hurt capsule is what enemy attacks judge). */
  get playerReceiver(): HitReceiver {
    return this.playerTarget;
  }

  /**
   * Task 14.2: the menu screens (Shop, Echo Altar, Inventory / Equipment, Quest) open under PauseMode 'menu', where no
   * fixed tick runs. Their UiCommands are applied here at once, through the same owning systems and checks as at the
   * start of a tick, followed by an EventDispatch (the Milestone save requests, the HUD Objective); game time does not
   * advance. Commands that move the party or need the world running (Defeat / Victory choices, fast travel, "끼임
   * 해제", Debug_Tools) stay queued, in order, for the next tick.
   */
  applyMenuCommands(): void {
    const later: UiCommand[] = [];
    let applied = false;
    for (const command of this.options.commands.drain()) {
      if (MENU_COMMAND_KINDS.has(command.kind)) {
        this.apply(command);
        applied = true;
      } else {
        later.push(command);
      }
    }
    for (const command of later) this.options.commands.push(command);
    if (applied) this.bus.dispatch();
  }

  /**
   * One fixed tick of `dt` s; the InputState already holds this tick's sample. `cameraYaw` is the movement and aim
   * reference, `aimRay` the camera's centre ray for Isla's shots without a target (RuntimeState.lockTarget holds
   * the camera's Lock-on target).
   */
  tick(dt: number, cameraYaw: number, aimRay: AimRay | null = null): PlaySimTickResult {
    let teleported = false;
    for (const command of this.options.commands.drain()) teleported = this.apply(command) || teleported;
    // Task 13.3: a Side_Quest accepted outside a talk gets its held progress re-sent (after the last EventDispatch).
    this.sideQuests.tick();
    const { player, recovery, runtime, enemies, gates, triggers, interaction, stair, boss, combat } = this;
    const input = this.options.input;
    // Task 13.4: Tutorial_Hints first, while the InputState still holds this tick's presses in the gameplay context
    // (a dialogue opened later in this tick switches the context and clears them).
    this.tutorial.tick(dt);
    // Task 21.1: the tick a cinematic ends (or is skipped) still holds input; control returns on the next tick.
    const wasPlaying = this.cinematics.playing !== null;
    this.cinematics.tick(dt);
    const cinematic = wasPlaying || this.cinematics.playing !== null;
    // Task 13.1: the Dialogue_System reads this tick's advance presses (interact / jump / attack) while a window is
    // open, or starts a waiting stage briefing; a dialogue open at any point of the tick holds the game like the
    // ContextGate's 'dialogue' mode (player input to the dialogue only, enemies and the boss frozen).
    const wasTalking = this.dialogue.open;
    this.dialogue.tick(dt, input);
    const talking = wasTalking || this.dialogue.open;
    // ContextGate: no player input while fading (recovery, task 13.7 fast travel), in a cinematic or in a dialogue
    const locked = recovery.active || cinematic || this.waystones.travelling || talking;
    // PartySystem: cooldowns, joins, the Downed timer and switch presses (refused while climbing, gliding,
    // swimming, in a dialogue or in a cinematic); a Downed Active_Character takes no control input for its 0.8 s.
    const { party } = this;
    const scene = cinematic ? 'cinematic' : talking ? 'dialogue' : 'play';
    party.tick({ dt, input: locked ? null : input, context: switchContextFor(player.state.mode, scene) });
    const down = party.inputBlocked;
    this.consumables.tick(dt, !locked && !down && input.pressed('heal')); // task 12.4: Z herb dumpling (Req 27.5)
    if (!locked) {
      const before = { mode: player.state.mode, modeTime: player.state.modeTime };
      const moved = player.tick(down ? this.idleInput : this.playerInput, cameraYaw, dt);
      // Task 12.4 (깃털 방울): a Dodge that started this tick gets part of its Stamina back.
      const after = player.state;
      if (after.mode === 'dodge' && (before.mode !== 'dodge' || after.modeTime < before.modeTime)) {
        player.refundStamina(this.equipment.dodgeRefund());
      }
      // Party Stamina lives in RuntimeState (Req 17.1); the controller steps it with the Active_Character's passive.
      runtime.stamina = { ...player.stamina };
      this.controllerEvents(moved);
    }
    this.perfectDodge.observe(player.state.iFrames); // a new Dodge re-arms the Perfect_Dodge
    // CombatSystem → EnemyAI → BossEncounter; a cinematic stops the attack and freezes both sides (Req 21.10), and so
    // does a dialogue (its advance presses are not attacks).
    if (cinematic || down || talking) combat.cancel();
    else {
      const aim = { lockTarget: runtime.lockTarget, ray: aimRay };
      combat.tick({ input, body: player, cameraYaw, aim, targets: this.targets(), dt, acceptInput: !locked });
    }
    enemies.tick({ dt, player: this.playerTarget, frozen: locked });
    if (!locked) {
      // Devices: pressure plates under the character and Talus's pillars, Unstable_Crystal blasts on the enemies and
      // the character; then the puzzles: arrival triggers, sequence time limits and the devices' solid bodies.
      this.pillars.tick(dt);
      const weights = [{ id: PLAYER_ENTITY_ID, pos: player.state.pos }, ...this.pillars.weights()];
      this.devices.tick(dt, [...enemies.receivers(), this.playerTarget], weights);
      this.puzzles.tick(player.state.pos);
    }
    boss.tick({ dt, target: this.playerTarget, frozen: locked });
    runtime.inCombat = enemies.engaged || boss.active;
    if (!locked) this.equipment.tick(dt); // task 12.4: 새싹 씨앗 out-of-combat regen
    // WorldTriggers: barriers follow GameState, then Region / area / Landmark entry, the boss fight start and the
    // nearest interaction target (2.5 m).
    gates.tick(dt, this.gameState);
    triggers.tick(player.state.pos);
    this.fog.tick(player.state.pos); // task 13.5: 40 m reveal on each new fog cell, Vista_Point 200 m reveal
    // Tasks 12.7 / 20.1: Chests that appear, map POIs and hidden places entered, the Sky Ring Trial's rings and clock.
    this.chests.tick(dt);
    const landed = ['grounded', 'landing', 'slide', 'swim'].includes(player.state.mode);
    this.pois.tick(dt, player.state.pos, landed, locked);
    this.startBossFight();
    this.sanctum.tick(player.state.pos); // a seal waiting for the character to leave the entrance gap closes
    // Task 13.2: NPC behaviour (walkers stop within 2.5 m of the character, a talking NPC turns to it), before the
    // prompt so the talk targets stand where they are drawn.
    this.npcs.tick(dt, player.state.pos);
    interaction.tick(locked ? null : player.state.pos, !locked && input.pressed('interact'));
    // Challenge_Areas: the area the feet are in, checkpoint runes, a fall into its judgement volume (the fade starts in
    // this tick's recovery), combat-room locks, the recovery's checkpoint override and the doors.
    this.challenge.tick({ pos: player.state.pos });
    // CollisionResolve: enemy spacing, push-out of the player's capsule, enemies out of the world back to spawn.
    enemies.resolveCollisions(this.collision, this.playerTarget.hurtVolume(), dt);
    // A fall 10 m below the last Starlit_Stair platform fades back onto it (Req 5.6).
    const stairReturn = locked ? null : stair.track(player.state);
    if (stairReturn !== null) recovery.restorePlayer('stairFall', stairReturn);
    const { teleport } = recovery.tick({ body: player.state, dt, inCombat: runtime.inCombat });
    if (teleport !== null) {
      player.teleport(teleport.pos, teleport.yaw);
      teleported = true;
    }
    // Task 13.7: fast travel's move at the end of its 0.5 s fade-out, then the world refresh (Req 11.4).
    const arrival = this.waystones.tickTravel(dt);
    if (arrival !== null) teleported = this.arriveByFastTravel(arrival) || teleported;
    this.restorables.tick(dt);
    // Drops within 3 m of the final position fly in and are granted ('item:granted', Req 28.13).
    this.loot.tick(dt, locked ? null : player.state.pos);
    party.afterHits(); // Downed at 0 HP; the automatic switch or Party_Wipe follows 0.8 s later
    this.bus.dispatch(); // EventDispatch: quest progress, stubs, cinematics, screens
    return { teleported };
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    this.tutorial.dispose(); // task 13.4
    this.combat.dispose();
    this.quests.dispose();
    this.route.dispose();
    this.stubs.dispose();
    this.cinematics.dispose();
    this.altar.dispose();
    this.spawners.dispose();
    this.loot.dispose();
    this.progression.dispose(); // task 12.1
    this.equipment.dispose(); // task 12.4
    this.challenge.dispose();
    this.waystones.dispose(); // task 13.7
    this.dialogue.dispose(); // tasks 13.1–13.3
    this.village.dispose();
    this.sideQuests.dispose();
    this.chests.dispose(); // task 12.7
    this.pois.dispose(); // task 20.1
    this.bus.clear();
  }

  /**
   * Task 21.1: a cinematic's entity anchor for the render camera: the Active_Character's pose at `alpha`, or Caelith's
   * feet and facing (null while the encounter is dormant: the shot keeps its world fallback).
   */
  cinematicAnchor(anchor: 'player' | 'caelith', alpha = 1): AnchorFrame | null {
    if (anchor === 'player') {
      const pose = this.player.pose(alpha);
      return { pos: { ...pose.pos }, yaw: pose.yaw };
    }
    if (!this.boss.engaged && this.boss.state !== 'dead') return null;
    const snap = this.boss.snapshot();
    return { pos: { ...snap.pos }, yaw: snap.yaw };
  }

  /** Living enemies and the fighting Caelith, for the camera's Lock-on (Req 21.6, 21.8). */
  lockCandidates(): LockCandidate[] {
    const out: LockCandidate[] = [];
    for (const r of this.enemies.receivers()) {
      if (r.immune()) continue; // dead bodies stay listed as immune until removed
      out.push({ id: r.id, center: aimPoint(r.hurtVolume()) });
    }
    if (this.boss.active) {
      out.push({ id: CAELITH_ENTITY_ID, center: aimPoint(this.boss.receiver().hurtVolume()) });
      // Task 10.4: the standing Shard_Crystals can be locked on too.
      for (const c of this.boss.crystalReceivers()) out.push({ id: c.id, center: aimPoint(c.hurtVolume()) });
    }
    return out;
  }

  /**
   * Reaction preview per party slot (Req 23.9): against the Lock-on target, else the nearest marked enemy, the
   * reaction each standby character's Element would cause now; null hides the icon.
   */
  reactionPreviews(): ReactionPreviewSlot[] {
    const now = this.enemies.simTime;
    const candidates: PreviewCandidate[] = [...this.runtime.enemies.values()].map((e) => ({
      id: e.id, pos: e.pos, alive: e.state !== 'dead', element: e.element,
    }));
    const target = previewTarget(candidates, this.runtime.lockTarget, this.player.state.pos, now);
    const slots = this.party.slots().map((s) => ({
      characterId: s.id,
      element: CHARACTERS[s.id].element,
      standby: s.joined && !s.active && !s.downed,
    }));
    return reactionPreviews(target?.element ?? null, slots, now);
  }

  /** Attack Telegraphs showing now: enemies' and Caelith's (Req 21.5). */
  telegraphs(): TelegraphMarker[] {
    const out: TelegraphMarker[] = this.enemies.telegraphs();
    // Task 10: one arrow per Caelith / Shard_Crystal Telegraph area, at its centre, strong ones marked.
    if (this.boss.active) {
      for (const t of this.boss.telegraphs()) out.push({ entityId: CAELITH_ENTITY_ID, pos: { ...t.center }, strong: t.strong });
    }
    return out;
  }

  /**
   * The controller's events of this tick for the presentation and the recovery: `exhausted` flashes the Stamina ring
   * (Req 17.3), `footstep` and `enteredWater` go to the step / splash sinks at the water surface (Req 16.9, 16.10), and
   * `recoveryNeeded` (a swim out of Stamina, the body now `locked`) asks the RecoverySystem for its fade back to the last
   * Safe_Position, which begins in this tick's CollisionResolve; its teleport ends the lock (Req 16.11). A recovery
   * already waiting or running refuses the request, and its own teleport ends the lock just the same.
   */
  private controllerEvents(events: readonly ControllerEvent[]): void {
    const { sinks } = this.options;
    for (const e of events) {
      switch (e.type) {
        case 'exhausted':
          sinks.staminaExhausted?.();
          break;
        case 'footstep':
          sinks.footstep?.(e.material, e.material === 'water' ? this.waterSurfacePoint() : { ...this.player.state.pos });
          break;
        case 'enteredWater':
          sinks.enteredWater?.(this.waterSurfacePoint());
          break;
        case 'recoveryNeeded':
          this.recovery.restorePlayer('swimExhausted');
          break;
        default:
          break;
      }
    }
  }

  /** The water surface above (or at) the Active_Character's feet; the feet where there is no water. */
  private waterSurfacePoint(): Vec3 {
    const { pos } = this.player.state;
    const water = this.controllerVolumes.water(pos.x, pos.z);
    return { x: pos.x, y: water !== null && water.level > pos.y ? water.level : pos.y, z: pos.z };
  }

  /** What the party's hits can land on: the enemies and, while it fights, Caelith. */
  private *targets(): Iterable<HitReceiver> {
    yield* this.enemies.receivers();
    if (this.boss.active) {
      yield this.boss.receiver();
      yield* this.boss.crystalReceivers(); // task 10.4: Shard_Crystals
    }
    yield* this.devices.hitTargets();
    yield* this.pois.hitTargets(); // task 20.1: breakable caches
  }

  /** `joinParty` (a companion's dialogue): the companion joins its slot ('party:joined'). */
  private joinParty(character: CharacterId): void {
    this.party.join(character);
  }

  /** Task 12.1: a quest `grant` reward: XP to the Progression_System, Glim and items to the Inventory_System. */
  private grantReward(reward: RewardRef, source: string): void {
    if (reward.xp !== undefined) this.progression.grantXp(reward.xp);
    if (reward.glim !== undefined) this.inventory.addGlim(reward.glim);
    for (const item of reward.items ?? []) this.inventory.grant(item.id, item.count, source);
  }

  /**
   * The Caelith fight begins on the arena once its `defeat caelith` Objective is current and the Active_Character
   * is in the fight zone: the entrance seals, and on the first entry (cin_boss_intro not in GameState.cinematicsSeen)
   * Caelith stands through its intro cinematic before the fight starts from its end ('cinematic:ended'); later
   * entries start the fight at once. Either way from the highest Phase reached (its checkpoint).
   */
  private startBossFight(): void {
    const gs = this.gameState;
    if (this.boss.state !== 'dormant' || gs.bossDefeated) return;
    const trigger = this.quests.objectiveView('main')?.objective.trigger;
    if (trigger?.kind !== 'defeat' || trigger.groupId !== BOSS_GROUP_ID) return;
    const p = this.player.state.pos;
    if (!this.sanctum.inFightZone(p)) return;
    const phase = gs.boss?.reachedPhase ?? 1;
    this.sanctum.setSealed(true, p);
    if (gs.cinematicsSeen.includes(BOSS_INTRO_CINEMATIC_ID)) {
      this.boss.begin(phase);
      return;
    }
    this.boss.intro(phase);
    this.cinematics.play(BOSS_INTRO_CINEMATIC_ID);
  }

  /**
   * UiCommands, validated and applied here until their owning systems exist: the Party_System restores the party
   * on the Defeat restart, the Caelith encounter (task 10) takes over the Phase retry and Waystone return, and the World
   * the post-ending state for "탐험 계속" (Req 7.5). Returns whether the character was moved.
   */
  private apply(command: UiCommand): boolean {
    switch (command.kind) {
      case 'defeatChoice': {
        // Req 27.3, 27.4: the whole party at full HP; the fight's enemies back at full HP by the spawner rules.
        this.party.restoreAll();
        this.combat.reset();
        this.respawnWorld();
        // "현재 Phase부터 재도전": just inside the entrance, sealed again, the fight from the Phase's checkpoint (the
        // intro is not played again). "Waystone으로 돌아가기": in front of ws_sanctum with the entrance open.
        if (command.choice === 'retryPhase' && this.boss.active) {
          const spot = this.sanctum.arenaEntrySpot();
          this.boss.begin(this.boss.phase);
          this.sanctum.setSealed(true, spot.pos);
          return this.place(spot);
        }
        this.boss.sleep();
        this.sanctum.setSealed(false);
        if (command.choice === 'returnToWaystone') return this.place(this.sanctum.waystoneSpot());
        // Inside a Challenge_Area the party starts again at its latest checkpoint (Req 12.8): solved puzzles, cleared
        // rooms and defeated Elites stay; attempts in progress (sequence timers, plates, pillars) and the uncleared
        // fight (placed again at full HP by respawnWorld above) start over.
        const checkpoint = this.challenge.restartSpot();
        this.challenge.restart();
        this.puzzles.resetUnsolved();
        this.pillars.clear();
        if (checkpoint !== null) return this.place(checkpoint);
        return this.placeSpot(respawnSpot(this.gameState.respawn));
      }
      case 'continueExploring':
        return this.placeSpot(THISTLEWICK_HEARTH);
      // Task 13.7: map fast travel, checked here on the tick after the map queued it: refused In_Combat with its
      // message, else the 0.5 s fade-out begins and tickTravel moves the character at its end (Req 11.4, 11.5).
      case 'fastTravel':
        // Not over a running recovery / lift fade or a cinematic (the map cannot open then either).
        if (!this.inputLocked) this.waystones.requestTravel(command.waystoneId, this.runtime.inCombat);
        return false;
      // Task 12.3: Echo Altar, re-validated with canUpgrade; the Inventory_System takes Starmote and Glim (Req 29.4–29.6).
      case 'upgradeAbility':
        this.progression.upgradeAbility(command.characterId, command.ability, this.inventory);
        return false;
      // Task 12.4: equip / unequip, in force this tick, 'equipment' Milestone save (Req 30.2, 30.3).
      case 'equip':
        this.inventory.equip(command.characterId, command.slot, command.itemId);
        return false;
      // Task 12.4: Inventory screen use: herb dumpling on the Active_Character, Ember Feather on a Downed target (Req 27.6).
      case 'useItem':
        this.consumables.useItem(command.itemId, command.target);
        return false;
      // Task 12.5: Pip's shop, only `purchase` ok changes the inventory and Glim (Req 14.11, 14.12).
      case 'purchase':
        this.inventory.purchase(command.itemId);
        return false;
      // Task 13.3: the Quest screen's tracked Side_Quest (null: the Main_Quest); only an 'active' one is taken, and the
      // HUD, Compass and map follow the re-shown Objective (Req 15.4).
      case 'trackQuest':
        this.quests.track(command.questId ?? 'main');
        return false;
      // Task 14.2: Pause "끼임 해제" (Req 20.8): the automatic recovery path (fade, the latest Safe_Position or checkpoint).
      case 'unstuck':
        return this.recovery.requestUnstuck();
      // Task 22.1: a Debug_Tools panel operation, through the owning systems' public methods (Req 41.1, 41.4).
      case 'debug':
        return this.debugTools.apply(command.action);
      // ── Owned-system commands (tasks 12–22): each owning system adds its case above this line. ──
      default:
        return false;
    }
  }

  private placeSpot(spot: SpotDef): boolean {
    return this.place({ pos: { x: spot.x, y: spot.groundY, z: spot.z }, yaw: spot.yaw });
  }

  private place(spot: SafePosition): boolean {
    return this.player.teleport(spot.pos, spot.yaw);
  }

  /**
   * Task 13.7: fast travel arrives (the end of its fade-out): the Active_Character stands 2 m in front of the
   * Waystone, and the world is refreshed as after a Party_Wipe restart (enemies placed again by the spawner rules,
   * drops cleared, Req 11.6); the triggers and the fog forget the old position so the new one is entered afresh.
   */
  private arriveByFastTravel(spot: SafePosition): boolean {
    this.combat.reset();
    const moved = this.place(spot);
    this.respawnWorld();
    this.triggers.reset();
    this.fog.reset();
    return moved;
  }
}
