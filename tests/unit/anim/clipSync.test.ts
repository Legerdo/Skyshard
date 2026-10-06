import { describe, expect, it } from 'vitest';
import { HERO_COMMON_CLIPS, NPC_ANIM_CLIPS, strikeStart, type EnemyClipSet } from '../../../src/anim/animState';
import { BLEND_RANGE, BLEND_TIMES, blendTime } from '../../../src/anim/blendTimes';
import type { PoseClip } from '../../../src/anim/clip';
import {
  CAELITH_ATTACK_CLIPS, CAELITH_CLIP_LIST, CHARACTER_CLIPS, CLIP_LIBRARY, COMMON_CLIPS, ENEMY_CLIP_SETS, NPC_CLIPS,
} from '../../../src/anim/clips';
import { BOSS_ATTACKS, CAELITH_ACTIONS, CAELITH_ATTACKS, MIN_TELEGRAPH } from '../../../src/data/boss';
import { CHARACTERS } from '../../../src/data/characters';
import type { AttackDef } from '../../../src/data/combatTypes';
import { ELITE_DEFS, ENEMY_DEFS, type EnemyAttackDef } from '../../../src/data/enemies';
import { CHARACTER_IDS } from '../../../src/data/ids';
import { NPC_PLACEMENTS } from '../../../src/data/village';

// Task 19.4 `clipSync` (design "타이밍 동기화", Req 24.1, 22.6, 26.5): every AttackDef / BossAttackDef timeline refers
// to clips that exist, each judgement has a `hit` marker within ±1 tick and no marker lacks a judgement, the timeline
// length is the attack's duration, and every windup lasts at least its Telegraph. Plus BLEND_TIMES (Req 39.8).

const TICK = 1 / 60;
const hitsOf = (clip: PoseClip): number[] => clip.events.filter((e) => e.kind === 'hit').map((e) => e.t);

/** Timeline hit times match the judgement times one-to-one within a tick. */
function expectHitsMatch(timeline: number[], judged: readonly number[], what: string): void {
  expect(timeline.length, `${what}: hit markers`).toBe(judged.length);
  const sorted = [...timeline].sort((a, b) => a - b);
  judged.forEach((t, i) => expect(Math.abs(sorted[i]! - t), `${what}: hit ${i} at ${sorted[i]} vs ${t}`).toBeLessThanOrEqual(TICK + 1e-9));
}

describe('clipSync: Player_Character attacks', () => {
  const attacksOf = (id: (typeof CHARACTER_IDS)[number]): AttackDef[] => {
    const c = CHARACTERS[id];
    return [...c.normal, c.charged, c.skill.attack, c.burst.attack];
  };

  it('plays one AttackDef clip from start to duration with its hit markers on the judgement times', () => {
    for (const id of CHARACTER_IDS) {
      for (const def of attacksOf(id)) {
        const clip = CHARACTER_CLIPS[id].find((c) => c.name === def.clip);
        expect(clip, `${def.id}: clip ${def.clip}`).toBeDefined();
        if (clip === undefined) continue;
        expect(Math.abs(clip.duration - def.duration), `${def.id}: timeline length`).toBeLessThanOrEqual(TICK);
        expectHitsMatch(hitsOf(clip), def.hits.map((h) => h.t), def.id);
        expect(clip.loop).toBe(false);
      }
    }
    // The design's example: kairen_n1–n4 hit at 0.18 · 0.20 · 0.22 · 0.30 s.
    expect(['kairen_n1', 'kairen_n2', 'kairen_n3', 'kairen_n4'].map((n) => hitsOf(CLIP_LIBRARY.get(n)!)[0])).toEqual([0.18, 0.2, 0.22, 0.3]);
  });

  it('never shares attack, Skill or Burst clips between characters, each calling its Element VFX', () => {
    const names = CHARACTER_IDS.flatMap((id) => CHARACTER_CLIPS[id].map((c) => c.name));
    expect(new Set(names).size).toBe(names.length);
    for (const id of CHARACTER_IDS) {
      for (const clip of CHARACTER_CLIPS[id]) {
        expect(clip.name.startsWith(`${id}_`), clip.name).toBe(true);
        expect(clip.events.some((e) => e.kind === 'vfx'), `${clip.name} vfx`).toBe(true);
      }
    }
  });

  it('opens every Burst with a cut-in of at most 1.0 s before its first hit', () => {
    for (const id of CHARACTER_IDS) {
      const burst = CHARACTERS[id].burst;
      const clip = CLIP_LIBRARY.get(burst.attack.clip)!;
      expect(burst.cutIn).toBeLessThanOrEqual(1.0);
      expect(Math.min(...hitsOf(clip))).toBeGreaterThanOrEqual(burst.cutIn);
      expect(clip.events.find((e) => e.kind === 'vfx')?.t).toBe(0);
    }
  });

  it('provides the 20 shared hero clips, the climb four directions among them', () => {
    expect(COMMON_CLIPS.map((c) => c.name)).toEqual([...HERO_COMMON_CLIPS]);
    for (const n of ['climbUp', 'climbDown', 'climbLeft', 'climbRight']) expect(CLIP_LIBRARY.get(n)?.rootMotion?.forward).toBeGreaterThan(0);
  });
});

