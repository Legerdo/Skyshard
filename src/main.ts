import './ui/styles/base.css';
import * as THREE from 'three';
import { CAMERA_FOV_DEG } from './camera/constants';
import { applyCameraRig } from './camera/threeCamera';
import { titleCameraRig } from './camera/titleOrbit';
import { GameLoop } from './core/loop';
import { UiCommandQueue } from './core/uiCommands';
import { FpsMeter, PerfOverlay, type PerfInfo } from './debug/perfOverlay';
import { GameSession } from './gameSession';
import { BrowserInput } from './input/browserInput';
import { InputSampler } from './input/inputSampler';
import { InputState } from './input/inputState';
import { createNewGameState } from './logic/save/gameState';
import { hasSaveData, type SaveProbe } from './logic/save/saveKeys';
import type { GameState } from './logic/save/gameState';
import { loadSave } from './logic/save/load'; // task 15.1
import { SaveSystem } from './save/saveSystem'; // task 15.6
import { openSaveStore } from './save/storage'; // task 15.6
import { ContextLossOverlay } from './render/contextLossOverlay';
import { bindRenderSettings, createRenderer, isWebGL2Supported, type RendererHandle } from './render/renderer';
import { CAMERA_FAR_PLANE, CAMERA_NEAR_PLANE } from './data/renderQuality'; // task 18.3: same in every quality preset
import { createTerrainView, type TerrainView } from './render/terrainView';
import { showUnsupportedScreen } from './render/unsupportedScreen';
import { createWorldScene } from './render/worldScene';
import { RenderPipeline } from './render/pipeline'; // tasks 18.5 / 18.6: shadows, interior lighting, post, live quality
import { defaultSettings, SettingsStore } from './settings/settings';
import { DefeatScreen } from './ui/defeatScreen';
import { h } from './ui/dom';
import { installNavKeyGuard } from './ui/navInput';
import { pauseModeFor, ScreenManager, type Screen, type ScreenContext } from './ui/screenManager';
import { TitleScreen } from './ui/titleScreen';
import { UiFlow } from './ui/uiFlow';
import { VictoryScreen } from './ui/victoryScreen';
import { buildTerrain } from './world/terrain';
import { completedHints } from './logic/tutorial'; // task 14.4: Settings "조작 안내 보기"
import { connectSettings } from './settings/applySettings'; // task 14.4
import { loadSettings, settingsWriter } from './settings/persistence'; // task 14.4
import { createSettingsScreen } from './ui/settingsScreen'; // task 14.4
import { MapImageCache } from './map/mapCanvas'; // task 13.5: the map image, built once per page
import { createMapScreen } from './ui/mapScreen'; // task 13.5: the Map screen (M)
// Task 16: the Audio_System (one AudioContext per page), its settings, menu sounds and the optional CC0 files.
import { createBrowserAudioEngine } from './audio/audioEngine';
import { connectAudioSettings } from './audio/audioSettings';
import { loadAudioAssets } from './audio/assets';
import { uiScreenSfx } from './audio/uiSounds';
// Tasks 22.1 / 22.2: Debug_Tools (`?debug=1` only) and the read-only Test_Harness (every build).
import { mountDebugPanel, type DebugPanel } from './debug/debugPanel';
import { debugSessionFlag, sessionStore, setDebugSessionFlag } from './debug/debugSession';
import { createHarness, HarnessEventLog, installHarness } from './harness/harness';
import { buildSnapshot, RecoveryCounter } from './harness/snapshot';
// Task 14.2: Loading, Pause, the confirm / save error dialogs, Credits and the menu screens over the game.
import type { UiCommand } from './core/uiCommands';
import type { TerrainField } from './world/terrain';
import { LoadingScreen } from './ui/loadingScreen';
import { once, runLoading, type LoadingTask } from './ui/loadingProgress';
import { PauseScreen } from './ui/pauseScreen';
import { ConfirmScreen } from './ui/confirmScreen';
import { CreditsScreen } from './ui/creditsScreen';
import { InventoryScreen } from './ui/inventoryScreen';
import { QuestScreen } from './ui/questScreen';
import { CodexScreen } from './ui/codexScreen';
import { ShopScreen } from './ui/shopScreen';
import { AltarScreen } from './ui/altarScreen';
import { showFatalError } from './ui/fatalErrorOverlay';

