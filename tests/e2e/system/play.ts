/*
 * Closed-loop play helpers for the system scenarios (task 24.3; design "시스템 시나리오"): the game is driven only with
 * page.keyboard / page.mouse (the arrow keys turn the camera, so no pointer lock is needed) and judged from the
 * read-only Test_Harness snapshot. The `?debug=1` helpers go through the F9 Debug_Tools panel like a developer would
 * (system scenarios may use it; only the playthrough must stay debug-free).
 */
import type { Page } from '@playwright/test';
import { expect, type Game, type Snapshot } from '../fixtures';

export interface V3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}
export interface XZ {
  readonly x: number;
  readonly z: number;
}

/** The snapshot fields these scenarios read beyond the fixture's (src/harness/snapshot.ts, schema version 1). */
export interface PlaySnapshot extends Snapshot {
  readonly simTime: number;
  readonly camera: { readonly pos: V3; readonly yaw: number; readonly pitch: number; readonly distance: number } | null;
  readonly party: readonly {
    readonly id: string; readonly joined: boolean; readonly active: boolean; readonly hp: number; readonly maxHp: number;
    readonly downed: boolean; readonly skillCooldown: number; readonly energy: number; readonly energyMax: number;
  }[];
  readonly player: Snapshot['player'] & { readonly exhausted: boolean };
  readonly enemies: readonly {
    readonly id: string; readonly kind: string; readonly pos: V3; readonly state: string; readonly hp: number; readonly maxHp: number;
    readonly distance: number; readonly attack: string | null; readonly telegraph: number | null;
  }[];
  readonly cinematic: {
    readonly id: string; readonly t: number; readonly duration: number; readonly skippable: boolean; readonly skipAvailable: boolean;
  } | null;
  readonly boss: { readonly phase: number; readonly hp: number; readonly state: string } | null;
}

export const snap = async (game: Game): Promise<PlaySnapshot> => (await game.snapshot()) as PlaySnapshot;

/**
 * Trace option for the scenarios that play for a while (`test.use(PLAY_TRACE)`): the config's retain-on-failure trace
 * without its screencast, which at the game's frame rate (a 1920×1080 canvas at several hundred fps) adds minutes of
 * teardown per test. Actions, console and network stay in the trace.
 */
export const PLAY_TRACE = { trace: { mode: 'retain-on-failure', screenshots: false } } as const;

const TRACE_ON = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env.SKYSHARD_E2E_TRACE === '1';

/** With `SKYSHARD_E2E_TRACE=1`, prints a one-line state summary (debugging a scenario run). */
export async function traceLine(game: Game, label: string): Promise<void> {
  if (!TRACE_ON) return;
  const s = await snap(game);
  const p = s.player;
  console.log(`[${label}] tick ${s.tick} fps ${s.fps.toFixed(0)} ${p.pos.x.toFixed(1)},${p.pos.y.toFixed(2)},${p.pos.z.toFixed(1)} ${p.mode} st ${p.stamina.toFixed(0)} cam ${s.camera?.yaw.toFixed(2) ?? '-'} ${s.activeCharacter} enemies ${s.enemies.length} screens ${s.screens.join('>')}`);
}

// ── Geometry (src/core/math conventions: yaw 0 faces +z, positive yaw turns toward +x) ─────────────────────────────

export const flat = (a: XZ, b: XZ): number => Math.hypot(b.x - a.x, b.z - a.z);
export const hspeed = (v: V3): number => Math.hypot(v.x, v.z);
export const yawTo = (from: XZ, to: XZ): number => Math.atan2(to.x - from.x, to.z - from.z);
/** Signed shortest turn from `from` to `to` (rad, in (−π, π]). */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}
export const along = (origin: XZ, yaw: number, distance: number): XZ => ({
  x: origin.x + Math.sin(yaw) * distance,
  z: origin.z + Math.cos(yaw) * distance,
});

const CLIMB_MODES = new Set(['climbAttach', 'climb', 'climbLeap', 'mantle']);
const GLIDE_MODES = new Set(['glideDeploy', 'glide']);
export const isClimbMode = (mode: string): boolean => CLIMB_MODES.has(mode);
export const isGlideMode = (mode: string): boolean => GLIDE_MODES.has(mode);

