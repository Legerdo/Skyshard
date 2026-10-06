import { describe, expect, it } from 'vitest';
import {
  BOSS_IDS, CHARACTER_IDS, ELITE_IDS, ENEMY_IDS, NPC_IDS, type VisualEntityId,
} from '../../src/data/ids';
import {
  isVisualEntityId, proceduralSpec, resolveVisualManifest, resolveVisualSpec, VISUAL_ENTITY_IDS, VISUAL_MANIFEST,
} from '../../src/data/visualManifest';

// Task 19.7: the shipped Visual_Manifest (Req 40.4, 43.1) and resolveVisualSpec examples (Req 43.7).

const ALL: readonly VisualEntityId[] = [...CHARACTER_IDS, ...ENEMY_IDS, ...ELITE_IDS, ...BOSS_IDS, ...NPC_IDS];

describe('Visual_Manifest data', () => {
  it('has an entry for every CharacterId, EnemyId, EliteId, BossId and NpcId, and no other keys', () => {
    expect([...VISUAL_ENTITY_IDS].sort()).toEqual([...ALL].sort());
    expect(Object.keys(VISUAL_MANIFEST).sort()).toEqual([...ALL].sort());
    for (const key of Object.keys(VISUAL_MANIFEST)) expect(isVisualEntityId(key), key).toBe(true);
  });

  it('ships every entity as a valid procedural entry', () => {
    for (const id of ALL) {
      const entry = VISUAL_MANIFEST[id];
      expect(entry?.source, id).toEqual({ kind: 'procedural' });
      const { spec, warnings } = resolveVisualSpec(id, entry);
      expect(warnings, id).toEqual([]);
      expect(spec, id).toEqual(entry);
    }
    expect(resolveVisualManifest(VISUAL_MANIFEST).warnings).toEqual([]);
  });

  it('marks the party, NPCs, Caelith and the humanoid-preset enemies humanoid, the rest generic', () => {
    for (const id of [...CHARACTER_IDS, ...NPC_IDS, ...BOSS_IDS, 'mossbackBrute', 'oldMossback', 'rootboundWarden'] as const) {
      expect(VISUAL_MANIFEST[id]?.rig, id).toBe('humanoid');
    }
    for (const id of ['bramblekin', 'thornspitter', 'cinderHound', 'slagshell', 'ashWisp', 'windcutter', 'aetherSentinel'] as const) {
      expect(VISUAL_MANIFEST[id]?.rig, id).toBe('generic');
    }
    for (const id of ALL) expect(proceduralSpec(id).rig, id).toBe(VISUAL_MANIFEST[id]?.rig);
  });
});

describe('resolveVisualSpec', () => {
  it('keeps a valid external entry as is', () => {
    const entry = {
      source: { kind: 'vrm', url: 'assets/models/kairen.vrm' }, rig: 'humanoid', height: 1.72, yawDeg: 180,
      offset: [0, 0.01, 0], boneMap: { hips: 'J_Bip_C_Hips' }, restPose: 'A', clips: { idle: 'Idle', run: { name: 'Run', speed: 1.1, loop: true } },
      sockets: { weaponR: { bone: 'J_Bip_R_Hand', offset: [0, 0, 0.02], rotDeg: [0, 90, 0] } }, hideProceduralWeapon: false,
      materials: 'original', outline: true, expressions: { blink: 'blink', talk: 'aa' }, lodDistance: 60,
      credit: { name: 'Kairen', author: 'someone', url: 'https://example.com/kairen', license: 'CC-BY-4.0' },
    };
    const { spec, warnings } = resolveVisualSpec('kairen', entry);
    expect(warnings).toEqual([]);
    expect(spec).toEqual(entry);
    expect(spec).not.toBe(entry);
  });

  it.each([
    ['a non-object', 42, /entry must be an object/],
    ['a missing source', { rig: 'humanoid' }, /no source/],
    ['an unsupported kind', { source: { kind: 'obj', url: 'a.obj' }, rig: 'generic' }, /not supported/],
    ['another origin', { source: { kind: 'gltf', url: 'https://cdn.example.com/a.glb' }, rig: 'generic' }, /same-origin/],
    ['a protocol-relative url', { source: { kind: 'gltf', url: '//cdn.example.com/a.glb' }, rig: 'generic' }, /same-origin/],
    ['a wrong extension', { source: { kind: 'fbx', url: 'assets/models/a.glb' }, rig: 'generic' }, /\.fbx/],
    ['a bad rig', { source: { kind: 'procedural' }, rig: 'robot' }, /rig must be/],
    ['a typo field', { source: { kind: 'procedural' }, rig: 'humanoid', heigth: 2 }, /unknown field 'heigth'/],
    ['a bad bone', { source: { kind: 'procedural' }, rig: 'humanoid', boneMap: { tail: 'Tail' } }, /humanoid bone/],
    ['a negative height', { source: { kind: 'procedural' }, rig: 'humanoid', height: -1 }, /height must be > 0/],
  ])('falls back to the procedural spec with one warning for %s', (_what, raw, reason) => {
    const { spec, warnings } = resolveVisualSpec('slagshell', raw);
    expect(spec).toEqual({ source: { kind: 'procedural' }, rig: 'generic' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(reason);
    expect(warnings[0]).toMatch(/^visualManifest\.slagshell: /);
  });

  it('treats an absent entry as the procedural default without a warning, and reports foreign manifest keys', () => {
    expect(resolveVisualSpec('pip', undefined)).toEqual({ spec: proceduralSpec('pip'), warnings: [] });
    const { specs, warnings } = resolveVisualManifest({ kairen: { source: { kind: 'fbx', url: 'x.fbx' }, rig: 'humanoid' }, goblin: {} });
    expect(specs.kairen.source).toEqual({ kind: 'fbx', url: 'x.fbx' });
    expect(specs.isla).toEqual(proceduralSpec('isla'));
    expect(warnings).toEqual(["visualManifest: 'goblin' is not an entity id; ignored"]);
  });
});
