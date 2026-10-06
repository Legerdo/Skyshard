// System scenario: Music / SFX independence (task 24.3; Req 37.4): Settings' 음악 off → musicOn false and the music bus
// at 0 with the effects bus untouched; 효과음 off → the effects bus at 0 with the music bus untouched.
import { expect, expectCleanRun, test, type Game } from '../fixtures';

async function buses(game: Game): Promise<{ musicOn: boolean; musicBusGain: number; sfxBusGain: number }> {
  const s = await game.snapshot();
  const a = s.audio as { musicOn?: boolean; musicBusGain?: number; sfxBusGain?: number } | null;
  if (a === null || a.musicBusGain === undefined || a.sfxBusGain === undefined) throw new Error('no audio state in the snapshot');
  return { musicOn: a.musicOn ?? true, musicBusGain: a.musicBusGain, sfxBusGain: a.sfxBusGain };
}

test('Music and SFX switches move only their own bus', async ({ game, page }) => {
  await game.open();
  await page.getByRole('button', { name: '설정' }).click();
  await game.waitFor((s) => s.screen === 'settings');
  const before = await buses(game);
  expect(before.musicBusGain).toBeGreaterThan(0);
  expect(before.sfxBusGain).toBeGreaterThan(0);

  await page.getByRole('switch', { name: '음악' }).click();
  await expect.poll(async () => (await buses(game)).musicBusGain, { timeout: 5_000 }).toBeLessThan(1e-3);
  const musicOff = await buses(game);
  expect(musicOff.musicOn).toBe(false);
  expect(musicOff.sfxBusGain).toBeCloseTo(before.sfxBusGain, 3);

  await page.getByRole('switch', { name: '음악' }).click();
  await page.getByRole('switch', { name: '효과음' }).click();
  await expect.poll(async () => (await buses(game)).sfxBusGain, { timeout: 5_000 }).toBeLessThan(1e-3);
  await expect.poll(async () => (await buses(game)).musicBusGain, { timeout: 5_000 }).toBeCloseTo(before.musicBusGain, 2);
  expectCleanRun(game.record);
});
