/*
 * Shared Playwright fixture (task 24.2; Req 42.6): every e2e page records console errors, uncaught page errors and
 * requests to any host other than the local preview server, and detects a software (SwiftShader) WebGL renderer. The
 * `game` helper reads the read-only Test_Harness (window.__SKYSHARD_HARNESS__) and never changes game state.
 */
import { expect, test as base, type Page } from '@playwright/test';

export interface PageRecord {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  readonly externalRequests: string[];
}

/** The harness snapshot fields the e2e tests read (src/harness/snapshot.ts, schema version 1). */
export interface Snapshot {
  readonly version: 1;
  readonly seq: number;
  readonly tick: number;
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
  readonly objective: { readonly questId: string; readonly stageId: string; readonly objectiveId: string; readonly text: string } | null;
  readonly skyshards: number;
  readonly gameCompleted: boolean;
  readonly activeCharacter: string;
  readonly glim: number;
  readonly party: readonly { readonly id: string; readonly joined: boolean; readonly active: boolean; readonly hp: number; readonly maxHp: number }[];
  readonly player: { readonly pos: { x: number; y: number; z: number }; readonly vel: { x: number; y: number; z: number }; readonly yaw: number; readonly mode: string; readonly grounded: boolean; readonly stamina: number; readonly staminaMax: number };
  readonly inCombat: boolean;
  readonly enemies: readonly { readonly id: string; readonly kind: string; readonly pos: { x: number; y: number; z: number }; readonly state: string; readonly hp: number; readonly distance: number }[];
  readonly cinematic: { readonly id: string; readonly skippable: boolean; readonly skipAvailable: boolean } | null;
  readonly interact: { readonly kind: string; readonly id: string; readonly name: string } | null;
  readonly dialogue: { readonly dialogueId: string; readonly complete: boolean } | null;
  readonly recovery: { readonly active: boolean; readonly reason: string | null; readonly counts: Readonly<Record<string, number>> };
  readonly audio: { readonly musicBusGain?: number; readonly sfxBusGain?: number; readonly musicOn?: boolean } | null;
}

export interface Game {
  readonly page: Page;
  readonly record: PageRecord;
  /** The latest snapshot. */
  snapshot(): Promise<Snapshot>;
  /** Polls the snapshot (≥ 50 ms apart) until `check` holds; returns that snapshot. */
  waitFor(check: (s: Snapshot) => boolean, options?: { timeout?: number; message?: string }): Promise<Snapshot>;
  /** The WebGL renderer string (UNMASKED_RENDERER_WEBGL when exposed). */
  gpu(): Promise<string>;
  /** Opens the game and waits for the Title; `first` sends the first input that opens its menu. */
  open(options?: { first?: boolean; path?: string }): Promise<void>;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const test = base.extend<{ game: Game }>({
  game: async ({ page }, use) => {
    const record: PageRecord = { consoleErrors: [], pageErrors: [], externalRequests: [] };
    page.on('console', (msg) => {
      if (msg.type() === 'error') record.consoleErrors.push(msg.text());
    });
    page.on('pageerror', (error) => record.pageErrors.push(error.message));
    page.on('request', (request) => {
      const url = new URL(request.url());
      if ((url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ws:' || url.protocol === 'wss:') && !LOCAL_HOSTS.has(url.hostname)) {
        record.externalRequests.push(request.url());
      }
    });
    const snapshot = (): Promise<Snapshot> =>
      page.evaluate(() => {
        const h = (window as unknown as { __SKYSHARD_HARNESS__?: { snapshot(): unknown } }).__SKYSHARD_HARNESS__;
        if (h === undefined) throw new Error('Test_Harness not installed');
        return JSON.parse(JSON.stringify(h.snapshot())) as never;
      });
    const game: Game = {
      page,
      record,
      snapshot,
      async waitFor(check, options = {}) {
        const deadline = Date.now() + (options.timeout ?? 20_000);
        let last: Snapshot | null = null;
        for (;;) {
          try {
            last = await snapshot();
            if (check(last)) return last;
          } catch {
            // harness not ready yet
          }
          if (Date.now() > deadline) {
            throw new Error(`${options.message ?? 'condition not met'} (last screens: ${last?.screens.join(' > ') ?? 'none'})`);
          }
          await page.waitForTimeout(60);
        }
      },
      gpu: () =>
        page.evaluate(() => {
          const canvas = document.createElement('canvas');
          const gl = canvas.getContext('webgl2');
          if (gl === null) return 'no-webgl2';
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          return String(gl.getParameter(ext === null ? gl.RENDERER : ext.UNMASKED_RENDERER_WEBGL));
        }),
      async open(options = {}) {
        await page.goto(options.path ?? '/');
        await game.waitFor((s) => s.screen === 'title', { timeout: 30_000, message: 'Title Screen did not appear' });
        if (options.first !== false) {
          await page.mouse.click(960, 540);
          await expect(page.locator('.title-screen__menu')).toBeVisible();
        }
      },
    };
    await use(game);
  },
});

/** The run had no console errors, uncaught exceptions or external requests (Req 42.6). */
export function expectCleanRun(record: PageRecord): void {
  expect(record.pageErrors, 'uncaught page errors').toEqual([]);
  expect(record.consoleErrors, 'console errors').toEqual([]);
  expect(record.externalRequests, 'external requests').toEqual([]);
}

/** Whether the renderer string is a software rasterizer (fps figures are then not Dev_Machine figures). */
export function isSoftwareGpu(renderer: string): boolean {
  return /swiftshader|llvmpipe|software/i.test(renderer);
}

export { expect };
