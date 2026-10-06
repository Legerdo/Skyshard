import * as THREE from 'three';
import type { AudioEngine } from './audio/audioEngine'; // task 16: the page's Audio_System
import { SessionAudio } from './audio/sessionAudio'; // task 16: this session's sounds and music selection
import { createCameraCollision } from './camera/cameraCollision';
import { CameraCore } from './camera/cameraCore';
import { CameraSystem } from './camera/cameraSystem';
import { combatSpread, edgeIndicator } from './camera/combatFraming';
import { CinematicOverlay } from './cinematics/cinematicOverlay'; // task 21.1
import type { CameraRig } from './camera/cameraCore'; // task 21.1: the cinematic shot pose and its 0.4 s blend out
import { applyCameraRig } from './camera/threeCamera'; // task 21.1
import { CAELITH_ENTITY_ID } from './boss/bossEncounter';
import type { AimRay } from './combat/aim';
import type { SetTimeScale } from './combat/perfectDodge';
import type { GameEventBus } from './core/gameEvents';
import type { Vec3 } from './core/types';
import type { UiCommandQueue } from './core/uiCommands';
import { CHARACTERS } from './data/characters';
import type { InputState } from './input/inputState';
import { keyLabel } from './input/keyLabels';
import type { GameState } from './logic/save/gameState';
import { PlaySim } from './playSim';
import { TempAirVolumeView } from './render/tempAirVolumeView';
import { TempBossView } from './render/tempBossView';
import { TempChallengeAreaView } from './render/tempChallengeAreaView';
import { HeroViews, type HeroViewState } from './visual/heroViews'; // task 19.2: hero rigs (was the temporary capsule)
import { defaultVisualLibrary } from './visual/visualLibrary'; // task 19.7: Visual_Manifest → procedural / external models
import { TempEnemyView } from './render/tempEnemyView';
import { TempPickupView } from './render/tempPickupView';
import { TempProjectileView } from './render/tempProjectileView';
import { TempPuzzleView } from './render/tempPuzzleView';
import { TempRouteView } from './render/tempRouteView';
import { TempSanctumView } from './render/tempSanctumView';
import { WorldObjectsView } from './render/worldObjectsView';
import { SessionVfx } from './vfx/sessionVfx'; // tasks 19.5 / 19.6: VFX, decals, damage numbers, hit feel
import type { RuntimeState } from './save/runtimeState';
import { BossBar } from './ui/bossBar';
import { bossBarModel } from './ui/bossBarModel';
import { CombatHud } from './ui/combatHud';
import { EnemyBars } from './ui/enemyBars'; // task 14.3: enemy HP bar pool (12)
import { HUD_WORLD_BARS } from './ui/hudLayout'; // task 14.3
import { HudModelTracker } from './ui/hudModel'; // task 14.3: the frame's HudModel
import { hudInputOf } from './ui/hudSource'; // task 14.3
import { GameplayHud } from './ui/hud';
import { HudBanner } from './ui/hudBanner';
import { InteractPromptView } from './ui/interactPrompt';
import { ReactionPopups } from './ui/reactionPopups';
import { RegionTitleCard } from './ui/regionTitleCard';
import { LevelUpNotice } from './ui/levelUpNotice'; // task 12.1
import { SaveIndicator } from './ui/saveIndicator'; // task 15.6
import type { SaveTarget } from './save/saveSystem'; // task 15.6
import { ScreenFade } from './ui/screenFade';
import { StaminaRing, type ScreenAnchor } from './ui/staminaRing';
import { TelegraphArrows, type TelegraphArrow } from './ui/telegraphArrows';
import { TutorialHintView } from './ui/tutorialHint'; // task 13.4: Tutorial_Hint card
import { tapLook } from './tutorial/hintKeys'; // task 13.4: mouse look completes the camera hint
import { buildVictoryView, type VictoryView } from './ui/victoryView';
import type { TerrainField } from './world/terrain';
// Tasks 13.5 / 13.7: Compass, Waystone notices and stones, the map screen's read-outs.
import { Compass } from './ui/compass';
import { TravelNotice } from './ui/travelNotice';
import { TempWaystoneView } from './render/tempWaystoneView';
import { compassModel } from './map/compassModel';
import { headingFromYaw } from './map/mapCoords';
import { LANDMARK_POINTS, type MapObjectives } from './map/mapModel';
import { WAYSTONES } from './data/waystones';
import type { MapScreenOptions } from './ui/mapScreen';
// Tasks 13.1–13.3: the Dialogue screen and the TEMPORARY Thistlewick / NPC view.
import { DialogueScreen } from './ui/dialogueScreen';
import { TempVillageView } from './render/tempVillageView';
// Tasks 18.2 / 18.3: the time-of-day request for the page's world scene, and the Landmarks (seal ring, light pillar).
import { bossSkyOf, SkyDirector, type SkyRequest } from './render/timeOfDay';
import { LandmarkView } from './render/landmarks';
import { EnvironmentView } from './render/environmentView'; // task 18.5: water, atmosphere, birds, Blight, blob shadows
import type { InteriorLook } from './render/interiorLighting'; // task 18.5
// Tasks 12.7 / 20.1–20.4: pickup feed, discovery card, Landmark framing, the TEMPORARY POI view and the cloud sea.
import { CHEST_TOTAL, PLACE_TOTAL, SKY_RING_TRIAL, silhouettePoint } from './data/pois';
import { LandmarkFraming, LANDMARK_FRAMING_SECONDS } from './camera/landmarkFraming';
import { PickupFeed } from './ui/pickupFeed';
import { DiscoveryNotice } from './ui/discoveryNotice';
import { TempPoiView } from './render/tempPoiView';
import { WorldEdgeView } from './render/worldEdgeView';
// Task 21.1: cinematic data (landmark ids ↔ their cinematics) and the fixed tick for the shot look-ahead.
import { CINEMATIC_TRIGGERS, cinematicDef } from './data/cinematics';
import { LANDMARK_IDS } from './data/ids';
import { SIM_DT } from './core/loop';
import { AnimClock } from './anim/animClock'; // task 19.4: scaled animation time

