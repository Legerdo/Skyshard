// Element_System application and Reaction effects (design "Reaction 효과", "확산과 연쇄", "반응 예고와 도감";
// Req 25.5–25.7, 25.9, 25.13). Every Element a hit (or the environment) applies to a combat target goes through
// `apply`, which runs logic/element resolveSpread over all targets of the host, so spread and chain reactions
// happen in the same frame, then executes each reaction's effect around the reacting target:
// - steamBurst: 3 m blast. The target takes 150% of the trigger hit's final damage, other enemies in the blast 60%;
//   everyone in it is staggered for 1 s; Hit_Stop 70 ms (setTimeScale('hitStop', 0, 0.07), once per application).
// - lavaRift: a 3 m lava zone under the target for 4 s; every 0.5 s each enemy inside takes 25% of the reactor's
//   ATK (computeDamage kind 'dot'). Listed in RuntimeState.zones while it burns.
// - mudBind: every enemy within 4 m cannot move for 2.5 s.
// - flameSpread / sandGust: the mark spreads (resolveSpread) and every enemy within 5 m takes 80% of the reactor's
//   ATK (kind 'reaction'); mistSpread: the mark spreads and every enemy within 5 m is slowed by 40% for 3 s.
// Each reaction then goes out as 'reaction' (reaction, target, position, chain depth): its VFX, sound and Korean
// name at the target (REACTION_PRESENTATION), Energy +5 for the Active_Character (PlayerCombat) and the harness log
// listen to it. A reaction seen for the first time is added to GameState.codex once. When one application chains
// n ≥ 2 reactions, 'reaction:chain' (n) follows for the "연쇄 x{n}" display. Chain reactions use the trigger hit and
// reactor of the application that started them. No three.js or DOM.

import { copyV3, distance, type Vec3 } from '../core/math';
import type { ElementSource, GameEventBus } from '../core/gameEvents';
import type { TimeScaleSource } from '../core/loop';
import type { ElementId, EntityId, ReactionId } from '../data/ids';
import { REACTION_DEFS } from '../data/reactions';
import { resolveSpread, type ElementTarget, type ReactionEvent, type SpreadApplication } from '../logic/element';
import { chainLabel, reactionAtkDamage, triggerScaledDamage, type ReactorStats } from '../logic/reactionEffects';
import type { EffectZone } from '../save/runtimeState';

/** Slack when comparing accumulated tick time with zone tick times. */
const TIME_EPS = 1e-9;

/** A combat target as the Element_System sees it. */
export interface ReactionActor {
  readonly id: EntityId;
  /** Feet position (live values are fine; nothing is kept). */
  readonly pos: Readonly<Vec3>;
  readonly alive: boolean;
  /** DEF for ATK-based reaction damage. */
  readonly def: number;
  readonly element: ElementTarget;
}

/** What the reaction effects act on (the EnemySystem's enemies). Calls on dead or unknown ids are ignored. */
export interface ReactionHost {
  /** Every current target, in a stable order. */
  actors(): readonly ReactionActor[];
  setElement(id: EntityId, next: ElementTarget): void;
  /** Reaction damage (no Element, no crit). `element` only colours the damage number. */
  damage(id: EntityId, amount: number, element: ElementId | null): void;
  /** Stagger for `seconds` from now (steamBurst). */
  stagger(id: EntityId, seconds: number): void;
  /** No movement until sim time `until` (mudBind). */
  root(id: EntityId, until: number): void;
  /** Move speed × `mul` until sim time `until` (mistSpread). */
  slow(id: EntityId, mul: number, until: number): void;
}

/** The hit that applied the Element. */
export interface ReactionTrigger {
  /** Final damage of the hit (steamBurst's 150% / 60%); 0 when the Element came without damage. */
  damage: number;
  /** Stats of the character who applied it (ATK-based reaction damage); null: none (environment). */
  reactor: ReactorStats | null;
}

export interface ReactionSystemOptions {
  bus: GameEventBus;
  host: ReactionHost;
  /** Sim clock (s): marks, rate limits and zones. */
  now(): number;
  /** GameState.codex: each ReactionId is appended the first time it occurs (Req 25.13). */
  codex?: ReactionId[];
  /** GameLoop.setTimeScale for steamBurst's Hit_Stop; omitted headless. */
  setTimeScale?: (source: TimeScaleSource, scale: number, realSeconds: number) => void;
  /** RuntimeState.zones: lava rifts are listed here while they burn. */
  zones?: EffectZone[];
}

export interface ReactionReport {
  /** Reactions in chain order (the direct one first, chainDepth 1). */
  reactions: ReactionEvent[];
  /** Spread applications to other targets. */
  applied: SpreadApplication[];
  /** Reactions from this application ("연쇄 x{n}" when ≥ 2). */
  chainCount: number;
}

/** A burning lava rift. */
export interface LavaZone {
  readonly id: EntityId;
  readonly pos: Vec3;
  readonly radius: number;
  /** Burns while now < until (a tick exactly at `until` still lands). */
  readonly until: number;
  /** Sim time of the next damage tick. */
  nextTickAt: number;
  readonly reactor: ReactorStats | null;
}

const EMPTY_REPORT: ReactionReport = { reactions: [], applied: [], chainCount: 0 };

export class ReactionSystem {
  private readonly o: ReactionSystemOptions;
  private readonly lava: LavaZone[] = [];
  private serial = 0;

  constructor(options: ReactionSystemOptions) {
    this.o = options;
  }

  /** Lava rifts burning now. */
  get lavaZones(): readonly Readonly<LavaZone>[] {
    return this.lava;
  }

