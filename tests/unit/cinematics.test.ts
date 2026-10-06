import { describe, expect, it } from 'vitest';
import {
  CINEMATIC_IDS, CINEMATIC_LIMITS, CINEMATIC_TITLES, CINEMATIC_TRIGGERS, CINEMATICS, staticAnchorOrigin, type CinematicAnchor,
} from '../../src/data/cinematics';
import { CHALLENGE_AREA_IDS, LANDMARK_IDS } from '../../src/data/ids';
import { TIME_OF_DAY_IDS } from '../../src/data/timeOfDay';

// Cinematic data (design "연출 데이터" 데이터 테스트, "연출 목록"; Req 4.2, 4.5–4.7, 5.4, 6.10, 6.11, 7.1, 9.4, 12.5,
// 21.9, 21.11, 22.3).

const EPS = 1e-9;
const defs = Object.values(CINEMATICS);
const limitOf = (id: string) => CINEMATIC_LIMITS.find((l) => id.startsWith(l.prefix));

describe('cinematic definitions', () => {
  it('lays every shot end to end from 0 to the duration, without gaps or overlaps', () => {
    for (const d of defs) {
      expect(d.shots.length, d.id).toBeGreaterThan(0);
      expect(d.shots[0]?.t0, d.id).toBe(0);
      for (let i = 0; i < d.shots.length; i++) {
        const s = d.shots[i];
        expect(s !== undefined && s.t1 > s.t0, `${d.id} shot ${i}`).toBe(true);
        const next = d.shots[i + 1];
        if (next !== undefined) expect(Math.abs(next.t0 - (s?.t1 ?? NaN)), `${d.id} shot ${i} → ${i + 1}`).toBeLessThan(EPS);
      }
      expect(Math.abs((d.shots[d.shots.length - 1]?.t1 ?? NaN) - d.duration), d.id).toBeLessThan(EPS);
    }
  });

  it('keeps events within the duration and in time order, with known title keys and sky presets', () => {
    for (const d of defs) {
      let last = -Infinity;
      for (const e of d.events) {
        expect(e.t >= 0 && e.t <= d.duration, `${d.id} ${e.kind}@${e.t}`).toBe(true);
        expect(e.t, d.id).toBeGreaterThanOrEqual(last);
        last = e.t;
        if (e.kind === 'title') expect(CINEMATIC_TITLES[e.data], `${d.id} title ${e.data}`).toBeDefined();
        if (e.kind === 'timeOfDay') expect(TIME_OF_DAY_IDS as readonly string[]).toContain(e.data);
        if (e.kind === 'music') expect(e.data).toMatch(/^mus_/);
      }
    }
  });

  it('is skippable (and letterboxed) exactly when longer than 3 s', () => {
    for (const d of defs) {
      expect(d.skippable, d.id).toBe(d.duration > 3);
      expect(d.letterbox, d.id).toBe(d.duration > 3);
    }
  });

  it('uses only the Req 21.9 id prefixes and each category’s length limit', () => {
    for (const d of defs) {
      const limit = limitOf(d.id);
      expect(limit, d.id).toBeDefined();
      expect(d.duration, d.id).toBeGreaterThanOrEqual(limit?.min ?? Infinity);
      expect(d.duration, d.id).toBeLessThanOrEqual(limit?.max ?? -Infinity);
    }
    expect(CINEMATICS.cin_ending?.duration).toBeGreaterThanOrEqual(20);
    expect(CINEMATICS.cin_ending?.duration).toBeLessThanOrEqual(45);
    expect(CINEMATICS.cin_boss_intro?.duration).toBeLessThanOrEqual(5);
    expect(CINEMATICS.cin_altar?.duration).toBeLessThanOrEqual(12);
  });

  it('defines the whole list: 8 Landmarks, 3 areas, 3 joins, 3 Skyshards, the altar, Caelith’s three and the ending', () => {
    const count = (prefix: string): number => CINEMATIC_IDS.filter((id) => id.startsWith(prefix)).length;
    expect([count('cin_landmark_'), count('cin_area_'), count('cin_join_'), count('cin_skyshard_')]).toEqual([8, 3, 3, 3]);
    for (const id of ['cin_altar', 'cin_boss_intro', 'cin_boss_phase2', 'cin_boss_phase3', 'cin_ending']) expect(CINEMATICS[id], id).toBeDefined();
    expect(new Set(CINEMATIC_IDS).size).toBe(CINEMATIC_IDS.length);
    // Every trigger resolves to a definition.
    for (const id of LANDMARK_IDS) expect(CINEMATICS[CINEMATIC_TRIGGERS.landmark(id)], id).toBeDefined();
    for (const id of CHALLENGE_AREA_IDS) expect(CINEMATICS[CINEMATIC_TRIGGERS.area(id, true) ?? ''], id).toBeDefined();
    expect(CINEMATIC_TRIGGERS.area('hollowroot', false)).toBeNull();
    expect(CINEMATIC_TRIGGERS.area('thistlewick', true)).toBeNull();
    expect(CINEMATIC_TRIGGERS.join('kairen')).toBeNull();
    for (const c of ['isla', 'wren', 'talus'] as const) expect(CINEMATICS[CINEMATIC_TRIGGERS.join(c) ?? ''], c).toBeDefined();
    for (const n of [1, 2, 3] as const) expect(CINEMATICS[CINEMATIC_TRIGGERS.skyshard(n)]).toBeDefined();
    for (const n of [2, 3] as const) expect(CINEMATICS[CINEMATIC_TRIGGERS.phase(n)]?.once).toBe('perFight');
    // Main-path control loss before the ending: at most the design's 92 s sum of upper bounds.
    const total = defs.filter((d) => d.id !== 'cin_ending').reduce((sum, d) => sum + d.duration, 0);
    expect(total).toBeLessThanOrEqual(92);
  });

  it('cuts Skyshards 1 and 2 to their Blight_Barrier breaking in the last 1.5 s, and moves the sky on every Skyshard', () => {
    for (const [index, gate] of [[1, 'gate_ember'], [2, 'gate_azure']] as const) {
      const d = CINEMATICS[`cin_skyshard_${index}`];
      if (d === undefined) throw new Error(`no cin_skyshard_${index}`);
      const last = d.shots[d.shots.length - 1];
      expect(last?.anchor).toBe(gate);
      expect(d.duration - (last?.t0 ?? 0)).toBeCloseTo(1.5, 9);
      const change = d.events.find((e) => e.kind === 'worldChange');
      expect(change?.data).toBe(gate);
      expect(change?.t ?? 0).toBeGreaterThanOrEqual(d.duration - 1.5);
    }
    for (const n of [1, 2, 3]) expect(CINEMATICS[`cin_skyshard_${n}`]?.events.some((e) => e.kind === 'timeOfDay'), `skyshard ${n}`).toBe(true);
    expect(CINEMATICS.cin_boss_phase3?.events[0]).toEqual({ t: 0, kind: 'timeOfDay', data: 'starNight' });
    expect(CINEMATICS.cin_altar?.events.map((e) => e.kind === 'worldChange' ? e.data : null).filter(Boolean).at(-1)).toBe('starlit_stair');
    expect(CINEMATICS.cin_ending?.events.some((e) => e.kind === 'timeOfDay' && e.data === 'sunrise')).toBe(true);
  });

  it('anchors to placement-table locations and Landmarks (static) or the followed entities', () => {
    for (const d of defs) {
      for (const s of d.shots) {
        for (const a of [s.anchor, s.face, s.lookAnchor].filter((x): x is CinematicAnchor => x !== undefined)) {
          if (a === 'player' || a === 'caelith') expect(staticAnchorOrigin(a)).toBeNull();
          else expect(staticAnchorOrigin(a), `${d.id} ${a}`).not.toBeNull();
        }
        for (const p of [s.from, s.to]) {
          expect([p.pos.x, p.pos.y, p.pos.z, p.look.x, p.look.y, p.look.z].every(Number.isFinite), d.id).toBe(true);
          expect(p.fov > 20 && p.fov < 90, d.id).toBe(true);
        }
      }
    }
    expect(staticAnchorOrigin('gate_ember')).toEqual({ x: 60, y: 20, z: 300 });
    expect(staticAnchorOrigin('lm_cinderspire')).toEqual({ x: 340, y: 6, z: 100 });
  });
});
