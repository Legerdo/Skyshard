/*
 * Playwright (task 24.2; design "브라우저 검증", Req 42.5, 42.6, 1.3): the static dist/ build served by `vite preview`
 * on port 4173, tested at 1920 × 1080 with one worker.
 * - Projects: `system` (tests/e2e/system: movement, climbing, gliding, combat, party, UI, save → reload → Continue,
 *   audio buses, performance, model swap) and `playthrough` (tests/e2e/playthrough.spec.ts: the input-only bot from
 *   Title to Victory).
 * - Browser: headed Chromium with the GPU flags (ANGLE on D3D11, GPU rasterization, no frame-rate limit) so the WebGL2
 *   game runs on the real GPU; when Playwright's Chromium is not installed, the installed Microsoft Edge (`msedge`
 *   channel) is used instead. `SKYSHARD_HEADLESS=1` runs headless (SwiftShader is then likely; the fixture reports it).
 * - Reporters: the list output plus tests/e2e/reporters/summaryReporter.ts, which writes
 *   test-results/verification-summary.md (task 25.4).
 */
import { chromium, defineConfig, devices, type LaunchOptions } from '@playwright/test';

// @types/node is not installed (tests/unit/helpers/importScan.ts): read the environment and fs through getBuiltinModule.
interface NodeProcess {
  env: Record<string, string | undefined>;
  getBuiltinModule?: (id: string) => unknown;
}
const proc = (globalThis as unknown as { process?: NodeProcess }).process;
const env = proc?.env ?? {};
const fs = proc?.getBuiltinModule?.('node:fs') as { existsSync(path: string): boolean } | undefined;

function chromiumInstalled(): boolean {
  try {
    const path = chromium.executablePath();
    return path !== '' && (fs?.existsSync(path) ?? false);
  } catch {
    return false;
  }
}

const headless = env.SKYSHARD_HEADLESS === '1';
/**
 * Preview port (design: 4173). Another project's preview may already hold it, so a running server is never reused
 * (the run fails instead of testing the wrong page); `SKYSHARD_E2E_PORT` picks another port.
 */
const port = Number(env.SKYSHARD_E2E_PORT ?? '4173');
const channel = chromiumInstalled() ? undefined : 'msedge';
const launchOptions: LaunchOptions = {
  args: [
    '--use-angle=d3d11',
    '--enable-gpu-rasterization',
    '--ignore-gpu-blocklist',
    '--disable-frame-rate-limit',
    '--disable-gpu-vsync',
    '--autoplay-policy=no-user-gesture-required',
  ],
};

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results/playwright',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['./tests/e2e/reporters/summaryReporter.ts', { outputDir: 'test-results' }]],
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    headless,
    ...(channel === undefined ? {} : { channel }),
    launchOptions,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'system',
      testDir: 'tests/e2e/system',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
    },
    {
      name: 'playthrough',
      testMatch: 'playthrough.spec.ts',
      timeout: 60 * 60_000, // a full run (20–30 min of play) with margin
      use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
    },
  ],
  webServer: {
    command: `npm run build && npm run preview -- --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