/** Task 21.1: after a cinematic the camera blends back to its follow pose over this many real seconds. */
const CINEMATIC_BLEND_OUT = 0.4;
/** Task 21.1: the cinematic camera stays this far above the terrain under it (m). */
const CINEMATIC_GROUND_CLEARANCE = 0.6;

/*
 * One play session: the headless simulation (PlaySim: GameState, RuntimeState, the event bus and every system that
 * changes them) plus the camera, the views and the HUD built around it, so the Title Screen can show a prepared
 * world and "메인 메뉴" can throw a session away. Page-level parts (the renderer, terrain mesh, lights, input,
 * ScreenManager, game loop) stay in main.ts and are passed in.
 *
 * Fixed tick: PlaySim.tick with the Camera_System's yaw (movement is camera relative); a teleport snaps the camera.
 * Render frame: interpolate the player pose (alpha) → Camera_System (skipped under the Title's orbit camera) →
 * character, enemy, boss, route and progress-object views → recovery fade, title card, banners, combat HUD,
 * Stamina ring (beside the character, Req 17.5) and interaction prompt.
 *
 * Terrain colours, the capsule character, the route pieces and the lighting are temporary until the art tasks.
 */

/**
 * Place and Chest totals for the Victory Screen (tasks 12.7 / 20.1): Landmarks, map POIs and hidden places; every
 * Chest (src/data/pois.ts).
 */
const PLACES_TOTAL = PLACE_TOTAL;
const CHESTS_TOTAL = CHEST_TOTAL;
/** The Stamina ring's anchor above the feet (m): about shoulder height (Req 17.5). */
const STAMINA_RING_HEIGHT = 1.3;

export interface GameSessionOptions {
  /** The session's persistent progress; its systems own and change it inside the fixed tick. */
  gameState: GameState;
  /** Heightfield built from `gameState.seed` (the page keeps its mesh). */
  terrain: TerrainField;
  /** Scene the session's objects join; removed again on dispose. */
  scene: THREE.Scene;
  /** Render camera the Camera_System drives during play. */
  camera: THREE.PerspectiveCamera;
  input: InputState;
  /** UI commands, applied at the start of the next tick. */
  commands: UiCommandQueue;
  /** The loop's play time (s), for the Victory Screen until the completion record exists. */
  playTimeSec(): number;
  /** `'party:wipe'` (from EventDispatch): open the Defeat Screen. */
  onPartyWipe(bossPhase: 1 | 2 | 3 | null): void;
  /** `cin_ending` ended: open the Victory Screen. */
  onEnding(): void;
  /** A cinematic began (true) or ended (false): the input context and PauseMode follow (design "재생 규칙"). */
  onCinematic?(playing: boolean): void;
  /**
   * Task 13.1: a dialogue opened (its screen, to push over the HUD: `dialogue` context, PauseMode 'dialogue') or
   * closed (null: pop it, the context returns).
   */
  onDialogue?(screen: DialogueScreen | null): void;
  /** Task 14.2: Pip ('shop') or Old Bram ('echoAltar') was interacted with: open that screen over the game. */
  onMenu?(menu: 'shop' | 'echoAltar'): void;
  /** GameLoop.setTimeScale (Perfect_Dodge slow motion, Req 24.9). */
  timeScale?: SetTimeScale;
  /** Task 14.4: Settings.shake (0..1), read every frame by the camera shake; default 1. */
  shake?: () => number;
  /** Task 16: the page's AudioEngine (null / omitted: silent, e.g. without Web Audio). */
  audio?: AudioEngine | null;
  /** Task 19.5: Settings.qualityPreset, read every frame by the VFX particle budget; default 'medium'. */
  quality?: () => string;
  /** Task 19.5: the loop is under a menu (PauseMode 'menu'): the VFX clock stops; default never. */
  paused?: () => boolean;
  /** Task 19.2: the page's renderer, for the one-time 64 × 64 party portraits (omitted: no portraits). */
  renderer?: THREE.WebGLRenderer | null;
}

/** Enemy AI states that count as engaging for the combat framing (Req 21.5). */
const ENGAGED = new Set<string>(['alert', 'chase', 'attack', 'recovery', 'stagger']);

