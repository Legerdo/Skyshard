/*
 * Save version migrations (design "검사", Req 36.11): `MIGRATIONS[v]` turns a version-v save state into version v+1.
 * `migrate` applies them in a chain up to SAVE_VERSION; a missing step or a step that throws makes it throw, and
 * loadSave treats that like corrupt data (backup, then quarantine). Version 1 is the first released schema, so the
 * table is empty today; the next schema change adds `1: (v1) => v2` here and bumps SAVE_VERSION. Pure.
 */
import { SAVE_VERSION } from './gameState';

export type Migration = (old: unknown) => unknown;

/** Version v → v + 1. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = Object.freeze({});

/**
 * `raw` (a version `fromVersion` state) migrated to `toVersion` through `table`. Throws for a version that is not an
 * integer in [1, toVersion] or a missing step. `table` / `toVersion` are injectable so the chain logic is testable
 * before the first real migration exists.
 */
export function migrate(raw: unknown, fromVersion: number, table: Readonly<Record<number, Migration>> = MIGRATIONS, toVersion: number = SAVE_VERSION): unknown {
  if (!Number.isInteger(fromVersion) || fromVersion < 1 || fromVersion > toVersion) {
    throw new Error(`save version ${String(fromVersion)} cannot be migrated to ${toVersion}`);
  }
  let data = raw;
  for (let v = fromVersion; v < toVersion; v++) {
    const step = table[v];
    if (typeof step !== 'function') throw new Error(`no migration from save version ${v}`);
    data = step(data);
  }
  return data;
}