// ── Play state ──────────────────────────────────────────────────────────────

/** Free control: the gameplay HUD on top with nothing holding input. */
export function isFree(s: PlaySnapshot): boolean {
  return s.screen === 'gameplay' && s.inputContext === 'gameplay' && s.pauseMode !== 'menu' && s.cinematic === null
    && s.dialogue === null && !s.recovery.active;
}

export const pause = (page: Page, ms: number): Promise<void> => page.waitForTimeout(ms);

/**
 * Plays through whatever holds input, as a player would: a dialogue window is advanced with F, a skippable cinematic
 * is skipped by holding Space once its skip hint shows. Returns once play has been free for `quietMs`.
 */
export async function settle(game: Game, options: { timeout?: number; quietMs?: number } = {}): Promise<PlaySnapshot> {
  const { page } = game;
  const deadline = Date.now() + (options.timeout ?? 60_000);
  const quietMs = options.quietMs ?? 1_200;
  let freeSince: number | null = null;
  let holdingSkip = false;
  let lastF = 0;
  try {
    for (;;) {
      const s = await snap(game);
      const now = Date.now();
      if (isFree(s)) {
        if (holdingSkip) {
          await page.keyboard.up('Space');
          holdingSkip = false;
        }
        freeSince ??= now;
        if (now - freeSince >= quietMs) return s;
      } else {
        freeSince = null;
        if (s.dialogue !== null && now - lastF > 300) {
          await page.keyboard.press('KeyF');
          lastF = now;
        }
        const skip = s.cinematic?.skipAvailable === true;
        if (skip && !holdingSkip) {
          await page.keyboard.down('Space');
          holdingSkip = true;
        } else if (!skip && holdingSkip) {
          await page.keyboard.up('Space');
          holdingSkip = false;
        }
      }
      if (now > deadline) {
        throw new Error(`play did not settle: screens ${s.screens.join(' > ')}, context ${s.inputContext}, cinematic ${s.cinematic?.id ?? '-'}, dialogue ${s.dialogue?.dialogueId ?? '-'}, recovery ${String(s.recovery.active)}`);
      }
      await pause(page, 80);
    }
  } finally {
    if (holdingSkip) await page.keyboard.up('Space');
  }
}

/**
 * Title → 새로 시작 → the gameplay HUD, then the ms1 briefing (it opens by itself 0.8 s after the party can listen)
 * read through with F. `debug` opens the page with `?debug=1` (Debug_Tools panel on F9).
 */
export async function startNewGame(game: Game, options: { debug?: boolean } = {}): Promise<PlaySnapshot> {
  const { page } = game;
  await game.open({ path: options.debug === true ? '/?debug=1' : '/' });
  await page.getByRole('button', { name: '새로 시작' }).click();
  await game.waitFor((s) => s.screens[0] === 'gameplay' && s.mainStage !== '', { timeout: 60_000, message: 'New Game did not start' });
  // The briefing may take a moment to open; it is not a failure if it never does.
  await game.waitFor((s) => s.dialogue !== null, { timeout: 6_000 }).catch(() => undefined);
  await page.mouse.move(960, 540); // the pointer over the canvas for the mouse buttons (the HUD passes pointer events through)
  return settle(game);
}

// ── Camera and movement ─────────────────────────────────────────────────────

/** The camera keys turn 150°/s of sim time (src/input/inputState.ts KEY_YAW_RATE). */
const KEY_YAW_RATE = (150 * Math.PI) / 180;

function cameraYaw(s: PlaySnapshot): number {
  if (s.camera === null) throw new Error('no camera in the snapshot');
  return s.camera.yaw;
}

/**
 * Turns the camera to world yaw `yaw` with the arrow keys (ArrowLeft raises the yaw, ArrowRight lowers it): holds the
 * key until the camera is close, then trims with shorter holds. Returns the final snapshot.
 */
