/**
 * The object tree, built from the map and never from the device.
 *
 * WHY AN ABSENT MAP RETURNS AN EMPTY LIST AND NEVER THROWS. Read from source, not guessed:
 * `src/hooks/use-connection-manager.ts:335-362` on `origin/main` raises the red "Schema Error"
 * toast in exactly one place, inside the `catch` block, and calls `setSchemaError(null)` when the
 * inventory read succeeds. An empty result therefore takes the success path and shows no toast,
 * while a throw takes the other path. If `listObjects` threw for a connection whose map has not
 * been filled in, every such connection would greet its user with a red error for a state that is
 * normal and expected. The kinds exist, they list nothing, and the panel says that Modbus has no
 * discovery.
 *
 * Nothing here is walked and no device traffic happens: the points are read from the connection's
 * own map, which is also what plan mode grounds on (MB-S12).
 */
import { parseRegisterMap, type MapPoint } from "./register-map";
import type { Table } from "./pdu";

export interface ObjectKind {
  readonly id: Table;
  readonly label: string;
  readonly labelPlural: string;
}

/** The four tables of MB 4.3, under the specification's own names. */
export const MODBUS_OBJECT_KINDS: readonly ObjectKind[] = Object.freeze([
  { id: "coil", label: "Coil", labelPlural: "Coils" },
  { id: "discrete_input", label: "Discrete input", labelPlural: "Discrete inputs" },
  { id: "input_register", label: "Input register", labelPlural: "Input registers" },
  { id: "holding_register", label: "Holding register", labelPlural: "Holding registers" },
] as const);

export const NO_DISCOVERY_SENTENCE =
  "Modbus has no discovery: no request lists what a device holds, so this tree is built from the register map kept with this connection.";

export interface ListedObject {
  readonly kind: Table;
  readonly name: string;
  readonly unitId: number;
  readonly address: number;
  readonly type: string;
}

export interface Listing {
  readonly objects: readonly ListedObject[];
  readonly notice: string;
  readonly warnings: readonly string[];
}

/**
 * Lists the points of one kind. Never throws for an absent or empty map, which is the rule above.
 * A map that is PRESENT and malformed does throw, because that is a document the user wrote and
 * needs told about; the two cases are not the same and are not collapsed.
 */
export function listObjects(mapDocument: string | undefined | null, kind: Table): Listing {
  const parsed = parseRegisterMap(mapDocument);
  if (parsed.isEmpty) return { objects: [], notice: NO_DISCOVERY_SENTENCE, warnings: [] };
  const objects = parsed.points
    .filter((point: MapPoint) => point.table === kind)
    .map((point) => ({
      kind: point.table,
      name: point.name,
      unitId: point.unitId,
      address: point.address,
      type: point.type,
    }));
  return { objects, notice: NO_DISCOVERY_SENTENCE, warnings: parsed.warnings };
}

/**
 * Per kind counts, where an absent map is NOT zero.
 *
 * `src/lib/db/types.ts` states the contract on `countObjects`: "A refused read is `{ unavailable }`,
 * never 0." The two are different answers and the tree draws them differently, an empty folder
 * against a sentence, so the choice matters here more than it looks.
 *
 * With no map, this provider does not know how many coils the DEVICE has, and saying 0 would be a
 * claim about the device that Modbus cannot support: there is no request that lists what a device
 * holds. So an absent or empty map answers `{ unavailable }` with the no discovery sentence, and
 * the user reads why rather than reading a zero that looks like a fact about their hardware.
 *
 * With a map present, the count is the number of points of that kind IN THE MAP, and that count may
 * legitimately be 0: a map that declares no coils really does declare none. That zero is an answer,
 * not a refusal, and it is reported as one.
 */
export type KindCountLike = { readonly count: number } | { readonly unavailable: string };

export function countObjects(mapDocument: string | undefined | null): Record<Table, KindCountLike> {
  const parsed = parseRegisterMap(mapDocument);
  const out = {} as Record<Table, KindCountLike>;
  for (const kind of MODBUS_OBJECT_KINDS) {
    out[kind.id] = parsed.isEmpty
      ? { unavailable: NO_DISCOVERY_SENTENCE }
      : { count: parsed.points.filter((p) => p.table === kind.id).length };
  }
  return out;
}

/** The units the tree shows: the ones the map names, never a scan (MB-S9). */
export function listUnits(mapDocument: string | undefined | null): readonly number[] {
  const parsed = parseRegisterMap(mapDocument);
  return [...new Set(parsed.points.map((p) => p.unitId))].sort((a, b) => a - b);
}
