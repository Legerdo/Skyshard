// System scenario: movement (task 24.3; Req 42.5, 16.1–16.4, 21.1–21.3): right after a New Game at Thistlewick's
// village entrance, judged from harness snapshots — camera look (arrow keys, and the mouse when the pointer lock is
// granted), a jump's height, the 0.7 m plaza step that stops a walk and is cleared with a jump, then the walk (X),
// run and sprint (Shift, Stamina drains) speeds on the road out of the village.
import { TUTORIAL_ANCHORS } from '../../../src/data/tutorials';
import { PLAZA_STEP } from '../../../src/data/village';
import { NEW_GAME_START } from '../../../src/data/worldLayout';
import { expect, expectCleanRun, test, type Game } from '../fixtures';
import {
  angleDelta, attack, hold, hspeed, pause, PLAY_TRACE, snap, startNewGame, track, traceLine, turnTo, type PlaySnapshot,
} from './play';

test.use(PLAY_TRACE);

const VILLAGE_Y = NEW_GAME_START.groundY; // 18
const STEP = TUTORIAL_ANCHORS.plaza_step;
/** The step runs across the entrance road; its depth lies along the New Game facing. */
const STEP_AXIS = { x: Math.sin(NEW_GAME_START.yaw), z: Math.cos(NEW_GAME_START.yaw) };
/** Signed distance of the feet from the step centre along the road (negative: the village-entrance side). */
const alongStep = (s: PlaySnapshot): number => (s.player.pos.x - STEP.x) * STEP_AXIS.x + (s.player.pos.z - STEP.z) * STEP_AXIS.z;

/** Median horizontal speed of the grounded snapshots. */
function medianSpeed(list: readonly PlaySnapshot[]): number {
  const v = list.filter((s) => s.player.grounded).map((s) => hspeed(s.player.vel)).sort((a, b) => a - b);
  return v.length === 0 ? 0 : (v[Math.floor(v.length / 2)] ?? 0);
}

/** Holds `keys` for `ms`; returns the snapshots of the second half (the speed has ramped up by then). */
async function moveFor(game: Game, keys: readonly string[], ms: number): Promise<PlaySnapshot[]> {
  const { page } = game;
  for (const k of keys) await page.keyboard.down(k);
  const out: PlaySnapshot[] = [];
  const start = Date.now();
  try {
    while (Date.now() - start < ms) {
      const s = await snap(game);
      if (Date.now() - start > ms / 2) out.push(s);
      await pause(page, 50);
    }
  } finally {
    for (const k of [...keys].reverse()) await page.keyboard.up(k);
  }
  return out;
}

