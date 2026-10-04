/**
 * The "Read-only" marker a connection whose `readOnly` is true carries beside its name (#1089): in the
 * sidebar beside the managed lock, and in both editor headers. Its callers read the public field and
 * nothing else, so no engine is named here; only an engine whose provider enforces the mode can carry
 * it, because the seed schema and the factory refuse the field everywhere else.
 */
export function ReadOnlyMarker() {
  return (
    <span
      title="Writes, value edits and maintenance are refused on this connection"
      className="text-[0.625rem] font-medium px-1.5 py-0.5 rounded-sm shrink-0 bg-fill text-fg-muted"
    >
      Read-only
    </span>
  );
}
