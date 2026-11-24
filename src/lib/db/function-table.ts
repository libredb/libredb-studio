/**
 * The one lookup that binds a function name an engine declaration gives to the function Studio's own source holds for
 * that engine at that slot. A declaration names a function and never carries one, so each table that binds such names,
 * the connection form's (src/lib/db/connection-form.ts, `CONNECTION_FORM_FUNCTIONS`) and the connection string's
 * (src/lib/db/connection-string/index.ts, `CONNECTION_STRING_FUNCTIONS`), looks every name up here: an own property of
 * the table for the engine, and an own property of that engine's slots for the name, so a name `Object.prototype`
 * holds, such as `toString`, binds nothing. A name the table holds no function for is refused by name, with no default.
 *
 * UI-free and import-free apart from the type-id union, so the dialog, the parser, the seed loader and the generators
 * all load it.
 */
import type { DatabaseType } from "@/lib/types";

/** One slot kind of a function table: per engine, each name its declaration may give mapped to the function. */
export type FunctionTable<Bound> = Readonly<Partial<Record<DatabaseType, Readonly<Record<string, Bound>>>>>;

/**
 * The function `table` holds for engine `id` under `name`.
 *
 * @throws {Error} Naming the engine and the name, where the table holds no function for that engine under that name,
 * including a name it holds only under another slot kind: there is no default and no slot is skipped.
 */
export function boundFunction<Bound>(id: DatabaseType, table: FunctionTable<Bound>, name: string): Bound {
  const slots = Object.hasOwn(table, id) ? table[id] : undefined;
  if (slots === undefined || !Object.hasOwn(slots, name)) {
    throw new Error(`${id} names the function ${JSON.stringify(name)}, which Studio holds no function for.`);
  }
  return slots[name] as Bound;
}
