// System scenario: combat (task 24.3; Req 42.5, 24.1–24.9, 20.x): the ms1 village raid (four level-1 Bramblekin in
// Hobb's field east of the New Game start, spawned by the first stage) fought with Kairen from normal play — the raid
// notices the party, a Bramblekin's hit costs HP, the Dodge (right button) spends Stamina, the Skill (E) starts its
// Cooldown, the Normal_Attack chain (left button) deals damage and defeats Bramblekin.
import { LOCATIONS } from '../../../src/data/worldLayout';
import { expect, expectCleanRun, test } from '../fixtures';
import {
  dodge, ENGAGED_STATES, EnemyTracker, fightUntil, PLAY_TRACE, snap, startNewGame, track, traceLine, turnTo, walkTo, yawTo,
  type PlaySnapshot,
} from './play';

test.use(PLAY_TRACE);

/** Centre of the ms1 raid group (src/data/spawns.ts village_raid; the onboarding anchor). */
const RAID = { x: -212.25, z: 304 };
const kairen = (s: PlaySnapshot) => s.party.find((p) => p.id === 'kairen')!;
const raidNear = (s: PlaySnapshot) => s.enemies.filter((e) => e.kind === 'bramblekin' && e.distance < 35);

test('village raid: take a hit, Dodge, Skill, attack and defeat Bramblekin', async ({ game, page }) => {
  test.setTimeout(300_000);
  const start = await startNewGame(game);
  expect(Math.hypot(start.player.pos.x - LOCATIONS.thistlewick.x, start.player.pos.z - LOCATIONS.thistlewick.z)).toBeLessThan(25);
  expect(raidNear(start).length, 'the raid stands east of the village entrance').toBeGreaterThanOrEqual(4);
  const tracker = new EnemyTracker();

  // Walk at the raid until it notices the party.
  const noticed = await walkTo(game, RAID, {
    radius: 6,
    stopWhen: (s) => s.inCombat || s.enemies.some((e) => e.distance < 14 && ENGAGED_STATES.has(e.state)),
  });
  await traceLine(game, 'noticed');
  expect(noticed.enemies.some((e) => ENGAGED_STATES.has(e.state)) || noticed.inCombat, 'the raid engages').toBe(true);

  // Damage taken: stand facing the nearest Bramblekin until one of their hits lands.
  const hit = await fightUntil(game, (s) => kairen(s).hp < kairen(s).maxHp, { swing: false, reach: 2.2, timeout: 20_000, tracker });
  const hpAfterHit = kairen(hit).hp;
  expect(hpAfterHit, 'a Bramblekin hit costs HP').toBeLessThan(kairen(hit).maxHp);
  expect(hpAfterHit).toBeGreaterThan(0);
  await traceLine(game, `hit ${hpAfterHit}`);

  // Dodge (Mouse2): the dodge mode and its 20 Stamina.
  // (A press while a hit staggers the character is dropped after its 0.15 s buffer, so try again.)
  let dodgedOk = false;
  for (let attempt = 0; attempt < 4 && !dodgedOk; attempt++) {
    const beforeDodge = await snap(game);
    await dodge(page);
    dodgedOk = await track(game, (s) => s.player.mode === 'dodge' || s.player.stamina <= beforeDodge.player.stamina - 15, {
      timeout: 1_500, everyMs: 15,
    }).then(() => true, () => false);
  }
  expect(dodgedOk, 'the Dodge (right button) happened').toBe(true);

  // Attack: the Normal_Attack chain (left button) damages a Bramblekin and defeats it.
  const byChain = await fightUntil(game, () => tracker.hurt.size >= 1 && tracker.defeated.size >= 1, { timeout: 60_000, tracker });
  expect(tracker.hurt.size, 'the Normal_Attack chain deals damage').toBeGreaterThanOrEqual(1);
  expect(tracker.defeated.size, 'a Bramblekin defeated by the chain').toBeGreaterThanOrEqual(1);
  expect(kairen(byChain).energy, 'hits charge the Burst Energy').toBeGreaterThan(0);
  await traceLine(game, `chain defeated=${tracker.defeated.size}`);

  // Skill (E) at the nearest remaining Bramblekin: the Cooldown starts.
  const close = await fightUntil(game, (s) => (s.enemies[0]?.distance ?? 0) < 5.5, { swing: false, reach: 3, timeout: 15_000, tracker });
  if (close.enemies[0] !== undefined) await turnTo(game, yawTo(close.player.pos, close.enemies[0].pos), 0.15);
  await page.keyboard.press('KeyE');
  const skill = await track(game, (s) => kairen(s).skillCooldown > 0, { timeout: 3_000, message: 'the Skill did not start its Cooldown' });
  expect(kairen(skill[skill.length - 1]!).skillCooldown).toBeGreaterThan(0);
  await traceLine(game, 'skill');

  // The rest of the raid.
  const done = await fightUntil(game, (s) => raidNear(s).length === 0, { timeout: 120_000, tracker });
  await traceLine(game, `raid beaten defeated=${tracker.defeated.size} hurt=${tracker.hurt.size}`);
  expect([...tracker.defeated.values()].every((k) => k === 'bramblekin')).toBe(true);
  expect(tracker.defeated.size, 'the raid is beaten').toBeGreaterThanOrEqual(4);
  expect(kairen(done).hp, 'Kairen still standing').toBeGreaterThan(0);
  expect(done.screens).not.toContain('defeat');
  test.info().annotations.push({ type: 'note', description: `defeated ${tracker.defeated.size} Bramblekin; Kairen ${kairen(done).hp}/${kairen(done).maxHp} HP` });
  expectCleanRun(game.record);
});
