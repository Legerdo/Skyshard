/*
 * Visual_Manifest (design.md "시각 모델 교체 구조 (Visual_Provider)", Req 43.1–43.3, 43.7, 40.4). Pure data plus the pure
 * `resolveVisualSpec` check; no three.js, DOM or other src imports.
 *
 * Every Player_Character, enemy, Elite, NPC and Caelith has one entry. The shipped build draws all of them with the
 * procedural rig kit (`source: { kind: 'procedural' }`, Req 40.4). The rules never see this file: the simulation uses
 * the collision capsule, hit volumes and AttackDefs only, and the presentation's EntityView attaches whatever
 * VisualInstance the VisualProvider for the entry's source builds (Req 43.3).
 *
 * Swapping in an external model (developer steps):
 * 1. Put the file under `public/assets/models/` (same origin: other-origin URLs are refused, Req 1.4).
 * 2. Change the entry's `source`, e.g. `source: { kind: 'gltf', url: 'assets/models/kairen.glb' }`
 *    (`gltf` takes .gltf/.glb, `fbx` .fbx, `vrm` .vrm), and when needed set `height` (m, default = the procedural
 *    height), `yawDeg` (front correction; VRM 0.x defaults to 180°), `offset`, `boneMap` (HumanoidBoneName → the
 *    file's bone name; otherwise detected automatically), `restPose` ('T' | 'A' | per-bone degrees), `clips`
 *    (AnimStateName → clip name in the file), `sockets`, `materials` ('toon' | 'original'), `outline`, `expressions`,
 *    `lodDistance` and `credit`.
 * 3. Check the bone table, poses and sockets in `model-lab.html?entity=<id>` (task 19.8).
 * 4. Record the source in CREDITS.md (Req 43.9) and in `credit`.
 * A malformed entry, an unsupported kind or format, or a failed / timed-out load (15 s) logs one warning and keeps the
 * procedural model for that entity (Req 43.7); the game never stops for a model.
 */

import {
  BOSS_IDS, CHARACTER_IDS, ELITE_IDS, ENEMY_IDS, NPC_IDS,
  type VisualEntityId,
} from './ids';

// ── Names shared with the presentation ─────────────────────────────────────

/** VRM humanoid bone names a manifest `boneMap` / `restPose` may use (the procedural rig has the 19 core ones). */
export const HUMANOID_BONE_NAMES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftEye', 'rightEye', 'jaw',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
] as const;
export type HumanoidBoneName = (typeof HUMANOID_BONE_NAMES)[number];

/** The 15 bones an external humanoid must provide (VRM required set, design "실패와 대체"). */
export const REQUIRED_HUMANOID_BONES = [
  'hips', 'spine', 'head',
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
] as const satisfies readonly HumanoidBoneName[];

/** Attachment sockets every visual exposes (weapon hands, the back storage spot, above the head). */
export const SOCKET_NAMES = ['weaponR', 'weaponL', 'back', 'headTop'] as const;
export type SocketName = (typeof SOCKET_NAMES)[number];

/** Animation state names (the clip list arrives with the Animation_System, task 19.4); any non-empty string. */
export type AnimStateName = string;

export const VISUAL_SOURCE_KINDS = ['procedural', 'gltf', 'fbx', 'vrm'] as const;
export type VisualSourceKind = (typeof VISUAL_SOURCE_KINDS)[number];
export type ExternalSourceKind = Exclude<VisualSourceKind, 'procedural'>;

/** File extensions each external kind accepts (lower case, without the query / hash). */
export const SOURCE_EXTENSIONS: Readonly<Record<ExternalSourceKind, readonly string[]>> = {
  gltf: ['.gltf', '.glb'],
  fbx: ['.fbx'],
  vrm: ['.vrm'],
};

// ── Types ───────────────────────────────────────────────────────────────────

