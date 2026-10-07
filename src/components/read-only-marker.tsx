import { LockKeyhole } from "lucide-react";

/**
 * The "Read-only" marker a connection whose `readOnly` is true carries beside its name (#1089): in the
 * sidebar beside the managed lock, and in both editor headers. Its callers read the public field and
 * nothing else, so no engine is named here; only an engine whose provider enforces the mode can carry
 * it, because the seed schema and the factory refuse the field everywhere else.
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
