/*
 * View model of the Caelith boss bar (design "적·보스 표시"; Req 6.11, 32.6), read from `BossEncounter.snapshot`:
 * the name in capitals with its subtitle, the Phase, the HP fraction and the Phase notches at 65 % / 30 %, and while
 * a Starshell stands its Element and durability fraction. Pure (no DOM), so the rules are unit-tested; ./bossBar
 * draws it. Proper nouns (CAELITH, Phase, Starshell, Element names) stay English (Req 35.4).
 */
import type { BossSnapshot } from '../boss/bossSnapshot';
import { CAELITH } from '../data/boss';
import { ELEMENT_DEFS, type ElementIconShape } from '../data/elements';
import type { ElementId } from '../data/ids';

export interface BossBarStarshell {
  readonly element: ElementId;
  readonly elementName: string;
  readonly icon: ElementIconShape;
  /** CSS colour of the Element. */
  readonly color: string;
  /** Durability / max in [0, 1]. */
  readonly fraction: number;
  /** "Starshell 800 / 1200". */
  readonly text: string;
}

export interface BossBarModel {
  /** "CAELITH". */
  readonly title: string;
  /** "추락한 별의 수호자". */
  readonly subtitle: string;
  /** "Phase 1", "Phase 2", "Final Phase". */
  readonly phaseLabel: string;
  /** HP / max HP in [0, 1]. */
  readonly hpFraction: number;
  /** HP ratios of the Phase notches along the bar, in (0, 1): 0.65 and 0.30. */
  readonly notches: readonly number[];
  /** Null unless a Starshell stands. */
  readonly starshell: BossBarStarshell | null;
  /** Damage taken ×1.5 now (the bar glows). */
  readonly vulnerable: boolean;
}

/** States in which the bar shows: the fight itself, not before (dormant, intro) or after it (dead). */
const HIDDEN_STATES: ReadonlySet<BossSnapshot['state']> = new Set<BossSnapshot['state']>(['dormant', 'intro', 'dead']);

/** `value / max` clamped to [0, 1]; 0 for a non-positive max or a non-finite value. */
export function barFraction(value: number, max: number): number {
  if (!(max > 0) || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value / max));
}

const PHASE_LABEL: Readonly<Record<BossSnapshot['phase'], string>> = { 1: 'Phase 1', 2: 'Phase 2', 3: 'Final Phase' };

/** The bar for `snapshot`, or null while the boss is not fighting (the bar hides). */
export function bossBarModel(snapshot: BossSnapshot | null): BossBarModel | null {
  if (snapshot === null || HIDDEN_STATES.has(snapshot.state)) return null;
  const shell = snapshot.starshell;
  let starshell: BossBarStarshell | null = null;
  if (shell !== null) {
    const def = ELEMENT_DEFS[shell.element];
    const durability = Math.max(0, Math.ceil(shell.durability));
    starshell = {
      element: shell.element,
      elementName: def.name,
      icon: def.icon,
      color: def.cssColor,
      fraction: barFraction(shell.durability, shell.max),
      text: `Starshell ${durability} / ${shell.max}`,
    };
  }
  return {
    title: snapshot.name.toUpperCase(),
    subtitle: snapshot.name === CAELITH.name ? CAELITH.epithet : '',
    phaseLabel: PHASE_LABEL[snapshot.phase],
    hpFraction: barFraction(snapshot.hp, snapshot.maxHp),
    notches: snapshot.thresholds.filter((t) => t > 0 && t < 1),
    starshell,
    vulnerable: snapshot.vulnerable,
  };
}