/*
 * Composition root. Boot: WebGL2 check → Loading (the boot message while the world is built) → Title Screen at the
 * bottom of the ScreenManager stack over the live world → New Game → Gameplay HUD (task 4.8). Page-level parts
 * live here: renderer, render camera, terrain mesh and lights, input, the screen stack, the F3 panel and the game
 * loop. Everything tied to one GameState is a GameSession (src/gameSession.ts): one is prepared during Loading so
 * the Title shows its world, "새로 시작" begins it, and "메인 메뉴" replaces it with a fresh one.
 *
 * Each display frame:
 *   1. input: poll the gamepad and collect the frame's raw events. While a menu stops the game no tick runs, so the
 *      events are applied at once (held keys stay tracked) and every key / button press goes to the top screen
 *      as its first input or as navigation,
 *   2. fixed ticks (GameLoop, SIM_DT) while the top screen's context lets game time run: InputSample → session
 *      tick (UiCommands, movement, combat, enemies, world triggers, recovery, EventDispatch),
 *   3. render: the session's views, the Title orbit camera or the Camera_System, the screens (HUD text), renderer.
 * The top screen's context sets the input context and PauseMode: Title, Defeat and Victory are `menu` (game time
 * and play time stop, Req 7.8), the HUD is `gameplay`.
 */

/** World seed of every New Game (the terrain is built once for it). */
const WORLD_SEED = 20240601;
/** Render camera clip range (m); the far plane keeps the whole map and the ring mountains in view. */
const CAMERA_NEAR = CAMERA_NEAR_PLANE;
const CAMERA_FAR = CAMERA_FAR_PLANE; // 2,200 m, longer than the world diagonal (task 18.3)

function requireElement<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) {
    throw new Error(`Required element #${id} not found in index.html`);
  }
  return element;
}

/** Task 14.2: resolves after the browser has painted (the Loading bar repaints between work slices). */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/** Task 14.2: runs Loading stages in ~30 ms slices with repaints between them, reporting to the Loading screen. */
function loadStages(loading: LoadingScreen, tasks: readonly LoadingTask[]): Promise<void> {
  return runLoading(tasks, { now: () => performance.now(), yieldFrame: nextPaint, onProgress: (report) => loading.set(report) });
}

/** A page-level notice above everything for `seconds` (task 15.6: storage warnings, unreadable saves). */
function showPageNotice(uiRoot: HTMLElement, text: string, seconds = 8): void {
  const notice = h('div', { class: 'page-notice', role: 'alert' }, [text]);
  Object.assign(notice.style, {
    position: 'absolute', left: '50%', top: '1.5rem', transform: 'translateX(-50%)', maxWidth: '90vw', padding: '0.6rem 1.1rem',
    borderRadius: '0.6rem', background: 'rgba(11, 16, 38, 0.92)', border: '1px solid rgba(232, 200, 120, 0.7)',
    color: 'var(--text, #f4efe3)', zIndex: '50', pointerEvents: 'none', textAlign: 'center',
  });
  uiRoot.append(notice);
  setTimeout(() => notice.remove(), seconds * 1000);
}

/** Task 15.6: localStorage refused (policy, private mode): progress lives only in this page. Shown once. */
function showStorageWarning(uiRoot: HTMLElement): void {
  console.warn('localStorage is unavailable: progress will not be kept after this page closes.');
  showPageNotice(uiRoot, '브라우저 저장소를 사용할 수 없어 이 페이지를 닫으면 진행 상황이 사라집니다.');
}

/** Runs `cb` after the browser has painted the current DOM (so the boot message shows during the build). */
function afterNextPaint(cb: () => void): void {
  requestAnimationFrame(() => setTimeout(cb, 0));
}

/** Task 21.1: asks for the pointer lock again after a cinematic; a refusal keeps the canvas click-to-lock. */
function requestPointerLock(canvas: HTMLCanvasElement): void {
  if (document.pointerLockElement === canvas) return;
  try {
    // Promise in current browsers, void in older ones; refusals are reported through pointerlockerror.
    void Promise.resolve(canvas.requestPointerLock()).catch(() => undefined);
  } catch {
    // Older implementations may throw; the next canvas click locks again.
  }
}

/** localStorage, or null where it cannot be used (blocked by policy, opaque origin). */
function openStorage(): SaveProbe | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