export class GameSession {
  readonly gameState: GameState;
  readonly runtime: RuntimeState;
  /** Game events, delivered in emit order once per tick by the EventDispatch step. */
  readonly bus: GameEventBus;
  /** Bottom screen while this session is played. */
  readonly hud: GameplayHud;
  readonly sim: PlaySim;
  private readonly options: GameSessionOptions;
  private readonly group = new THREE.Group();
  private readonly cameraSystem: CameraSystem;
  // Task 19.2: the four hero rigs (only the Active_Character shown); the collision capsule and the sim are unchanged.
  // Task 19.4: their Animator reads the mode, the playing attack and a look-at point.
  private readonly heroState: {
    active: HeroViewState['active']; mode: string; vel: Vec3; modeTime: number; attack: HeroViewState['attack']; lookAt: Vec3 | null;
  } = { active: 'kairen', mode: 'grounded', vel: { x: 0, y: 0, z: 0 }, modeTime: 0, attack: null, lookAt: null };
  private readonly character = new HeroViews({ library: defaultVisualLibrary(), state: () => this.readHeroState() });
  /** Task 19.4: clips run on scaled sim time (Hit_Stop freezes them, Perfect_Dodge slows them). */
  private readonly animClock = new AnimClock();
  private readonly worldObjects = new WorldObjectsView(); // TEMPORARY barrier, altar and stair visuals until the art tasks
  private readonly enemyView = new TempEnemyView(); // task 19.3 enemy / Elite rigs, task 19.4 clips
  private readonly bossView = new TempBossView(); // task 19.3 Caelith model, task 19.4 clips
  private readonly projectileView = new TempProjectileView(); // TEMPORARY arrows until the VFX tasks
  private readonly enemyProjectileView = new TempProjectileView({ look: 'orb' }); // TEMPORARY fireballs
  private readonly pickupView = new TempPickupView(); // TEMPORARY enemy drops until the VFX tasks
  private readonly airView = new TempAirVolumeView(); // TEMPORARY Updraft motes and Wind_Zone streaks until the VFX tasks
  /** Tasks 19.5 / 19.6: combat and progress VFX, Telegraph decals, damage numbers, hit indicator, camera impulses. */
  private readonly vfx: SessionVfx;
  private readonly reactionPopups: ReactionPopups; // "연쇄 x{n}" (Reaction names are the VFX damage-number pool's)
  private readonly routeView: TempRouteView; // TEMPORARY route pieces, lifts and stubs (task 4.9)
  private readonly sanctumView: TempSanctumView; // TEMPORARY Astral Sanctum hall, arena and seal until the art tasks
  private readonly puzzleView: TempPuzzleView; // TEMPORARY Puzzle_Mechanism parts until the art tasks
  private readonly areaView: TempChallengeAreaView; // TEMPORARY Challenge_Area prefabs, runes, lifts, pillars and fog
  private readonly titleCard: RegionTitleCard;
  private readonly levelUpNotice: LevelUpNotice; // task 12.1: "레벨 업 · Lv N" (Req 29.2)
  private readonly promptView: InteractPromptView;
  private readonly screenFade: ScreenFade;
  private readonly banner: HudBanner;
  private readonly combatHud: CombatHud;
  private readonly enemyBars: EnemyBars; // task 14.3
  private readonly hudTracker = new HudModelTracker(); // task 14.3
  private readonly bossBar: BossBar;
  private readonly staminaRing: StaminaRing;
  private readonly telegraphArrows: TelegraphArrows;
  private readonly hintCard: TutorialHintView; // task 13.4
  private readonly compass: Compass; // task 13.7: top-centre Compass
  private readonly travelNotice: TravelNotice; // task 13.7: Waystone / Vista notices
  private readonly waystoneView: TempWaystoneView; // task 13.7: TEMPORARY Waystone stones and crystals
  private readonly saveIndicator: SaveIndicator; // task 15.6
  private readonly audio: SessionAudio | null; // task 16: bus events → sounds, music / ambient selection, loops
  /** Task 13.1: the Dialogue screen over the playing dialogue (pushed and popped through onDialogue). */
  readonly dialogueScreen: DialogueScreen;
  private readonly villageView: TempVillageView; // tasks 13.1–13.3: TEMPORARY Thistlewick, NPCs and their progress look
  private readonly landmarks: LandmarkView; // task 18.3: lm_* LODs (never culled), seal ring, altar light pillar
  private readonly environment: EnvironmentView; // task 18.5: water, waterfall, atmosphere, birds, Blight, blob shadows
  private readonly skyDirector: SkyDirector; // task 18.2: preset from progress / arena, cut or 4 s blend
  private skyRequest: SkyRequest | undefined; // task 18.2: this frame's request (main.ts hands it to the world scene)
  private readonly pickupFeed: PickupFeed; // task 12.7: item / Glim lines, 3 s, 5 at most (Req 30.6)
  private readonly discoveryNotice: DiscoveryNotice; // tasks 12.7 / 20.1 / 20.3: Landmark, hidden place, tablet, lore, trial
  private readonly framing = new LandmarkFraming(); // task 20.3: ≤ 3 s camera framing on a Landmark's first discovery
  private readonly cinematicOverlay: CinematicOverlay; // task 21.1: letterbox, title card, skip hint and gauge
  /** Task 21.1: the last cinematic camera pose, and the real seconds left of the 0.4 s blend back to the follow camera. */
  private cinematicRig: CameraRig | null = null;
  private cinematicBlend = 0;
  private framingPoint: Readonly<Vec3> | null = null;
  private readonly poiView: TempPoiView; // tasks 12.7 / 20.1: TEMPORARY Chests, tablets, lore, caches, herbs, rings
  private readonly worldEdge = new WorldEdgeView(); // task 20.4: the cloud sea past the ring mountains
  private readonly projectScratch = new THREE.Vector3();
  private readonly viewProjection = new THREE.Matrix4();
  private readonly unsubscribe: (() => void)[] = [];
  /** Real seconds rendered, for idle shimmer on the progress objects. */
  private renderTime = 0;
  private focusPos: Vec3;
  private began = false;

