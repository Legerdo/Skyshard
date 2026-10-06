/*
 * sanitizeGameState (design "보정 규칙", Req 36.12): turns any parsed value into a valid, canonical GameState and lists
 * every repair as one line ("inventory.con_herbDumpling: 14 → 10"). Rules:
 * - missing fields, wrong types and unknown enum values take the New Game default;
 * - negative counts become 0, counts above their cap the cap (consumables 10);
 * - the level is clamped to 1–10 and the XP moved into that level's band; the Skyshard count is clamped to 0–3 and
 *   then set to what the Main_Quest position implies;
 * - ids no content defines are dropped with their entry; non-finite (or out-of-world) positions become the respawn
 *   point's spot;
 * - equipped items that are not owned, do not fit the slot, or a Charm worn twice are unequipped.
 * Sets are sorted and de-duplicated (canonical form) without counting as repairs, so a valid canonical state passes
 * through unchanged with no repairs, and the result is a fixed point (Property 1, 3). Pure and total: never throws.
 */
import { CHARACTERS } from '../../data/characters';
import { CHARACTER_IDS, SIDE_QUEST_IDS, type CharacterId, type ItemId, type SideQuestId } from '../../data/ids';
import { CONSUMABLE_CAP } from '../../data/items';
import { MAX_LEVEL } from '../../data/progression';
import { QUESTS } from '../../data/quests';
import { FogOfWar } from '../fogOfWar';
import { levelFromXp, MAX_XP, statsAt, xpForLevel } from '../progression';
import type { QuestDef, QuestState, SideQuestStatus } from '../quest/types';
import {
  ELITE_SET, isEquipmentItem, isKnownCamp, isKnownCheckpoint, isKnownChest, isKnownCinematic,
  isKnownHiddenPlace, isKnownItem, isKnownPoi, isKnownRespawn, isKnownTablet, isKnownTutorial, isStackItem, itemDef,
  LANDMARK_SET, puzzleIds, REACTION_SET, REGION_SET, respawnPointSpot, WAYSTONE_SET, WORLD_HALF_EXTENT,
} from './contentIds';
import { canonicalizeGameState, createNewGameState, UNDATED_CREATED_AT, type GameState } from './gameState';

export interface SanitizeResult {
  state: GameState;
  repairs: string[];
}

type Obj = Record<string, unknown>;

export const isPlainObject = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

const show = (v: unknown): string => {
  if (typeof v === 'string') return JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v);
  if (typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined) return String(v);
  if (Array.isArray(v)) return `array(${v.length})`;
  return typeof v;
};

const SIDE_STATUSES: readonly SideQuestStatus[] = ['locked', 'available', 'active', 'done'];

/** Collects repair lines. */
class Repairs {
  readonly lines: string[] = [];
  add(path: string, from: unknown, to: unknown): void {
    this.lines.push(`${path}: ${show(from)} → ${show(to)}`);
  }
  note(line: string): void {
    this.lines.push(line);
  }
}

function field(obj: Obj, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

function sub(r: Repairs, obj: Obj, key: string, path: string): Obj {
  const v = field(obj, key);
  if (isPlainObject(v)) return v;
  r.add(path, v, 'default');
  return {};
}

function bool(r: Repairs, obj: Obj, key: string, path: string, def: boolean): boolean {
  const v = field(obj, key);
  if (typeof v === 'boolean') return v;
  r.add(path, v, def);
  return def;
}

function str(r: Repairs, obj: Obj, key: string, path: string, def: string): string {
  const v = field(obj, key);
  if (typeof v === 'string') return v;
  r.add(path, v, def);
  return def;
}

/** Finite number in [min, max]; non-numbers → def, out of range → clamped; `integer` floors fractions. */
function num(r: Repairs, v: unknown, path: string, def: number, min: number, max: number, integer = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    r.add(path, v, def);
    return def;
  }
  let out = integer ? Math.floor(v) : v;
  out = Math.min(max, Math.max(min, out));
  if (out !== v) r.add(path, v, out);
  return out;
}

