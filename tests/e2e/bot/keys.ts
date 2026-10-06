/*
 * Playthrough bot, input side (task 24.4; design "입력 전용 완주 봇" keys.ts, Req 42.3): low-level keyboard and mouse
 * events only (Playwright keyboard.down/up, mouse.move/down/up). The default bindings (src/input/bindings.ts) are
 * used; nothing is remapped.
 * - Camera: while the pointer is locked a relative mouse move turns it 1:1 (0.12°/px at sensitivity 1, yaw −= dx).
 *   Playwright's synthetic moves carry their delta to movementX even past the viewport edge, so the virtual pointer x
 *   is unbounded. Without the lock the fixed camera keys turn it (ArrowLeft / ArrowRight, 150°/s).
 * - Keys are tracked so a `set` only sends the edges it changes.
 */
import type { Page } from '@playwright/test';

export type MoveKey = 'KeyW' | 'KeyA' | 'KeyS' | 'KeyD';
export const MOVE_KEYS: readonly MoveKey[] = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];
const MOVE_GROUP: readonly string[] = [...MOVE_KEYS, 'ShiftLeft'];

/** src/input/inputState.ts MOUSE_RAD_PER_PX at the default sensitivity 1.0. */
export const MOUSE_RAD_PER_PX = (0.12 * Math.PI) / 180;
/** src/input/inputState.ts KEY_YAW_RATE (rad/s). */
export const KEY_YAW_RATE = (150 * Math.PI) / 180;
/** Canvas centre (1920 × 1080 viewport). */
export const CENTER = { x: 960, y: 540 } as const;

const MOUSE_BUTTONS = { Mouse0: 'left', Mouse1: 'middle', Mouse2: 'right' } as const;
type MouseCode = keyof typeof MOUSE_BUTTONS;
const isMouse = (code: string): code is MouseCode => code in MOUSE_BUTTONS;

export class Keys {
  private readonly held = new Set<string>();
  /** Virtual pointer (Playwright's mouse position). */
  private mouseX: number = CENTER.x;
  private mouseY: number = CENTER.y;

  constructor(private readonly page: Page) {}

  isHeld(code: string): boolean {
    return this.held.has(code);
  }

  async down(code: string): Promise<void> {
    if (this.held.has(code)) return;
    this.held.add(code);
    if (isMouse(code)) await this.page.mouse.down({ button: MOUSE_BUTTONS[code] });
    else await this.page.keyboard.down(code);
  }

  async up(code: string): Promise<void> {
    if (!this.held.delete(code)) return;
    if (isMouse(code)) await this.page.mouse.up({ button: MOUSE_BUTTONS[code] });
    else await this.page.keyboard.up(code);
  }

  /** Holds exactly `codes` among `group` (releases the rest of the group). */
  async set(codes: readonly string[], group: readonly string[]): Promise<void> {
    for (const code of group) if (!codes.includes(code)) await this.up(code);
    for (const code of codes) await this.down(code);
  }

  /** Holds exactly these movement keys, plus the sprint key when `sprint`. */
  async move(keys: readonly MoveKey[], sprint = false): Promise<void> {
    await this.set(sprint && keys.length > 0 ? [...keys, 'ShiftLeft'] : keys, MOVE_GROUP);
  }

  async stop(): Promise<void> {
    await this.move([]);
  }

  /** Press and release (an edge the next tick sees). */
  async tap(code: string): Promise<void> {
    await this.up(code);
    await this.down(code);
    await this.up(code);
  }

  /** Holds `code` for `ms` (real time). */
  async hold(code: string, ms: number): Promise<void> {
    await this.down(code);
    await this.page.waitForTimeout(ms);
    await this.up(code);
  }

  /** Charged_Attack: LMB held 0.5 s (the 0.4 s threshold with margin). */
  async charged(): Promise<void> {
    await this.hold('Mouse0', 500);
  }

  /** Skips a skippable cinematic: Space held 1.2 s (the 1 s hold with margin). */
  async skipCinematic(): Promise<void> {
    await this.hold('Space', 1200);
  }

  /**
   * Turns the camera by `delta` rad (positive = yaw grows = to the left). Locked: one relative mouse move. Unlocked:
   * the camera key toward it for |delta| / 150°/s (at least one tick).
   */
  async turn(delta: number, locked: boolean): Promise<void> {
    if (!Number.isFinite(delta) || delta === 0) return;
    if (locked) {
      this.mouseX += -delta / MOUSE_RAD_PER_PX;
      await this.page.mouse.move(this.mouseX, this.mouseY);
      return;
    }
    const key = delta > 0 ? 'ArrowLeft' : 'ArrowRight';
    await this.hold(key, Math.max(17, (Math.abs(delta) / KEY_YAW_RATE) * 1000));
  }

  /** Puts the virtual pointer back over the canvas centre (only while unlocked: no turn). */
  async recenter(): Promise<void> {
    this.mouseX = CENTER.x;
    this.mouseY = CENTER.y;
    await this.page.mouse.move(CENTER.x, CENTER.y);
  }

  /** A locator click moved Playwright's pointer; re-sync the virtual one to the canvas centre. */
  async afterUiClick(): Promise<void> {
    await this.recenter();
  }

  /** Releases every held key and button. */
  async releaseAll(): Promise<void> {
    for (const code of [...this.held]) await this.up(code);
  }

  /** Releases the movement group (keeps e.g. a held skip key). */
  async releaseMovement(): Promise<void> {
    await this.set([], MOVE_GROUP);
  }
}