  constructor(options: GameSessionOptions) {
    this.options = options;
    const { gameState, terrain, input } = options;
    this.gameState = gameState;
    // The HUD exists before the simulation so the first `hud:objective` reaches it.
    this.hud = new GameplayHud(gameState);
    // HUD widgets live in the HUD's layer, so they come and go with it.
    this.screenFade = new ScreenFade(this.hud.layer);
    this.titleCard = new RegionTitleCard(this.hud.layer);
    this.levelUpNotice = new LevelUpNotice(this.hud.layer); // task 12.1
    this.banner = new HudBanner(this.hud.layer);
    this.combatHud = new CombatHud(this.hud.layer);
    this.enemyBars = new EnemyBars(this.hud.layer, HUD_WORLD_BARS.pool); // task 14.3
    this.bossBar = new BossBar(this.hud.layer);
    this.staminaRing = new StaminaRing(this.hud.layer);
    this.telegraphArrows = new TelegraphArrows(this.hud.layer);
    this.reactionPopups = new ReactionPopups(this.hud.layer);
    this.promptView = new InteractPromptView(this.hud.layer);
    this.hintCard = new TutorialHintView(this.hud.layer); // task 13.4: above the Skill / Burst icons
    this.compass = new Compass(this.hud.layer); // task 13.7
    this.travelNotice = new TravelNotice(this.hud.layer); // task 13.7
    this.saveIndicator = new SaveIndicator(this.hud.layer); // task 15.6: "저장 중…" / "저장됨" / "저장 실패"
    this.pickupFeed = new PickupFeed(this.hud.layer); // task 12.7
    this.discoveryNotice = new DiscoveryNotice(this.hud.layer); // tasks 12.7 / 20.1 / 20.3
    // Task 21.1: the skip hint names Esc and the current `jump` key.
    this.cinematicOverlay = new CinematicOverlay(this.hud.layer, () => `${keyLabel('Escape')} / ${keyLabel(input.bindings.jump)}`);
    // Task 13.1: the window draws the simulation's playing dialogue; the advance keys as currently bound.
    this.dialogueScreen = new DialogueScreen({
      view: () => this.sim.dialogue.view(),
      keys: () => {
        const { bindings } = input;
        return [keyLabel(bindings.interact), keyLabel(bindings.jump), keyLabel(bindings.attack)];
      },
    });

    this.sim = new PlaySim({
      gameState,
      terrain,
      input,
      commands: options.commands,
      playTimeSec: () => options.playTimeSec(), // task 21.3: the Victory record's play time
      sinks: {
        objective: (view) => this.hud.setObjective(view),
        stageComplete: (stage, rewards) => this.banner.stageComplete(stage, rewards),
        regionTitle: (region) => this.titleCard.show(region),
        cinematic: (id) => {
          // Task 21.1: the HUD hides behind the cinematic overlay; the page releases the pointer lock and switches the
          // input context / PauseMode (design "재생 규칙").
          this.hud.setCinematic(id !== null);
          if (id === null) this.cinematicBlend = CINEMATIC_BLEND_OUT;
          options.onCinematic?.(id !== null);
        },
        partyWipe: (bossPhase) => options.onPartyWipe(bossPhase),
        ending: () => options.onEnding(),
        staminaExhausted: () => this.staminaRing.exhausted(),
        campCleared: (notice) => this.banner.campCleared(notice.chestId !== null),
        puzzleHint: (_puzzleId, hint) => this.banner.puzzleHint(hint),
        // Wading steps splash (Req 16.9) and a swim begins with a larger splash (Req 16.10); every step and the
        // entry also play their sounds (task 16.3), and the glide wind follows each controller tick (Req 19.10).
        glideWind: (intensity) => this.audio?.glideWind(intensity),
        footstep: (material, pos) => {
          this.audio?.footstep(material, pos);
          if (material === 'water') this.vfx.vfx.splash('step', pos); // task 19.5
        },
        enteredWater: (pos) => {
          this.vfx.vfx.splash('entry', pos); // task 19.5
          this.audio?.enteredWater(pos);
        },
        hit: (hit) => this.vfx.hit(hit), // tasks 19.5 / 19.6: impact flash and cone, Charged-final camera impulse
        // Task 13.7: Waystone activation card, rest line and the In_Combat fast-travel refusal (Req 11.1, 11.3, 11.5).
        waystone: (notice) => {
          if (notice.kind === 'activated') this.travelNotice.activated(notice.waystoneId);
          else if (notice.kind === 'rested') this.travelNotice.rested(notice.waystoneId);
          else if (notice.kind === 'travelRefused') this.travelNotice.refused(notice.text);
        },
        vista: (id, first) => {
          if (first) this.travelNotice.vista(id); // task 13.5: the 200 m map reveal (Req 9.5)
        },
        // Tasks 13.1 / 13.2: the Dialogue screen comes and goes with the dialogue; the Hearth's rest line.
        dialogue: (view) => options.onDialogue?.(view === null ? null : this.dialogueScreen),
        hearthRested: () => this.travelNotice.hearthRested(),
        // Tasks 12.7 / 20.1: a Chest's Glim joins the pickup feed (its items arrive as 'item:granted'); tablets, lore,
        // hidden places (with their own sound) and the Sky Ring Trial go to the discovery card, cache Glim to the feed.
        chestOpened: (notice) => {
          for (const r of notice.rewards) if (r.kind === 'glim') this.pickupFeed.glim(r.amount);
        },
        poi: (notice) => {
          if (notice.kind === 'cache') this.pickupFeed.glim(notice.glim);
          else if (notice.kind === 'hidden') this.options.audio?.sfx(notice.sfx);
          this.discoveryNotice.poi(notice);
        },
        log: (message) => console.debug(message),
      },
      timeScale: options.timeScale,
    });
    this.runtime = this.sim.runtime;
    this.bus = this.sim.bus;
    this.audio = options.audio == null ? null : new SessionAudio({ engine: options.audio, sim: this.sim, camera: options.camera }); // task 16
    this.focusPos = { ...this.sim.player.state.pos };

    const cameraCollision = createCameraCollision(this.sim.collision);
    this.cameraSystem = new CameraSystem({
      core: new CameraCore({ collision: cameraCollision }),
      camera: options.camera,
      target: (alpha) => this.sim.player.pose(alpha),
      input: tapLook(input, (delta) => this.sim.tutorial.look(delta)), // task 13.4: camera hint done on mouse look
      lockCandidates: () => this.sim.lockCandidates(),
      collision: cameraCollision,
      combatSpread: () => this.combatSpread(),
      shake: options.shake, // task 14.4: Settings "화면 흔들림"
      framing: () => this.framingPoint, // task 20.3: a Landmark's first-discovery framing
    });
    // Tasks 19.5 / 19.6: the VFX (bus, Combat_System hook, Telegraph decals from the enemies and Caelith) and the
    // strong-hit camera impulses (Burst, explosive Reactions, Charged final hits, Element_Shield / Starshell breaks).
    this.vfx = new SessionVfx({
      sim: this.sim, terrain, camera: options.camera, hud: this.hud.layer, quality: options.quality,
      addTrauma: (amount) => this.cameraSystem.addTrauma(amount),
      focus: () => this.focusPos,
      characterModel: () => this.character.object,
    });
    this.enemyView.flashOf = (id) => this.vfx.vfx.hitFlash(id); // uHitFlash 0.1 s on the enemy bodies
    // Task 19.4: Sentinel eyes and drones turn to the Active_Character; weapon trails from the attack clips' events.
    this.enemyView.lookTarget = () => ({ x: this.focusPos.x, y: this.focusPos.y + 1.2, z: this.focusPos.z });
    this.character.trailSink = {
      sample: (key, tip, base, element) => this.vfx.vfx.trailSample(key, tip, base, element),
      end: (key) => this.vfx.vfx.trailEnd(key),
    };
    // Task 18.5: water and waterfall, Region atmosphere, birds / butterflies, Blight (purified from GameState: instant on
    // load, 3 s after 'skyshard:acquired'), blob shadows, and the InteriorVolume the page's lighting blends toward.
    this.environment = new EnvironmentView({
      terrain, bus: this.bus, camera: options.camera,
      progress: () => this.gameState,
      player: () => this.sim.player.state,
      enemies: () => this.livingEnemyFeet(),
      npcs: () => this.sim.npcs.views().filter((n) => n.present).map((n) => n.pos),
      projectiles: () => this.runtime.projectiles.active.map((p) => p.pos),
      challengeArea: () => this.sim.challenge.current,
      quality: () => options.quality?.() ?? 'medium',
      burst: (spec, at) => {
        this.vfx.vfx.burst(spec, at);
      },
    });
    this.group.add(this.environment.object);

    // The HUD's Skyshard count follows the event (Req 4.3). A defeated Lock-on target, the boss's defeat and a
    // cinematic end the lock (Req 21.8, design "연출 전환").
    const releaseIf = (id: string): void => {
      if (this.cameraSystem.lockTarget === id) this.releaseLock();
    };
    this.unsubscribe.push(
      this.bus.on('skyshard:acquired', (p) => this.hud.skyshardAcquired(p.index)),
      this.bus.on('levelUp', (p) => this.levelUpNotice.show(p.level)), // task 12.1
      this.bus.on('save:done', () => this.saveIndicator.saved()), // task 15.6 (Req 36.6)
      this.bus.on('save:failed', () => this.saveIndicator.failed()), // task 15.6 (Req 36.13)
      // Task 14.2: Pip's shop and Old Bram's Echo Altar (Req 14.11, 29.4).
      this.bus.on('interact', (p) => {
        if (p.targetKind === 'shop' || p.targetKind === 'echoAltar') options.onMenu?.(p.targetKind);
      }),
      this.bus.on('enemy:defeated', (p) => releaseIf(p.entityId)),
      this.bus.on('boss:defeated', () => releaseIf(CAELITH_ENTITY_ID)),
      // Task 10.7: the camera impulse of Caelith's Phase transition (its roar); the Starshell break's is the VFX hit feel's.
      this.bus.on('boss:phaseChanged', () => this.cameraSystem.addTrauma(0.6)),
      this.bus.on('cinematic:started', () => this.releaseLock()),
      // A refused Skill / Burst press highlights its icon (Req 24.5); the refusal sound arrives with the Audio_System.
      this.bus.on('ability:refused', (p) => this.combatHud.refused(p.ability)),
      // Each reaction's own VFX and Korean name at the target are the VfxSystem's (task 19.5); "연쇄 x{n}" here
      // (Req 25.9, 25.7); its sound id (REACTION_PRESENTATION.sfx) is for the Audio_System (task 16).
      this.bus.on('reaction:chain', (p) => this.reactionPopups.chained(p.count)),
      // A hit on the Active_Character: the hurt motion here; the edge vignette and attacker arc for 0.4 s are the
      // VfxSystem's (Req 26.7). 'enemy:telegraph' carries the ready sound (task 16.3); the decals read the playback.
      this.bus.on('player:damaged', () => this.character.hurt()),
      // Task 19.2: Element glow lines at uGlow 1.0 while a Skill / Burst is cast (its AttackDef duration), else 0.3.
      this.bus.on('skill:cast', (p) => this.character.cast(p.characterId, CHARACTERS[p.characterId].skill.attack.duration)),
      this.bus.on('burst:cast', (p) => this.character.cast(p.characterId, CHARACTERS[p.characterId].burst.attack.duration)),
      // Task 12.7: every item grant on the pickup feed (Req 30.6).
      this.bus.on('item:granted', (p) => this.pickupFeed.item(p.itemId, p.count)),
      // Task 20.3: a Landmark's first discovery frames it (out of combat and cinematics) and names it (Req 9.4); its
      // map entry is GameState.discovery.landmarks (World triggers), its sound the Audio_System's.
      this.bus.on('landmark:discovered', (p) => {
        if (!this.runtime.inCombat && this.sim.cinematics.playing === null) this.framing.start(silhouettePoint(p.landmarkId, 0.55));
        // Task 21.1: its cin_landmark_* frames it instead; the name banner follows the cinematic's end.
        if (cinematicDef(CINEMATIC_TRIGGERS.landmark(p.landmarkId)) === null) this.discoveryNotice.landmark(p.landmarkId, LANDMARK_FRAMING_SECONDS);
      }),
      this.bus.on('cinematic:ended', (p) => {
        const landmark = LANDMARK_IDS.find((id) => CINEMATIC_TRIGGERS.landmark(id) === p.cinematicId);
        if (landmark !== undefined) this.discoveryNotice.landmark(landmark, LANDMARK_FRAMING_SECONDS);
      }),
      this.bus.on('cinematic:started', () => this.framing.cancel()),
    );

    this.routeView = new TempRouteView(this.sim.route, this.sim.stubs);
    this.sanctumView = new TempSanctumView(this.sim.sanctum);
    this.puzzleView = new TempPuzzleView(this.sim.puzzles);
    this.areaView = new TempChallengeAreaView(this.sim.challenge, this.sim.pillars, options.scene);
    this.group.add(
      this.character.object, this.worldObjects.object, this.enemyView.object, this.bossView.object, this.routeView.object, this.puzzleView.object,
      this.areaView.object, this.sanctumView.object,
      this.projectileView.object, this.enemyProjectileView.object, this.pickupView.object,
      this.airView.object, this.vfx.vfx.object,
    );
    // Task 19.2: each hero's 64 × 64 HUD portrait, rendered once now (and again after a visual swap).
    this.character.renderPortraits(options.renderer ?? null, (slot, url) => this.combatHud.setPortrait(slot, url));
    this.waystoneView = new TempWaystoneView(this.sim.waystones); // task 13.7
    this.group.add(this.waystoneView.object);
    // Tasks 13.1–13.3: Thistlewick's buildings and progress look, the NPCs, the Side_Quests' kite and forge.
    this.villageView = new TempVillageView({
      village: this.sim.village, npcs: this.sim.npcs, sideQuests: this.sim.sideQuests, heightAt: (x, z) => terrain.heightAt(x, z),
      player: () => this.sim.player.state.pos, // task 19.4: NPCs look at the player within 8 m
    });
    this.group.add(this.villageView.object);
    // Tasks 18.2 / 18.3: Landmarks and the sky preset director; a seal ring segment lights inside each acquisition.
    this.landmarks = new LandmarkView({ heightAt: (x, z) => terrain.heightAt(x, z) });
    this.group.add(this.landmarks.object);
    this.skyDirector = new SkyDirector(this.bus);
    this.unsubscribe.push(this.bus.on('skyshard:acquired', (p) => this.landmarks.skyshardAcquired(p.index)));
    // Tasks 12.7 / 20.1 / 20.4: the TEMPORARY POI view and the cloud sea at the world's edge.
    this.poiView = new TempPoiView({
      chests: this.sim.chests, pois: this.sim.pois, state: gameState, heightAt: (x, z) => terrain.heightAt(x, z),
    });
    this.group.add(this.poiView.object, this.worldEdge.object);
    options.scene.add(this.group);
  }

