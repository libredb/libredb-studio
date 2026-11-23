/**
 * An engine's SQL writing row rebuilt from the `sqlWriting` segment of its engine declaration, as a host that admits the
 * declaration would build one (docs/providers/CONTRACT.md, clause S-11).
 *
 * Every data member comes from the declaration: each type name list as a Set, the bare spellings and the bare type
 * families as the records Studio reads, each type pattern compiled from its source and flags. A hook stated as null is
 * left out, as Studio's row leaves it out, and a placeholder or a temporal literal stated as null stays null. Each
 * function is resolved by the slot name the declaration states, through the census's slot table, on the row the
 * engine's own module exports: the declaration says which slot, the module supplies the function, so a name stated at
 * the wrong member moves a function to where a reader then runs it.
 *
 * It is written apart from scripts/generate-engine-declarations.ts, which never reads a declaration back.
 */
import type { SqlWriting } from "@libredb/provider-sdk/manifest";
import type { ExportSpec, InferredKind, InlineEditSpec, SqlWritingSpec } from "@/lib/db/sql-writing/types";
import { isDeclaredSlotName, slotFunction } from "./declared-slots";

/** A pattern as Studio reads it, compiled from the source and flags a declaration states. */
function compiled(pattern: { readonly source: string; readonly flags: string }): RegExp {
  return new RegExp(pattern.source, pattern.flags);
}

/**
 * The row of engine `type` that `declared` states, every function resolved by its slot name on `row`, the row the
 * engine's own module exports. A name that is no slot of the census's table, and a slot `row` does not fill with a
 * function, are thrown by name.
 */
export function sqlWritingFromDeclaration(type: string, declared: SqlWriting, row: SqlWritingSpec): SqlWritingSpec {
  const resolve = <Fn>(name: string): Fn => {
    if (!isDeclaredSlotName(name)) {
      throw new Error(`${type}: the declaration names "${name}", which is no slot of the census's slot table`);
    }
    const held = slotFunction(row, name);
    if (typeof held !== "function")
      throw new Error(`${type}: the slot "${name}" holds no function in the module's row`);
    return held as Fn;
  };
  const { inlineEdit: edit, export: facts } = declared;
  const { typeVocabulary: vocabulary } = facts;

  const inlineEdit: InlineEditSpec = {
    instantTypeNames: new Set(edit.instantTypeNames),
    exactDecimalTypeNames: new Set(edit.exactDecimalTypeNames),
    float64TypeNames: edit.float64TypeNames === "all" ? "all" : new Set(edit.float64TypeNames),
    ...(edit.boundEdit === null
      ? {}
      : { boundEdit: resolve<NonNullable<InlineEditSpec["boundEdit"]>>(edit.boundEdit) }),
  };

  const bareTypeFamily: Record<string, InferredKind> = {};
  for (const [kind, names] of Object.entries(vocabulary.bareTypeFamily) as [InferredKind, readonly string[]][]) {
    for (const name of names) bareTypeFamily[name] = kind;
  }
  const exportSpec: ExportSpec = {
    ddlTypes: { ...facts.ddlTypes },
    standsAlone: [...facts.standsAlone],
    bareSpelling: Object.fromEntries(facts.bareSpelling.map(({ name, spelling }) => [name, spelling])),
    typeVocabulary: {
      bareTypeFamily,
      floatType: compiled(vocabulary.floatType),
      exactNumericType: compiled(vocabulary.exactNumericType),
      numericWrapper: compiled(vocabulary.numericWrapper),
    },
    binaryLiteral: resolve<ExportSpec["binaryLiteral"]>(facts.binaryLiteral),
    nonFinite: { ...facts.nonFinite },
    insertForm: facts.insertForm,
    ...(facts.rewriteDeclared === null
      ? {}
      : { rewriteDeclared: resolve<NonNullable<ExportSpec["rewriteDeclared"]>>(facts.rewriteDeclared) }),
    ...(facts.declareFromSample === null
      ? {}
      : { declareFromSample: resolve<NonNullable<ExportSpec["declareFromSample"]>>(facts.declareFromSample) }),
    ...(facts.typedLiteral === null
      ? {}
      : { typedLiteral: resolve<NonNullable<ExportSpec["typedLiteral"]>>(facts.typedLiteral) }),
    ...(facts.columnWriters === null
      ? {}
      : { columnWriters: resolve<NonNullable<ExportSpec["columnWriters"]>>(facts.columnWriters) }),
    ...(facts.createTableKey === null
      ? {}
      : {
          createTableKey: {
            note: facts.createTableKey.note,
            clause: resolve<NonNullable<ExportSpec["createTableKey"]>["clause"]>(facts.createTableKey.clause),
          },
        }),
  };

  return {
    escapeLiteral: resolve<SqlWritingSpec["escapeLiteral"]>(declared.escapeLiteral),
    unescapeLiteral: resolve<SqlWritingSpec["unescapeLiteral"]>(declared.unescapeLiteral),
    quoteIdentifier: resolve<SqlWritingSpec["quoteIdentifier"]>(declared.quoteIdentifier),
    placeholder:
      declared.placeholder === null ? null : resolve<NonNullable<SqlWritingSpec["placeholder"]>>(declared.placeholder),
    temporalLiteral:
      declared.temporalLiteral === null
        ? null
        : resolve<NonNullable<SqlWritingSpec["temporalLiteral"]>>(declared.temporalLiteral),
    inlineEdit,
    export: exportSpec,
    ...(declared.insertDocuments === null
      ? {}
      : { insertDocuments: resolve<NonNullable<SqlWritingSpec["insertDocuments"]>>(declared.insertDocuments) }),
  };
}
