// System scenario: save → reload → Continue (task 24.3; Req 42.5, 36.x): New Game writes its first save at once; after
// a reload the Title's Continue is enabled and restores the game (stage, Objective, party) at the saved Safe_Position.
import { expect, expectCleanRun, test } from '../fixtures';

test('New Game saves; reload → Continue restores the progress', async ({ game, page }) => {
  await game.open();
  await page.getByRole('button', { name: '새로 시작' }).click();
  const started = await game.waitFor((s) => s.screens[0] === 'gameplay' && s.mainStage !== '', { timeout: 60_000, message: 'play did not start' });
  // The 'newGame' save is written at once; the save key holds a JSON envelope.
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('skyshard.') && k.includes('save')).length)).toBeGreaterThan(0);

  await page.reload();
  await game.waitFor((s) => s.screen === 'title', { timeout: 30_000 });
  await page.mouse.click(960, 540);
  const cont = page.getByRole('button', { name: '이어하기' });
  await expect(cont).toBeVisible();
  await expect(cont).not.toHaveAttribute('aria-disabled', 'true');
  await cont.click();
  const resumed = await game.waitFor((s) => s.screens[0] === 'gameplay', { timeout: 60_000, message: 'Continue did not enter the game' });
  expect(resumed.mainStage).toBe(started.mainStage);
  expect(resumed.objective?.objectiveId).toBe(started.objective?.objectiveId);
  expect(resumed.party.filter((p) => p.joined).map((p) => p.id)).toEqual(started.party.filter((p) => p.joined).map((p) => p.id));
  const d = Math.hypot(resumed.player.pos.x - started.player.pos.x, resumed.player.pos.z - started.player.pos.z);
  expect(d, 'restored near the saved Safe_Position').toBeLessThan(30);
  expectCleanRun(game.record);
});

test('Pause "Title로" returns to the Title with Continue enabled', async ({ game, page }) => {
  await game.open();
  await page.getByRole('button', { name: '새로 시작' }).click();
  await game.waitFor((s) => s.screens[0] === 'gameplay' && s.cinematic === null && s.dialogue === null, { timeout: 60_000 });
  await page.keyboard.press('Escape');
  await game.waitFor((s) => s.screen === 'pause');
  await page.getByRole('button', { name: 'Title로', exact: true }).click();
  await game.waitFor((s) => s.screens.length === 1 && s.screen === 'title');
  await expect(page.getByRole('button', { name: '이어하기' })).not.toHaveAttribute('aria-disabled', 'true');
  expectCleanRun(game.record);
});