  /**
   * Tasks 13.5 / 13.7: what the Map screen reads from this session (the page adds the image, the fast-travel
   * command and closing): GameState read-only, the Active_Character's feet and facing, the current Objectives and
   * In_Combat.
   */
  mapSource(): Pick<MapScreenOptions, 'state' | 'player' | 'objectives' | 'inCombat'> {
    return {
      state: this.gameState,
      player: () => {
        const { pos, yaw } = this.sim.player.state;
        return { x: pos.x, z: pos.z, yaw };
      },
      objectives: () => this.mapObjectives(),
      inCombat: () => this.runtime.inCombat,
    };
  }

  /** The Main_Quest Objective and the tracked Side_Quest's, with their markers (Map and Compass, Req 3.6, 15.4). */
  private mapObjectives(): MapObjectives {
    const quests = this.sim.quests;
    const main = quests.objectiveView('main');
    const tracked = this.gameState.quests.tracked;
    const side = tracked === 'main' ? null : quests.objectiveView(tracked);
    return {
      main: main === null ? null : { text: main.objective.text, marker: main.objective.marker },
      side: side === null ? null : { text: side.objective.text, marker: side.objective.marker },
    };
  }

  /** Task 13.7: the Compass for this frame (camera heading, Objectives, active Waystones, discovered Landmarks). */
  private updateCompass(): void {
    const { pos } = this.sim.player.state;
    const objectives = this.mapObjectives();
    const { world, discovery } = this.gameState;
    this.compass.update(compassModel({
      player: pos,
      heading: headingFromYaw(this.cameraSystem.yaw),
      main: objectives.main?.marker ?? null,
      side: objectives.side?.marker ?? null,
      waystones: world.waystones.map((id) => ({ id, x: WAYSTONES[id].x, z: WAYSTONES[id].z })),
      landmarks: discovery.landmarks.map((id) => ({ id, ...LANDMARK_POINTS[id] })),
    }));
  }