/** Array of known strings: invalid entries are dropped (one line each); duplicates / order are not repairs. */
function idSet(r: Repairs, v: unknown, path: string, known: (id: string) => boolean): string[] {
  if (!Array.isArray(v)) {
    r.add(path, v, '[]');
    return [];
  }
  const out: string[] = [];
  for (const id of v) {
    if (typeof id === 'string' && known(id)) out.push(id);
    else r.note(`${path}: dropped ${show(id)}`);
  }
  return [...new Set(out)].sort();
}

function boolRecord(r: Repairs, v: unknown, path: string): Record<string, boolean> {
  if (!isPlainObject(v)) {
    r.add(path, v, '{}');
    return {};
  }
  const out: Record<string, boolean> = {};
  for (const [k, value] of Object.entries(v)) {
    if (typeof value === 'boolean') out[k] = value;
    else r.note(`${path}.${k}: dropped ${show(value)}`);
  }
  return out;
}

// ── Quests ──────────────────────────────────────────────────────────────────

function sanitizeQuests(r: Repairs, raw: unknown, defs: readonly QuestDef[], def: QuestState): QuestState {
  if (!isPlainObject(raw)) {
    r.add('quests', raw, 'New Game');
    return def;
  }
  const mainDef = defs.find((d) => d.id === 'main');
  const mainRaw = sub(r, raw, 'main', 'quests.main');
  const lastStage = Math.max(0, (mainDef?.stages.length ?? 1) - 1);
  const stage = num(r, field(mainRaw, 'stage'), 'quests.main.stage', 0, 0, lastStage, true);
  const lastObjective = Math.max(0, (mainDef?.stages[stage]?.objectives.length ?? 1) - 1);
  let objective = num(r, field(mainRaw, 'objective'), 'quests.main.objective', 0, 0, lastObjective, true);
  const done = bool(r, mainRaw, 'done', 'quests.main.done', false);
  let mainStage = stage;
  if (done && (stage !== lastStage || objective !== Math.max(0, (mainDef?.stages[lastStage]?.objectives.length ?? 1) - 1))) {
    mainStage = lastStage;
    objective = Math.max(0, (mainDef?.stages[lastStage]?.objectives.length ?? 1) - 1);
    r.note(`quests.main: done moved to the last objective`);
  }

  const sideRaw = sub(r, raw, 'side', 'quests.side');
  const side = {} as QuestState['side'];
  for (const id of SIDE_QUEST_IDS) {
    const path = `quests.side.${id}`;
    const entry = field(sideRaw, id);
    const qdef = defs.find((d) => d.id === id);
    const fallback = def.side[id];
    if (!isPlainObject(entry)) {
      r.add(path, entry, fallback.status);
      side[id] = { ...fallback };
      continue;
    }
    const st = field(entry, 'status');
    const status = SIDE_STATUSES.includes(st as SideQuestStatus) ? (st as SideQuestStatus) : (r.add(`${path}.status`, st, fallback.status), fallback.status);
    const sLast = Math.max(0, (qdef?.stages.length ?? 1) - 1);
    const sStage = num(r, field(entry, 'stage'), `${path}.stage`, 0, 0, sLast, true);
    const oLast = Math.max(0, (qdef?.stages[sStage]?.objectives.length ?? 1) - 1);
    const sObjective = num(r, field(entry, 'objective'), `${path}.objective`, 0, 0, oLast, true);
    side[id] = { status, stage: sStage, objective: sObjective };
  }
  for (const k of Object.keys(sideRaw)) if (!(SIDE_QUEST_IDS as readonly string[]).includes(k)) r.note(`quests.side: dropped ${k}`);

  const trackedRaw = field(raw, 'tracked');
  let tracked: QuestState['tracked'] = 'main';
  if (trackedRaw === 'main') tracked = 'main';
  else if (typeof trackedRaw === 'string' && (SIDE_QUEST_IDS as readonly string[]).includes(trackedRaw) && side[trackedRaw as SideQuestId].status === 'active') {
    tracked = trackedRaw as SideQuestId;
  } else r.add('quests.tracked', trackedRaw, 'main');

  const flags = boolRecord(r, field(raw, 'flags'), 'quests.flags');
  return { main: { stage: mainStage, objective, done }, side, tracked, flags };
}