export type VisualSource = { kind: 'procedural' } | { kind: ExternalSourceKind; url: string };
export type Vec3Tuple = [number, number, number];
export type ClipRef = string | { name: string; speed?: number; loop?: boolean };

export interface VisualSpec {
  source: VisualSource;
  rig: 'humanoid' | 'generic';
  /** Target height (m); default the procedural model's height. */
  height?: number;
  /** Front correction (°); default 180 for VRM 0.x, else 0. */
  yawDeg?: number;
  offset?: Vec3Tuple;
  boneMap?: Partial<Record<HumanoidBoneName, string>>;
  restPose?: 'T' | 'A' | Partial<Record<HumanoidBoneName, Vec3Tuple>>;
  clips?: Partial<Record<AnimStateName, ClipRef>>;
  sockets?: Partial<Record<SocketName, { bone: string; offset?: Vec3Tuple; rotDeg?: Vec3Tuple }>>;
  hideProceduralWeapon?: boolean;
  materials?: 'toon' | 'original';
  outline?: boolean;
  expressions?: { blink?: string; talk?: string };
  lodDistance?: number;
  credit?: { name: string; author: string; url: string; license: string };
}

export type VisualManifest = Partial<Record<VisualEntityId, VisualSpec>>;

/** Every VisualEntityId in registry order: characters, enemies, Elites, the boss, NPCs. */
export const VISUAL_ENTITY_IDS: readonly VisualEntityId[] = [
  ...CHARACTER_IDS, ...ENEMY_IDS, ...ELITE_IDS, ...BOSS_IDS, ...NPC_IDS,
];

const VISUAL_ENTITY_SET: ReadonlySet<string> = new Set<string>(VISUAL_ENTITY_IDS);
export const isVisualEntityId = (value: unknown): value is VisualEntityId =>
  typeof value === 'string' && VISUAL_ENTITY_SET.has(value);

/**
 * Skeleton family of each entity's procedural model: humanoid for the party, NPCs, Caelith and the humanoid-preset
 * enemies (Mossback Brute, Old Mossback, Rootbound Warden's upper body); generic (own preset joints) otherwise.
 */
const HUMANOID_ENEMIES: ReadonlySet<string> = new Set(['mossbackBrute', 'oldMossback', 'rootboundWarden']);
export function defaultRigKind(id: VisualEntityId): VisualSpec['rig'] {
  if ((ENEMY_IDS as readonly string[]).includes(id) || (ELITE_IDS as readonly string[]).includes(id)) {
    return HUMANOID_ENEMIES.has(id) ? 'humanoid' : 'generic';
  }
  return 'humanoid';
}

/** The procedural spec of `id` (the fallback of every invalid entry). */
export function proceduralSpec(id: VisualEntityId): VisualSpec {
  return { source: { kind: 'procedural' }, rig: defaultRigKind(id) };
}

