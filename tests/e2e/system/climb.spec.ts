// System scenario: climbing (task 24.3; Req 42.5, 18.2–18.7, 17.1): at the Breezewatch cliffs (the terrain terraces
// y 22 → 34 north-west of the windmill) — walking into the rock face attaches, W climbs up while the Stamina drains,
// C lets go (the mode leaves climbing and the character falls back to the foot), and a second climb mantles onto the
// first terrace. The Debug_Tools "지점 이동" puts the party on the windmill top (Breezewatch), from where a walk off
// the deck lands at the cliff foot.
import { LOCATIONS } from '../../../src/data/worldLayout';
import { expect, expectCleanRun, test } from '../fixtures';
import {
  along, flat, isClimbMode, pause, PLAY_TRACE, settle, snap, startNewGame, teleport, track, traceLine, turnTo, walkTo,
  type PlaySnapshot,
} from './play';

test.use(PLAY_TRACE);

const BW = LOCATIONS.breezewatch; // (−130, 250): cliff foot y 22, windmill top y 64
const ELDER = LOCATIONS.lm_elderbough;
/** The terraces rise from the windmill toward the Elderbough (src/world/terrain/features.ts BREEZEWATCH_TERRACES). */
const FACE_YAW = Math.atan2(ELDER.x - BW.x, ELDER.z - BW.z);
/** First cliff: 12 → 14 m along that line, from the foot (y 22) to the first terrace (y 34). */
const CLIFF_ALONG = 12;
const FOOT_Y = 22;
const TERRACE_Y = 34;
/**
 * The climb starts 6 m to the left of the terraces' centre line (seen from the windmill): on the line itself the push
 * does not attach, and between −3 and +10 m the climb stalls under the lip (checked on the headless route bot, seed of
 * the New Game); from −4 to −15 m it mantles onto the terrace.
 */
const LEFT = { x: Math.cos(FACE_YAW), z: -Math.sin(FACE_YAW) };
const FOOT = (() => {
  const p = along(BW, FACE_YAW, CLIFF_ALONG - 2.5);
  return { x: p.x + LEFT.x * 6, z: p.z + LEFT.z * 6 };
})();

/** Pushes into the cliff (camera toward it, W held) until the character is on the wall. */
async function attach(game: Parameters<typeof snap>[0]): Promise<PlaySnapshot> {
  await turnTo(game, FACE_YAW, 0.05);
  await game.page.keyboard.down('KeyW');
  const seen = await track(game, (s) => isClimbMode(s.player.mode), { timeout: 10_000, message: 'walking into the cliff did not attach' });
  return seen[seen.length - 1]!;
}

test('Breezewatch cliff: attach by walking into it, climb, Stamina drains, C lets go', async ({ game, page }) => {
  test.setTimeout(240_000);
  await startNewGame(game, { debug: true });
  const top = await teleport(game, 'Landmark · Breezewatch', BW);
  expect(top.player.pos.y, 'on the windmill top').toBeGreaterThan(60);
  await traceLine(game, 'windmill top');

  // Walk (X) off the deck toward the cliffs: the drop lands on the foot ground short of the first cliff.
  await turnTo(game, FACE_YAW, 0.05);
  await page.keyboard.press('KeyX');
  await page.keyboard.down('KeyW');
  await track(game, (s) => s.player.mode === 'fall', { timeout: 10_000, message: 'did not walk off the windmill deck' });
  await page.keyboard.up('KeyW');
  await track(game, (s) => s.player.grounded && s.player.pos.y < FOOT_Y + 2, { timeout: 15_000, message: 'did not land at the cliff foot' });
  await page.keyboard.press('KeyX'); // back to running
  await settle(game, { quietMs: 600 });
  await walkTo(game, FOOT, { radius: 0.6 });
  await traceLine(game, 'cliff foot');

  // Attach: the push into the ≥ 65° rock face for 0.2 s grabs it.
  const onWall = await attach(game);
  const startY = onWall.player.pos.y;
  const startStamina = onWall.player.stamina;
  expect(startY, 'attached at the foot').toBeLessThan(FOOT_Y + 2);

  // Climb up (2 m/s) for a while: height gained, Stamina drained (10/s while moving).
  const climbing = await track(game, (s) => s.player.pos.y > startY + 3, { timeout: 12_000, message: 'W did not climb the wall' });
  const high = climbing[climbing.length - 1]!;
  await page.keyboard.up('KeyW');
  expect(climbing.every((s) => isClimbMode(s.player.mode)), 'on the wall the whole way up').toBe(true);
  expect(climbing.some((s) => s.player.mode === 'climb'), 'climb mode after the grab').toBe(true);
  expect(high.player.stamina, 'climbing drains Stamina').toBeLessThan(startStamina - 8);
  await traceLine(game, 'climbed');

  // C lets go: the mode leaves climbing (a fall) and the character lands back at the foot.
  await page.keyboard.press('KeyC');
  const released = await track(game, (s) => !isClimbMode(s.player.mode), { timeout: 3_000, message: 'C did not let go of the wall' });
  expect(released[released.length - 1]!.player.mode, 'falls off the wall').toMatch(/fall|jump|landing|grounded/);
  const landed = await track(game, (s) => s.player.grounded, { timeout: 8_000, message: 'did not land after letting go' });
  expect(landed[landed.length - 1]!.player.pos.y).toBeLessThan(startY + 1);

  // Once rested, a full climb mantles onto the first terrace (y 34).
  await track(game, (s) => s.player.stamina >= 95 && !s.player.exhausted, { timeout: 15_000, message: 'Stamina did not come back' });
  await walkTo(game, FOOT, { radius: 0.6 });
  await attach(game);
  const up = await track(game, (s) => s.player.grounded && s.player.pos.y > TERRACE_Y - 0.5, { timeout: 20_000, message: 'the climb did not reach the terrace top' });
  await page.keyboard.up('KeyW');
  expect(up.some((s) => s.player.mode === 'mantle') || up.some((s) => isClimbMode(s.player.mode)), 'climbed onto the terrace').toBe(true);
  const summit = up[up.length - 1]!;
  expect(flat(summit.player.pos, BW), 'on the terrace past the cliff').toBeGreaterThan(CLIFF_ALONG);
  await traceLine(game, 'terrace');

  await pause(page, 300);
  expect((await snap(game)).recovery.counts, 'no Safe_Position recovery').toEqual({});
  expectCleanRun(game.record);
});
