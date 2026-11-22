import { resealConnections } from "./connection-secrets";
import { isVersionOneEnvelope, openSecret, requireStorageEncryptionKey, sealSecret } from "./encryption";
import { type AccountFactorField, accountBinding, connectionBindingProblem } from "./envelope-binding";
import type { ServerStorageProvider, StoredFactorRow } from "./types";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The operator re-seal of the server store (docs/STORAGE.md, "Re-sealing the store"), which
 * STORAGE_ENCRYPTION_RESEAL runs at boot (./reseal-at-boot.ts).
 *
 * The provider does the transaction and the backup (`rewriteStoredCredentials`); this module says
 * what happens to each stored value, synchronously inside that transaction: a v2 value that opens
 * for its place is kept; a version 1 envelope that opens, or an unsealed value, is sealed as v2 for
 * the place it is stored in. A well-formed version 1 envelope that does not open under the key in
 * use refuses the whole run by name (`ResealRefused`), before version 1 is retired: the key that
 * sealed it is likely another one, and once version 1 is retired that key could no longer open it.
 * With `leaveUnopened` (STORAGE_ENCRYPTION_RESEAL=leave-unopened) such values are left exactly as
 * they are and named instead. A malformed claim and a v2 value that does not open are not changed
 * by retirement, so they are always left as they are and named. A value that is not text, or a
 * version 1 or unsealed value beside a v2 value of its record, is left as it is and named
 * (./connection-secrets.ts). A row whose data is not a JSON list, a list element that is not an
 * object, and a connection that has no binding are left as they are and named; an element that
 * fails to re-seal, and a row that must be written back beside such an element and that the
 * serializer cannot write, fail the run by name (`ResealRowUnwritable`). Once the provider commits,
 * the store records that version 1 is retired.
 *
 * The key is derived before anything is read: without usable key material every value would read
 * as unopenable and be retired unopened, so the run throws by name instead.
 */

export type ResealReport =
  | { kind: "already-retired" }
  | {
      kind: "rewritten";
      /** Where the complete copy of the store as it was is. */
      backup: string;
      /** Values sealed as v2. */
      resealed: number;
      /** v2 values that already opened for their place. */
      kept: number;
      /**
       * Values left as they are because they open nowhere here: `<owner> <connection id> <field>` or `<email> <field>`.
       * Version 1 values among them only with `leaveUnopened`.
       */
      unopened: string[];
      /** Values left as they are because they are not text, or sit beside a v2 value: `<owner> <connection id> <field> (<reason>)`. */
      refused: string[];
      /**
       * Rows or list elements left as they are because they are not connections, or have no binding: `<owner> connections`
       * or `<owner> connections[<index>]`.
       */
      unread: string[];
    };

const FACTOR_FIELDS: readonly AccountFactorField[] = ["totpSecret", "totpPending"];

/** `pre-reseal-` and the UTC time to the second, `yyyymmddThhmmssZ`. */
export function resealBackupLabel(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
  return `pre-reseal-${stamp}`;
}

function isConnectionRecord(value: unknown): value is DatabaseConnection {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An id as a report names it: a string as it is, any other JSON value as its JSON text. */
function idText(id: unknown): string {
  return typeof id === "string" ? id : JSON.stringify(id);
}

/**
 * The re-seal refused to retire version 1, because version 1 values do not open under the key in use; it threw inside
 * the provider's transaction, so the rows, the factors and the marker are as they were. `unopened` names them as the
 * report would.
 */
export class ResealRefused extends Error {
  constructor(readonly unopened: string[]) {
    super(
      `${unopened.length} version 1 value(s) do not open under the key in use: ${unopened.join(", ")}. The re-seal rolled back and version 1 is not retired, because the key in use is likely not the one that sealed them, and once version 1 is retired that key could not open them again. Start with the key that sealed them (STORAGE_ENCRYPTION_KEY, or JWT_SECRET when it is unset), or set STORAGE_ENCRYPTION_RESEAL=leave-unopened to retire version 1 and leave them as they are (docs/STORAGE.md, Re-sealing the store).`,
    );
    this.name = "ResealRefused";
  }
}

/**
 * The re-seal could not handle a connections row: an element of it failed to re-seal (for example one nested deeper
 * than this runtime's serializer goes, in a field the binding check does not measure), or the rewritten list holds
 * elements the serializer cannot write. It threw inside the provider's transaction, so the store is as it was.
 * `elements` are their indexes in the row, and `cause` is the error of the step that failed.
 */
export class ResealRowUnwritable extends Error {
  constructor(
    readonly owner: string,
    readonly elements: number[],
    cause: unknown,
  ) {
    const names = elements.map((index) => `connections[${index}]`).join(", ");
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `The re-seal cannot write the connections row of ${owner} back: it cannot re-seal or serialize ${names} (${reason}). The re-seal rolled back and version 1 is not retired: remove or repair that element and start again.`,
      { cause },
    );
    this.name = "ResealRowUnwritable";
  }
}

