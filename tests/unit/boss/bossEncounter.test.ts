import { describe, expect, it } from 'vitest';
import { CAELITH, MIN_TELEGRAPH, STARSHELL } from '../../../src/data/boss';
import { phaseFloorHp } from '../../../src/logic/boss';
import { DT, partyHit, setupEncounter } from './bossHarness';

// BossEncounter behaviour (tasks 10.2–10.8, Req 6.1–6.14).

const runFor = (tick: () => void, seconds: number): void => {
  for (let t = 0; t < seconds; t += DT) tick();
};

describe('BossEncounter', () => {
  it('HP stops at the 65 % floor, the overflow is lost, and a 3 s transition with both sides immune follows', () => {
    const { boss, events, tick } = setupEncounter();
    runFor(tick, 0.5);
    boss.applyHit(partyHit(CAELITH.maxHp)); // one huge hit
    const floor = phaseFloorHp(CAELITH.maxHp, 1);
    expect(boss.hp).toBe(floor);
    // The transition starts at once or right after a playing attack.
    for (let i = 0; i < 600 && boss.state !== 'transition'; i++) tick();
    expect(boss.state).toBe('transition');
    tick(); // EventDispatch delivers it
    expect(events.some((e) => e.type === 'boss:phaseChanged')).toBe(true);
    boss.applyHit(partyHit(5000));
    expect(boss.hp).toBe(floor);
    expect(boss.snapshot().telegraphs).toEqual([]);
    runFor(tick, CAELITH.transitionSeconds + 0.1);
    expect(boss.phase).toBe(2);
    expect(boss.state).not.toBe('transition');
  });

  it('Phase 2 raises a 1,200 Starshell that absorbs damage; breaking it disables Caelith for 6 s at ×1.5', () => {
    const { boss, tick } = setupEncounter(11, 2);
    runFor(tick, 0.2);
    const shell = boss.snapshot().starshell;
    expect(shell?.max).toBe(STARSHELL.durability.p2);
    const hp = boss.hp;
    boss.applyHit(partyHit(500));
    expect(boss.hp).toBe(hp);
    expect(boss.snapshot().starshell?.durability).toBe(700);
    boss.applyHit(partyHit(700));
    for (let i = 0; i < 600 && boss.state !== 'disabled'; i++) tick();
    expect(boss.state).toBe('disabled');
    expect(boss.snapshot().vulnerable).toBe(true);
    runFor(tick, STARSHELL.disabledSeconds + 0.1);
    const regrown = boss.snapshot().starshell;
    expect(regrown?.durability).toBe(regrown?.max);
  });

  it('the Starshell changes Element every 12 s, never to the same one', () => {
    const { boss, tick } = setupEncounter(12, 2);
    runFor(tick, 0.1);
    let last = boss.snapshot().starshell?.element;
    let changes = 0;
    for (let t = 0; t < 40; t += DT) {
      tick();
      const now = boss.snapshot().starshell?.element;
      if (now !== undefined && last !== undefined && now !== last) {
        changes++;
        expect(now).not.toBe(last);
      }
      if (now !== undefined) last = now;
    }
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  it('begin(fromPhase) restarts at 100 / 65 / 30 % HP; the Final Phase has the starlit sky and its music', () => {
    for (const [phase, ratio] of [[1, 1], [2, 0.65], [3, 0.3]] as const) {
      const { boss } = setupEncounter(1, phase);
      expect(boss.hp).toBe(Math.floor(CAELITH.maxHp * ratio));
      const snap = boss.snapshot();
      expect(snap.music).toBe(`mus_boss_p${phase}`);
      expect(snap.skyPreset).toBe(phase === 3 ? 'starNight' : 'dusk');
      if (phase >= 2) expect(snap.crystals).toEqual([]); // removed; the first action re-summons them
    }
  });

  it('every Telegraph shown lasts at least 0.4 s (0.8 s for strong attacks) and is never moved', () => {
    const { boss, tick } = setupEncounter(21, 3);
    const seen = new Map<number, { center: string; duration: number }>();
    for (let t = 0; t < 90; t += DT) {
      tick();
      for (const tg of boss.telegraphs()) {
        expect(tg.duration).toBeGreaterThanOrEqual((tg.strong ? MIN_TELEGRAPH.strong : MIN_TELEGRAPH.normal) - 1e-9);
        const key = JSON.stringify(tg.center);
        const prev = seen.get(tg.id);
        if (prev !== undefined) expect(key).toBe(prev.center);
        else seen.set(tg.id, { center: key, duration: tg.duration });
      }
    }
    expect(seen.size).toBeGreaterThan(10);
  });

  it('Astral Sweep: jumping above 0.8 m or Dodge i-frames pass the ring; standing still is hit', () => {
    const standing = setupEncounter(31, 3);
    runFor(standing.tick, 45);
    const sweepHits = standing.dummy.hits.filter((h) => h.attackId === 'atk_caelith_astralSweep');
    expect(sweepHits.length).toBeGreaterThan(0);

    const dodging = setupEncounter(31, 3);
    for (let t = 0; t < 45; t += DT) {
      dodging.dummy.iFrames = dodging.boss.snapshot().ring !== null;
      dodging.tick();
    }
    expect(dodging.dummy.hits.filter((h) => h.attackId === 'atk_caelith_astralSweep')).toEqual([]);
  });

  it('HP 0 in the Final Phase: dead, hazards cleared, then boss:defeated and the defeat recorded', () => {
    const { boss, events, record, tick } = setupEncounter(41, 3);
    runFor(tick, 0.2);
    // Break the Starshell, then finish the HP during `disabled`.
    boss.applyHit(partyHit(STARSHELL.durability.final));
    for (let i = 0; i < 600 && boss.state !== 'disabled'; i++) tick();
    boss.applyHit(partyHit(CAELITH.maxHp));
    expect(boss.state).toBe('dead');
    expect(boss.snapshot().telegraphs).toEqual([]);
    tick();
    expect(events.some((e) => e.type === 'boss:defeated')).toBe(true);
    expect(record.defeated).toBe(true);
  });

  it('halt() stops the fight on a Party_Wipe; begin() at the current Phase resumes it', () => {
    const { boss, tick } = setupEncounter(51, 2);
    runFor(tick, 3);
    boss.halt();
    expect(boss.halted).toBe(true);
    const t = boss.time;
    runFor(tick, 2);
    expect(boss.time).toBe(t);
    boss.begin(2);
    expect(boss.halted).toBe(false);
    expect(boss.hp).toBe(Math.floor(CAELITH.maxHp * 0.65));
  });
});
