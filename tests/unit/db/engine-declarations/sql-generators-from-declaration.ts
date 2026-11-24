/**
 * An SQL engine's generator row rebuilt from the `sqlGenerators` segment of its engine declaration, as a host that
 * admits the declaration would build one (docs/providers/CONTRACT.md, clause S-20).
 *
 * The count expression comes from the declaration. Each form is resolved by the slot name the declaration states,
 * through the census's slot table, on the row the engine's own module exports: the declaration says which slot, the
 * module supplies the function, so a name stated at the wrong member moves a function to where the generators then run
 * it. A form the declaration states as null is left out of the row, so the shared form stands there.
 *
 * It is written apart from scripts/generate-engine-declarations.ts, which reads back only a declaration's authored members.
 */
import type { SqlGenerators } from "@libredb/provider-sdk/manifest";
import type { SqlEngineGenerators } from "@/lib/db/query-generators/types";
import { DECLARED_SLOTS, isDeclaredSlotName, slotFunction } from "./declared-slots";

/**
 * The row of engine `type` that `declared` states, every form resolved by its slot name on `row`, the row the engine's
 * own module exports. A null segment, a name that is no SQL generator slot of the census's table, and a slot `row` does
 * not fill with a function, are thrown by name.
 */
export function sqlGeneratorsFromDeclaration(type: string, declared: SqlGenerators, row: object): SqlEngineGenerators {
  if (declared === null) {
    throw new Error(`${type}: the declaration states no SQL generator forms, but the engine's module exports a row`);
  }
  const resolve = <Fn>(name: string): Fn => {
    if (!isDeclaredSlotName(name) || DECLARED_SLOTS[name].table !== "SQL_ENGINE_GENERATORS") {
      throw new Error(`${type}: the declaration names "${name}", which is no SQL generator slot of the census's table`);
    }
    const held = slotFunction(row, name);
    if (typeof held !== "function") {
      throw new Error(`${type}: the slot "${name}" holds no function in the module's row`);
    }
    return held as Fn;
  };
  const { table, select, selectList } = declared;

  return {
    quote: resolve<SqlEngineGenerators["quote"]>(declared.quote),
    ...(table === null ? {} : { table: resolve<NonNullable<SqlEngineGenerators["table"]>>(table) }),
    ...(select === null ? {} : { select: resolve<NonNullable<SqlEngineGenerators["select"]>>(select) }),
    ...(selectList === null ? {} : { selectList: resolve<NonNullable<SqlEngineGenerators["selectList"]>>(selectList) }),
    countExpression: declared.countExpression,
  };
}
