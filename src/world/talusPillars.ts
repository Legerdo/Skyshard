// Talus's stone pillar (Skill 암석 방벽, data/characters/talus `pillar*` params; design "캐릭터 키트", Req 13.1): when the
// Skill reaches its hit (PlayerCombat `onAbilityHit`), a pillar rises `pillarDistance` m ahead of Talus on the ground
// there and stands `pillarSeconds` s. It is a walkable-topped dynamic collider (nobody climbs it) and a weight on
// pressure plates, which is how a plate stays held while the party walks away (pz_azure_2, Hollowroot R3). At most
// `pillars` stand at once; a new cast replaces the oldest. Casts by other characters place nothing.
// The clock is the caller's tick, so pillars wait out fades and cinematics with the devices. Pure TypeScript.

import { copyV3, dirFromYaw } from '../core/math';
import type { Vec3 } from '../core/types';
import type { CharacterId } from '../data/ids';
import type { AbilityHit } from '../combat/playerCombat';
import type { Weight } from '../element/receiverField';
import type { ColliderIdSource } from '../physics/colliderIds';
import type { Collider, CollisionWorld } from '../physics/types';

/** The pillar's ground is searched from this far above the caster's feet down to this far below. */
const GROUND_PROBE_UP = 3;
const GROUND_PROBE_DOWN = 8;
/** Whose Skill raises pillars. */
const PILLAR_CASTER: CharacterId = 'talus';

/** One standing pillar (the render draws it; tests read it). */
export interface PillarView {
  readonly id: string;
  /** Base centre on the ground. */
  readonly pos: Vec3;
  readonly radius: number;
  readonly height: number;
  /** Seconds left standing. */
  readonly remaining: number;
}

interface Pillar {
  readonly id: string;
  readonly body: Collider & { kind: 'cylinder' };
  remaining: number;
}

export interface TalusPillarsOptions {
  world: Pick<CollisionWorld, 'upsertDynamic' | 'removeDynamic' | 'raycast'>;
  ids: ColliderIdSource;
}

export class TalusPillars {
  private readonly o: TalusPillarsOptions;
  private list: Pillar[] = [];
  private serial = 0;

  constructor(options: TalusPillarsOptions) {
    this.o = options;
  }

  /** PlayerCombat `onAbilityHit`: Talus's Skill raises a pillar ahead of him; returns whether one rose. */
  abilityHit(hit: AbilityHit): boolean {
    if (hit.characterId !== PILLAR_CASTER || hit.ability !== 'skill') return false;
    const p = hit.params;
    const distance = p.pillarDistance;
    const radius = p.pillarRadius;
    const height = p.pillarHeight;
    const seconds = p.pillarSeconds;
    if (!(distance >= 0 && radius > 0 && height > 0 && seconds > 0)) return false;
    const f = dirFromYaw(hit.origin.yaw);
    const x = hit.origin.pos.x + f.x * distance;
    const z = hit.origin.pos.z + f.z * distance;
    const top = hit.origin.pos.y + GROUND_PROBE_UP;
    const ground = this.o.world.raycast({ x, y: top, z }, { x: 0, y: -1, z: 0 }, GROUND_PROBE_UP + GROUND_PROBE_DOWN);
    if (ground === null) return false;
    this.serial += 1;
    const pillar: Pillar = {
      id: `pillar_${this.serial}`,
      body: {
        kind: 'cylinder', id: this.o.ids.next(), base: { x, y: ground.point.y, z }, radius, height,
        flags: { climbable: false, walkableTop: true, blocksCamera: false, material: 'stone' },
      },
      remaining: seconds,
    };
    if (!this.o.world.upsertDynamic(pillar.body)) return false;
    this.list.push(pillar);
    const max = Math.max(1, Math.floor(p.pillars ?? 1));
    while (this.list.length > max) this.drop(this.list[0]);
    return true;
  }

  /** Counts the pillars down; spent ones sink away. */
  tick(dt: number): void {
    if (!(Number.isFinite(dt) && dt > 0)) return;
    for (const pillar of [...this.list]) {
      pillar.remaining -= dt;
      if (pillar.remaining <= 1e-9) this.drop(pillar);
    }
  }

  /** The pillars as pressure-plate weights (their base points). */
  weights(): Weight[] {
    return this.list.map((p) => ({ id: p.id, pos: copyV3(p.body.base) }));
  }

  views(): PillarView[] {
    return this.list.map((p) => ({ id: p.id, pos: copyV3(p.body.base), radius: p.body.radius, height: p.body.height, remaining: p.remaining }));
  }

  /** Removes every pillar (Party_Wipe restart). */
  clear(): void {
    for (const pillar of [...this.list]) this.drop(pillar);
  }

  private drop(pillar: Pillar): void {
    this.o.world.removeDynamic(pillar.body.id);
    this.list = this.list.filter((p) => p !== pillar);
  }
}
