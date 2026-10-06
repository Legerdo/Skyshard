import { describe, expect, it } from 'vitest';
import { CHARACTERS } from '../../src/data/characters';
import { cinematicDef, CINEMATIC_TRIGGERS } from '../../src/data/cinematics';
import { DIALOGUES } from '../../src/data/dialogue';
import { ENEMY_DEFS } from '../../src/data/enemies';
import {
  joinCinematicId, ONBOARDING_CONTROLS, ONBOARDING_HINTS, ONBOARDING_LIMIT_SECONDS, ONBOARDING_ROUTE, travelSeconds,
  VILLAGE_RAID_CENTER, type OnboardingControl, type OnboardingStep,
} from '../../src/data/onboarding';
import { MAIN_QUEST } from '../../src/data/quests';
import { REACTION_DEFS } from '../../src/data/reactions';
import { ENCOUNTER_GROUPS, SPAWNERS } from '../../src/data/spawns';
import { FIRST_TEN_MINUTE_HINTS, TUTORIAL_ANCHORS, tutorialHint, type TutorialHintDef } from '../../src/data/tutorials';
import { PLAZA_STEP, VILLAGE_BUILDINGS } from '../../src/data/village';
import { AREA_VOLUMES } from '../../src/data/volumes';
import { JUMP_APEX_HEIGHT, STEP_UP_HEIGHT } from '../../src/player/core/constants';

// Task 21.4 (design "첫 10분 온보딩 흐름"; Req 34.2, 34.6, 22.2, 22.3): the first-10-minute path, its time budget and
// the Tutorial_Hint at each control's first need.

/** Arrival and leave times (s) of every step at Normal_Play pace; a join adds its cinematic. */
function timeline(): { step: OnboardingStep; arrive: number; leave: number }[] {
  const out: { step: OnboardingStep; arrive: number; leave: number }[] = [];
  let t = 0;
  ONBOARDING_ROUTE.forEach((step, i) => {
    const prev = ONBOARDING_ROUTE[i - 1] ?? step;
    const arrive = t + travelSeconds(prev, step);
    const join = step.joins === undefined ? 0 : (cinematicDef(joinCinematicId(step.joins))?.duration ?? Number.NaN);
    t = arrive + step.dwell + join;
    out.push({ step, arrive, leave: t });
  });
  return out;
}

/** Where each control is first needed and when. */
function firstNeeds(): Map<OnboardingControl, { step: OnboardingStep; arrive: number; index: number }> {
  const needs = new Map<OnboardingControl, { step: OnboardingStep; arrive: number; index: number }>();
  timeline().forEach(({ step, arrive }, index) => {
    for (const c of step.needs) if (!needs.has(c)) needs.set(c, { step, arrive, index });
  });
  return needs;
}

const hint = (id: string): TutorialHintDef => {
  const h = tutorialHint(id);
  if (h === null) throw new Error(`no hint ${id}`);
  return h;
};

describe('first-10-minute path (Req 34.2)', () => {
  it('needs every control of Req 34.2, each within 10 minutes at Normal_Play pace', () => {
    const needs = firstNeeds();
    expect([...needs.keys()].sort()).toEqual([...ONBOARDING_CONTROLS].sort());
    for (const control of ONBOARDING_CONTROLS) {
      const need = needs.get(control);
      expect(need, control).toBeDefined();
      expect(need?.arrive, `${control} at ${need?.step.id}`).toBeLessThanOrEqual(ONBOARDING_LIMIT_SECONDS);
    }
    const end = timeline().at(-1);
    expect(end?.leave).toBeLessThan(ONBOARDING_LIMIT_SECONDS); // the glide starts inside the first 10 minutes
    // Order of first needs follows the design's hint list.
    const order = [...needs.entries()].sort((a, b) => a[1].index - b[1].index || ONBOARDING_CONTROLS.indexOf(a[0]) - ONBOARDING_CONTROLS.indexOf(b[0]));
    expect(order.map(([c]) => ONBOARDING_HINTS[c])).toEqual([...FIRST_TEN_MINUTE_HINTS]);
  });

  it('follows the Main_Quest objectives in order (ms1, then ms2 up to Wren)', () => {
    const ids = MAIN_QUEST.stages.slice(0, 2).flatMap((s) => s.objectives.map((o) => o.id));
    const onRoute = ONBOARDING_ROUTE.flatMap((s) => (s.objective === undefined ? [] : [s.objective]));
    expect(onRoute).toEqual(ids.filter((id) => onRoute.includes(id)));
    expect(onRoute).toEqual(['ms1_maren', 'ms1_isla', 'ms1_raid', 'ms1_report', 'ms2_breezewatch', 'ms2_wren']);
  });
});