/** Skyshards the Main_Quest position implies: its `skyshard` Objectives already passed (all of them when done). */
export function skyshardsForQuest(main: QuestState['main'], defs: readonly QuestDef[] = QUESTS): 0 | 1 | 2 | 3 {
  const def = defs.find((d) => d.id === 'main');
  if (def === undefined) return 0;
  let n = 0;
  def.stages.forEach((stage, si) => {
    stage.objectives.forEach((o, oi) => {
      if (o.trigger.kind !== 'skyshard') return;
      const passed = main.done || si < main.stage || (si === main.stage && oi < main.objective);
      if (passed) n = Math.max(n, o.trigger.index);
    });
  });
  return Math.min(3, n) as 0 | 1 | 2 | 3;
}

// ── Party and inventory ─────────────────────────────────────────────────────

const maxHpAt = (id: CharacterId, level: number): number => statsAt(CHARACTERS[id].baseStats, level).hp;

/** XP band of `level`: [start, next start − ε] (level 10: exactly MAX_XP). */
export function xpBand(level: number): [number, number] {
  const lo = xpForLevel(level);
  const hi = level >= MAX_LEVEL ? MAX_XP : xpForLevel(level + 1) - 1;
  return [lo, hi];
}

function sanitizeInventory(r: Repairs, raw: unknown): GameState['inventory'] & { moved: ItemId[] } {
  const inv = isPlainObject(raw) ? raw : (r.add('inventory', raw, 'default'), {});
  const glim = num(r, field(inv, 'glim'), 'inventory.glim', 0, 0, Number.MAX_SAFE_INTEGER, true);
  const itemsRaw = field(inv, 'items');
  const items: Partial<Record<ItemId, number>> = {};
  const moved: ItemId[] = [];
  if (!isPlainObject(itemsRaw)) r.add('inventory.items', itemsRaw, '{}');
  else {
    for (const [id, count] of Object.entries(itemsRaw)) {
      const path = `inventory.${id}`;
      if (!isKnownItem(id)) {
        r.note(`inventory.items: dropped ${show(id)}`);
        continue;
      }
      if (isEquipmentItem(id)) {
        if (typeof count === 'number' && count >= 1) moved.push(id);
        r.note(`${path}: equipment moved to ownedEquipment`);
        continue;
      }
      const cap = itemDef(id)?.kind === 'consumable' ? (itemDef(id)?.cap ?? CONSUMABLE_CAP) : Number.MAX_SAFE_INTEGER;
      items[id] = num(r, count, path, 0, 0, cap, true);
    }
  }
  const owned = idSet(r, field(inv, 'ownedEquipment'), 'inventory.ownedEquipment', (id) => isKnownItem(id) && isEquipmentItem(id));
  const ownedEquipment = [...new Set([...owned, ...moved])].sort() as ItemId[];
  return { glim, items, ownedEquipment, moved };
}

