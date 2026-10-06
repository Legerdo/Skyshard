// System scenario: party (task 24.3; Req 42.5, 22.x, 23.1–23.4): with every companion joined through the Debug_Tools
// "캐릭터 전원 합류", the number keys 1–4 switch the Active_Character (Kairen, Isla, Wren, Talus), each member keeps
// its own HP (a hit on the active one leaves the others untouched and survives a switch), every character's Skill
// (E) starts its own Cooldown, and every character's Normal_Attack (left button) lands on the ms1 raid's Bramblekin
// (the hit charges that character's Burst Energy).
import { NEW_GAME_START } from '../../../src/data/worldLayout';
import { expect, expectCleanRun, test } from '../fixtures';
import {
  debugButton, ENGAGED_STATES, EnemyTracker, fightUntil, pause, PLAY_TRACE, settle, snap, startNewGame, switchTo, track,
  traceLine, turnTo, walkTo, type PlaySnapshot,
} from './play';

test.use(PLAY_TRACE);

const PARTY = ['kairen', 'isla', 'wren', 'talus'] as const;
type Member = (typeof PARTY)[number];
const RAID = { x: -212.25, z: 304 }; // ms1 village_raid (src/data/spawns.ts)
const member = (s: PlaySnapshot, id: Member) => s.party.find((p) => p.id === id)!;
/** Stand-off distance per weapon: Isla's bow shoots from range, the others close in. */
const REACH: Readonly<Record<Member, number>> = { kairen: 1.8, isla: 7, wren: 2.2, talus: 1.8 };

test('keys 1–4 switch the Active_Character; HP per member; each Skill and Normal_Attack works', async ({ game, page }) => {
  test.setTimeout(300_000);
  await startNewGame(game, { debug: true });
  await debugButton(game, '캐릭터 전원 합류');
  const joined = await game.waitFor((s) => s.party.every((p) => p.joined), { timeout: 10_000, message: 'the companions did not join' }) as PlaySnapshot;
  await settle(game); // join cinematics, if any
  expect(joined.party.map((p) => p.id)).toEqual([...PARTY]);
  for (const p of joined.party) {
    expect(p.maxHp, `${p.id} max HP`).toBeGreaterThan(0);
    expect(p.hp, `${p.id} starts at full HP`).toBe(p.maxHp);
  }
  expect(new Set(joined.party.map((p) => p.maxHp)).size, 'each character has its own HP pool').toBeGreaterThan(1);

  // ── Skills at the village entrance (facing into the village, away from the raid): each starts its own Cooldown ──
  await turnTo(game, NEW_GAME_START.yaw);
  for (const id of PARTY) {
    const on = await switchTo(game, id);
    expect(on.party.filter((p) => p.active).map((p) => p.id), `only ${id} is active`).toEqual([id]);
    await pause(page, 300);
    await page.keyboard.press('KeyE');
    const cast = await track(game, (s) => member(s, id).skillCooldown > 0, { timeout: 3_000, message: `${id}'s Skill did not start its Cooldown` });
    expect(member(cast[cast.length - 1]!, id).skillCooldown, `${id} Skill Cooldown`).toBeGreaterThan(0);
    await settle(game, { quietMs: 400 });
    await traceLine(game, `skill ${id}`);
  }

  // ── HP per member: Kairen takes a raid hit; the others keep full HP, and the loss stays Kairen's across a switch ──
  await switchTo(game, 'kairen');
  const tracker = new EnemyTracker();
  await walkTo(game, RAID, { radius: 6, stopWhen: (s) => s.enemies.some((e) => e.distance < 14 && ENGAGED_STATES.has(e.state)) });
  const hurt = await fightUntil(game, (s) => member(s, 'kairen').hp < member(s, 'kairen').maxHp, { swing: false, reach: 2.2, timeout: 20_000, tracker });
  const kairenHp = member(hurt, 'kairen').hp;
  for (const id of PARTY.slice(1)) expect(member(hurt, id).hp, `${id} is untouched by Kairen's hit`).toBe(member(hurt, id).maxHp);
  const toIsla = await switchTo(game, 'isla');
  expect(member(toIsla, 'kairen').hp, "Kairen's HP stays with Kairen after the switch").toBeLessThanOrEqual(kairenHp);
  expect(member(toIsla, 'kairen').hp).toBeGreaterThan(0);
  expect(member(toIsla, 'isla').hp, 'Isla comes in at her own full HP').toBe(member(toIsla, 'isla').maxHp);
  await traceLine(game, `hp kairen ${kairenHp}`);

  // ── Each character's Normal_Attack lands (their Burst Energy rises from the hit) ──
  for (const id of ['isla', 'wren', 'talus', 'kairen'] as const) {
    const on = await switchTo(game, id);
    const energy = member(on, id).energy;
    const landed = await fightUntil(game, (s) => member(s, id).energy > energy, { reach: REACH[id], timeout: 30_000, tracker });
    expect(member(landed, id).energy, `${id}'s Normal_Attack hit (Energy)`).toBeGreaterThan(energy);
    await traceLine(game, `attack ${id} energy ${member(landed, id).energy.toFixed(1)}`);
  }
  expect(tracker.hurt.size + tracker.defeated.size, 'the hits damaged Bramblekin').toBeGreaterThanOrEqual(1);

  const end = await snap(game);
  expect(end.party.every((p) => p.hp > 0 && !p.downed), 'nobody Downed').toBe(true);
  expect(end.screens).not.toContain('defeat');
  expectCleanRun(game.record);
});