  /** Starts play of a New Game: the first stage's `onStart` and the first objective. Once only. */
  begin(): void {
    if (this.began) return;
    this.began = true;
    this.gameState.createdAt = new Date().toISOString();
    this.sim.begin();
    this.cameraSystem.snap(); // no smoothing in from the Title's orbit camera
  }

  /** Task 15.6 Continue: play of the loaded GameState from its saved Safe_Position, no cinematic. Once only. */
  resume(): void {
    if (this.began) return;
    this.began = true;
    this.sim.resume();
    this.cameraSystem.snap();
  }

  /** Task 15.6: what the Save_System writes from this session. */
  saveTarget(): SaveTarget {
    return {
      bus: this.bus,
      gameState: this.gameState,
      recordPosition: () => this.sim.recordSafePosition(),
      playTimeSec: () => this.options.playTimeSec(),
    };
  }

  /** Task 15.6: a one-line HUD status (e.g. "백업에서 복구했습니다"). */
  notice(text: string): void {
    this.saveIndicator.notice(text);
  }

  /** Task 14.2: a menu screen's UiCommands (purchase, equip, upgrade, item use, tracking) applied under the menu. */
  applyMenuCommands(): void {
    this.sim.applyMenuCommands();
  }

  /** Active_Character feet at the last render (the sun's shadow box follows it). */
  get focus(): Readonly<Vec3> {
    return this.focusPos;
  }

  /** Task 18.2: the time-of-day request of the last render (undefined before the first). */
  get sky(): SkyRequest | undefined {
    return this.skyRequest;
  }

  /** Task 18.5: the InteriorVolume look at the Active_Character of the last render (null outdoors). */
  get interior(): InteriorLook | null {
    return this.environment.interior;
  }

  /** Task 18.5: feet of the enemies still standing (their blob shadows). */
  private *livingEnemyFeet(): Iterable<Vec3> {
    for (const e of this.runtime.enemies.values()) if (e.hp > 0) yield e.pos;
  }

  /** Movement mode and position for the F3 panel. */
  debugInfo(): Record<string, string> {
    return this.sim.debugInfo();
  }

  /** Victory Screen figures, from the completion record when there is one (Req 7.3, 7.7). */
  victoryView(): VictoryView {
    return buildVictoryView(this.gameState, {
      playTimeSec: this.options.playTimeSec(),
      placesTotal: PLACES_TOTAL,
      chestsTotal: CHESTS_TOTAL,
    });
  }

  /**
   * One fixed tick of `dt` s; InputState already holds this tick's sample. A `lockOn` press toggles the camera's
   * Lock-on first, so the tick's aim already sees it; the camera's centre ray aims Isla's untargeted shots.
   */
  tick(dt: number): void {
    const camera = this.cameraSystem;
    if (this.options.input.pressed('lockOn')) {
      this.framing.cancel(); // task 20.3: Lock-on ends a Landmark framing
      camera.lockOn();
    }
    this.runtime.lockTarget = camera.lockTarget;
    const { teleported } = this.sim.tick(dt, camera.yaw, this.aimRay());
    this.animClock.tick(); // task 19.4
    if (teleported) {
      camera.snap();
      this.character.teleported(); // task 19.2: spring chains back to rest at the new place
    }
    this.runtime.lockTarget = camera.lockTarget; // a defeat during the tick released it
  }

