// System scenario: UI (task 24.3; Req 42.5, 31.x): Title → New Game → Pause, Inventory, Quest, codex, Settings, Map,
// each opening over the game with game time stopped and closing back to play; the Title's Credits.
import { expect, expectCleanRun, test } from '../fixtures';

test('Title menu, Credits and the New Game → Gameplay HUD', async ({ game, page }) => {
  await game.open();
  await expect(page.getByRole('button', { name: '새로 시작' })).toBeVisible();
  await expect(page.getByRole('button', { name: /이어하기/ })).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('button', { name: '크레딧' }).click();
  await game.waitFor((s) => s.screen === 'credits');
  await expect(page.getByText('사용 라이브러리')).toBeVisible();
  await page.keyboard.press('Escape');
  await game.waitFor((s) => s.screen === 'title');
  await page.getByRole('button', { name: '새로 시작' }).click();
  await game.waitFor((s) => s.screens[0] === 'gameplay', { timeout: 30_000 });
  expectCleanRun(game.record);
});

test('Pause stops game time and opens every menu screen', async ({ game, page }) => {
  await game.open();
  await page.getByRole('button', { name: '새로 시작' }).click();
  await game.waitFor((s) => s.screens[0] === 'gameplay' && s.cinematic === null && s.dialogue === null, { timeout: 60_000, message: 'play did not start' });
  await page.keyboard.press('Escape');
  const paused = await game.waitFor((s) => s.screen === 'pause', { message: 'Pause did not open' });
  expect(paused.pauseMode).toBe('menu');
  const tick = paused.tick;
  await page.waitForTimeout(500);
  expect((await game.snapshot()).tick).toBe(tick); // game time stands still under the menu

  for (const [label, id] of [['인벤토리/장비', 'inventory'], ['퀘스트', 'quest'], ['속성 반응 도감', 'codex'], ['설정', 'settings']] as const) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await game.waitFor((s) => s.screen === id, { message: `${id} did not open` });
    await page.keyboard.press('Escape');
    await game.waitFor((s) => s.screen === 'pause', { message: `${id} did not close back to Pause` });
  }
  await page.getByRole('button', { name: '지도', exact: true }).click();
  await game.waitFor((s) => s.screen === 'map', { message: 'Map did not open' });
  await page.keyboard.press('Escape');
  await game.waitFor((s) => s.screen === 'pause');
  await page.getByRole('button', { name: '계속', exact: true }).click();
  await game.waitFor((s) => s.screen === 'gameplay' && s.pauseMode !== 'menu', { message: 'play did not resume' });
  expectCleanRun(game.record);
});
