/**
 * The Modbus dialect's generators, collected as its row by `DIALECT_GENERATORS` in
 * `src/lib/db/query-generators/index.ts`.
 */
import type { DialectGenerators } from "@/lib/db/query-generators/types";

/**
 * One JSON read request for the clicked point.
 *
 * A point's path is its unit id and its name (`src/lib/db/providers/industrial/modbus/index.ts`),
 * and the name is the only thing a read needs: the map already holds the unit, the table, the
 * address and the type. Where the path stops at the unit there is no point to name, so the
 * request written is the one shape that needs no map - a range by address - with the unit filled
 * in and the rest left for the reader to say.
 */
function modbusReadRequest(path: readonly string[]): string {
  const unit = path[0];
  const name = path.length > 1 ? path[path.length - 1] : undefined;
  if (name !== undefined) return JSON.stringify({ read: [name] }, null, 2);
  const unitId = unit === undefined || unit === "" ? 1 : Number(unit);
  return JSON.stringify(
    { unit: Number.isInteger(unitId) ? unitId : 1, table: "holding_register", address: 0, count: 1 },
    null,
    2,
  );
}

/** A tree click and Generate Query both write the one read request for the clicked point. */
export const MODBUS_GENERATORS: DialectGenerators = Object.freeze<DialectGenerators>({
  table: (path: readonly string[]) => modbusReadRequest(path),
  select: (path: readonly string[]) => modbusReadRequest(path),
});