export async function turnTo(game: Game, yaw: number, tolerance = 0.06, timeout = 15_000): Promise<PlaySnapshot> {
  const { page } = game;
  const deadline = Date.now() + timeout;
  let minHold = 40;
  let last = Infinity;
  for (;;) {
    const s = await snap(game);
    const d = angleDelta(cameraYaw(s), yaw);
    if (Math.abs(d) <= tolerance) return s;
    if (Date.now() > deadline) throw new Error(`camera did not turn to ${yaw.toFixed(2)} (at ${cameraYaw(s).toFixed(2)})`);
    if (Math.abs(Math.abs(d) - last) < 1e-3) minHold = Math.min(400, minHold * 2); // the last hold did not register
    last = Math.abs(d);
    const key = d > 0 ? 'ArrowLeft' : 'ArrowRight';
    if (Math.abs(d) > 0.35) {
      // Coarse: hold until the camera is within 0.2 rad (the sim may run slower than real time, so poll).
      await page.keyboard.down(key);
      const until = Date.now() + 6_000;
      for (;;) {
        await pause(page, 20);
        const now = await snap(game);
        const rest = angleDelta(cameraYaw(now), yaw);
        if (Math.abs(rest) < 0.2 || Math.sign(rest) !== Math.sign(d) || Date.now() > until) break;
      }
      await page.keyboard.up(key);
    } else {
      await page.keyboard.down(key);
      await pause(page, Math.max(minHold, (Math.abs(d) / KEY_YAW_RATE) * 1000 * 0.7));
      await page.keyboard.up(key);
    }
    await pause(page, 60);
  }
}

/** Holds `keys` for `ms`, then releases them. */
export async function hold(page: Page, keys: readonly string[], ms: number): Promise<void> {
  for (const k of keys) await page.keyboard.down(k);
  await pause(page, ms);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
}

export interface WalkOptions {
  /** Arrival radius (m). */
  radius?: number;
  sprint?: boolean;
  timeout?: number;
  /** Called with every polled snapshot; returning true stops the walk early. */
  stopWhen?: (s: PlaySnapshot) => boolean;
}

/**
 * Walks to (x, z) with W held, steering the camera toward the target with the arrow keys as it goes; jumps when no
 * progress is made for a while. Returns the snapshot on arrival (the keys released).
 */
export async function walkTo(game: Game, target: XZ, options: WalkOptions = {}): Promise<PlaySnapshot> {
  const { page } = game;
  const radius = options.radius ?? 1.2;
  const deadline = Date.now() + (options.timeout ?? 45_000);
  let first = await snap(game);
  if (flat(first.player.pos, target) <= radius) return first;
  first = await turnTo(game, yawTo(first.player.pos, target), 0.12);
  const moveKeys = options.sprint === true ? ['ShiftLeft', 'KeyW'] : ['KeyW'];
  let steering: string | null = null;
  let best = Infinity;
  let bestAt = Date.now();
  let lastJump = 0;
  for (const k of moveKeys) await page.keyboard.down(k);
  try {
    for (;;) {
      const s = await snap(game);
      const d = flat(s.player.pos, target);
      if (d <= radius || options.stopWhen?.(s) === true) return s;
      const now = Date.now();
      if (now > deadline) throw new Error(`walk to (${target.x.toFixed(1)}, ${target.z.toFixed(1)}) timed out at (${s.player.pos.x.toFixed(1)}, ${s.player.pos.y.toFixed(1)}, ${s.player.pos.z.toFixed(1)}) ${s.player.mode}`);
      if (d < best - 0.3) {
        best = d;
        bestAt = now;
      } else if (now - bestAt > 1_500 && now - lastJump > 1_000 && s.player.grounded) {
        await page.keyboard.press('Space'); // a low obstacle in the way
        lastJump = now;
      }
      const turn = angleDelta(cameraYaw(s), yawTo(s.player.pos, target));
      const want = Math.abs(turn) < 0.06 ? null : turn > 0 ? 'ArrowLeft' : 'ArrowRight';
      if (want !== steering) {
        if (steering !== null) await page.keyboard.up(steering);
        if (want !== null) await page.keyboard.down(want);
        steering = want;
      }
      await pause(page, 40);
    }
  } finally {
    if (steering !== null) await page.keyboard.up(steering);
    for (const k of [...moveKeys].reverse()) await page.keyboard.up(k);
  }
}