function sanitizeParty(r: Repairs, raw: unknown, owned: readonly ItemId[], def: GameState['party']): GameState['party'] {
  if (!isPlainObject(raw)) {
    r.add('party', raw, 'New Game');
    return def;
  }
  let joined = idSet(r, field(raw, 'joined'), 'party.joined', (id) => (CHARACTER_IDS as readonly string[]).includes(id)) as CharacterId[];
  if (joined.length === 0) {
    r.note('party.joined: empty → kairen');
    joined = ['kairen'];
  }
  const activeRaw = field(raw, 'active');
  let active: CharacterId;
  if (typeof activeRaw === 'string' && (joined as string[]).includes(activeRaw)) active = activeRaw as CharacterId;
  else {
    active = joined.includes('kairen') ? 'kairen' : joined[0];
    r.add('party.active', activeRaw, active);
  }
  const level = num(r, field(raw, 'level'), 'party.level', 1, 1, MAX_LEVEL, true);
  const [lo, hi] = xpBand(level);
  const xpRaw = field(raw, 'xp');
  let xp = num(r, xpRaw, 'party.xp', lo, 0, MAX_XP);
  if (levelFromXp(xp) !== level) {
    const fixed = Math.min(hi, Math.max(lo, xp));
    r.add('party.xp', xp, fixed);
    xp = fixed;
  }

  const hpRaw = sub(r, raw, 'hp', 'party.hp');
  const hp = {} as Record<CharacterId, number>;
  for (const id of CHARACTER_IDS) {
    const max = maxHpAt(id, level);
    hp[id] = num(r, field(hpRaw, id), `party.hp.${id}`, max, 0, max);
  }
  const downed = idSet(r, field(raw, 'downed'), 'party.downed', (id) => (joined as string[]).includes(id)) as CharacterId[];

  const upRaw = sub(r, raw, 'upgrades', 'party.upgrades');
  const upgrades = {} as GameState['party']['upgrades'];
  for (const id of CHARACTER_IDS) {
    const u = isPlainObject(field(upRaw, id)) ? (field(upRaw, id) as Obj) : (r.add(`party.upgrades.${id}`, field(upRaw, id), 'default'), {});
    upgrades[id] = {
      skill: num(r, field(u, 'skill'), `party.upgrades.${id}.skill`, 0, 0, 3, true) as 0 | 1 | 2 | 3,
      burst: num(r, field(u, 'burst'), `party.upgrades.${id}.burst`, 0, 0, 3, true) as 0 | 1 | 2 | 3,
    };
  }

  const ownedSet = new Set<string>(owned);
  const eqRaw = sub(r, raw, 'equipment', 'party.equipment');
  const equipment = {} as GameState['party']['equipment'];
  const charmsWorn = new Set<string>();
  const slotItem = (v: unknown, path: string, fits: (id: string) => boolean): ItemId | null => {
    if (v === null) return null;
    if (typeof v === 'string' && isKnownItem(v) && fits(v) && ownedSet.has(v)) return v;
    r.add(path, v, null);
    return null;
  };
  for (const id of CHARACTER_IDS) {
    const e = isPlainObject(field(eqRaw, id)) ? (field(eqRaw, id) as Obj) : (r.add(`party.equipment.${id}`, field(eqRaw, id), 'default'), { weapon: null, charm: null });
    const weapon = slotItem(field(e, 'weapon') ?? null, `party.equipment.${id}.weapon`, (x) => itemDef(x)?.kind === 'weapon' && itemDef(x)?.character === id);
    let charm = slotItem(field(e, 'charm') ?? null, `party.equipment.${id}.charm`, (x) => itemDef(x)?.kind === 'charm');
    if (charm !== null && charmsWorn.has(charm)) {
      r.add(`party.equipment.${id}.charm`, charm, null);
      charm = null;
    }
    if (charm !== null) charmsWorn.add(charm);
    equipment[id] = { weapon, charm };
  }
  const relic = slotItem(field(raw, 'relic') ?? null, 'party.relic', (x) => itemDef(x)?.kind === 'relic');
  return { joined, active, level, xp, hp, downed, upgrades, equipment, relic };
}

// ── Whole state ─────────────────────────────────────────────────────────────

const statKeys = ['playTimeSec', 'enemiesDefeated', 'reactions', 'chestsOpened', 'placesDiscovered', 'questsCompleted', 'partyWipes'] as const;

