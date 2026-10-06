// System scenario: gliding (task 24.3; Req 42.5, 19.1–19.5): from the Breezewatch windmill top (y 64, reached with
// the Debug_Tools "지점 이동") a run off the deck with a jump and a second Space in the fall opens the glider. The
// flight follows the designed Breezewatch glide over the cliffs, then circles (camera held turning) over the top
// terrace (y 46) until it lands there. While gliding the descent, computed from consecutive snapshots' heights over
// sim time as the design asks, stays within 2.5 m/s, and the Stamina drains (6/s).
import { LOCATIONS } from '../../../src/data/worldLayout';
import { expect, expectCleanRun, test } from '../fixtures';
import {
  flat, isGlideMode, pause, PLAY_TRACE, snap, startNewGame, teleport, track, traceLine, turnTo, type PlaySnapshot,
} from './play';

test.use(PLAY_TRACE);

const BW = LOCATIONS.breezewatch; // windmill top y 64 at (−130, 250)
const ELDER = LOCATIONS.lm_elderbough;
/** The designed Breezewatch glide heads for the Elderbough, over the terraces (src/world/terrain/features.ts). */
const GLIDE_YAW = Math.atan2(ELDER.x - BW.x, ELDER.z - BW.z);
const DIR = { x: Math.sin(GLIDE_YAW), z: Math.cos(GLIDE_YAW) };
const alongLine = (s: PlaySnapshot): number => (s.player.pos.x - BW.x) * DIR.x + (s.player.pos.z - BW.z) * DIR.z;
/** The top terrace (y 46) spans 32–60 m along the line; the glider starts circling 42 m out, over its middle. */
const CIRCLE_FROM = 42;
const TOP_TERRACE_Y = 46;
const MAX_DESCENT = 2.5;

test('windmill top: jump + Space opens the glider, descent ≤ 2.5 m/s, Stamina drains, lands', async ({ game, page }) => {
  test.setTimeout(240_000);
  await startNewGame(game, { debug: true });
  const top = await teleport(game, 'Landmark · Breezewatch', BW);
  expect(top.player.pos.y, 'on the windmill top').toBeGreaterThan(60);
  await turnTo(game, GLIDE_YAW, 0.04);
  const before = await snap(game);
  await traceLine(game, 'deck');

  // Run to the deck's edge (3 m from its centre), jump off, and press Space again once falling.
  await page.keyboard.down('KeyW');
  let circling = false;
  try {
    await track(game, (s) => flat(s.player.pos, before.player.pos) > 2.6, { timeout: 8_000, message: 'did not run to the deck edge' });
    await page.keyboard.press('Space');
    await track(game, (s) => s.player.mode === 'jump' || s.player.mode === 'fall', { timeout: 3_000, message: 'the jump did not start' });
    let opened: PlaySnapshot | null = null;
    const deployDeadline = Date.now() + 8_000;
    while (opened === null) {
      const s = await snap(game);
      if (isGlideMode(s.player.mode)) opened = s;
      else if (s.player.mode === 'fall') await page.keyboard.press('Space');
      else if (s.player.grounded) throw new Error(`landed before the glider opened (at y ${s.player.pos.y.toFixed(1)})`);
      if (Date.now() > deployDeadline) throw new Error(`the glider did not open (mode ${s.player.mode})`);
      await pause(page, 60);
    }
    expect(opened.player.pos.y, 'the glider opened high above the ground').toBeGreaterThan(58);
    await traceLine(game, 'glider open');

    // Out over the cliffs, then circle over the top terrace until the glide ends.
    const flight = await track(game, (s) => !isGlideMode(s.player.mode) || (!circling && alongLine(s) >= CIRCLE_FROM), {
      timeout: 30_000, everyMs: 60, message: 'the glide did not reach the top terrace',
    });
    if (isGlideMode(flight[flight.length - 1]!.player.mode)) {
      circling = true;
      await page.keyboard.down('ArrowLeft'); // the camera turns 150°/s and the glide heading follows it
      flight.push(...await track(game, (s) => !isGlideMode(s.player.mode), { timeout: 30_000, everyMs: 60, message: 'the glide did not end' }));
    }
    await traceLine(game, 'glide over');
    const end = flight[flight.length - 1]!;
    const gliding = flight.filter((s) => s.player.mode === 'glide');
    expect(circling, 'reached the top terrace').toBe(true);
    expect(end.player.mode, 'the glide ended by landing').toMatch(/^(grounded|landing)$/);
    expect(end.player.pos.y, 'landed on the top terrace').toBeCloseTo(TOP_TERRACE_Y, 0);

    // Descent from the height change over sim time between glide snapshots at least 0.2 s apart.
    expect(gliding.length, 'glide snapshots').toBeGreaterThan(10);
    let worst = 0;
    let ref = gliding[0]!;
    for (const s of gliding) {
      const dt = s.simTime - ref.simTime;
      if (dt < 0.2) continue;
      worst = Math.min(worst, (s.player.pos.y - ref.player.pos.y) / dt);
      ref = s;
    }
    expect(worst, 'glide descent rate (m/s, from positions)').toBeGreaterThanOrEqual(-MAX_DESCENT - 0.05);
    expect(worst, 'the glider does descend').toBeLessThan(-1);
    expect(Math.min(...gliding.map((s) => s.player.vel.y)), 'glide vertical speed (m/s)').toBeGreaterThanOrEqual(-MAX_DESCENT - 1e-6);
    const glideSeconds = gliding[gliding.length - 1]!.simTime - gliding[0]!.simTime;
    expect(glideSeconds, 'glided for a while').toBeGreaterThan(4);
    const drained = opened.player.stamina - end.player.stamina;
    expect(drained, 'gliding drains Stamina (6/s)').toBeGreaterThan(glideSeconds * 6 * 0.7);
    test.info().annotations.push({
      type: 'note',
      description: `glided ${glideSeconds.toFixed(1)} s, worst descent ${worst.toFixed(2)} m/s, Stamina −${drained.toFixed(0)}, landed at y ${end.player.pos.y.toFixed(1)}, ${alongLine(end).toFixed(0)} m out`,
    });
  } finally {
    if (circling) await page.keyboard.up('ArrowLeft');
    await page.keyboard.up('KeyW');
  }
  await pause(page, 500);
  expect((await snap(game)).recovery.counts, 'no Safe_Position recovery').toEqual({});
  expectCleanRun(game.record);
});
