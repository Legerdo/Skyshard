// System scenario: performance (task 24.3; design "성능 측정", Req 38.3, 38.4, 38.7): at Default_Quality in the
// 1920 × 1080 viewport, with the F3 overlay on, the F3 figures (the harness `drawCalls`, `triangles`, `fps`) are
// sampled for 5 s at three fixed places — Thistlewick, the Ember canyon at the Cinderspire entrance and the Sanctum
// arena (Caelith fighting) — reached with the Debug_Tools (invincible, so the fight cannot end the run). Draw calls
// ≤ 500 and triangles ≤ 1.5 M (the per-place maxima) always count; the average ≥ 60 fps is asserted only on a
// hardware GPU (a software rasterizer's figure is recorded, not judged). test-results/perf.json takes the figures
// and the GPU string for the verification summary.
import type { PerfPoint } from '../../tools/verificationSummary';
import { LOCATIONS } from '../../../src/data/worldLayout';
import { expect, expectCleanRun, isSoftwareGpu, test, type Game } from '../fixtures';
import {
  debugButton, debugInvincible, flat, pause, PLAY_TRACE, settle, snap, startNewGame, teleport, traceLine, writeResultJson,
} from './play';

test.use(PLAY_TRACE);

const BUDGET = { drawCalls: 500, triangles: 1_500_000, fps: 60 } as const;
const WARM_MS = 2_000;
const SAMPLE_MS = 5_000;

async function measure(game: Game, label: string, gpu: string): Promise<PerfPoint> {
  await pause(game.page, WARM_MS);
  const fps: number[] = [];
  let drawCalls = 0;
  let triangles = 0;
  const end = Date.now() + SAMPLE_MS;
  while (Date.now() < end) {
    const s = await snap(game);
    fps.push(s.fps);
    drawCalls = Math.max(drawCalls, s.drawCalls);
    triangles = Math.max(triangles, s.triangles);
    await pause(game.page, 100);
  }
  const avgFps = fps.reduce((a, b) => a + b, 0) / Math.max(1, fps.length);
  await traceLine(game, `${label}: ${avgFps.toFixed(1)} fps, ${drawCalls} calls, ${triangles} tris`);
  return { label, avgFps: Math.round(avgFps * 10) / 10, drawCalls, triangles, gpu };
}

test('F3 figures at Thistlewick, the Ember canyon and the Sanctum arena', async ({ game, page }) => {
  test.setTimeout(240_000);
  const gpu = await game.gpu();
  const software = isSoftwareGpu(gpu);
  await startNewGame(game, { debug: true });
  await debugInvincible(game);
  await page.keyboard.press('F3');
  await expect(page.locator('#perf-overlay'), 'the F3 overlay shows').toBeVisible();

  const points: PerfPoint[] = [];
  await teleport(game, 'Thistlewick', { x: LOCATIONS.thistlewick.x + 4, z: LOCATIONS.thistlewick.z });
  points.push(await measure(game, 'Thistlewick', gpu));
  await teleport(game, '입구 · Cinderspire', LOCATIONS.cinderspire_base);
  points.push(await measure(game, 'Ember canyon (Cinderspire 입구)', gpu));
  await debugButton(game, '보스 직행');
  const arena = await game.waitFor((s) => flat(s.player.pos, LOCATIONS.sanctum_arena) < 34 && s.player.pos.y > 150, {
    timeout: 15_000, message: 'boss direct did not reach the Sanctum arena',
  });
  expect(arena.player.pos.y).toBeGreaterThan(170);
  await settle(game, { quietMs: 500 });
  expect((await snap(game)).boss, 'Caelith is fighting').not.toBeNull();
  points.push(await measure(game, 'Sanctum arena (Caelith 전투)', gpu));
  await expect(page.locator('#perf-overlay')).toBeVisible();

  writeResultJson('perf.json', points);
  test.info().annotations.push({
    type: 'note',
    description: `GPU ${gpu}${software ? ' (software: fps recorded only)' : ''}; ${points.map((p) => `${p.label} ${p.avgFps} fps ${p.drawCalls} calls ${p.triangles} tris`).join(' | ')}`,
  });
  for (const p of points) {
    expect.soft(p.drawCalls, `${p.label}: draw calls`).toBeLessThanOrEqual(BUDGET.drawCalls);
    expect.soft(p.triangles, `${p.label}: triangles`).toBeLessThanOrEqual(BUDGET.triangles);
    expect.soft(p.drawCalls, `${p.label}: something was drawn`).toBeGreaterThan(0);
    if (!software) expect.soft(p.avgFps, `${p.label}: average fps on ${gpu}`).toBeGreaterThanOrEqual(BUDGET.fps);
  }
  expectCleanRun(game.record);
});