  /** Task 19.2: what the hero views read each frame (one reused object). */
  private readHeroState(): HeroViewState {
    const s = this.sim.player.state;
    const out = this.heroState;
    out.active = this.gameState.party.active;
    out.mode = s.mode;
    out.vel = s.vel;
    // Task 19.4: mode clock, the attack playing, and the head's look-at (Lock-on target, else the nearest NPC in 8 m).
    out.modeTime = s.modeTime;
    out.attack = this.sim.combat.attack;
    const locked = this.runtime.lockTarget === null ? undefined : this.runtime.enemies.get(this.runtime.lockTarget);
    let look: Vec3 | null = locked === undefined ? null : { x: locked.pos.x, y: locked.pos.y + 1.2, z: locked.pos.z };
    if (look === null) {
      let best = 64;
      for (const npc of this.sim.npcs.views()) {
        const d2 = (npc.pos.x - s.pos.x) ** 2 + (npc.pos.z - s.pos.z) ** 2;
        if (npc.present && d2 < best) {
          best = d2;
          look = { x: npc.pos.x, y: npc.pos.y + 1.5, z: npc.pos.z };
        }
      }
    }
    out.lookAt = look;
    return out;
  }

  private releaseLock(): void {
    this.cameraSystem.releaseLock();
    this.runtime.lockTarget = null;
  }

  /** The render camera's centre ray of the last frame, or null before the first. */
  private aimRay(): AimRay | null {
    const rig = this.cameraSystem.rig;
    if (rig === null) return null;
    const dir = { x: rig.lookAt.x - rig.position.x, y: rig.lookAt.y - rig.position.y, z: rig.lookAt.z - rig.position.z };
    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (!(len > 1e-9)) return null;
    return { origin: { ...rig.position }, dir: { x: dir.x / len, y: dir.y / len, z: dir.z / len } };
  }

  /** While In_Combat: the farthest engaged enemy (or Caelith) within 15 m of the Active_Character (Req 21.5). */
  private combatSpread(): number | null {
    if (!this.runtime.inCombat) return null;
    const engaged: Vec3[] = [];
    for (const e of this.runtime.enemies.values()) if (ENGAGED.has(e.state)) engaged.push(e.pos);
    if (this.sim.boss.active) engaged.push(this.sim.boss.receiver().hurtVolume().pos);
    return combatSpread(this.sim.player.state.pos, engaged);
  }

  /** Off-screen Telegraph arrows for the render camera's current view (Req 21.5). */
  private telegraphArrowsFor(camera: THREE.PerspectiveCamera): TelegraphArrow[] {
    const telegraphs = this.sim.telegraphs();
    if (telegraphs.length === 0) return [];
    camera.updateMatrixWorld();
    const m = this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
    const height = 1080;
    const width = height * (camera.aspect > 0 ? camera.aspect : 16 / 9);
    const arrows: TelegraphArrow[] = [];
    for (const t of telegraphs) {
      const edge = edgeIndicator(m, t.pos, width, height);
      if (edge !== null) arrows.push({ ...edge, strong: t.strong });
    }
    return arrows;
  }