describe('clipSync: enemies, Elites and drones', () => {
  function checkPair(def: EnemyAttackDef, set: EnemyClipSet, clips: readonly PoseClip[], owner: string): void {
    const pair = set.attacks[def.clip];
    expect(pair, `${owner} ${def.id}: pair for ${def.clip}`).toBeDefined();
    if (pair === undefined) return;
    const windup = clips.find((c) => c.name === pair.windup);
    const strike = clips.find((c) => c.name === pair.strike);
    expect(windup, `${def.id} windup`).toBeDefined();
    expect(strike?.name, `${def.id} strike`).toBe(def.clip);
    if (windup === undefined || strike === undefined) return;
    const first = def.hits[0]!.t;
    // Windup ≥ Telegraph (the first judgement and the telegraph duration).
    expect(windup.duration, `${def.id} windup vs Telegraph`).toBeGreaterThanOrEqual(Math.max(first, def.telegraph.duration) - 1e-9);
    expect(hitsOf(windup)).toEqual([]);
    // Lead: the strike's first hit, at least 0.1 s (the windup → strike blend is over first).
    expect(pair.lead).toBeGreaterThanOrEqual(0.1);
    expect(hitsOf(strike)[0]).toBeCloseTo(pair.lead, 9);
    const start = strikeStart(first, pair);
    expectHitsMatch(hitsOf(strike).map((t) => start + t), def.hits.map((h) => h.t), def.id);
    expect(Math.abs(start + strike.duration - def.duration), `${def.id}: timeline length`).toBeLessThanOrEqual(TICK);
  }

  it('gives every kind idle, move, windup · strike per attack, hurt, stagger and defeat, synced with its AttackDefs', () => {
    for (const [id, def] of Object.entries(ENEMY_DEFS)) {
      const entry = ENEMY_CLIP_SETS[id as keyof typeof ENEMY_CLIP_SETS];
      expect(entry, id).toBeDefined();
      const names = new Set(entry.clips.map((c) => c.name));
      for (const k of ['idle', 'move', 'hurt', 'stagger', 'defeat'] as const) expect(names.has(entry.set[k]), `${id} ${k}`).toBe(true);
      expect(Object.keys(entry.set.attacks).sort(), `${id} attack pairs`).toEqual(def.attacks.map((a) => a.clip).sort());
      for (const atk of def.attacks) checkPair(atk, entry.set, entry.clips, id);
    }
    const drone = ELITE_DEFS.sentinelPrime.drones!;
    checkPair(drone.attack, ENEMY_CLIP_SETS.sentinelPrime_drone.set, ENEMY_CLIP_SETS.sentinelPrime_drone.clips, 'drone');
  });

  it('lets Elites reuse their base kind clips (plus their own pairs); rootboundWarden has its own set', () => {
    expect(ENEMY_CLIP_SETS.oldMossback.set.idle).toBe(ENEMY_CLIP_SETS.mossbackBrute.set.idle);
    expect(ENEMY_CLIP_SETS.emberjaw.set.move).toBe('cinderHound_move');
    expect(ENEMY_CLIP_SETS.rootboundWarden.set.idle).toBe('rootboundWarden_idle');
    for (const kind of ['bramblekin', 'thornspitter', 'cinderHound', 'slagshell', 'ashWisp', 'windcutter'] as const) {
      expect(ENEMY_CLIP_SETS[kind].clips).toHaveLength(7);
    }
    expect(ENEMY_CLIP_SETS.aetherSentinel.clips).toHaveLength(9); // two attacks: a pair each
  });
});

