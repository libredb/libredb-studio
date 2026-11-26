/**
 * The statement redaction the query event log keeps a statement's text by is composed per event from the engine
 * record's grant of its redaction (`EngineGrants.redaction`, read from the engine's register row): a `sql` and a `none`
 * redaction as granted, and a `command` redaction with the reader it names bound through Studio's grammar function
 * table under the record's legacy engine's id, so the log reads the grant and never a request.
 *
 * The module sits beside the grammar rows rather than in them, because the VS Code webview and the browser bundle the
 * grammar module (src/lib/db/sql-grammar/index.ts), and the server catalog's closure holds the grant reader and the
 * register package, which the webview's boundary refuses; the last test holds that boundary.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { StatementRedaction } from "@libredb/provider-sdk/manifest";
import { STUDIO_GRANT_REGISTER } from "@/lib/db/claim-grants";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { MONGODB_REDACTION_READER } from "@/lib/db/providers/document/mongodb/sql-grammar";
import { REDIS_REDACTION_READER } from "@/lib/db/providers/keyvalue/redis-sql-grammar";
import { type EngineRecord, servedEngineRecord } from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { SQL_GRAMMAR_FUNCTIONS, type SqlGrammarFunctions } from "@/lib/db/sql-grammar";
import { SQL_TEXT_REDACTION } from "@/lib/db/sql-grammar/redaction";
import { composeStatementRedaction } from "@/lib/db/sql-grammar/statement-redaction";
import { admittedFor, admittedManifest } from "../../../helpers/package-catalog";
import { valueImportClosure, valueImportsOf } from "../../../helpers/value-import-closure";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const STATEMENT_REDACTION = "src/lib/db/sql-grammar/statement-redaction.ts";
const REDACTOR = "src/lib/query-events/redact.ts";
const GRAMMAR_MODULE = "src/lib/db/sql-grammar/index.ts";
const SERVER_CATALOG = "src/lib/db/server-catalog.ts";
const GRANT_READER = "src/lib/db/claim-grants.ts";

/** Every `.ts` and `.tsx` module under src, repository-relative with forward slashes on every platform. */
function sourceModules(): string[] {
  return readdirSync(join(REPO_ROOT, "src"), { recursive: true, encoding: "utf8" })
    .map((file) => `src/${file.split("\\").join("/")}`)
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".d.ts"))
    .sort();
}

/** `engine`'s record with its granted redaction replaced by `redaction`, which may be one no register row grants. */
function grantingRedaction(engine: EngineRecord, redaction: unknown): EngineRecord {
  return Object.freeze({
    ...engine,
    grants: Object.freeze({ ...engine.grants, redaction: redaction as EngineRecord["grants"]["redaction"] }),
  });
}

describe("the statement redaction composed from the engine record's grant", () => {
  test("every legacy record's statement redaction is its granted redaction, a command reader bound through the grammar function table", () => {
    const kinds = new Set<string>();
    const nameQuotes = new Set<string | null>();
    for (const id of SHIPPED_DATABASE_TYPES) {
      const record = servedEngineRecord(id);
      const granted: StatementRedaction = record.grants.redaction;
      const redaction = composeStatementRedaction(record);
      // The record's grant is Studio's record of the claim for every legacy engine.
      expect({ id, granted }).toEqual({ id, granted: SQL_TEXT_REDACTION[id] });
      expect({ id, frozen: Object.isFrozen(redaction) }).toEqual({ id, frozen: true });
      kinds.add(redaction.kind);
      if (granted.kind === "command") {
        expect({ id, kind: redaction.kind }).toEqual({ id, kind: "command" });
      } else {
        expect({ id, redaction }).toEqual({ id, redaction: granted });
        if (granted.kind === "sql") nameQuotes.add(granted.nameQuote);
      }
    }
    // Vacuity: every kind and four name quotes occur among the legacy engines.
    expect([...kinds].sort()).toEqual(["command", "none", "sql"]);
    expect(nameQuotes).toEqual(new Set(['"', "`", "[", null]));
    expect(composeStatementRedaction(servedEngineRecord("mongodb"))).toEqual({
      kind: "command",
      read: MONGODB_REDACTION_READER,
    });
    expect(composeStatementRedaction(servedEngineRecord("redis"))).toEqual({
      kind: "command",
      read: REDIS_REDACTION_READER,
    });
    // The composition reads the grant it is handed: a granted none keeps nothing whatever the engine.
    const mongodb = grantingRedaction(servedEngineRecord("mongodb"), { kind: "none" });
    expect(composeStatementRedaction(mongodb)).toEqual({ kind: "none" });
  });

  test("a granted command reader Studio's table holds no function for is refused by name", () => {
    const postgres = servedEngineRecord("postgres");
    expect(() =>
      composeStatementRedaction(grantingRedaction(postgres, { kind: "command", reader: "formatSegment" })),
    ).toThrow('postgres names the function "formatSegment", which Studio holds no function for.');
    expect(() =>
      composeStatementRedaction(
        grantingRedaction(servedEngineRecord("mongodb"), { kind: "command", reader: "toString" }),
      ),
    ).toThrow('mongodb names the function "toString", which Studio holds no function for.');
    // The reader is bound through the table handed in: one that holds none for the engine refuses it by name.
    const empty: SqlGrammarFunctions = { ...SQL_GRAMMAR_FUNCTIONS, redactionReaders: {} };
    expect(() => composeStatementRedaction(servedEngineRecord("redis"), empty)).toThrow(
      'redis names the function "redactionReader", which Studio holds no function for.',
    );
  });

  test("a command redaction granted to an engine no legacy provider serves is refused as a host defect", () => {
    const catalog = composeServerCatalog(
      [admittedFor("acmecommand-package", admittedManifest("acmecommand"))],
      [],
      STUDIO_GRANT_REGISTER,
    );
    const record = catalog.engines.get("acmecommand") as EngineRecord;
    // Vacuity: the composed package record grants none, which composes.
    expect(composeStatementRedaction(record)).toEqual({ kind: "none" });
    expect(() =>
      composeStatementRedaction(grantingRedaction(record, { kind: "command", reader: "redactionReader" })),
    ).toThrow(
      "The engine \"acmecommand\" is granted a command redaction, whose reader Studio's grammar function table binds by a legacy engine's id, and its record offers no legacy provider: a host defect.",
    );
  });
});

describe("the statement redaction stays on the server", () => {
  test("only the query event log's redactor imports the statement redaction, and the grammar module the webview bundles reaches neither it, the server catalog nor the grant reader", () => {
    expect(sourceModules().filter((module) => valueImportsOf(module).includes(STATEMENT_REDACTION))).toEqual([
      REDACTOR,
    ]);
    const closure = valueImportClosure(GRAMMAR_MODULE);
    expect(closure.unresolved).toEqual([]);
    for (const target of [STATEMENT_REDACTION, SERVER_CATALOG, GRANT_READER]) {
      expect({ target, reached: closure.modules.includes(target) }).toEqual({ target, reached: false });
    }
    // The control: the walk sees the server catalog and the grant reader where they are reached.
    const redactor = valueImportClosure(REDACTOR);
    for (const target of [STATEMENT_REDACTION, SERVER_CATALOG, GRANT_READER]) {
      expect({ target, reached: redactor.modules.includes(target) }).toEqual({ target, reached: true });
    }
  });
});
