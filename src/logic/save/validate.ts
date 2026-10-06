/*
 * validateGameState (design "인터페이스"): the schema and content rules a GameState must meet to be played, as a list
 * of violations (empty: valid). Written independently of sanitizeGameState so the property tests cross-check the two:
 * whatever sanitize returns must pass here. Pure.
 */
import { CHARACTERS } from '../../data/characters';
import { CHARACTER_IDS, SIDE_QUEST_IDS } from '../../data/ids';
import { CONSUMABLE_CAP } from '../../data/items';
import { MAX_LEVEL } from '../../data/progression';
import { QUESTS } from '../../data/quests';
import { FogOfWar } from '../fogOfWar';
import { levelFromXp, MAX_XP, statsAt } from '../progression';
import type { QuestDef } from '../quest/types';
import {
  ELITE_SET, isKnownCamp, isKnownCheckpoint, isKnownChest, isKnownCinematic, isKnownHiddenPlace, isKnownItem, isKnownPoi,
  isKnownRespawn, isKnownTablet, isKnownTutorial, itemDef, LANDMARK_SET, puzzleIds, REACTION_SET, REGION_SET, WAYSTONE_SET,
  WORLD_HALF_EXTENT,
} from './contentIds';
import type { GameState } from './gameState';
import { skyshardsForQuest } from './sanitize';

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isFin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function validateGameState(gs: GameState, defs: readonly QuestDef[] = QUESTS): string[] {
  const out: string[] = [];
  const need = (ok: boolean, msg: string): void => {
    if (!ok) out.push(msg);
  };
  const ids = (list: unknown, name: string, known: (id: string) => boolean): void => {
    if (!Array.isArray(list)) {
      out.push(`${name} is not an array`);
      return;
    }
    for (const id of list) need(typeof id === 'string' && known(id), `${name}: unknown id ${String(id)}`);
  };
  try {
    need(isInt(gs.seed) && gs.seed >= 0 && gs.seed <= 0xffffffff, 'seed out of range');
    need(typeof gs.createdAt === 'string', 'createdAt not a string');

    // Quests
    const main = defs.find((d) => d.id === 'main');
    const q = gs.quests;
    need(isInt(q.main.stage) && q.main.stage >= 0 && q.main.stage < (main?.stages.length ?? 1), 'quests.main.stage out of range');
    const stage = main?.stages[q.main.stage];
    need(isInt(q.main.objective) && q.main.objective >= 0 && q.main.objective < (stage?.objectives.length ?? 1), 'quests.main.objective out of range');
    need(typeof q.main.done === 'boolean', 'quests.main.done not boolean');
    for (const id of SIDE_QUEST_IDS) {
      const s = q.side[id];
      need(s !== undefined && ['locked', 'available', 'active', 'done'].includes(s.status), `quests.side.${id}.status invalid`);
      need(s !== undefined && isInt(s.stage) && s.stage >= 0 && isInt(s.objective) && s.objective >= 0, `quests.side.${id} position invalid`);
    }
    need(q.tracked === 'main' || q.side[q.tracked]?.status === 'active', 'quests.tracked is not main or an active Side_Quest');
    need(Object.values(q.flags).every((v) => typeof v === 'boolean'), 'quests.flags not boolean');

    need([0, 1, 2, 3].includes(gs.skyshards), 'skyshards out of 0–3');
    need(gs.skyshards === skyshardsForQuest(q.main, defs), 'skyshards disagree with the Main_Quest position');
    for (const k of ['altarActivated', 'bossDefeated', 'gameCompleted', 'debugUsed'] as const) need(typeof gs[k] === 'boolean', `${k} not boolean`);

    // Party
    const p = gs.party;
    need(p.joined.length > 0, 'party.joined empty');
    ids(p.joined, 'party.joined', (id) => (CHARACTER_IDS as readonly string[]).includes(id));
    need(p.joined.includes(p.active), 'party.active not joined');
    need(isInt(p.level) && p.level >= 1 && p.level <= MAX_LEVEL, 'party.level out of 1–10');
    need(isFin(p.xp) && p.xp >= 0 && p.xp <= MAX_XP && levelFromXp(p.xp) === p.level, 'party.xp outside the level band');
    for (const id of CHARACTER_IDS) {
      const max = statsAt(CHARACTERS[id].baseStats, p.level).hp;
      need(isFin(p.hp[id]) && p.hp[id] >= 0 && p.hp[id] <= max, `party.hp.${id} out of 0–max`);
      const u = p.upgrades[id];
      need(u !== undefined && [0, 1, 2, 3].includes(u.skill) && [0, 1, 2, 3].includes(u.burst), `party.upgrades.${id} out of 0–3`);
      const e = p.equipment[id];
      need(e !== undefined, `party.equipment.${id} missing`);
      if (e?.weapon != null) {
        need(itemDef(e.weapon)?.kind === 'weapon' && itemDef(e.weapon)?.character === id, `party.equipment.${id}.weapon does not fit`);
        need(gs.inventory.ownedEquipment.includes(e.weapon), `party.equipment.${id}.weapon not owned`);
      }
      if (e?.charm != null) {
        need(itemDef(e.charm)?.kind === 'charm', `party.equipment.${id}.charm is not a Charm`);
        need(gs.inventory.ownedEquipment.includes(e.charm), `party.equipment.${id}.charm not owned`);
      }
    }
    const charms = CHARACTER_IDS.map((id) => p.equipment[id]?.charm).filter((c) => c != null);
    need(new Set(charms).size === charms.length, 'a Charm is worn by two characters');
    need(p.downed.every((id) => p.joined.includes(id)), 'party.downed not joined');
    if (p.relic !== null) {
      need(itemDef(p.relic)?.kind === 'relic', 'party.relic is not a Relic');
      need(gs.inventory.ownedEquipment.includes(p.relic), 'party.relic not owned');
    }

    // Inventory
    need(isInt(gs.inventory.glim) && gs.inventory.glim >= 0, 'inventory.glim negative or fractional');
    for (const [id, n] of Object.entries(gs.inventory.items)) {
      const def = itemDef(id);
      need(isKnownItem(id) && (def?.kind === 'consumable' || def?.kind === 'material'), `inventory.items: ${id} is not a stack item`);
      const cap = def?.kind === 'consumable' ? (def.cap ?? CONSUMABLE_CAP) : Number.MAX_SAFE_INTEGER;
      need(isInt(n) && n >= 0 && n <= cap, `inventory.${id} out of 0–${cap}`);
    }
    ids(gs.inventory.ownedEquipment, 'inventory.ownedEquipment', (id) => {
      const k = itemDef(id)?.kind;
      return k === 'weapon' || k === 'charm' || k === 'relic';
    });

    // Discovery and world
    ids(gs.discovery.regions, 'discovery.regions', (id) => REGION_SET.has(id));
    ids(gs.discovery.landmarks, 'discovery.landmarks', (id) => LANDMARK_SET.has(id));
    ids(gs.discovery.pois, 'discovery.pois', isKnownPoi);
    ids(gs.discovery.hiddenPlaces, 'discovery.hiddenPlaces', isKnownHiddenPlace);
    need(typeof gs.discovery.fog === 'string' && FogOfWar.decode(gs.discovery.fog).encode() === gs.discovery.fog, 'discovery.fog is not a fog bitset');
    const puzzles = puzzleIds(gs.seed);
    ids(gs.world.waystones, 'world.waystones', (id) => WAYSTONE_SET.has(id));
    ids(gs.world.chests, 'world.chests', isKnownChest);
    ids(gs.world.puzzles, 'world.puzzles', (id) => puzzles.has(id));
    ids(gs.world.camps, 'world.camps', isKnownCamp);
    ids(gs.world.elites, 'world.elites', (id) => ELITE_SET.has(id));
    ids(gs.world.echoTablets, 'world.echoTablets', isKnownTablet);
    need(Object.values(gs.world.flags).every((v) => typeof v === 'boolean'), 'world.flags not boolean');
    ids(gs.codex, 'codex', (id) => REACTION_SET.has(id));
    ids(gs.tutorials, 'tutorials', isKnownTutorial);
    ids(gs.cinematicsSeen, 'cinematicsSeen', isKnownCinematic);

    // Places
    need(isKnownRespawn(gs.respawn.kind, gs.respawn.id), 'respawn point unknown');
    if (gs.lastSafe !== null) {
      const [x, y, z] = gs.lastSafe.pos;
      need([x, y, z, gs.lastSafe.yaw].every(isFin) && Math.abs(x) <= WORLD_HALF_EXTENT && Math.abs(z) <= WORLD_HALF_EXTENT, 'lastSafe not a finite in-world pose');
    }
    if (gs.checkpoint !== null) need(isKnownCheckpoint(gs.checkpoint.area, gs.checkpoint.id), 'checkpoint unknown');
    if (gs.boss !== null) need([1, 2, 3].includes(gs.boss.reachedPhase), 'boss.reachedPhase out of 1–3');

    // Stats
    for (const [k, v] of Object.entries(gs.stats)) {
      need(isFin(v) && v >= 0 && (k === 'playTimeSec' || Number.isInteger(v)), `stats.${k} invalid`);
    }
    if (gs.victory !== null) {
      const v = gs.victory;
      need(isFin(v.playTimeSec) && v.playTimeSec >= 0, 'victory.playTimeSec invalid');
      need(isInt(v.level) && v.level >= 1 && v.level <= MAX_LEVEL, 'victory.level invalid');
      need(v.places[0] <= v.places[1] && v.chests[0] <= v.chests[1], 'victory counts invalid');
    }
  } catch (err) {
    out.push(`shape: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}