describe('clipSync: Caelith', () => {
  it('pairs a windup and a strike per attack, hits on each damaging judgement, timeline = activeEnd + recovery', () => {
    for (const a of CAELITH_ATTACKS) {
      const timing = CAELITH_ATTACK_CLIPS[a];
      const windup = CLIP_LIBRARY.get(timing.windup);
      const strike = CLIP_LIBRARY.get(timing.strike);
      expect(windup, a).toBeDefined();
      expect(strike, a).toBeDefined();
      if (windup === undefined || strike === undefined) continue;
      const def = BOSS_ATTACKS[a];
      const action = CAELITH_ACTIONS[a];
      expect(windup.duration, `${a} windup ≥ Telegraph`).toBeGreaterThanOrEqual(def.telegraph[0]! - 1e-9);
      if (def.strength !== null) expect(def.telegraph[0]).toBeGreaterThanOrEqual(MIN_TELEGRAPH[def.strength]);
      const lead = action.judgements[0]!.at - timing.strikeStart;
      expect(lead, `${a} lead`).toBeGreaterThanOrEqual(0.1);
      const damaging = action.judgements.filter((_, i) => (def.dmgMul[i] ?? 0) > 0).map((j) => j.at);
      expectHitsMatch(hitsOf(strike).map((t) => timing.strikeStart + t), damaging, a);
      expect(Math.abs(timing.strikeStart + strike.duration - (action.activeEnd + action.recovery)), `${a} timeline`).toBeLessThanOrEqual(TICK);
      expect(timing.activeEnd).toBe(action.activeEnd);
    }
  });

  it('has idle, move, both phase shifts, stagger, disabled and death', () => {
    const names = new Set(CAELITH_CLIP_LIST.map((c) => c.name));
    for (const n of ['caelith_idle', 'caelith_move', 'caelith_phaseShift_p2', 'caelith_phaseShift_final', 'caelith_stagger', 'caelith_disabled', 'caelith_death']) {
      expect(names.has(n), n).toBe(true);
    }
    expect(CAELITH_CLIP_LIST).toHaveLength(2 + 16 + 5);
  });
});

describe('NPC clips (Req 14.9)', () => {
  it('plays idle and at least one of work / walk / lookAround for every NPC, every NpcSystem animation having a clip', () => {
    const names = new Set(NPC_CLIPS.map((c) => c.name));
    for (const clip of Object.values(NPC_ANIM_CLIPS)) expect(names.has(clip), clip).toBe(true);
    expect(names.has('npc_idle')).toBe(true);
    for (const p of NPC_PLACEMENTS) {
      const ambient = NPC_ANIM_CLIPS[p.ambient.anim];
      expect(/^npc_(work_|walk|run|lookAround)/.test(ambient), `${p.id}: ${ambient}`).toBe(true);
    }
  });
});

describe('BLEND_TIMES (Req 39.8)', () => {
  it('keeps every crossfade within 0.1–0.25 s', () => {
    for (const [k, v] of Object.entries(BLEND_TIMES)) {
      expect(v, k).toBeGreaterThanOrEqual(BLEND_RANGE.min);
      expect(v, k).toBeLessThanOrEqual(BLEND_RANGE.max);
    }
    const names = [null, ...CLIP_LIBRARY.keys(), 'locomotion', 'climb'];
    for (const a of names) {
      for (const b of ['idle', 'dodge', 'glide', 'swim', 'kairen_n2', 'hurt', 'bramblekin_claw', null]) {
        const t = blendTime(a, b);
        expect(t).toBeGreaterThanOrEqual(0.1);
        expect(t).toBeLessThanOrEqual(0.25);
      }
    }
    expect(blendTime('kairen_n1', 'kairen_n2')).toBe(0.1);
    expect(blendTime('grounded', 'dodge')).toBe(0.1);
    expect(blendTime('bramblekin_claw_windup', 'bramblekin_claw')).toBe(0.1);
    expect(blendTime('fall', 'glide')).toBe(0.25);
    expect(blendTime('locomotion', 'swim')).toBe(0.25);
    expect(blendTime('idle', 'jump')).toBe(0.15);
  });
});