describe('the Tutorial_Hint at each first need', () => {
  const needs = firstNeeds();
  const at = (c: OnboardingControl) => needs.get(c) as { step: OnboardingStep; arrive: number; index: number };

  it('move and camera: the start hints show within seconds of play', () => {
    for (const c of ['move', 'camera'] as const) {
      const trigger = hint(ONBOARDING_HINTS[c]).trigger;
      expect(trigger.kind, c).toBe('start');
      if (trigger.kind === 'start') expect(trigger.delay).toBeLessThanOrEqual(at(c).arrive + 3);
    }
  });

  it('jump: the plaza step ledge stands at the hint point, too high to step onto and low enough to jump', () => {
    const trigger = hint('tut_jump').trigger;
    expect(trigger).toMatchObject({ kind: 'near', targetId: 'plaza_step' });
    const step = at('jump').step;
    const anchor = TUTORIAL_ANCHORS.plaza_step;
    const radius = trigger.kind === 'near' ? trigger.radius : 0;
    expect(Math.hypot(step.at.x - anchor.x, step.at.z - anchor.z)).toBeLessThanOrEqual(radius);
    const ledge = VILLAGE_BUILDINGS.find((b) => b.id === 'plaza_step');
    expect(ledge).toMatchObject({ kind: 'step', center: { x: anchor.x, z: anchor.z } });
    expect(PLAZA_STEP.height).toBeGreaterThan(STEP_UP_HEIGHT);
    expect(PLAZA_STEP.height).toBeLessThan(JUMP_APEX_HEIGHT);
  });

  it('switch: Isla joins at the watchtower just before the raid (join cinematic, then the switch hint)', () => {
    const joinIndex = ONBOARDING_ROUTE.findIndex((s) => s.joins === 'isla');
    expect(joinIndex).toBeGreaterThanOrEqual(0);
    expect(joinIndex).toBe(at('switch').index - 1); // the hint shows on joining, the raid next needs the switch
    expect(ONBOARDING_ROUTE[joinIndex].at).toEqual(ONBOARDING_ROUTE.find((s) => s.objective === 'ms1_isla')?.at);
    expect(DIALOGUES.some((d) => d.npc === 'isla' && (d.onEnd ?? []).some((e) => e.kind === 'joinParty' && e.character === 'isla'))).toBe(true);
    expect(CINEMATIC_TRIGGERS.join('isla')).toBe('cin_join_isla');
    expect(cinematicDef('cin_join_isla')).not.toBeNull();
    expect(hint('tut_switch').trigger).toMatchObject({ kind: 'event', event: 'party:joined' });
  });

  it('attack, dodge, skill and reaction: the village_raid fight right after Isla joins asks for a steam burst', () => {
    for (const c of ['attack', 'dodge', 'switch', 'skill', 'reaction'] as const) expect(at(c).step.fight, c).toBe('village_raid');
    // Isla is in the party for the fight (Req 34.6).
    expect(at('attack').index).toBeGreaterThan(ONBOARDING_ROUTE.findIndex((s) => s.joins === 'isla'));
    // ms1's onStart places the raid; its members stand around the route's fight point and they telegraph (Dodge).
    expect(MAIN_QUEST.stages[0].onStart).toContainEqual({ kind: 'spawnGroup', groupId: 'village_raid' });
    expect(ENCOUNTER_GROUPS.some((g) => g.id === 'village_raid')).toBe(true);
    const members = SPAWNERS.filter((s) => s.campId === 'village_raid');
    expect(members.length).toBeGreaterThanOrEqual(3);
    for (const m of members) expect(Math.hypot(m.pos.x - VILLAGE_RAID_CENTER.x, m.pos.z - VILLAGE_RAID_CENTER.z)).toBeLessThan(10);
    expect(ENEMY_DEFS.bramblekin.attacks.some((a) => a.telegraph !== undefined && a.telegraph !== null)).toBe(true);
    // Kairen's Skill leaves Ember; Isla's Tide on it is the steam burst.
    expect([CHARACTERS.kairen.element, CHARACTERS.isla.element]).toEqual(['ember', 'tide']);
    expect(REACTION_DEFS.steamBurst.pair).toEqual(['ember', 'tide']);
    expect(hint('tut_attack').trigger).toMatchObject({ kind: 'event', event: 'enemy:alerted' });
    expect(hint('tut_skill').trigger).toMatchObject({ kind: 'event', event: 'enemy:alerted' });
    expect(hint('tut_dodge').trigger.kind).toBe('signal');
    expect(hint('tut_reaction').trigger.kind).toBe('signal');
    expect(hint('tut_reaction').text).toContain('증기 폭발');
  });

  it('climb: the cliff foot lies inside the breezewatch_base area the climb hint listens for', () => {
    const trigger = hint('tut_climb').trigger;
    expect(trigger).toMatchObject({ kind: 'event', event: 'area:entered' });
    const volume = AREA_VOLUMES.find((v) => v.id === 'breezewatch_base');
    expect(volume?.shape.kind).toBe('cylinder');
    const step = at('climb').step;
    if (volume?.shape.kind === 'cylinder') {
      const s = volume.shape;
      expect(Math.hypot(step.at.x - s.x, step.at.z - s.z)).toBeLessThanOrEqual(s.radius);
      expect(step.at.y).toBeGreaterThanOrEqual(s.minY);
      expect(step.at.y).toBeLessThanOrEqual(s.maxY);
    }
  });

  it('glide: Wren joins on the windmill top, where the glide hint shows', () => {
    const step = at('glide').step;
    expect(step.joins).toBe('wren');
    expect(hint('tut_glide').trigger).toMatchObject({ kind: 'event', event: 'party:joined' });
    expect(cinematicDef('cin_join_wren')).not.toBeNull();
  });
});
