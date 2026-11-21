import { LockKeyhole } from "lucide-react";
import { WRITE_REACH } from "@/lib/db/compatibility";
import { typeIdRow } from "@/lib/db/type-id";
import type { DatabaseConnection } from "@/lib/types";

/**
 * Whether a connection carries the marker: its `readOnly` is true, or its engine's `WRITE_REACH` is
 * `none`, where Studio has no write path at all. The connection form does not write `readOnly` on such
 * an engine, so the record answers for it, and no engine is named here.
 *
 * The engine's row is read through `typeIdRow` (FND-1), so where the record's `readOnly` does not answer, a type
 * outside the `DatabaseType` union is refused by name with `UnknownProviderError` rather than read as an engine with
 * a write path.
 *
 * @throws {UnknownProviderError} When `readOnly` is not true and the type is absent, not text, or names no provider.
 */
export function showsReadOnlyMarker(connection: Pick<DatabaseConnection, "type" | "readOnly">): boolean {
  return connection.readOnly === true || typeIdRow(WRITE_REACH, connection.type) === "none";
}

/**
 * The "Read-only" marker beside a connection's name (#1089): in the sidebar beside the managed lock,
 * and in both editor headers. Its callers decide through `showsReadOnlyMarker`; only an engine whose
 * provider enforces the mode can carry it, because the seed schema and the factory refuse the field
 * everywhere else.
 */
export function ReadOnlyMarker({ compact = false }: { compact?: boolean }) {
  return (
    <span
      title="Writes, value edits and maintenance are refused on this connection"
      className={
        compact
          ? "shrink-0 text-fg-muted"
          : "text-[0.625rem] font-medium px-1.5 py-0.5 rounded-sm shrink-0 bg-fill text-fg-muted"
      }
    >
      {compact ? (
        <>
          <LockKeyhole aria-hidden="true" strokeWidth={1.5} className="w-3 h-3" />
          <span className="sr-only">Read-only</span>
        </>
      ) : (
        "Read-only"
      )}
    </span>
  );
}
