/*
 * Playthrough bot core (task 24.4): one closed-loop `frame()` that every behaviour (navigate, traverse, combat, boss,
 * route) awaits. A frame polls the Test_Harness (≥ 50 ms apart) and first services whatever holds the game the way a
 * player would, before handing the snapshot to the behaviour:
 * - a dialogue window: Space (an advance key) until it closes;
 * - a skippable cinematic: Space held from its skip hint until it ends; others are waited out;
 * - the Defeat Screen: its normal choice ("현재 Phase부터 재도전" in the Caelith fight, else the last respawn point),
 *   then a WipeError once play resumes so the route can pick up from the current Objective;
 * - a Pause the bot did not ask for (a lost pointer lock): "계속"; any other menu over play: Esc;
 * - a recovery fade: waited out.
 * Camera turns go through `face(yaw)`: mouse look while the pointer is locked, the camera keys otherwise.
 * Only keyboard and mouse events reach the page; `?debug=1` is never used and no debug feature is called.
 */
import type { Page } from '@playwright/test';
import { angleDelta } from '../../../src/core/math';
import type { TerrainField } from '../../../src/world/terrain';
import { Harness, free, type Snap } from './harness';
import { KEY_YAW_RATE, Keys } from './keys';

/** A Party_Wipe happened and the Defeat Screen's choice was taken; play has resumed. */
export class WipeError extends Error {
  constructor(readonly bossPhase: number | null, readonly objective: string) {
    super(`Party_Wipe during ${objective}${bossPhase === null ? '' : ` (Caelith Phase ${bossPhase})`}`);
  }
}

export interface BotHooks {
  /** A navigation stall: no progress toward the goal for 5 s. */
  stall(label: string, s: Snap): void;
  /** The bot used Pause → 끼임 해제. */
  unstuck(label: string, s: Snap): void;
  /** Screenshots due now (awaited before the next poll). */
  flush(): Promise<void>;
}

export class Bot {
  readonly h: Harness;
  readonly keys: Keys;
  /** The latest snapshot. */
  s!: Snap;
  /** The step being played (failure messages). */
  label = 'start';
  readonly wipes: { t: number; stage: string; objective: string; bossPhase: number | null }[] = [];
  /** Traversal steps that had to be tried again (route.ts retry). */
  readonly retries: { t: number; label: string; message: string }[] = [];
  hooks: BotHooks | null = null;
  private lastAdvanceAt = 0;
  private skipping: string | null = null;
  private pendingWipe: WipeError | null = null;
  /** Set while the bot itself has Pause open (unstuck). */
  ownPause = false;

  constructor(
    readonly page: Page,
    /** The world heightfield (same seed as the game), for ground paths and clearance checks. */
    readonly terrain: TerrainField,
  ) {
    this.h = new Harness(page);
    this.keys = new Keys(page);
  }

  now(): number {
    return Date.now();
  }

  /** Development trace line (SKYSHARD_BOT_TRACE=1). */
  trace(line: string): void {
    if (this.tracing) console.info(`[trace ${this.s.simTime.toFixed(2)}] ${line}`);
  }

  tracing = false;

  where(s: Snap = this.s): string {
    const p = s.player.pos;
    return `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) ${s.player.mode} [${s.mainStage}/${s.objective?.objectiveId ?? '-'}]`;
  }

  /** Polls until play takes input (servicing dialogues, cinematics, menus, fades); returns that snapshot. */
  async frame(): Promise<Snap> {
    for (;;) {
      if (this.hooks !== null) await this.hooks.flush();
      const s = await this.h.poll();
      this.s = s;
      if (s.debugUsed) throw new Error('debugUsed became true (a debug feature was used)');
      if (await this.service(s)) continue;
      if (this.pendingWipe !== null && free(s)) {
        const wipe = this.pendingWipe;
        this.pendingWipe = null;
        throw wipe;
      }
      return s;
    }
  }

  /** Handles whatever holds play; true when this frame was spent on it. */
  private async service(s: Snap): Promise<boolean> {
    // A skip key still down after its cinematic ended (or a new cinematic started) is released first.
    if (this.skipping !== null && s.cinematic?.id !== this.skipping) {
      await this.keys.up('Space');
      this.skipping = null;
    }
    const screen = s.screen;
    if (screen === 'defeat') {
      await this.keys.releaseAll();
      const retry = s.boss !== null && s.boss.state !== 'dead';
      const objective = s.objective?.objectiveId ?? '';
      this.wipes.push({ t: s.simTime, stage: s.mainStage, objective, bossPhase: retry ? s.boss?.phase ?? null : null });
      const name = retry ? '현재 Phase부터 재도전' : '마지막 부활 지점에서 다시 시작';
      await this.page.getByRole('button', { name, exact: true }).click({ timeout: 10_000 });
      await this.keys.afterUiClick();
      this.pendingWipe = new WipeError(retry ? s.boss?.phase ?? null : null, objective);
      return true;
    }
    if (screen === 'pause' && !this.ownPause) {
      await this.keys.releaseAll();
      await this.page.getByRole('button', { name: '계속', exact: true }).click({ timeout: 10_000 });
      await this.keys.afterUiClick();
      return true;
    }
    if (screen === 'victory' || screen === 'title' || screen === null) return false;
    if (screen !== 'gameplay' && screen !== 'dialogue' && !this.ownPause) {
      // A shop / altar / map / inventory screen over play: close it like a player (Esc).
      await this.keys.releaseAll();
      await this.page.keyboard.press('Escape');
      return true;
    }
    if (s.dialogue !== null) {
      await this.keys.releaseMovement();
      if (this.now() - this.lastAdvanceAt >= 110) {
        this.lastAdvanceAt = this.now();
        await this.keys.tap('Space');
      }
      return true;
    }
    if (s.cinematic !== null) {
      await this.keys.releaseMovement();
      if (s.cinematic.skippable && s.cinematic.skipAvailable) {
        if (this.skipping !== s.cinematic.id) {
          await this.keys.up('Space');
          await this.keys.down('Space');
          this.skipping = s.cinematic.id;
        }
      }
      return true;
    }
    if (s.recovery.active) {
      await this.keys.releaseMovement();
      return true;
    }
    return s.inputContext !== 'gameplay';
  }

