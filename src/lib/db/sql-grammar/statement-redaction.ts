/**
 * The statement redaction the query event log keeps a statement's text by, composed per event from the engine
 * record's grant of its `sqlText.redaction` claim, `EngineGrants.redaction` (src/lib/db/claim-grants.ts), which the
 * engine's register row grants for the grammar it reviewed (docs/providers/CONTRACT.md, clauses M-54 and S-7): a
 * `sql` and a `none` redaction as granted, and a `command` redaction with the reader it names bound through Studio's
 * grammar function table, `SQL_GRAMMAR_FUNCTIONS` in ./index.ts, under the record's legacy engine's id. It holds no
 * table keyed by engine.
 *
 * It sits beside the grammar rows rather than in them because the VS Code webview and the browser bundle ./index.ts,
 * while the server catalog's closure holds the grant reader and the register package, which the webview's boundary
 * refuses; so only the query event log's redactor, src/lib/query-events/redact.ts, loads this module
 * (tests/unit/db/sql-grammar/statement-redaction.test.ts), and the grammar rows hold no redaction.
 */
import { boundFunction } from "@/lib/db/function-table";
import { type EngineRecord, legacyProviderType } from "@/lib/db/server-catalog";
import { SQL_GRAMMAR_FUNCTIONS, type SqlGrammarFunctions } from "@/lib/db/sql-grammar";
import { quoteTypeId } from "@/lib/db/type-id";
import type { SqlRedaction } from "./types";

/**
 * The statement redaction `engine`'s record grants: a `sql` and a `none` redaction as granted, and a `command`
 * redaction with the reader it names bound through `functions` under the record's legacy engine's id. Frozen.
 *
 * @throws {Error} Naming the engine and the name, where `functions` holds no redaction reader for it under that name;
 * and a host defect, naming the engine, where a `command` redaction is granted to a record that offers no legacy
 * provider, since the register grants a provider package's engine `sql` or `none` only.
 */
export function composeStatementRedaction(
  engine: EngineRecord,
  functions: SqlGrammarFunctions = SQL_GRAMMAR_FUNCTIONS,
): SqlRedaction {
  const granted = engine.grants.redaction;
  switch (granted.kind) {
    case "sql":
      return Object.freeze({ kind: "sql", nameQuote: granted.nameQuote });
    case "command": {
      const type = legacyProviderType(engine);
      if (type === undefined) {
        throw new Error(
          `The engine ${quoteTypeId(engine.id)} is granted a command redaction, whose reader Studio's grammar function table binds by a legacy engine's id, and its record offers no legacy provider: a host defect.`,
        );
      }
      return Object.freeze({ kind: "command", read: boundFunction(type, functions.redactionReaders, granted.reader) });
    }
    case "none":
      return Object.freeze({ kind: "none" });
  }
}