async function runGame(handle: RendererHandle, uiRoot: HTMLElement, loading: LoadingScreen): Promise<void> {
  const { renderer } = handle;
  // Task 15.6: localStorage when usable, else an in-memory store for this page with a one-time warning.
  const opened = openSaveStore(() => openStorage() as Storage | null);
  const storage = opened.store;
  if (!opened.persistent) showStorageWarning(uiRoot);
  const saveSystem = new SaveSystem(storage);
  // Unreadable save and backup (Req 36.10): the data is already quarantined; task 14.2's save error dialog over the
  // Title offers New Game without the overwrite question.
  const onSaveError = (): void => flow.saveError();
  // Page-wide Settings (src/settings/settings.ts). Consumers (audio, render quality, camera, input, UI scale)
  // subscribe to this one store. Task 14.4: `skyshard.settings` is loaded and repaired (sanitizeSettings) into it
  // and every change is written back at once; a failing write keeps the value in memory.
  const settings = new SettingsStore(
    loadSettings(storage), // defaults when the key is missing or unreadable (defaultSettings())
    settingsWriter(storage, (error) => console.warn('Settings could not be saved; they stay in effect for this page.', error)),
  );
  // Task 18.1: pixel ratio = min(devicePixelRatio, the preset's DPR cap) × render scale, now and on every change.
  bindRenderSettings(handle, settings);
  // Task 16.1: the page's AudioEngine (suspended until the first pointerdown / keydown; null without Web Audio).
  // Music / SFX on-off and volumes follow the settings at once and on every change (Req 37.4, 37.5).
  const audio = createBrowserAudioEngine();
  if (audio !== null) connectAudioSettings(settings, audio);
  window.addEventListener('pagehide', (event) => {
    if (!event.persisted) audio?.dispose();
  });

  // Page-level world: lights and sky, and the seeded terrain mesh shared by every session.
  const worldScene = createWorldScene();
  const { scene } = worldScene;
  // Task 14.2: Loading stages 'terrain' (the seeded heightfield) and 'vegetation' (the terrain mesh and what grows on
  // it), with the bar repainted between slices; 'characters' follows once the session can be prepared.
  let terrain!: TerrainField;
  // Task 18.4: chunk LODs, instanced vegetation and props, following the vegetation / quality settings live.
  let terrainView: TerrainView | null = null;
  await loadStages(loading, [
    { stage: 'terrain', work: () => once(() => { terrain = buildTerrain(WORLD_SEED); }) },
    { stage: 'vegetation', work: () => once(() => { scene.add((terrainView = createTerrainView(terrain, { settings })).object); }) },
  ]);

  const size = renderer.getSize(new THREE.Vector2());
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, size.x / size.y, CAMERA_NEAR, CAMERA_FAR);
  handle.onResize((w, h) => {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  // Tasks 18.5 / 18.6: the character shadow map, the interior lighting blend and the composer, applied live from the
  // graphics settings (only the changed resources are rebuilt); `renderer.info` sums every pass of a frame.
  const pipeline = new RenderPipeline({ handle, scene, camera, world: worldScene, settings });

  const inputState = new InputState();
  const sampler = new InputSampler(inputState);
  const browserInput = new BrowserInput({
    canvas: handle.canvas,
    getContext: () => inputState.context,
    // Task 14.2: a lost pointer lock, a hidden tab or a lost gamepad opens Pause during play (Req 31.8, 31.9).
    onPauseRequest: () => openPause(),
  });

  const perf = new PerfOverlay(uiRoot);
  // Task 14.4: bindings (code map, prompt / hint keys), look sensitivity / invert (mouse and right stick), UI scale
  // and the F3 panel follow the settings at once, now and on every change.
  connectSettings(settings, { input: inputState, browserInput, perf, root: document.documentElement });
  const fpsMeter = new FpsMeter();
  const perfInfo: PerfInfo = { fps: 0, drawCalls: 0, triangles: 0, frameMs: 0 };
  const commands = new UiCommandQueue();
  // Task 22.2: the harness event log (sessions attach their bus) and the recovery counts; task 22.1: the flag write.
  const harnessLog = new HarnessEventLog();
  const recoveries = new RecoveryCounter();
  let debugFlagWritten = false;

  let session: GameSession | null = null;
  let loop: GameLoop | null = null;
  /** A New Game session, built but not begun: its world is the Title background until "새로 시작". */
  const prepareSession = (gameState: GameState = createNewGameState(WORLD_SEED)): GameSession => {
    // Task 22.1: Debug_Tools used earlier in this tab mark every later GameState too (Req 41.3).
    if (debugSessionFlag(sessionStore())) gameState.debugUsed = true;
    const prepared: GameSession = new GameSession({
      gameState,
      terrain,
      scene,
      camera,
      input: inputState,
      commands,
      playTimeSec: () => loop?.playTimeSec ?? 0,
      onPartyWipe: (bossPhase) => flow.partyWiped(bossPhase),
      onEnding: () => flow.endingFinished(() => prepared.victoryView()),
      onCinematic: (playing) => {
        cinematicPlaying = playing;
        applyContext(ui.context);
        // Task 21.1: the pointer lock is released (so Esc reaches the page as the skip key, not the browser's unlock)
        // and requested again at the end; a refusal leaves the usual click-to-lock on the canvas.
        if (playing) browserInput.releasePointerLock();
        else if (ui.context === 'gameplay') requestPointerLock(handle.canvas);
      },
      // Task 13.1: the Dialogue screen over the HUD while a dialogue plays: its `dialogue` context sets the input
      // context and PauseMode 'dialogue' (enemies frozen); popping it returns them.
      onDialogue: (screen) => {
        if (screen !== null) {
          if (ui.top?.id === 'gameplay') ui.push(screen);
        } else if (ui.top === prepared.dialogueScreen) {
          ui.pop();
        }
      },
      // Task 14.2: Pip's shop / Old Bram's Echo Altar open after the talk's screen has closed (checked after each tick).
      onMenu: (menu) => {
        pendingMenu = menu;
      },
      timeScale: (source, scale, realSeconds) => loop?.setTimeScale(source, scale, realSeconds),
      shake: () => settings.get().shake, // task 14.4: "화면 흔들림" 0–100 %
      audio, // task 16
      quality: () => settings.get().qualityPreset, // task 19.5: VFX particle budget (2,000 / 4,000 / 6,000)
      paused: () => loop?.pauseMode === 'menu', // task 19.5: the VFX clock stops only under a menu
      renderer, // task 19.2: the heroes' 64 × 64 HUD portraits
    });
    harnessLog.attach(prepared.bus, () => loop?.simTime ?? 0); // task 22.2 (the bus drops it on dispose)
    return prepared;
  };

  /** A cinematic of the running session holds the gameplay screen (design "재생 규칙"). */
  let cinematicPlaying = false;
  /** Task 14.2: a shop / altar screen waiting for the gameplay screen to be on top again. */
  let pendingMenu: 'shop' | 'echoAltar' | null = null;
  // The top screen decides the input context and whether game time runs (Req 31.5, 7.8). Over the gameplay
  // screen a cinematic switches both to 'cinematic' (game time keeps running, gameplay actions read as idle).
  // A cinematic releases the pointer lock and asks for it again at its end (task 21.1, onCinematic).
  const applyContext = (context: ScreenContext | null): void => {
    const cinematic = cinematicPlaying && context === 'gameplay';
    inputState.setContext(cinematic ? 'cinematic' : (context ?? 'menu'));
    if (loop !== null && !handle.contextLost) loop.pauseMode = cinematic ? 'cinematic' : pauseModeFor(context);
    // A dialogue keeps the pointer lock too (task 13.1): its left-click advance reaches the canvas, play resumes at once.
    if (context !== 'gameplay' && context !== 'dialogue') browserInput.releasePointerLock();
  };

  // Screen stack above the game view, under the boot message, the F3 panel and the system overlays.
  const stackRoot = h('div', { class: 'screen-stack' });
  uiRoot.prepend(stackRoot);
  const ui = new ScreenManager({
    root: stackRoot,
    onScreen: (event) => {
      session?.bus.emit('ui:screen', event);
      harnessLog.record('screen', loop?.simTime ?? 0, { ...event }); // task 22.2: at once (no tick runs under a menu)
    },
    onContext: applyContext,
  });
  // Task 16.3: menu sounds at once, in real time (menus stop game time): open / close, focus move, confirm, refusal
  // (Req 31.6), and the Defeat sting.
  ui.onFeedback((feedback) => {
    if (audio === null) return;
    if (feedback.kind === 'open' || feedback.kind === 'close') {
      const id = uiScreenSfx(feedback.screen, feedback.kind === 'open');
      if (id !== null) audio.sfx(id);
    } else {
      audio.sfx(feedback.kind === 'move' ? 'sfx_ui_move' : feedback.kind === 'confirm' ? 'sfx_ui_confirm' : 'sfx_ui_refuse');
    }
  });
  // Pointer presses count as a first input (Title), and hover / Tab focus changes follow into the stack.
  stackRoot.addEventListener('pointerdown', () => ui.anyInput());
  stackRoot.addEventListener('focusin', (event) => ui.focusElement(event.target));
  installNavKeyGuard(window, () => ui.context !== null && ui.context !== 'gameplay');

  // Task 14.4: the Settings screen over the Title ("설정") or the game (the Pause screen's "설정", task 14.2, calls
  // openSettings too). Esc / B / "닫기" pop it; the settings themselves are page-wide and saved on every change.
  const openSettings = (): void => {
    if (ui.has('settings')) return;
    const screen = createSettingsScreen({
      settings,
      hints: () => (session === null ? [] : completedHints(session.gameState)),
      onClose: () => {
        if (ui.top === screen) ui.pop();
      },
      onRefuse: () => ui.feedback({ kind: 'refuse' }),
    });
    ui.push(screen);
  };

  const flow = new UiFlow({
    ui,
    commands,
    screens: {
      title: (options) => new TitleScreen(options),
      defeat: (options) => new DefeatScreen(options),
      victory: (options) => new VictoryScreen(options),
      confirm: (options) => new ConfirmScreen(options), // task 14.2: New Game overwrite question, save error
    },
    hasSave: () => hasSaveData(storage),
    startNewGame: () => {
      const current = session ?? (session = prepareSession());
      // Task 15.6: an existing save becomes the backup (the settings key stays), then the new game saves at once.
      saveSystem.archiveForNewGame();
      current.begin();
      loop?.setPlayTime(current.gameState.stats.playTimeSec);
      loop?.resetAccumulator();
      saveSystem.attach(current.saveTarget());
      saveSystem.saveNow('newGame');
      return current.hud;
    },
    continueGame: () => {
      // Task 15.6: main → backup → quarantine (never throws). The world is rebuilt from the loaded GameState without
      // cinematics and the party stands at its saved Safe_Position (Req 36.8, 36.10).
      const result = loadSave(storage, { warn: (message) => console.warn(message) });
      if (result.kind === 'none') return null;
      if (result.kind === 'unrecoverable') {
        console.error(`Continue: the save and its backup could not be read (copied to ${result.quarantinedKey}).`);
        onSaveError();
        return null;
      }
      const previous = session;
      cinematicPlaying = false;
      const loaded = prepareSession(result.state);
      session = loaded;
      previous?.dispose();
      loaded.resume();
      loop?.setPlayTime(result.state.stats.playTimeSec);
      loop?.resetAccumulator();
      saveSystem.attach(loaded.saveTarget());
      if (result.source === 'backup') loaded.notice('백업에서 복구했습니다');
      return loaded.hud;
    },
    endSession: () => {
      const ended = session;
      saveSystem.scheduler.flush(); // task 15.6: a waiting Milestone (e.g. the game completion) is written first
      saveSystem.detach();
      cinematicPlaying = false;
      session = prepareSession(); // fresh world behind the Title
      ended?.dispose();
    },
    openSettings: () => openSettings(), // task 14.4: Title "설정"
    openCredits: () => openPanel(new CreditsScreen({ onClose: () => closeTop('credits'), focus })), // task 14.2
  });

  // Task 14.2: Loading's last stage, the session behind the Title (hero rigs and their portraits).
  await loadStages(loading, [{ stage: 'characters', work: () => once(() => { session = prepareSession(); }) }]);

  // Tasks 13.5 / 13.7: the Map screen over the game. Its base image is built once per page (warmed after the first
  // frame). `map` (M) in play opens it; M or Esc closes it. Choosing an active Waystone queues `fastTravel` and closes
  // every screen above the HUD so the next tick can run it. The Pause screen's "지도" button calls openMap() too.
  const mapImage = new MapImageCache(terrain);
  const openMap = (): void => {
    const current = session;
    if (current === null || !ui.has('gameplay') || ui.has('map')) return;
    const screen = createMapScreen({
      ...current.mapSource(),
      image: () => mapImage.get(),
      onFastTravel: (waystoneId) => {
        commands.push({ kind: 'fastTravel', waystoneId });
        while (ui.top !== null && ui.top.id !== 'gameplay') ui.pop();
      },
      onClose: () => {
        if (ui.top === screen) ui.pop();
      },
    });
    ui.push(screen);
  };

  // ── Task 14.2: Pause and the menu screens over the game ──────────────────────
  /** The ScreenManager focus follows a screen's rebuilt element. */
  const focus = (element: HTMLElement): void => {
    ui.setFocus(element);
  };
  /** Pops the top screen when it is `id` (a screen opened above it closes first). */
  const closeTop = (id: string): void => {
    if (ui.top?.id === id) ui.pop();
  };
  const openPanel = (screen: Screen): void => {
    if (!ui.has(screen.id)) ui.push(screen);
  };
  /** A menu screen's UiCommand: queued, then applied at once under the menu (PlaySim.applyMenuCommands). */
  const runMenuCommand = (command: UiCommand): void => {
    commands.push(command);
    session?.applyMenuCommands();
  };
  /** Menus over play need the running game with the HUD at the bottom and nothing but play or a talk on top. */
  const canOpenOverPlay = (): boolean =>
    session !== null && ui.has('gameplay') && (ui.context === 'gameplay' || ui.context === 'dialogue') && !handle.contextLost;
  const openInventory = (): void => {
    const current = session;
    if (current === null || !ui.has('gameplay')) return;
    openPanel(new InventoryScreen({
      state: () => current.gameState,
      healCooldown: () => current.sim.consumables.healCooldown,
      run: runMenuCommand,
      onClose: () => closeTop('inventory'),
      focus,
    }));
  };
  const openQuest = (): void => {
    const current = session;
    if (current === null || !ui.has('gameplay')) return;
    openPanel(new QuestScreen({ quests: () => current.gameState.quests, run: runMenuCommand, onClose: () => closeTop('quest'), focus }));
  };
  const openCodex = (): void => {
    const current = session;
    if (current === null || !ui.has('gameplay')) return;
    openPanel(new CodexScreen({ codex: () => current.gameState.codex, onClose: () => closeTop('codex'), focus }));
  };
  const openShop = (): void => {
    const current = session;
    if (current === null) return;
    openPanel(new ShopScreen({ state: () => current.gameState, run: runMenuCommand, onClose: () => closeTop('shop'), focus }));
  };
  const openAltar = (): void => {
    const current = session;
    if (current === null) return;
    openPanel(new AltarScreen({ state: () => current.gameState, run: runMenuCommand, onClose: () => closeTop('echoAltar'), focus }));
  };
  /** Esc / Start in play, or a lost pointer lock / hidden tab / lost gamepad (Req 31.5, 31.8, 31.9). */
  const openPause = (): void => {
    if (!canOpenOverPlay() || ui.has('pause') || cinematicPlaying) return;
    const resume = (): void => {
      closeTop('pause');
      if (ui.context === 'gameplay') requestPointerLock(handle.canvas);
    };
    ui.push(new PauseScreen({
      ignoreCancel: () => browserInput.justUnlocked(300),
      actions: {
        resume,
        map: () => openMap(),
        inventory: () => openInventory(),
        quest: () => openQuest(),
        codex: () => openCodex(),
        settings: () => openSettings(),
        // "끼임 해제" (Req 20.8): Pause closes and the next tick runs the automatic recovery path.
        unstuck: () => {
          closeTop('pause');
          commands.push({ kind: 'unstuck' });
        },
        title: () => flow.returnToTitle(),
      },
    }));
  };

  let firstFrame = true;
  /** Real seconds rendered: drives the Title camera's slow orbit. */
  let realTime = 0;
  /** Task 22.2: the last frame's draw calls and triangles for the harness. */
  const harnessRender = { drawCalls: 0, triangles: 0 };
  /** Task 22.1: the Debug_Tools panel, only with `?debug=1`. */
  let debugPanel: DebugPanel | null = null;

  const gameLoop = new GameLoop({
    // Not called under a menu (ContextGate): the loop runs no step while pauseMode is 'menu'.
    step: ({ dt }) => {
      sampler.beginTick(dt); // InputSample: the frame's events reach the first tick only
      if (inputState.pressed('perfOverlay')) settings.set({ showPerfOverlay: !settings.get().showPerfOverlay }); // task 14.4
      session?.tick(dt);
      if (session !== null) {
        recoveries.observe(session.sim.recovery.reason); // task 22.2: harness recovery counts
        if (session.gameState.debugUsed && !debugFlagWritten) {
          debugFlagWritten = true;
          setDebugSessionFlag(sessionStore()); // task 22.1: the tab's session flag (Req 41.3)
        }
      }
      // Task 13.5: M in play opens the Map (not during a fade or cinematic); the loop stops this frame's other ticks.
      if (inputState.pressed('map') && ui.context === 'gameplay' && session?.sim.inputLocked === false) openMap();
      // Task 14.2: Esc / Start → Pause, I → Inventory / Equipment, J → Quest (the cinematic context has its own Esc).
      if (inputState.context === 'gameplay' || inputState.context === 'dialogue') {
        if (inputState.pressed('pause')) openPause();
        else if (inputState.context === 'gameplay' && ui.top?.id === 'gameplay') {
          if (inputState.pressed('inventory')) openInventory();
          else if (inputState.pressed('quest')) openQuest();
        }
      }
      // Task 14.2: a talk with Pip / Old Bram ended: its screen opens once play is on top again.
      if (pendingMenu !== null && ui.top?.id === 'gameplay' && !cinematicPlaying) {
        const menu = pendingMenu;
        pendingMenu = null;
        if (menu === 'shop') openShop();
        else openAltar();
      }
    },
    render: (alpha, realDt) => {
      fpsMeter.tick(realDt);
      realTime += realDt;
      const onTitle = ui.top?.id === 'title';
      if (session !== null) {
        session.render(alpha, realDt, !onTitle);
        // Task 18.2: time-of-day cut / 4 s blend, Region grading (fog, dome haze, rim) at the character, sun box.
        worldScene.update(realDt, { focus: session.focus, sky: session.sky });
        // Task 15.6: after this frame's ticks, in real time (menus stop game time, not saving).
        saveSystem.update(realDt, {
          inCombat: session.runtime.inCombat, cinematic: cinematicPlaying, menu: ui.context !== 'gameplay',
        });
      }
      if (onTitle) applyCameraRig(camera, titleCameraRig(realTime, (x, z) => terrain.heightAt(x, z)));
      ui.update(realDt);
      terrainView?.update(camera, realDt, session?.focus ?? null); // task 18.4: LODs, vegetation culling / loading, wind, bend
      if (handle.contextLost) return; // drawing waits for the restore
      // Tasks 18.5 / 18.6: interior blend, shadow box at the character, then the composer (or renderer.render).
      pipeline.render(realDt, session === null ? null : { focus: session.focus, interior: session.interior });
      harnessRender.drawCalls = renderer.info.render.calls; // task 22.2
      harnessRender.triangles = renderer.info.render.triangles;
      debugPanel?.update(); // task 22.1: toggles and AI labels (`?debug=1` only)
      if (firstFrame) {
        firstFrame = false;
        loading.remove(); // Loading ends once the Title has been drawn over the world
        setTimeout(() => mapImage.warm(), 0); // task 13.5: the map image, once, off the first frame
      }
      if (perf.visible) {
        const { render } = renderer.info; // re-read: three.js replaces `info` on context restore
        perfInfo.fps = fpsMeter.fps;
        perfInfo.drawCalls = render.calls;
        perfInfo.triangles = render.triangles;
        perfInfo.frameMs = realDt * 1000;
        perfInfo.extra = session?.debugInfo();
        perf.update(perfInfo);
      }
    },
    // Input is collected once per display frame, before the loop runs that frame's ticks.
    requestFrame: (cb) =>
      requestAnimationFrame((time) => {
        browserInput.pollGamepads();
        const events = browserInput.drain();
        sampler.collect(events);
        if (inputState.context !== 'gameplay' && gameLoop.pauseMode === 'menu') {
          // No tick runs under a menu: apply the events now so held keys stay tracked, and the key that closes
          // the menu is ignored in play until it is released.
          sampler.flush();
          if (inputState.pressed('perfOverlay')) settings.set({ showPerfOverlay: !settings.get().showPerfOverlay }); // task 14.4
          if (inputState.pressed('map') && ui.top?.id === 'map') ui.pop(); // task 13.5: M closes the Map
          // Task 14.2: I / J close the screen they opened.
          if (inputState.pressed('inventory') && ui.top?.id === 'inventory') ui.pop();
          if (inputState.pressed('quest') && ui.top?.id === 'quest') ui.pop();
        }
        // Task 14.1: an 'up' ends a held direction's repeat (and reaches the Settings remap); blur ends every hold.
        for (const event of events) {
          if (event.kind === 'down' || event.kind === 'up') ui.input(event.code, event.kind);
          else if (event.kind === 'releaseAll') ui.releaseInputs();
        }
        cb(time);
      }),
    cancelFrame: (id) => cancelAnimationFrame(id),
  });
  loop = gameLoop;

  // Task 22.2: the read-only Test_Harness in every build (window.__SKYSHARD_HARNESS__).
  const cameraDir = new THREE.Vector3();
  const harnessSources = {
    sim: () => session?.sim ?? null,
    screens: () => ui.ids,
    inputContext: () => inputState.context,
    pauseMode: () => gameLoop.pauseMode,
    pointerLocked: () => browserInput.pointerLocked,
    clock: () => ({ tick: gameLoop.tickCount, simTime: gameLoop.simTime, playTimeSec: gameLoop.playTimeSec }),
    camera: () => {
      camera.getWorldDirection(cameraDir);
      return { pos: { x: camera.position.x, y: camera.position.y, z: camera.position.z }, dir: { x: cameraDir.x, y: cameraDir.y, z: cameraDir.z } };
    },
    render: () => ({ fps: fpsMeter.fps, drawCalls: harnessRender.drawCalls, triangles: harnessRender.triangles }),
    audio: () => audio?.debugState() ?? null,
    log: harnessLog,
    recoveries,
  };
  const harness = createHarness(() => buildSnapshot(harnessSources), harnessLog);
  installHarness(window, harness);
  // Task 22.1: the Debug_Tools panel (F9) only with `?debug=1`; without it nothing is created or registered.
  const projected = new THREE.Vector3();
  debugPanel = mountDebugPanel({
    search: location.search,
    root: uiRoot,
    keyTarget: window,
    commands,
    releasePointerLock: () => browserInput.releasePointerLock(),
    toggles: () => session?.sim.debugTools ?? null,
    snapshot: () => harness.snapshot(), // the same frozen snapshot the harness gives (read-only)
    project: (pos) => {
      const p = projected.set(pos.x, pos.y, pos.z).project(camera);
      if (!(p.z > -1 && p.z < 1) || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) return null;
      const rect = uiRoot.getBoundingClientRect();
      return { x: ((p.x + 1) / 2) * rect.width, y: ((1 - p.y) / 2) * rect.height };
    },
  });

  // Req 1.8: the simulation pauses while the WebGL context is lost and resumes on restore.
  const lossOverlay = new ContextLossOverlay(uiRoot, {
    // The save system later sets the sessionStorage resume flag before this reload.
    onRestartFromSave: () => location.reload(),
  });
  handle.onContextLost(() => {
    lossOverlay.show();
    gameLoop.pauseMode = 'menu';
  });
  handle.onContextRestored(() => {
    lossOverlay.hide();
    applyContext(ui.context);
  });

  // Loading is done: the Title goes to the bottom of the stack (menu context, so the loop only renders).
  flow.showTitle();
  gameLoop.start();
  // Task 16.4: after the Title shows, the optional CC0 files decode in the background; a missing manifest or file
  // only warns and its synthesized sound stays in use (Req 40.1, 40.6).
  if (audio !== null) {
    void loadAudioAssets({
      assetsUrl: `${import.meta.env.BASE_URL}assets/`,
      fetch: (url) => fetch(url),
      decode: (data) => audio.decode(data),
    }).then((buffers) => audio.setBuffers(buffers));
  }
}

function start(): void {
  const canvas = requireElement('game-canvas', HTMLCanvasElement);
  const uiRoot = requireElement('ui-root', HTMLElement);
  const loading = new LoadingScreen(uiRoot); // task 14.2
  // Task 14.2: an uncaught error from the game's own scripts stops the frame loop: say so and offer a reload.
  window.addEventListener('error', (event) => {
    if (event.filename !== '' && !event.filename.startsWith(location.origin)) return; // extensions, other origins
    showFatalError(uiRoot, event.error ?? event.message);
  });

  let handle: RendererHandle | null = null;
  // Task 18.1: the probe's WebGL2 context (antialias off) stays on the game canvas and becomes the renderer's.
  if (isWebGL2Supported(canvas)) {
    try {
      handle = createRenderer(canvas);
    } catch (err) {
      console.error('WebGL2 renderer creation failed', err);
    }
  }
  if (handle === null) {
    loading.remove();
    showUnsupportedScreen(uiRoot); // loading stops here (Req 1.7)
    return;
  }
  const ready = handle;
  afterNextPaint(() => {
    runGame(ready, uiRoot, loading).catch((error: unknown) => {
      loading.remove();
      showFatalError(uiRoot, error); // task 14.2: a failure while the world is built
    });
  });
}

start();