/** The shipped manifest: every entity procedural (Req 40.4). Edit an entry to swap in an external model. */
export const VISUAL_MANIFEST: VisualManifest = {
  // Party
  kairen: { source: { kind: 'procedural' }, rig: 'humanoid' },
  isla: { source: { kind: 'procedural' }, rig: 'humanoid' },
  wren: { source: { kind: 'procedural' }, rig: 'humanoid' },
  talus: { source: { kind: 'procedural' }, rig: 'humanoid' },
  // Enemies
  bramblekin: { source: { kind: 'procedural' }, rig: 'generic' },
  thornspitter: { source: { kind: 'procedural' }, rig: 'generic' },
  mossbackBrute: { source: { kind: 'procedural' }, rig: 'humanoid' },
  cinderHound: { source: { kind: 'procedural' }, rig: 'generic' },
  slagshell: { source: { kind: 'procedural' }, rig: 'generic' },
  ashWisp: { source: { kind: 'procedural' }, rig: 'generic' },
  windcutter: { source: { kind: 'procedural' }, rig: 'generic' },
  aetherSentinel: { source: { kind: 'procedural' }, rig: 'generic' },
  // Elites
  oldMossback: { source: { kind: 'procedural' }, rig: 'humanoid' },
  emberjaw: { source: { kind: 'procedural' }, rig: 'generic' },
  galeclaw: { source: { kind: 'procedural' }, rig: 'generic' },
  rootboundWarden: { source: { kind: 'procedural' }, rig: 'humanoid' },
  cinderAlpha: { source: { kind: 'procedural' }, rig: 'generic' },
  sentinelPrime: { source: { kind: 'procedural' }, rig: 'generic' },
  // Boss
  caelith: { source: { kind: 'procedural' }, rig: 'humanoid' },
  // NPCs
  maren: { source: { kind: 'procedural' }, rig: 'humanoid' },
  pip: { source: { kind: 'procedural' }, rig: 'humanoid' },
  bram: { source: { kind: 'procedural' }, rig: 'humanoid' },
  tamsin: { source: { kind: 'procedural' }, rig: 'humanoid' },
  hobb: { source: { kind: 'procedural' }, rig: 'humanoid' },
  durga: { source: { kind: 'procedural' }, rig: 'humanoid' },
  oriel: { source: { kind: 'procedural' }, rig: 'humanoid' },
};

// ── Validation ──────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

/** A problem found in an entry; the first one becomes the single warning. */
class Invalid {
  constructor(readonly reason: string) {}
}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: Obj, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key) && o[key] !== undefined;
const HUMANOID_BONE_SET: ReadonlySet<string> = new Set(HUMANOID_BONE_NAMES);
const SOCKET_SET: ReadonlySet<string> = new Set(SOCKET_NAMES);
const EXTERNAL_KINDS: ReadonlySet<string> = new Set(['gltf', 'fbx', 'vrm']);
const SPEC_KEYS: ReadonlySet<string> = new Set([
  'source', 'rig', 'height', 'yawDeg', 'offset', 'boneMap', 'restPose', 'clips', 'sockets', 'hideProceduralWeapon',
  'materials', 'outline', 'expressions', 'lodDistance', 'credit',
]);

function fail(reason: string): never {
  throw new Invalid(reason);
}

function onlyKeys(o: Obj, allowed: ReadonlySet<string>, where: string): void {
  for (const key of Object.keys(o)) {
    if (!allowed.has(key)) fail(`${where}: unknown field '${key}'`);
  }
}

function str(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.length === 0) fail(`${where} must be a non-empty string`);
  return v;
}

