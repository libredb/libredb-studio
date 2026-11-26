/**
 * A reader of the committed grant register with some legacy rows' grants planted, for a test that mocks
 * `@libredb/grant-register` so a gate reads a legacy engine's claims from a row the case wrote.
 *
 * The test hands in the real package's exports, captured before it mocks the module, so the reader never reaches the
 * mocked namespace (a mock that reads the module it replaces calls itself). Every legacy row is read through the real
 * reader, the planted members are written over a structured clone of its grants, and the rows are read again through
 * the real `parseGrantRegister`, so every plant passes the register's schema and code rules. This module imports the
 * package by type only.
 */
import type { GrantRegister, RegisterGrants, RegisterRow } from "@libredb/grant-register";

/** The exports of `@libredb/grant-register` the planted reader reads. */
export interface RealGrantRegister {
  readonly LEGACY_KEY: "@libredb/studio";
  readonly readGrantRegister: (legacyEngines: readonly string[]) => GrantRegister;
  readonly parseGrantRegister: (value: unknown, legacyEngines: readonly string[]) => GrantRegister;
}

/**
 * A `readGrantRegister` answering the committed register's legacy rows of the engines it is handed, each row's grants
 * with `edits`' members for its engine written over them.
 *
 * @throws {Error} Naming the engine, for an edit of an engine the reader is not handed, or one with no legacy row.
 */
export function plantedRegisterReader(
  real: RealGrantRegister,
  edits: Readonly<Record<string, Partial<RegisterGrants>>>,
): (legacyEngines: readonly string[]) => GrantRegister {
  return (legacyEngines) => {
    for (const engine of Object.keys(edits)) {
      if (!legacyEngines.includes(engine)) throw new Error(`a planted legacy row names ${engine}, which is not served`);
    }
    const committed = real.readGrantRegister(legacyEngines);
    const rows = legacyEngines.map((engine): RegisterRow => {
      const row = committed.rowFor({ legacy: real.LEGACY_KEY, engine });
      if (row === null) throw new Error(`the committed register holds no legacy row for ${engine}`);
      const copy = structuredClone(row) as RegisterRow & { grants: RegisterGrants };
      return { ...copy, grants: { ...copy.grants, ...edits[engine] } };
    });
    return real.parseGrantRegister(rows, legacyEngines);
  };
}
