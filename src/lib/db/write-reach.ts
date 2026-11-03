/**
 * What Studio can write on an engine, folded from a provider's per-path declaration into one value.
 *
 * `none`: on every write path the provider has no code that can send a write, whatever the connection's `readOnly`
 * says. `guarded`: at least one path writes, and every one is refused by a named gate while read-only mode holds.
 * `open`: at least one path sends a write no Studio gate refuses. The value is a fact about Studio's code, not about
 * the engine, the role or the deployment: a Postgres role holding only `SELECT` is still `open`.
 *
 * Pure and UI-free, and it names no engine: `WRITE_REACH` in `./compatibility.ts` is the static per-engine answer,
 * and `tests/unit/db/write-reach-capability.test.ts` holds it equal to this summary of every provider's declaration.
 * It is not an MCP criterion, and no MCP code reads it.
 */
import type { ProviderCapabilities, WritePath, WritePathReach, WriteProof } from "./types";

export type WriteReach = "none" | "guarded" | "open";

/** The four write paths, in the order every declaration lists them. */
export const WRITE_PATHS: readonly WritePath[] = Object.freeze(["editor", "objectEdit", "maintenance", "transaction"]);

/** `open` when nothing is declared or any path is open, `guarded` when any path is gated, else `none`. */
export function summarizeWriteReach(paths: ProviderCapabilities["writeReach"]): WriteReach {
  if (paths === undefined) return "open";
  const reaches = WRITE_PATHS.map((path) => paths[path].reach);
  if (reaches.includes("open")) return "open";
  return reaches.includes("gated") ? "guarded" : "none";
}

function frozenPath(path: WritePathReach): WritePathReach {
  if (path.reach === "gated") return Object.freeze({ reach: "gated", gate: Object.freeze({ ...path.gate }) });
  if (path.reach === "absent" && path.proof !== undefined) {
    return Object.freeze({ reach: "absent", proof: Object.freeze({ ...path.proof }) });
  }
  return Object.freeze({ ...path });
}

/**
 * A provider's declaration, frozen all the way down, so the module constant a provider class holds cannot be
 * changed by any reader of its capabilities.
 */
export function declareWriteReach(
  paths: Readonly<Record<WritePath, WritePathReach>>,
): Readonly<Record<WritePath, WritePathReach>> {
  return Object.freeze({
    editor: frozenPath(paths.editor),
    objectEdit: frozenPath(paths.objectEdit),
    maintenance: frozenPath(paths.maintenance),
    transaction: frozenPath(paths.transaction),
  });
}

/**
 * The declaration of a provider with no write path: the editor absent with the structural proof that keeps it so,
 * and object edit, maintenance and transactions absent, which the census checks against the capabilities.
 */
export function noWritePath(editorProof: WriteProof): Readonly<Record<WritePath, WritePathReach>> {
  return declareWriteReach({
    editor: { reach: "absent", proof: editorProof },
    objectEdit: { reach: "absent" },
    maintenance: { reach: "absent" },
    transaction: { reach: "absent" },
  });
}