export interface ResealOptions {
  /** Retire version 1 over version 1 values the key in use does not open, leaving and naming them, instead of refusing. */
  leaveUnopened: boolean;
}

/** Whether this runtime's serializer writes `value`; a value nested deeper than it goes throws a RangeError. */
function serializes(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

/** Re-seals every stored credential of `provider` after a complete backup, and retires version 1. */
export async function resealStore(
  provider: ServerStorageProvider,
  now: Date,
  options: ResealOptions = { leaveUnopened: false },
): Promise<ResealReport> {
  requireStorageEncryptionKey();
  let resealed = 0;
  let kept = 0;
  const unopened: string[] = [];
  const unopenedVersionOne: string[] = [];
  const refused: string[] = [];
  const unread: string[] = [];

  const connections = (owner: string, data: string): string | null => {
    let list: unknown;
    try {
      list = JSON.parse(data);
    } catch {
      unread.push(`${owner} connections`);
      return null;
    }
    if (!Array.isArray(list)) {
      unread.push(`${owner} connections`);
      return null;
    }
    let changed = false;
    const next = list.map((element: unknown, index) => {
      if (!isConnectionRecord(element) || connectionBindingProblem(element) !== null) {
        unread.push(`${owner} connections[${index}]`);
        return element;
      }
      let result: ReturnType<typeof resealConnections>;
      try {
        result = resealConnections(owner, [element]);
      } catch (error) {
        throw new ResealRowUnwritable(owner, [index], error);
      }
      resealed += result.resealed;
      kept += result.kept;
      for (const { id, path } of result.unopened) unopened.push(`${owner} ${idText(id)} ${path}`);
      for (const { id, path } of result.unopenedVersionOne) unopenedVersionOne.push(`${owner} ${idText(id)} ${path}`);
      for (const { id, path, reason } of result.refused) refused.push(`${owner} ${idText(id)} ${path} (${reason})`);
      if (result.resealed > 0) changed = true;
      return result.connections[0];
    });
    if (!changed) return null;
    try {
      return JSON.stringify(next);
    } catch (error) {
      // Each element is tried at the depth it has inside the list.
      const unwritable = next.flatMap((element, index) => (serializes([element]) ? [] : [index]));
      throw new ResealRowUnwritable(owner, unwritable, error);
    }
  };

  const factors = (row: StoredFactorRow): Pick<StoredFactorRow, "totpSecret" | "totpPending"> | null => {
    const binding = accountBinding(row.email);
    const next = { totpSecret: row.totpSecret, totpPending: row.totpPending };
    let changed = false;
    for (const field of FACTOR_FIELDS) {
      const value = row[field];
      if (value === null) continue;
      const read = openSecret(value, binding.field(field));
      if (read.kind === "v2") {
        kept += 1;
      } else if (read.kind === "unopenable") {
        (isVersionOneEnvelope(value) ? unopenedVersionOne : unopened).push(`${row.email} ${field}`);
      } else {
        next[field] = sealSecret(read.value, binding.field(field));
        resealed += 1;
        changed = true;
      }
    }
    return changed ? next : null;
  };

  const beforeRetire = (): void => {
    if (unopenedVersionOne.length === 0) return;
    if (!options.leaveUnopened) throw new ResealRefused(unopenedVersionOne);
    unopened.push(...unopenedVersionOne);
  };

  const result = await provider.rewriteStoredCredentials(
    { connections, factors, beforeRetire },
    resealBackupLabel(now),
  );
  if (result.kind === "already-retired") return result;
  return { kind: "rewritten", backup: result.backup, resealed, kept, unopened, refused, unread };
}