/** Waits (polling) until `check` holds; returns every snapshot seen on the way, the matching one last. */
export async function track(
  game: Game, check: (s: PlaySnapshot) => boolean, options: { timeout?: number; message?: string; everyMs?: number } = {},
): Promise<PlaySnapshot[]> {
  const seen: PlaySnapshot[] = [];
  const deadline = Date.now() + (options.timeout ?? 20_000);
  for (;;) {
    const s = await snap(game);
    seen.push(s);
    if (check(s)) return seen;
    if (Date.now() > deadline) {
      const p = s.player;
      throw new Error(`${options.message ?? 'condition not met'} (at ${p.pos.x.toFixed(1)}, ${p.pos.y.toFixed(1)}, ${p.pos.z.toFixed(1)} ${p.mode}, screens ${s.screens.join(' > ')})`);
    }
    await pause(game.page, options.everyMs ?? 40);
  }
}

// ── Mouse buttons (mousedown on the canvas: Mouse0 attack, Mouse2 dodge) ─────

export async function attack(page: Page): Promise<void> {
  await page.mouse.down({ button: 'left' });
  await page.mouse.up({ button: 'left' });
}

export async function dodge(page: Page): Promise<void> {
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
}

// ── Combat ──────────────────────────────────────────────────────────────────

/** Enemy AI states that mean it has noticed the party (src/enemy AI; the route bot's ENGAGED set). */
export const ENGAGED_STATES = new Set(['alert', 'chase', 'attack', 'recovery', 'stagger']);

/** Follows the enemies across snapshots: which were hurt and which disappeared close by (defeated). */
export class EnemyTracker {
  private readonly last = new Map<string, { hp: number; maxHp: number; distance: number; kind: string }>();
  readonly defeated = new Map<string, string>();
  /** Enemies seen below full HP. */
  readonly hurt = new Set<string>();

  observe(s: PlaySnapshot): void {
    const now = new Set(s.enemies.map((e) => e.id));
    for (const [id, e] of this.last) {
      if (!now.has(id) && e.distance < 40) this.defeated.set(id, e.kind);
    }
    for (const id of [...this.last.keys()]) if (!now.has(id)) this.last.delete(id);
    for (const e of s.enemies) {
      if (e.hp < e.maxHp) this.hurt.add(e.id);
      this.last.set(e.id, { hp: e.hp, maxHp: e.maxHp, distance: e.distance, kind: e.kind });
    }
  }
}

export interface FightOptions {
  /** Distance kept to the target (m): melee closes to ~2 m, a bow may stand off. */
  reach?: number;
  /** Swing (Mouse0) while in range. */
  swing?: boolean;
  timeout?: number;
  tracker?: EnemyTracker;
  /** Only enemies within this range are targets (m). */
  range?: number;
}

/**
 * Closed-loop melee: faces the nearest enemy with the arrow keys, closes to `reach` with W and swings every ~0.2 s,
 * until `until` holds for a snapshot (returned). The keys are released on the way out.
 */
export async function fightUntil(game: Game, until: (s: PlaySnapshot) => boolean, options: FightOptions = {}): Promise<PlaySnapshot> {
  const { page } = game;
  const reach = options.reach ?? 1.8;
  const range = options.range ?? 30;
  const deadline = Date.now() + (options.timeout ?? 60_000);
  let steering: string | null = null;
  let moving = false;
  let lastSwing = 0;
  const setSteer = async (want: string | null): Promise<void> => {
    if (want === steering) return;
    if (steering !== null) await page.keyboard.up(steering);
    if (want !== null) await page.keyboard.down(want);
    steering = want;
  };
  const setMove = async (want: boolean): Promise<void> => {
    if (want === moving) return;
    if (want) await page.keyboard.down('KeyW');
    else await page.keyboard.up('KeyW');
    moving = want;
  };
  try {
    for (;;) {
      const s = await snap(game);
      options.tracker?.observe(s);
      if (until(s)) return s;
      const now = Date.now();
      if (now > deadline) {
        throw new Error(`fight: condition not met in time (${s.activeCharacter} ${s.party.find((p) => p.active)?.hp ?? '?'} HP; enemies ${s.enemies.map((e) => `${e.kind} ${Math.ceil(e.hp)} HP ${e.distance.toFixed(1)} m ${e.state}`).join(', ') || 'none'})`);
      }
      const target = s.enemies.find((e) => e.distance <= range) ?? null;
      if (target === null || !isFree(s)) {
        await setSteer(null);
        await setMove(false);
      } else {
        const d = flat(s.player.pos, target.pos);
        const turn = angleDelta(cameraYaw(s), yawTo(s.player.pos, target.pos));
        await setSteer(Math.abs(turn) < 0.1 ? null : turn > 0 ? 'ArrowLeft' : 'ArrowRight');
        await setMove(d > reach && Math.abs(turn) < 1.2);
        if (options.swing !== false && d <= reach + 1.2 && Math.abs(turn) < 0.7 && now - lastSwing > 200) {
          await attack(page);
          lastSwing = now;
        }
      }
      await pause(page, 40);
    }
  } finally {
    await setSteer(null);
    await setMove(false);
  }
}

