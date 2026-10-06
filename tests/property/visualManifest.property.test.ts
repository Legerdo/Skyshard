// Feature: skyshard-echoes-of-the-wild, Property 32: Visual_Manifest 해석의 전체성
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  HUMANOID_BONE_NAMES, proceduralSpec, resolveVisualSpec, SOCKET_NAMES, VISUAL_ENTITY_IDS, type VisualSpec,
} from '../../src/data/visualManifest';

// **Validates: Requirements 43.1, 43.7** — for any JSON value as a manifest entry, resolveVisualSpec returns a valid
// VisualSpec without throwing; malformed entries and unsupported sources give the procedural spec and exactly one
// warning; valid entries come back unchanged.

const RUNS = { numRuns: 200 };
const id = fc.constantFrom(...VISUAL_ENTITY_IDS);
const finite = fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 });
const positive = fc.double({ noNaN: true, noDefaultInfinity: true, min: 1e-3, max: 1e3 });
const name = fc.string({ minLength: 1, maxLength: 12 });
const vec3 = fc.tuple(finite, finite, finite);
const path = fc.stringMatching(/^[a-z0-9_]{1,10}(\/[a-z0-9_]{1,10}){0,2}$/);

/** Arbitrary valid entries (every optional field may appear). */
const validSpec: fc.Arbitrary<VisualSpec> = fc.record(
  {
    source: fc.oneof(
      fc.constant({ kind: 'procedural' as const }),
      fc.record({ kind: fc.constant('gltf' as const), url: fc.tuple(path, fc.constantFrom('.glb', '.gltf', '.GLB')).map(([p, e]) => `${p}${e}`) }),
      fc.record({ kind: fc.constant('fbx' as const), url: path.map((p) => `/${p}.fbx`) }),
      fc.record({ kind: fc.constant('vrm' as const), url: path.map((p) => `assets/models/${p}.vrm?v=1`) }),
    ),
    rig: fc.constantFrom('humanoid' as const, 'generic' as const),
    height: positive,
    yawDeg: finite,
    offset: vec3,
    boneMap: fc.dictionary(fc.constantFrom(...HUMANOID_BONE_NAMES), name, { maxKeys: 4 }),
    restPose: fc.oneof(fc.constantFrom('T' as const, 'A' as const), fc.dictionary(fc.constantFrom(...HUMANOID_BONE_NAMES), vec3, { maxKeys: 3 })),
    clips: fc.dictionary(name, fc.oneof(name, fc.record({ name, speed: positive, loop: fc.boolean() }, { requiredKeys: ['name'] })), { maxKeys: 3 }),
    sockets: fc.dictionary(fc.constantFrom(...SOCKET_NAMES), fc.record({ bone: name, offset: vec3, rotDeg: vec3 }, { requiredKeys: ['bone'] }), { maxKeys: 2 }),
    hideProceduralWeapon: fc.boolean(),
    materials: fc.constantFrom('toon' as const, 'original' as const),
    outline: fc.boolean(),
    expressions: fc.record({ blink: name, talk: name }, { requiredKeys: [] }),
    lodDistance: positive,
    credit: fc.record({ name, author: name, url: name, license: name }),
  },
  { requiredKeys: ['source', 'rig'] },
) as fc.Arbitrary<VisualSpec>;

/** A result is a valid spec when resolving it again keeps it and warns nothing. */
function isValid(spec: VisualSpec, entity: (typeof VISUAL_ENTITY_IDS)[number]): boolean {
  const again = resolveVisualSpec(entity, JSON.parse(JSON.stringify(spec)));
  return again.warnings.length === 0 && JSON.stringify(again.spec) === JSON.stringify(spec);
}

describe('Property 32: Visual_Manifest 해석의 전체성', () => {
  it('any JSON value resolves without throwing to a valid spec; invalid ones to the procedural spec with one warning', () => {
    fc.assert(
      fc.property(id, fc.jsonValue(), (entity, raw) => {
        const { spec, warnings } = resolveVisualSpec(entity, raw);
        expect(isValid(spec, entity)).toBe(true);
        expect(warnings.length).toBeLessThanOrEqual(1);
        if (warnings.length === 1) expect(spec).toEqual(proceduralSpec(entity));
        else expect(spec).toEqual(raw);
      }),
      RUNS,
    );
  });

  it('valid entries are preserved exactly, with no warning', () => {
    fc.assert(
      fc.property(id, validSpec, (entity, entry) => {
        const raw: unknown = JSON.parse(JSON.stringify(entry));
        const { spec, warnings } = resolveVisualSpec(entity, raw);
        expect(warnings).toEqual([]);
        expect(spec).toEqual(raw);
      }),
      RUNS,
    );
  });

  it('a broken valid entry (a field replaced by any JSON value of the wrong kind, or an unknown field) gives the procedural spec and exactly one warning', () => {
    const breakers: fc.Arbitrary<(e: Record<string, unknown>) => void>[] = [
      fc.jsonValue().filter((v) => typeof v !== 'object' || v === null || Array.isArray(v)).map((v) => (e: Record<string, unknown>) => { e.source = v; }),
      fc.string().filter((s) => s !== 'humanoid' && s !== 'generic').map((s) => (e: Record<string, unknown>) => { e.rig = s; }),
      fc.constantFrom('obj', 'usdz', 'png', '').map((k) => (e: Record<string, unknown>) => { e.source = { kind: k, url: `a.${k}` }; }),
      fc.constantFrom('http://x.com/a.glb', 'data:model/gltf;base64,AAAA', '//x.com/a.glb', 'C:\\a.glb').map((url) => (e: Record<string, unknown>) => { e.source = { kind: 'gltf', url }; }),
      fc.oneof(fc.constant(0), fc.constant(-2), fc.string(), fc.constant(null)).map((h) => (e: Record<string, unknown>) => { e.height = h; }),
      fc.string({ minLength: 1 }).filter((k) => !['source', 'rig', 'height', 'yawDeg', 'offset', 'boneMap', 'restPose', 'clips', 'sockets', 'hideProceduralWeapon', 'materials', 'outline', 'expressions', 'lodDistance', 'credit'].includes(k))
        .map((k) => (e: Record<string, unknown>) => { Object.defineProperty(e, k, { value: 1, enumerable: true, writable: true, configurable: true }); }),
    ];
    fc.assert(
      fc.property(id, validSpec, fc.oneof(...breakers), (entity, entry, breakIt) => {
        const raw = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
        breakIt(raw);
        const { spec, warnings } = resolveVisualSpec(entity, raw);
        expect(warnings).toHaveLength(1);
        expect(spec).toEqual(proceduralSpec(entity));
      }),
      RUNS,
    );
  });
});