  /** Turns the camera toward world yaw `yaw` (one step: the next frames correct any rest). */
  async face(yaw: number): Promise<void> {
    const cam = this.s.camera;
    if (cam === null) return;
    const err = angleDelta(cam.yaw, yaw);
    if (Math.abs(err) < 0.02) return;
    if (this.s.pointerLocked) await this.keys.turn(err, true);
    else await this.keys.turn(Math.max(-KEY_YAW_RATE * 0.12, Math.min(KEY_YAW_RATE * 0.12, err)), false);
  }

  /**
   * Takes the pointer lock back (a cinematic released it and the browser refused the page's own request): a click on
   * the canvas, as a player does. The click is also an attack, so this runs where a swing does no harm.
   */
  async ensureLock(): Promise<void> {
    const s = this.s;
    if (s.pointerLocked || !free(s) || !s.player.grounded || this.now() - this.lastLockTry < 1500) return;
    this.lastLockTry = this.now();
    await this.keys.recenter();
    await this.keys.tap('Mouse0');
  }

  private lastLockTry = 0;

  /** Left click on the canvas (attack; it also takes the pointer lock back when it was lost). */
  async attack(): Promise<void> {
    if (!this.s.pointerLocked) await this.keys.recenter();
    await this.keys.tap('Mouse0');
  }

  /** Frames with the movement keys up for `ms`. */
  async idle(ms: number): Promise<void> {
    await this.keys.stop();
    const end = this.now() + ms;
    while (this.now() < end) await this.frame();
  }

  /** Frames without movement until `done` holds; fails after `ms`. */
  async waitUntil(label: string, done: (s: Snap) => boolean, ms = 10_000): Promise<Snap> {
    await this.keys.stop();
    const end = this.now() + ms;
    for (;;) {
      const s = await this.frame();
      if (done(s)) return s;
      if (this.now() > end) throw new Error(`${label}: not done after ${ms} ms (at ${this.where(s)})`);
    }
  }

  /** Waits until play has been free for two consecutive frames (after a fade, cinematic or dialogue). */
  async settle(ms = 90_000): Promise<Snap> {
    let ok = 0;
    let s = this.s;
    const end = this.now() + ms;
    while (ok < 2) {
      s = await this.frame();
      ok = free(s) ? ok + 1 : 0;
      if (ok < 2 && this.now() > end) {
        throw new Error(`${this.label}: play did not become free in ${ms} ms (screens ${s.screens.join(' > ')}, context ${s.inputContext}, at ${this.where(s)})`);
      }
    }
    if (!s.pointerLocked) {
      await this.ensureLock();
      s = await this.frame();
    }
    return s;
  }

  /** Polls until `done` (no servicing); fails after `ms`. */
  private async pollUntil(label: string, done: (s: Snap) => boolean, ms: number): Promise<Snap> {
    const end = this.now() + ms;
    for (;;) {
      const s = await this.h.poll();
      this.s = s;
      if (done(s)) return s;
      if (this.now() > end) throw new Error(`${label} (screens ${s.screens.join(' > ')})`);
    }
  }

  /**
   * Pause → "끼임 해제" (Req 20.8): Pause closes and the automatic recovery runs (the latest checkpoint inside a
   * Challenge_Area, else a Safe_Position). While the pointer is locked the browser keeps Esc for the unlock (and a
   * synthetic Esc does not unlock), so the bot first opens the Quest screen (J; a menu releases the lock) and closes
   * it, then opens Pause with Esc.
   */
  async unstuck(label: string): Promise<void> {
    await this.keys.releaseAll();
    this.ownPause = true;
    try {
      let s = await this.h.poll();
      if (s.pointerLocked) {
        await this.page.keyboard.press('KeyJ');
        await this.pollUntil(`${label}: the Quest screen did not open`, (x) => x.screen === 'quest', 5000);
        await this.page.keyboard.press('Escape');
        s = await this.pollUntil(`${label}: the Quest screen did not close`, (x) => x.screen === 'gameplay', 5000);
      }
      await this.page.keyboard.press('Escape');
      await this.pollUntil(`${label}: Pause did not open for 끼임 해제`, (x) => x.screen === 'pause', 5000);
      this.hooks?.unstuck(label, this.s);
      await this.page.getByRole('button', { name: '끼임 해제', exact: true }).click({ timeout: 10_000 });
      await this.keys.afterUiClick();
    } finally {
      this.ownPause = false;
    }
    await this.settle();
  }
}