function num(v: unknown, where: string, positive = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${where} must be a finite number`);
  if (positive && !(v > 0)) fail(`${where} must be > 0`);
  return v;
}

function bool(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') fail(`${where} must be true or false`);
  return v;
}

function vec3(v: unknown, where: string): Vec3Tuple {
  if (!Array.isArray(v) || v.length !== 3) fail(`${where} must be [x, y, z]`);
  return [num(v[0], `${where}[0]`), num(v[1], `${where}[1]`), num(v[2], `${where}[2]`)];
}

function record(v: unknown, where: string): Obj {
  if (!isObj(v)) fail(`${where} must be an object`);
  return v;
}

/**
 * Same-origin relative URL with the kind's extension: no scheme (`https:`, `data:` …), no protocol-relative `//`, no
 * backslashes or whitespace (Req 1.4 "다른 출처 URL", design "지원하지 않는 형식").
 */
function sourceUrl(v: unknown, kind: ExternalSourceKind): string {
  const url = str(v, 'source.url');
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//') || /[\\\s]/.test(url)) {
    fail(`source.url '${url}' is not a same-origin relative path`);
  }
  const path = url.replace(/[?#].*$/, '').toLowerCase();
  if (!SOURCE_EXTENSIONS[kind].some((ext) => path.endsWith(ext) && path.length > ext.length)) {
    fail(`source.url '${url}' is not a ${SOURCE_EXTENSIONS[kind].join(' / ')} file for kind '${kind}'`);
  }
  return url;
}

function source(v: unknown): VisualSource {
  const o = record(v, 'source');
  const kind = o.kind;
  if (kind === 'procedural') {
    onlyKeys(o, new Set(['kind']), 'source');
    return { kind: 'procedural' };
  }
  if (typeof kind !== 'string' || !EXTERNAL_KINDS.has(kind)) {
    fail(`source.kind ${JSON.stringify(kind) ?? 'undefined'} is not supported (procedural, gltf, fbx, vrm)`);
  }
  onlyKeys(o, new Set(['kind', 'url']), 'source');
  const external = kind as ExternalSourceKind;
  return { kind: external, url: sourceUrl(o.url, external) };
}

function boneKeyed<T>(v: unknown, where: string, value: (x: unknown, at: string) => T): Partial<Record<HumanoidBoneName, T>> {
  const o = record(v, where);
  const out: Partial<Record<HumanoidBoneName, T>> = {};
  for (const key of Object.keys(o)) {
    if (!HUMANOID_BONE_SET.has(key)) fail(`${where}: '${key}' is not a humanoid bone name`);
    if (o[key] === undefined) continue;
    out[key as HumanoidBoneName] = value(o[key], `${where}.${key}`);
  }
  return out;
}

function clipRef(v: unknown, where: string): ClipRef {
  if (typeof v === 'string') return str(v, where);
  const o = record(v, where);
  onlyKeys(o, new Set(['name', 'speed', 'loop']), where);
  const out: { name: string; speed?: number; loop?: boolean } = { name: str(o.name, `${where}.name`) };
  if (has(o, 'speed')) out.speed = num(o.speed, `${where}.speed`, true);
  if (has(o, 'loop')) out.loop = bool(o.loop, `${where}.loop`);
  return out;
}

function parseSpec(raw: unknown): VisualSpec {
  const o = record(raw, 'entry');
  onlyKeys(o, SPEC_KEYS, 'entry');
  if (!has(o, 'source')) fail('entry has no source');
  const spec: VisualSpec = { source: source(o.source), rig: 'humanoid' };
  if (o.rig !== 'humanoid' && o.rig !== 'generic') fail("rig must be 'humanoid' or 'generic'");
  spec.rig = o.rig;
  if (has(o, 'height')) spec.height = num(o.height, 'height', true);
  if (has(o, 'yawDeg')) spec.yawDeg = num(o.yawDeg, 'yawDeg');
  if (has(o, 'offset')) spec.offset = vec3(o.offset, 'offset');
  if (has(o, 'boneMap')) spec.boneMap = boneKeyed(o.boneMap, 'boneMap', str);
  if (has(o, 'restPose')) {
    spec.restPose = o.restPose === 'T' || o.restPose === 'A' ? o.restPose : boneKeyed(o.restPose, 'restPose', vec3);
  }
  if (has(o, 'clips')) {
    const clips = record(o.clips, 'clips');
    const out: Partial<Record<AnimStateName, ClipRef>> = {};
    for (const key of Object.keys(clips)) {
      if (key.length === 0) fail('clips: empty state name');
      if (clips[key] === undefined) continue;
      // defineProperty: a state named '__proto__' stays an own entry instead of replacing the prototype.
      Object.defineProperty(out, key, { value: clipRef(clips[key], `clips.${key}`), enumerable: true, writable: true, configurable: true });
    }
    spec.clips = out;
  }
  if (has(o, 'sockets')) {
    const sockets = record(o.sockets, 'sockets');
    const out: NonNullable<VisualSpec['sockets']> = {};
    for (const key of Object.keys(sockets)) {
      if (!SOCKET_SET.has(key)) fail(`sockets: '${key}' is not a socket name (${SOCKET_NAMES.join(', ')})`);
      if (sockets[key] === undefined) continue;
      const s = record(sockets[key], `sockets.${key}`);
      onlyKeys(s, new Set(['bone', 'offset', 'rotDeg']), `sockets.${key}`);
      const socket: { bone: string; offset?: Vec3Tuple; rotDeg?: Vec3Tuple } = { bone: str(s.bone, `sockets.${key}.bone`) };
      if (has(s, 'offset')) socket.offset = vec3(s.offset, `sockets.${key}.offset`);
      if (has(s, 'rotDeg')) socket.rotDeg = vec3(s.rotDeg, `sockets.${key}.rotDeg`);
      out[key as SocketName] = socket;
    }
    spec.sockets = out;
  }
  if (has(o, 'hideProceduralWeapon')) spec.hideProceduralWeapon = bool(o.hideProceduralWeapon, 'hideProceduralWeapon');
  if (has(o, 'materials')) {
    if (o.materials !== 'toon' && o.materials !== 'original') fail("materials must be 'toon' or 'original'");
    spec.materials = o.materials;
  }
  if (has(o, 'outline')) spec.outline = bool(o.outline, 'outline');
  if (has(o, 'expressions')) {
    const e = record(o.expressions, 'expressions');
    onlyKeys(e, new Set(['blink', 'talk']), 'expressions');
    const out: { blink?: string; talk?: string } = {};
    if (has(e, 'blink')) out.blink = str(e.blink, 'expressions.blink');
    if (has(e, 'talk')) out.talk = str(e.talk, 'expressions.talk');
    spec.expressions = out;
  }
  if (has(o, 'lodDistance')) spec.lodDistance = num(o.lodDistance, 'lodDistance', true);
  if (has(o, 'credit')) {
    const c = record(o.credit, 'credit');
    onlyKeys(c, new Set(['name', 'author', 'url', 'license']), 'credit');
    spec.credit = {
      name: str(c.name, 'credit.name'), author: str(c.author, 'credit.author'),
      url: str(c.url, 'credit.url'), license: str(c.license, 'credit.license'),
    };
  }
  return spec;
}

export interface ResolvedVisualSpec {
  readonly spec: VisualSpec;
  /** Empty for a valid (or absent) entry; exactly one line for an invalid one. */
  readonly warnings: string[];
}

/**
 * Checks one manifest entry (any JSON value). A valid entry comes back as an equal copy with no warning; a malformed
 * entry or an unsupported source / format comes back as the procedural spec with exactly one warning (Req 43.7). An
 * absent entry (`undefined`) is the procedural default without a warning. Never throws.
 */
export function resolveVisualSpec(id: VisualEntityId, raw: unknown): ResolvedVisualSpec {
  if (raw === undefined) return { spec: proceduralSpec(id), warnings: [] };
  try {
    return { spec: parseSpec(raw), warnings: [] };
  } catch (error) {
    const reason = error instanceof Invalid ? error.reason : 'unreadable entry';
    return { spec: proceduralSpec(id), warnings: [`visualManifest.${id}: ${reason}; using the procedural model`] };
  }
}

/** Resolves every entity of `manifest` (any object); keys that are not VisualEntityIds add one warning each. */
export function resolveVisualManifest(manifest: unknown): { specs: Record<VisualEntityId, VisualSpec>; warnings: string[] } {
  const warnings: string[] = [];
  const source = isObj(manifest) ? manifest : {};
  if (!isObj(manifest)) warnings.push('visualManifest: not an object; every entity uses the procedural model');
  for (const key of Object.keys(source)) {
    if (!isVisualEntityId(key)) warnings.push(`visualManifest: '${key}' is not an entity id; ignored`);
  }
  const specs = {} as Record<VisualEntityId, VisualSpec>;
  for (const id of VISUAL_ENTITY_IDS) {
    const resolved = resolveVisualSpec(id, Object.prototype.hasOwnProperty.call(source, id) ? source[id] : undefined);
    specs[id] = resolved.spec;
    warnings.push(...resolved.warnings);
  }
  return { specs, warnings };
}
