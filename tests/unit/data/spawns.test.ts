import { describe, expect, it } from 'vitest';
import { MAIN_QUEST } from '../../../src/data/quests';
import {
  CAMPS, ENCOUNTER_GROUPS, SPAWNERS, spawnDataErrors, type CampDef, type EncounterGroupDef, type SpawnerDef,
} from '../../../src/data/spawns';

// Placement data rules (design "스폰·캠프·재배치", data file spawns.ts; Req 10.7, 11.6).
const lone = (over: Partial<SpawnerDef> = {}): SpawnerDef =>
  ({ id: 'sp_verdant_1', region: 'verdant', kind: 'bramblekin', pos: { x: 0, z: 0, y: 'ground' }, yaw: 0, level: 1, campId: null, respawn: 'roaming', ...over }) as SpawnerDef;

describe('spawn data', () => {
  it('is valid: every spawner belongs to a known camp or group of its region, and every Main_Quest defeat group but the boss is an encounter group', () => {
    expect(spawnDataErrors(SPAWNERS, CAMPS, ENCOUNTER_GROUPS)).toEqual([]);
    const defeats = MAIN_QUEST.stages.flatMap((s) => s.objectives).flatMap((o) => (o.trigger.kind === 'defeat' ? [o.trigger.groupId] : []));
    // The Observatory's first wave is called by its area, not a quest target; its last wave is `observatory_waves`.
    const areaWaves = ENCOUNTER_GROUPS.filter((g) => g.byArea === true).map((g) => g.id);
    expect(areaWaves).toEqual(['observatory_wave_1', 'observatory_waves']);
    expect(defeats.filter((g) => g !== 'caelith').sort()).toEqual(ENCOUNTER_GROUPS.map((g) => g.id).filter((id) => id !== 'observatory_wave_1').sort());
    // Hollowroot's R4 room is bramblekin ×4 + thornspitter ×2 and R5 the Rootbound Warden (Req 12.1), Cinderspire's
    // summit Cinder Alpha (Req 12.2), the Observatory's waves windcutter ×2 + aetherSentinel ×1 then aetherSentinel ×2
    // and Sentinel Prime (Req 12.3); the other route groups keep their Bramblekin stand-ins: 4 + 3 + 3.
    const kinds = (groupId: string): string[] => SPAWNERS.filter((s) => s.campId === groupId).map((s) => s.kind).sort();
    expect(kinds('hollowroot_room')).toEqual(['bramblekin', 'bramblekin', 'bramblekin', 'bramblekin', 'thornspitter', 'thornspitter']);
    expect(kinds('rootboundWarden')).toEqual(['rootboundWarden']);
    expect(kinds('cinderAlpha')).toEqual(['cinderAlpha']);
    expect(kinds('observatory_wave_1')).toEqual(['aetherSentinel', 'windcutter', 'windcutter']);
    expect(kinds('observatory_waves')).toEqual(['aetherSentinel', 'aetherSentinel']);
    expect(kinds('sentinelPrime')).toEqual(['sentinelPrime']);
    const areaGroups = ['hollowroot_room', 'rootboundWarden', 'cinderAlpha', 'observatory_wave_1', 'observatory_waves', 'sentinelPrime'];
    const campIds = CAMPS.map((c) => c.id);
    // The route stand-ins: every spawner of an encounter group that is neither a Challenge_Area group, an Enemy_Camp
    // (task 20.1) nor a lone spawner (the hidden Elites, task 20.1).
    const standIns = SPAWNERS.filter((s) => s.campId !== null && !areaGroups.includes(s.campId) && !campIds.includes(s.campId));
    expect(standIns.every((s) => s.kind === 'bramblekin')).toBe(true);
    expect(standIns).toHaveLength(10);
    expect(ENCOUNTER_GROUPS.filter((g) => g.standIn !== true).map((g) => g.id).sort()).toEqual([...areaGroups].sort());
  });

  it('places two Enemy_Camps per main Region, each with members and its locked Chest, and the three hidden Elites once each (task 20.1)', () => {
    for (const region of ['verdant', 'ember', 'azure'] as const) {
      const camps = CAMPS.filter((c) => c.region === region);
      expect(camps, region).toHaveLength(2);
      for (const c of camps) {
        expect(c.chestId, c.id).toMatch(new RegExp(`^chest_${region}_\\d+$`));
        expect(SPAWNERS.filter((s) => s.campId === c.id).length, c.id).toBeGreaterThanOrEqual(3);
      }
    }
    const lone = SPAWNERS.filter((s) => s.campId === null);
    expect(lone.map((s) => [s.kind, s.respawn]).sort()).toEqual([['emberjaw', 'never'], ['galeclaw', 'never'], ['oldMossback', 'never']]);
  });

  it('reports broken placements', () => {
    const camp: CampDef = { id: 'camp_verdant_1', region: 'verdant', chestId: 'chest_verdant_1' };
    const group: EncounterGroupDef = { id: 'pack', region: 'ember' };
    const member = lone({ id: 'sp_camp_verdant_1_1', campId: camp.id });
    expect(spawnDataErrors([member, lone({ id: 'sp_oldMossback', kind: 'oldMossback', level: 3, respawn: 'never' })], [camp], [])).toEqual([]);
    const errors = (spawners: SpawnerDef[], camps: CampDef[] = [camp], groups: EncounterGroupDef[] = []): string[] =>
      spawnDataErrors([member, ...spawners], camps, groups);
    expect(errors([lone({ kind: 'oldMossback', level: 3 })])).toEqual(["spawner sp_verdant_1: a lone Elite must be 'never'"]);
    expect(errors([lone({ respawn: 'never' })])).toEqual(["spawner sp_verdant_1: only lone Elites are 'never'"]);
    expect(errors([lone({ level: 4 })])).toEqual(["spawner sp_verdant_1: level 4 is outside verdant's range"]);
    expect(errors([lone({ campId: 'camp_verdant_9' })])).toEqual(['spawner sp_verdant_1: unknown camp or group camp_verdant_9']);
    expect(errors([lone({ id: member.id })])).toEqual([`duplicate spawner id ${member.id}`]);
    expect(errors([lone({ campId: 'pack' })], [camp], [group])).toEqual(["spawner sp_verdant_1: region verdant differs from pack's ember"]);
    expect(errors([], [camp, { id: 'camp_ember_x', region: 'ember', chestId: 'chest_verdant_2' }])).toEqual([
      'camp camp_ember_x: id is not camp_ember_<n>',
      'camp camp_ember_x: chest chest_verdant_2 is not chest_ember_<n>',
      'camp_ember_x has no spawners',
    ]);
  });
});
