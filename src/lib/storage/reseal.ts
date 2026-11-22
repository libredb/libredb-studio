import { resealConnections } from "./connection-secrets";
import { openSecret, requireStorageEncryptionKey, sealSecret } from "./encryption";
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
 * the place it is stored in; a value that opens as neither is left exactly as it is and named,
 * because it is already unreadable and the backup keeps it for a restored key. A value that is not
 * text, or a version 1 or unsealed value beside a v2 value of its record, is left as it is and
 * named (./connection-secrets.ts). A row whose data is not a JSON list, a list element that is not
 * an object, and a connection that has no binding are left as they are and named. Once the provider
 * commits, the store records that version 1 is retired.
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
      /** Values left as they are because they open nowhere here: `<owner> <connection id> <field>` or `<email> <field>`. */
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

/** Re-seals every stored credential of `provider` after a complete backup, and retires version 1. */
export async function resealStore(provider: ServerStorageProvider, now: Date): Promise<ResealReport> {
  requireStorageEncryptionKey();
  let resealed = 0;
  let kept = 0;
  const unopened: string[] = [];
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
      const result = resealConnections(owner, [element]);
      resealed += result.resealed;
      kept += result.kept;
      for (const { id, path } of result.unopened) unopened.push(`${owner} ${idText(id)} ${path}`);
      for (const { id, path, reason } of result.refused) refused.push(`${owner} ${idText(id)} ${path} (${reason})`);
      if (result.resealed > 0) changed = true;
      return result.connections[0];
    });
    return changed ? JSON.stringify(next) : null;
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
        unopened.push(`${row.email} ${field}`);
      } else {
        next[field] = sealSecret(read.value, binding.field(field));
        resealed += 1;
        changed = true;
      }
    }
    return changed ? next : null;
  };

  const result = await provider.rewriteStoredCredentials({ connections, factors }, resealBackupLabel(now));
  if (result.kind === "already-retired") return result;
  return { kind: "rewritten", backup: result.backup, resealed, kept, unopened, refused, unread };
}