function sanitizeVictory(r: Repairs, v: unknown): GameState['victory'] {
  if (v === null) return null;
  const bad = (): null => {
    r.add('victory', v, null);
    return null;
  };
  if (!isPlainObject(v)) return bad();
  const n = (x: unknown, integer: boolean): number | null =>
    typeof x === 'number' && Number.isFinite(x) && x >= 0 && (!integer || Number.isInteger(x)) ? x : null;
  const pair = (x: unknown): [number, number] | null =>
    Array.isArray(x) && x.length === 2 && n(x[0], true) !== null && n(x[1], true) !== null && (x[0] as number) <= (x[1] as number)
      ? [x[0] as number, x[1] as number]
      : null;
  const playTimeSec = n(field(v, 'playTimeSec'), false);
  const enemiesDefeated = n(field(v, 'enemiesDefeated'), true);
  const quests = n(field(v, 'quests'), true);
  const level = n(field(v, 'level'), true);
  const places = pair(field(v, 'places'));
  const chests = pair(field(v, 'chests'));
  const up = field(v, 'upgrades');
  if (playTimeSec === null || enemiesDefeated === null || quests === null || level === null || level < 1 || level > MAX_LEVEL) return bad();
  if (places === null || chests === null || !isPlainObject(up)) return bad();
  const upgrades = {} as Record<CharacterId, number>;
  for (const id of CHARACTER_IDS) {
    const u = n(field(up, id), true);
    if (u === null || u > 6) return bad();
    upgrades[id] = u;
  }
  return { playTimeSec, enemiesDefeated, places, quests, chests, level, upgrades };
}

function sanitizeLastSafe(r: Repairs, v: unknown, respawn: GameState['respawn']): GameState['lastSafe'] {
  if (v === null) return null;
  const pos = isPlainObject(v) ? field(v, 'pos') : undefined;
  const yaw = isPlainObject(v) ? field(v, 'yaw') : undefined;
  const ok =
    Array.isArray(pos) && pos.length === 3 && pos.every((c) => typeof c === 'number' && Number.isFinite(c)) &&
    Math.abs(pos[0] as number) <= WORLD_HALF_EXTENT && Math.abs(pos[2] as number) <= WORLD_HALF_EXTENT &&
    typeof yaw === 'number' && Number.isFinite(yaw);
  if (ok) return { pos: [pos[0] as number, pos[1] as number, pos[2] as number], yaw: yaw as number };
  const spot = respawnPointSpot(respawn);
  const fixed: GameState['lastSafe'] = { pos: [spot.x, spot.groundY, spot.z], yaw: spot.yaw };
  r.add('lastSafe', v, 'respawn point');
  return fixed;
}