  /**
   * Applies `el` from `source` to `targetId` with spread and chains, stores every changed Element state through
   * the host, emits 'element:applied' (the direct application with `source`, spread ones with 'reaction'), runs each
   * reaction's effect and emits 'reaction', then 'reaction:chain' for n ≥ 2. A dead or unknown target: nothing.
   */
  apply(targetId: EntityId, el: ElementId, source: ElementSource, trigger: ReactionTrigger | null): ReactionReport {
    const { bus, host } = this.o;
    const now = this.o.now();
    const actors = host.actors();
    const start = actors.find((a) => a.id === targetId);
    if (start === undefined || !start.alive) return EMPTY_REPORT;
    const res = resolveSpread(
      actors.map((a) => ({ id: a.id, pos: a.pos, alive: a.alive, element: a.element })),
      targetId,
      el,
      now,
    );
    res.targets.forEach((t, i) => {
      if (t.element !== actors[i]?.element) host.setElement(t.id, t.element);
    });
    bus.emit('element:applied', { targetId, element: el, source });
    for (const a of res.applied) bus.emit('element:applied', { targetId: a.targetId, element: a.element, source: 'reaction' });
    let hitStop = false;
    for (const ev of res.reactions) {
      hitStop = this.execute(ev, trigger, now) || hitStop;
      bus.emit('reaction', ev);
      this.record(ev.reaction);
    }
    if (hitStop) {
      const burst = REACTION_DEFS.steamBurst.effect;
      if (burst.kind === 'burst') this.o.setTimeScale?.('hitStop', 0, burst.hitStop);
    }
    const first = res.reactions[0];
    if (first !== undefined && chainLabel(res.chainCount) !== null) {
      bus.emit('reaction:chain', { count: res.chainCount, targetId, position: copyV3(first.position) });
    }
    return { reactions: res.reactions, applied: res.applied, chainCount: res.chainCount };
  }

  /**
   * Lava rift damage ticks due by now (`frozen`: the ticks pass without damage, as during a cinematic); burnt-out
   * rifts are removed (also from RuntimeState.zones).
   */
  tick(frozen = false): void {
    if (this.lava.length === 0) return;
    const now = this.o.now();
    const { host } = this.o;
    for (const z of this.lava) {
      const effect = REACTION_DEFS.lavaRift.effect;
      if (effect.kind !== 'zone') break;
      while (z.nextTickAt <= Math.min(now, z.until) + TIME_EPS) {
        if (z.reactor !== null && !frozen) {
          for (const a of this.around(z.pos, z.radius)) {
            host.damage(a.id, reactionAtkDamage(z.reactor, effect.tickAtkMul, a.def, 'dot'), 'ember');
          }
        }
        z.nextTickAt += effect.tickInterval;
      }
    }
    const burnt = new Set(this.lava.filter((z) => now >= z.until - TIME_EPS).map((z) => z.id));
    if (burnt.size === 0) return;
    this.lava.splice(0, this.lava.length, ...this.lava.filter((z) => !burnt.has(z.id)));
    const zones = this.o.zones;
    if (zones !== undefined) zones.splice(0, zones.length, ...zones.filter((z) => !burnt.has(z.id)));
  }

  /** Drops every lava rift (Party_Wipe restart, reload). */
  clear(): void {
    const ids = new Set(this.lava.map((z) => z.id));
    this.lava.length = 0;
    const zones = this.o.zones;
    if (zones !== undefined) zones.splice(0, zones.length, ...zones.filter((z) => !ids.has(z.id)));
  }

  /** One reaction's effect around its target; returns whether it asks for the Hit_Stop. */
  private execute(ev: ReactionEvent, trigger: ReactionTrigger | null, now: number): boolean {
    const { host } = this.o;
    const def = REACTION_DEFS[ev.reaction];
    const effect = def.effect;
    const near = this.around(ev.position, def.radius);
    switch (effect.kind) {
      case 'burst': {
        const hit = trigger?.damage ?? 0;
        for (const a of near) {
          const amount = triggerScaledDamage(hit, a.id === ev.targetId ? effect.bonusMul : effect.splashMul);
          if (amount > 0) host.damage(a.id, amount, null);
        }
        for (const a of near) host.stagger(a.id, effect.stagger);
        return true;
      }
      case 'zone': {
        this.serial += 1;
        const zone: LavaZone = {
          id: `${ev.reaction}_${this.serial}`,
          pos: copyV3(ev.position),
          radius: def.radius,
          until: now + effect.seconds,
          nextTickAt: now + effect.tickInterval,
          reactor: trigger?.reactor ?? null,
        };
        this.lava.push(zone);
        this.o.zones?.push({
          id: zone.id, source: ev.reaction, owner: ev.targetId, pos: copyV3(zone.pos), radius: zone.radius, until: zone.until,
        });
        return false;
      }
      case 'root':
        for (const a of near) host.root(a.id, now + effect.seconds);
        return false;
      case 'spread': {
        const reactor = trigger?.reactor ?? null;
        if (effect.atkMul !== null && reactor !== null) {
          for (const a of near) host.damage(a.id, reactionAtkDamage(reactor, effect.atkMul, a.def, 'reaction'), def.spreads);
        }
        if (effect.slow !== null) for (const a of near) host.slow(a.id, 1 - effect.slow.pct, now + effect.slow.seconds);
        return false;
      }
    }
  }

  /** Living targets within `radius` of `center` (3D distance, inclusive), in host order. */
  private around(center: Readonly<Vec3>, radius: number): ReactionActor[] {
    return this.o.host.actors().filter((a) => a.alive && distance(center, a.pos) <= radius);
  }

  /** First occurrence of `r`: add it to the codex once. */
  private record(r: ReactionId): void {
    const codex = this.o.codex;
    if (codex !== undefined && !codex.includes(r)) codex.push(r);
  }
}