test('camera look, jump, the plaza step, walk / run / sprint', async ({ game, page }) => {
  test.setTimeout(240_000);
  const start = await startNewGame(game);
  await traceLine(game, 'started');
  expect(Math.hypot(start.player.pos.x - NEW_GAME_START.x, start.player.pos.z - NEW_GAME_START.z), 'New Game starts at the village entrance').toBeLessThan(1.5);
  expect(start.player.pos.y).toBeCloseTo(VILLAGE_Y, 0);
  expect(start.camera, 'the harness reports the camera').not.toBeNull();

  // ── Camera look: ArrowLeft turns left (yaw up), ArrowRight right; ArrowUp looks up (pitch down) ──
  const yaw0 = start.camera!.yaw;
  await hold(page, ['ArrowLeft'], 400);
  const left = await snap(game);
  expect(angleDelta(yaw0, left.camera!.yaw), 'ArrowLeft turns the camera left').toBeGreaterThan(0.2);
  await hold(page, ['ArrowRight'], 400);
  const right = await snap(game);
  expect(angleDelta(left.camera!.yaw, right.camera!.yaw), 'ArrowRight turns it right').toBeLessThan(-0.2);
  const pitch0 = right.camera!.pitch;
  await hold(page, ['ArrowUp'], 300);
  const up = await snap(game);
  expect(up.camera!.pitch, 'ArrowUp looks up').toBeLessThan(pitch0 - 0.05);
  await hold(page, ['ArrowDown'], 300);

  // Mouse look needs the pointer lock, which a canvas click requests (the click is also an attack, harmless here).
  await attack(page);
  const locked = await game.waitFor((s) => s.pointerLocked, { timeout: 2_000 }).then(() => true, () => false);
  if (locked) {
    const before = await snap(game);
    await page.mouse.move(960 + 200, 540, { steps: 4 });
    await pause(page, 300);
    const after = await snap(game);
    // 200 px × 0.12°/px turns the camera 24° to the right (yaw down).
    expect(angleDelta(before.camera!.yaw, after.camera!.yaw), 'mouse right turns the camera right').toBeLessThan(-0.2);
    await page.mouse.move(960, 540, { steps: 4 });
  } else {
    test.info().annotations.push({ type: 'note', description: 'pointer lock not granted: mouse look not checked (the arrow keys were)' });
  }

  // ── Jump on the flat village pad: apex 1.4 m above the take-off ──
  await turnTo(game, NEW_GAME_START.yaw); // toward the village centre and the step
  await pause(page, 300);
  const ground = (await snap(game)).player.pos.y;
  let peak = ground;
  let airborne = false;
  await page.keyboard.press('Space');
  await track(game, (s) => {
    peak = Math.max(peak, s.player.pos.y);
    if (!s.player.grounded) airborne = true;
    return airborne && s.player.grounded;
  }, { timeout: 10_000, everyMs: 15, message: 'the jump did not land' });
  expect(peak - ground, 'jump height (m)').toBeGreaterThan(1.2);
  expect(peak - ground, 'jump height (m)').toBeLessThan(1.6);

  // ── The plaza step (0.7 m, above the 0.45 m step-up): a walk (X) stops at its face ──
  await page.keyboard.press('KeyX'); // walk toggle on
  await page.keyboard.down('KeyW');
  let blockedAt: PlaySnapshot | null = null;
  const toFace = Date.now();
  await track(game, (s) => {
    const stopped = Date.now() - toFace > 1_000 && hspeed(s.player.vel) < 0.3;
    const near = alongStep(s) > -1.15;
    if (near && (stopped || Date.now() - toFace > 6_000)) blockedAt = s;
    // Keep pushing for a moment at the face: it must hold.
    return blockedAt !== null && Date.now() - toFace > 1_000;
  }, { timeout: 20_000, message: 'did not reach the plaza step' });
  await pause(page, 600);
  const pushed = await snap(game);
  await page.keyboard.up('KeyW');
  expect(blockedAt, 'reached the step').not.toBeNull();
  expect(alongStep(pushed), 'the step face stops the walk (feet a capsule radius before it)').toBeLessThan(-(PLAZA_STEP.halfDepth + 0.25));
  expect(pushed.player.pos.y, 'still on the road, not on the step').toBeCloseTo(VILLAGE_Y, 1);
  await pause(page, 400);

  // A jump with the walk carries onto the step: stand on its top (y 18.7) or clear it completely.
  await page.keyboard.down('KeyW');
  await page.keyboard.press('Space');
  let onTop = false;
  const hop = await track(game, (s) => {
    if (s.player.grounded && Math.abs(s.player.pos.y - (VILLAGE_Y + PLAZA_STEP.height)) < 0.12) onTop = true;
    return onTop || (s.player.grounded && alongStep(s) > PLAZA_STEP.halfDepth + 0.3);
  }, { timeout: 8_000, everyMs: 15, message: 'the jump did not clear the plaza step' });
  await page.keyboard.up('KeyW');
  const cleared = hop[hop.length - 1]!;
  expect(onTop || alongStep(cleared) > PLAZA_STEP.halfDepth, 'the jump clears the step').toBe(true);
  test.info().annotations.push({ type: 'note', description: onTop ? 'stood on the plaza step (y 18.7)' : 'jumped over the plaza step' });
  await pause(page, 500);
  await traceLine(game, `step onTop=${String(onTop)} pushed=${alongStep(pushed).toFixed(2)}`);

  // ── Speeds on the road out of the village (walk 2.5, run 6, sprint 9 m/s) ──
  await turnTo(game, NEW_GAME_START.yaw + Math.PI);
  const walked = medianSpeed(await moveFor(game, ['KeyW'], 2_000));
  expect(walked, 'walk speed (m/s)').toBeGreaterThan(2.0);
  expect(walked, 'walk speed (m/s)').toBeLessThan(3.0);
  await page.keyboard.press('KeyX'); // walk toggle off: W runs
  const ran = medianSpeed(await moveFor(game, ['KeyW'], 2_000));
  expect(ran, 'run speed (m/s)').toBeGreaterThan(5.4);
  expect(ran, 'run speed (m/s)').toBeLessThan(6.6);
  const rested = await snap(game);
  const sprintSamples = await moveFor(game, ['ShiftLeft', 'KeyW'], 2_500);
  const sprinted = medianSpeed(sprintSamples);
  expect(sprinted, 'sprint speed (m/s)').toBeGreaterThan(8.1);
  expect(sprinted, 'sprint speed (m/s)').toBeLessThan(9.9);
  const stamina = Math.min(...sprintSamples.map((s) => s.player.stamina));
  expect(stamina, 'sprinting drains Stamina').toBeLessThan(rested.player.stamina - 10);
  test.info().annotations.push({ type: 'note', description: `speeds walk ${walked.toFixed(2)} · run ${ran.toFixed(2)} · sprint ${sprinted.toFixed(2)} m/s; jump ${(peak - ground).toFixed(2)} m` });

  await traceLine(game, 'speeds');
  const end = await snap(game);
  expect(end.recovery.counts, 'no Safe_Position recovery on the way').toEqual({});
  expectCleanRun(game.record);
});