/** Any value → a valid canonical GameState plus the repairs made. */
export function sanitizeGameState(raw: unknown, defs: readonly QuestDef[] = QUESTS): SanitizeResult {
  const r = new Repairs();
  let src: Obj;
  if (isPlainObject(raw)) src = raw;
  else {
    r.add('state', raw, 'New Game');
    src = {};
  }
  const seedRaw = field(src, 'seed');
  const seed = typeof seedRaw === 'number' && Number.isInteger(seedRaw) && seedRaw >= 0 && seedRaw <= 0xffffffff ? seedRaw : (r.add('seed', seedRaw, 0), 0);
  const def = createNewGameState(seed, { quests: defs });

  const quests = sanitizeQuests(r, field(src, 'quests'), defs, def.quests);
  const shardRaw = num(r, field(src, 'skyshards'), 'skyshards', 0, 0, 3, true);
  const implied = skyshardsForQuest(quests.main, defs);
  if (shardRaw !== implied) r.add('skyshards', shardRaw, implied);

  const inventory = sanitizeInventory(r, field(src, 'inventory'));
  const party = sanitizeParty(r, field(src, 'party'), inventory.ownedEquipment, def.party);

  const discRaw = sub(r, src, 'discovery', 'discovery');
  const fogRaw = field(discRaw, 'fog');
  let fog = def.discovery.fog;
  if (typeof fogRaw === 'string' && FogOfWar.decode(fogRaw).encode() === fogRaw) fog = fogRaw;
  else r.add('discovery.fog', fogRaw, 'hidden');
  const discovery: GameState['discovery'] = {
    regions: idSet(r, field(discRaw, 'regions'), 'discovery.regions', (id) => REGION_SET.has(id)) as GameState['discovery']['regions'],
    landmarks: idSet(r, field(discRaw, 'landmarks'), 'discovery.landmarks', (id) => LANDMARK_SET.has(id)) as GameState['discovery']['landmarks'],
    pois: idSet(r, field(discRaw, 'pois'), 'discovery.pois', isKnownPoi),
    hiddenPlaces: idSet(r, field(discRaw, 'hiddenPlaces'), 'discovery.hiddenPlaces', isKnownHiddenPlace),
    fog,
  };

  const worldRaw = sub(r, src, 'world', 'world');
  const puzzles = puzzleIds(seed);
  const world: GameState['world'] = {
    waystones: idSet(r, field(worldRaw, 'waystones'), 'world.waystones', (id) => WAYSTONE_SET.has(id)) as GameState['world']['waystones'],
    chests: idSet(r, field(worldRaw, 'chests'), 'world.chests', isKnownChest),
    puzzles: idSet(r, field(worldRaw, 'puzzles'), 'world.puzzles', (id) => puzzles.has(id)),
    camps: idSet(r, field(worldRaw, 'camps'), 'world.camps', isKnownCamp),
    elites: idSet(r, field(worldRaw, 'elites'), 'world.elites', (id) => ELITE_SET.has(id)) as GameState['world']['elites'],
    echoTablets: idSet(r, field(worldRaw, 'echoTablets'), 'world.echoTablets', isKnownTablet),
    flags: boolRecord(r, field(worldRaw, 'flags'), 'world.flags'),
  };

  const respawnRaw = field(src, 'respawn');
  let respawn = def.respawn;
  if (isPlainObject(respawnRaw) && isKnownRespawn(field(respawnRaw, 'kind'), field(respawnRaw, 'id'))) {
    respawn = { kind: field(respawnRaw, 'kind') as GameState['respawn']['kind'], id: field(respawnRaw, 'id') as string };
  } else r.add('respawn', respawnRaw, def.respawn.id);

  const cpRaw = field(src, 'checkpoint');
  let checkpoint: GameState['checkpoint'] = null;
  if (cpRaw !== null) {
    const area = isPlainObject(cpRaw) ? field(cpRaw, 'area') : undefined;
    const id = isPlainObject(cpRaw) ? field(cpRaw, 'id') : undefined;
    if (isKnownCheckpoint(area, id)) checkpoint = { area, id: id as string };
    else r.add('checkpoint', cpRaw, null);
  }

  const bossRaw = field(src, 'boss');
  let boss: GameState['boss'] = null;
  if (bossRaw !== null) {
    const phase = isPlainObject(bossRaw) ? field(bossRaw, 'reachedPhase') : undefined;
    if (phase === 1 || phase === 2 || phase === 3) boss = { reachedPhase: phase };
    else r.add('boss', bossRaw, null);
  }

  const statsRaw = sub(r, src, 'stats', 'stats');
  const stats = {} as GameState['stats'];
  for (const k of statKeys) stats[k] = num(r, field(statsRaw, k), `stats.${k}`, 0, 0, Number.MAX_SAFE_INTEGER, k !== 'playTimeSec');

  const state: GameState = {
    seed,
    createdAt: str(r, src, 'createdAt', 'createdAt', UNDATED_CREATED_AT),
    quests,
    skyshards: implied,
    altarActivated: bool(r, src, 'altarActivated', 'altarActivated', false),
    bossDefeated: bool(r, src, 'bossDefeated', 'bossDefeated', false),
    gameCompleted: bool(r, src, 'gameCompleted', 'gameCompleted', false),
    party,
    inventory: { glim: inventory.glim, items: inventory.items, ownedEquipment: inventory.ownedEquipment },
    discovery,
    world,
    codex: idSet(r, field(src, 'codex'), 'codex', (id) => REACTION_SET.has(id)) as GameState['codex'],
    tutorials: idSet(r, field(src, 'tutorials'), 'tutorials', isKnownTutorial),
    cinematicsSeen: idSet(r, field(src, 'cinematicsSeen'), 'cinematicsSeen', isKnownCinematic),
    respawn,
    lastSafe: sanitizeLastSafe(r, field(src, 'lastSafe'), respawn),
    checkpoint,
    boss,
    stats,
    victory: sanitizeVictory(r, field(src, 'victory')),
    debugUsed: bool(r, src, 'debugUsed', 'debugUsed', false),
  };
  return { state: canonicalizeGameState(state), repairs: r.lines };
}