/** Presses the Active_Character's slot key (1–4, PARTY_SLOTS order) until `id` is active (the 0.8 s switch lock). */
export async function switchTo(game: Game, id: string): Promise<PlaySnapshot> {
  const slots = ['kairen', 'isla', 'wren', 'talus'];
  const slot = slots.indexOf(id) + 1;
  if (slot < 1) throw new Error(`no party slot for ${id}`);
  const deadline = Date.now() + 6_000;
  for (;;) {
    const s = await snap(game);
    if (s.activeCharacter === id) return s;
    if (Date.now() > deadline) throw new Error(`could not switch to ${id} (active ${s.activeCharacter})`);
    await game.page.keyboard.press(`Digit${slot}`);
    await pause(game.page, 250);
  }
}

// ── Result files under test-results/ (read by tests/e2e/reporters/summaryReporter.ts) ──────────────────────────────

interface NodeFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  readFileSync(path: string): Uint8Array;
  writeFileSync(path: string, data: string | Uint8Array): void;
  mkdirSync(path: string, options: { recursive: true }): void;
  readdirSync(path: string): string[];
}

/** node:fs through process.getBuiltinModule (@types/node is not installed; tests/unit/helpers/importScan.ts). */
export function nodeFs(): NodeFs {
  const p = (globalThis as unknown as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  if (typeof p?.getBuiltinModule !== 'function') throw new Error('node:fs unavailable (Node >= 20.16 needed)');
  return p.getBuiltinModule('node:fs') as NodeFs;
}

/** Writes `test-results/<name>` as pretty JSON. */
export function writeResultJson(name: string, data: unknown): void {
  const fs = nodeFs();
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync(`test-results/${name}`, `${JSON.stringify(data, null, 2)}\n`);
}

// ── Debug_Tools panel (`?debug=1`, F9) ──────────────────────────────────────

/** Opens the F9 panel, runs `fn` on it, closes it and gives the keyboard back to the game. */
export async function withDebugPanel(page: Page, fn: () => Promise<void>): Promise<void> {
  const panel = page.getByRole('dialog', { name: 'DEBUG 패널' });
  await page.keyboard.press('F9');
  await expect(panel).toBeVisible();
  await fn();
  await page.keyboard.press('F9');
  await expect(panel).toBeHidden();
  // A focused panel control would keep the game's keys (the panel stops their propagation).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

export async function debugButton(game: Game, name: string): Promise<void> {
  await withDebugPanel(game.page, () => game.page.getByRole('button', { name, exact: true }).click());
}

export async function debugInvincible(game: Game): Promise<void> {
  await withDebugPanel(game.page, () => game.page.getByRole('checkbox', { name: '무적' }).check());
}

/** "지점 이동" to a DEBUG_LOCATIONS entry by its label (src/debug/debugLocations.ts); waits for the move and settles. */
export async function teleport(game: Game, label: string, expectNear?: XZ): Promise<PlaySnapshot> {
  const { page } = game;
  const before = await settle(game, { quietMs: 400 });
  await withDebugPanel(page, async () => {
    await page.getByLabel('이동할 지점').selectOption({ label });
    await page.getByRole('button', { name: '지점 이동', exact: true }).click();
  });
  await game.waitFor(
    (s) => expectNear !== undefined ? flat(s.player.pos, expectNear) < 3 : flat(s.player.pos, before.player.pos) > 3,
    { timeout: 15_000, message: `teleport to ${label} did not move the character` },
  );
  return settle(game);
}
