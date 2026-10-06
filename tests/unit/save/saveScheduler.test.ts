import { describe, expect, it } from 'vitest';
import type { SaveReason } from '../../../src/core/gameEvents';
import { PERIODIC_SAVE_SEC, SaveScheduler } from '../../../src/save/saveScheduler';

// SaveScheduler timing with a fake clock (task 15.6, Req 36.3–36.5).

const DT = 1 / 60;
function harness() {
  const writes: { at: number; reason: SaveReason }[] = [];
  let t = 0;
  const s = new SaveScheduler((reason) => writes.push({ at: t, reason }));
  const run = (seconds: number, ctx = { inCombat: false, cinematic: false, menu: false }): void => {
    const end = t + seconds;
    while (t < end - 1e-9) {
      t += DT;
      s.update(DT, ctx);
    }
  };
  return { s, writes, run, now: () => t };
}

describe('SaveScheduler', () => {
  it('one request is written after 0.5 s of quiet', () => {
    const h = harness();
    h.s.request('chest');
    h.run(0.4);
    expect(h.writes).toHaveLength(0);
    h.run(0.2);
    expect(h.writes).toEqual([{ at: expect.closeTo(0.5, 1), reason: 'chest' }]);
  });

  it('a steady stream of requests is merged and still written within 2 s of the first', () => {
    const h = harness();
    for (let i = 0; i < 10; i++) {
      h.s.request(i === 0 ? 'objective' : 'stage');
      h.run(0.3);
    }
    expect(h.writes.length).toBeGreaterThanOrEqual(1);
    expect(h.writes[0].at).toBeLessThanOrEqual(1.5 + DT);
    expect(h.writes[0].reason).toBe('objective');
  });

  it('requests In_Combat or in a cinematic wait, and are written within 2 s after both end', () => {
    const h = harness();
    h.run(1, { inCombat: true, cinematic: false, menu: false });
    h.s.request('skyshard');
    h.run(5, { inCombat: true, cinematic: false, menu: false });
    h.run(1, { inCombat: false, cinematic: true, menu: false });
    expect(h.writes).toHaveLength(0);
    const endedAt = h.now();
    h.run(2);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].at - endedAt).toBeLessThanOrEqual(2);
  });

  it('writes periodically every 90 s of gameplay, not counting combat, cinematics or menus', () => {
    const h = harness();
    h.run(60);
    h.run(30, { inCombat: true, cinematic: false, menu: false });
    h.run(20, { inCombat: false, cinematic: false, menu: true });
    expect(h.writes).toHaveLength(0);
    h.run(31);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].reason).toBe('periodic');
    // A Milestone write restarts the 90 s count.
    h.run(PERIODIC_SAVE_SEC - 10);
    h.s.request('waystone');
    h.run(1);
    expect(h.writes.at(-1)?.reason).toBe('waystone');
    h.run(PERIODIC_SAVE_SEC - 5);
    expect(h.writes.filter((w) => w.reason === 'periodic')).toHaveLength(1);
  });

  it('debounce runs in real time under a menu (game time stopped)', () => {
    const h = harness();
    h.s.request('equipment');
    h.run(0.6, { inCombat: false, cinematic: false, menu: true });
    expect(h.writes.map((w) => w.reason)).toEqual(['equipment']);
  });

  it('clear drops waiting requests', () => {
    const h = harness();
    h.s.request('chest');
    h.s.clear();
    h.run(2);
    expect(h.writes).toHaveLength(0);
  });
});