  /**
   * Task 21.1: while a cinematic plays the render camera takes its shot pose (entity anchors at this frame's
   * interpolated pose, kept above the terrain); afterwards it blends from the last shot pose to the follow rig over
   * 0.4 s. The Camera_System keeps running underneath, so look input reaches it at once.
   */
  private cinematicCamera(alpha: number, realDt: number): void {
    const shot = this.sim.cinematics.cameraPose((anchor) => this.sim.cinematicAnchor(anchor, alpha), alpha * SIM_DT);
    const camera = this.options.camera;
    if (shot !== null) {
      const ground = this.options.terrain.heightAt(shot.position.x, shot.position.z) + CINEMATIC_GROUND_CLEARANCE;
      const rig: CameraRig = { position: { ...shot.position, y: Math.max(shot.position.y, ground) }, lookAt: shot.lookAt, fov: shot.fov, roll: 0 };
      this.cinematicRig = rig;
      this.cinematicBlend = CINEMATIC_BLEND_OUT;
      applyCameraRig(camera, rig);
      return;
    }
    const from = this.cinematicRig;
    const follow = this.cameraSystem.rig;
    if (from === null || follow === null || this.sim.cinematics.playing !== null || this.cinematicBlend <= 0) {
      if (this.sim.cinematics.playing === null) this.cinematicRig = null;
      return;
    }
    this.cinematicBlend = Math.max(0, this.cinematicBlend - (Number.isFinite(realDt) && realDt > 0 ? realDt : 0));
    const u = 1 - this.cinematicBlend / CINEMATIC_BLEND_OUT;
    const k = u * u * (3 - 2 * u);
    const mix = (a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k });
    applyCameraRig(camera, { position: mix(from.position, follow.position), lookAt: mix(from.lookAt, follow.lookAt), fov: from.fov + (follow.fov - from.fov) * k, roll: follow.roll * k });
    if (this.cinematicBlend <= 0) this.cinematicRig = null;
  }

  /**
   * One render frame. `followCamera` runs the Camera_System (play); under the Title Screen the page drives the
   * render camera instead and the character is drawn fully opaque.
   */
  render(alpha: number, realDt: number, followCamera: boolean): void {
    const { sim } = this;
    this.framingPoint = followCamera ? this.framing.update(realDt) : null; // task 20.3: Landmark framing (≤ 3 s)
    if (followCamera) this.cameraSystem.update(realDt, alpha); // reads the interpolated pose and this frame's look / wheel
    if (followCamera) this.cinematicCamera(alpha, realDt); // task 21.1: the shot pose over the follow rig, then 0.4 s blend
    this.cinematicOverlay.update(followCamera ? sim.cinematics.view() : null);
    const pose = sim.player.pose(alpha);
    this.focusPos = { x: pose.pos.x, y: pose.pos.y, z: pose.pos.z };
    this.character.setPose(pose.pos, pose.yaw);
    // Task 19.4: clips on scaled sim time (real time under the Title Screen, where no tick runs).
    const scaledDt = this.animClock.frame(alpha);
    const animDt = followCamera ? scaledDt : realDt;
    this.character.update(animDt, alpha);
    this.character.setOpacity(followCamera && sim.cinematics.playing === null ? this.cameraSystem.characterOpacity : 1); // task 21.1
    this.enemyView.sync(this.runtime.enemies, alpha, animDt);
    this.enemyView.syncDrones(sim.enemies.drones(), alpha, animDt);
    this.projectileView.sync(this.runtime.projectiles.active);
    this.enemyProjectileView.sync(this.runtime.enemyProjectiles.active);

    this.telegraphArrows.update(followCamera ? this.telegraphArrowsFor(this.options.camera) : []);
    this.renderTime += realDt;
    this.pickupView.sync(this.runtime.pickups, alpha, this.renderTime);
    // Task 10.4 / 19.6: the Starshell break's camera impulse comes from the VFX hit feel (logic/hitFeel, 0.4).
    this.bossView.update(sim.boss, alpha, this.renderTime, animDt);
    // Tasks 19.5 / 19.6: VFX on real time (stopped only under a menu), after the views are posed.
    this.vfx.update(realDt, alpha, this.options.paused?.() ?? false, this.cameraSystem.yaw);
    // Task 18.5: environment on real time (still under a menu, like the VFX clock), blob shadows at the posed feet.
    this.environment.update(this.options.paused?.() === true ? 0 : realDt, this.focusPos);
    this.routeView.update(this.renderTime);
    this.sanctumView.update(this.renderTime);
    this.puzzleView.update(this.renderTime);
    // Challenge_Area doors, runes, lifts, pillars; green fog and glowing-root light while inside (Req 12.4).
    this.areaView.update(this.renderTime, realDt, pose.pos);
    this.airView.update(sim.volumes, this.renderTime); // Updraft and Wind_Zone flow (Req 19.8)
    this.worldObjects.update(
      { barriers: sim.gates.views(), stairActive: sim.stair.active, pillarVisible: sim.altar.pillarVisible },
      this.renderTime,
    );
    // Recovery fade, or the task 13.7 fast-travel fade (0.5 s out, 0.5 s in).
    this.screenFade.set(Math.max(sim.recovery.fadeAlpha, sim.waystones.fadeAlpha));
    this.waystoneView.update(this.renderTime); // task 13.7
    this.villageView.update(this.renderTime, animDt); // tasks 13.1–13.3; task 19.4 NPC clips
    // Tasks 18.2 / 18.3: seal ring and light pillar from progress; the sky preset (arena sky while Caelith fights).
    this.landmarks.update(this.renderTime, realDt, { skyshards: this.gameState.skyshards, pillarVisible: sim.altar.pillarVisible });
    this.skyRequest = this.skyDirector.update(realDt, this.gameState, bossSkyOf(sim.boss.snapshot()), sim.cinematics.playing);
    this.titleCard.update(realDt);
    this.levelUpNotice.update(realDt); // task 12.1
    this.banner.update(realDt);
    this.travelNotice.update(realDt); // task 13.7
    this.saveIndicator.update(realDt); // task 15.6
    // Tasks 12.7 / 20.1–20.4: POI objects, the cloud sea, the pickup feed, the discovery card and the trial timer.
    this.poiView.update(this.renderTime);
    this.worldEdge.update(this.renderTime);
    this.pickupFeed.update(realDt);
    this.discoveryNotice.trial(sim.pois.trial, SKY_RING_TRIAL.rings.length, SKY_RING_TRIAL.timeLimitSec);
    this.discoveryNotice.update(realDt);
    // Task 13.7: the Compass follows the camera; hidden under the Title and during cinematics (design "연출 중").
    this.compass.setVisible(followCamera && sim.cinematics.playing === null);
    if (followCamera) this.updateCompass();
    // Task 14.3: the frame's HudModel (combat fade, party slots, Skill / Burst, the enemy bar pool) and its views.
    const { bindings } = this.options.input;
    const camPos = this.options.camera.position;
    const hudModel = this.hudTracker.step(realDt, hudInputOf(sim, {
      skillKey: keyLabel(bindings.skill), burstKey: keyLabel(bindings.burst), camera: { x: camPos.x, y: camPos.y, z: camPos.z }, alpha,
    }));
    this.combatHud.update(hudModel);
    this.enemyBars.update(followCamera ? hudModel.enemyBars : [], (p) => this.screenAnchor(p, 0));
    // Caelith's bar from the encounter's snapshot, shown only while it fights (Req 6.11, 32.6).
    this.bossBar.update(bossBarModel(sim.boss.snapshot()));
    this.reactionPopups.update(realDt, (p) => this.screenAnchor(p, 0));
    this.staminaRing.update(this.runtime.stamina, realDt, this.screenAnchor(pose.pos, STAMINA_RING_HEIGHT));
    this.promptView.set(sim.interaction.prompt, keyLabel(this.options.input.bindings.interact)); // the key as currently bound
    // Task 13.4: the current Tutorial_Hint with keys from the current bindings; none under the Title or while a
    // cinematic, menu or dialogue is up (visibleHint is null then).
    this.hintCard.update(followCamera ? sim.tutorial.visibleHint() : null, this.options.input.bindings);
    // Task 16: listener, music / ambient selection (the Title under the orbit camera), action sounds, air loops.
    this.audio?.update(realDt, !followCamera);
  }

  /** Normalised device coordinates of `pos` raised by `lift` m in the render camera; null behind it or off screen. */
  private screenAnchor(pos: Readonly<Vec3>, lift: number): ScreenAnchor | null {
    const camera = this.options.camera;
    camera.updateMatrixWorld();
    const p = this.projectScratch.set(pos.x, pos.y + lift, pos.z).project(camera);
    if (!(p.z > -1 && p.z < 1) || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) return null;
    return { x: p.x, y: p.y };
  }

  /** Removes the session's objects from the scene and frees their GPU resources. The HUD leaves with the stack. */
  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    this.sim.dispose();
    this.options.scene.remove(this.group);
    this.character.dispose();
    this.worldObjects.dispose();
    this.enemyView.dispose();
    this.bossView.dispose();
    this.routeView.dispose();
    this.sanctumView.dispose();
    this.puzzleView.dispose();
    this.areaView.dispose();
    this.projectileView.dispose();
    this.enemyProjectileView.dispose();
    this.pickupView.dispose();
    this.airView.dispose();
    this.vfx.dispose(); // tasks 19.5 / 19.6
    this.waystoneView.dispose(); // task 13.7
    this.villageView.dispose(); // tasks 13.1–13.3
    this.landmarks.dispose(); // task 18.3
    this.environment.dispose(); // task 18.5
    this.skyDirector.dispose(); // task 18.2
    this.audio?.dispose(); // task 16
    this.poiView.dispose(); // tasks 12.7 / 20.1
    this.worldEdge.dispose(); // task 20.4
  }
}
