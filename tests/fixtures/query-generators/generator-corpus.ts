/**
 * The parity oracle of the query generators: every answer the generators and quoting helpers give over a corpus of
 * declarations, paths, columns and scopes, one SHA-256 digest per declaration.
 *
 * `generator-corpus.json` beside this file is this module's output on the commit before each engine's generator rows
 * moved beside its provider, and `tests/isolated/query-generator-parity.test.ts` holds today's output to it. When a
 * later change means to move an answer, regenerate the file from the base it starts from, with that base's code, and
 * commit it on its own before the change:
 *
 *   bun tests/fixtures/query-generators/generator-corpus.ts > tests/fixtures/query-generators/generator-corpus.json
 *
 * The declarations are every shipped provider's own, built unconnected through the real factory, and synthetic ones
 * that reach each SQL engine row, language and declared-quoting arm alone and in combination, as a host's own
 * declaration to `StudioWorkspace` may.
 * Each provider's declaration is read under its own type id.
 * Each synthetic one is read under `TYPE_OF_PORT[port]`, the type whose SQL engine row its port selected when the
 * generators still keyed those rows by port, so the committed digests hold across the move to type ids.
 */
import { createHash } from "node:crypto";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { ProviderCapabilities } from "@/lib/db/types";
import {
  generateCountQuery,
  generateRowActionQuery,
  generateSelectQuery,
  generateTableQuery,
  quoteIdentifier,
  quoteObjectPath,
  quoteTypedName,
} from "@/lib/query-generators";
import type { ColumnSchema, DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

const PATHS: readonly (readonly string[])[] = [
  [],
  ["orders"],
  ["public", "Order"],
  ["c0", 'Order"Items'],
  ["s", "when"],
  ["db", "m"],
  ["users:*"],
  ["cache:*"],
  ["a\nDEL user:1"],
  ["/app/config/*"],
  ["-dash/*"],
  ["x\r/*"],
  ["dev", "item"],
  ["ds", "mod", "node"],
  ["g", "e", "d"],
  ["1", "point"],
  ["lake", "a.b", "t"],
  ["neo4j", "label:Person"],
  ["ns", "Pod", "web-1"],
];

const NAMES: readonly string[] = ["id", "ORDERS", "Order", "when", "a b", 'q"t', "b`t", "br]k", "x$y", "count", ""];

const COLUMN_SETS: readonly (readonly ColumnSchema[])[] = [
  [],
  [
    { name: "id", type: "integer", nullable: false, isPrimary: true },
    { name: "name", type: "text", nullable: true, isPrimary: false },
    { name: "__id", type: "string", nullable: false, isPrimary: true },
    { name: "address", type: "object", nullable: true, isPrimary: false },
    { name: "address.city", type: "string", nullable: true, isPrimary: false },
    { name: "flat", type: "flattened", nullable: true, isPrimary: false, projectable: false },
    { name: "value", type: "float", nullable: true, isPrimary: false },
    { name: "geom", type: "geometry", nullable: true, isPrimary: false },
  ],
  [
    { name: "key", type: "hash", nullable: false, isPrimary: true },
    { name: "type", type: "hash", nullable: true, isPrimary: false },
  ],
  [
    { name: "key", type: "string", nullable: false, isPrimary: true },
    { name: "value", type: "string", nullable: true, isPrimary: false },
  ],
  [
    { name: "id", type: "string", nullable: false, isPrimary: true },
    { name: "document", type: "object", nullable: true, isPrimary: false },
  ],
];

const SCOPES = [
  undefined,
  { readOnly: true },
  { readOnly: false, namesKey: true },
  { readRanges: [{ prefix: "/app/config/" }, { key: "k\r1" }, { start: "a", end: "b" }] },
  { readRanges: [] },
  { kind: "Pod" },
] as const;

const ROW_ACTIONS: readonly string[] = ["describe", "logs", "list", "nope"];

function base(overrides: Partial<ProviderCapabilities>): ProviderCapabilities {
  return {
    queryLanguage: "sql",
    supportsExplain: false,
    supportsExternalQueryLimiting: true,
    supportsInlineRowEdit: false,
    supportsMaintenance: false,
    maintenanceOperations: [],
    supportsConnectionString: false,
    schemaRefreshPattern: "",
    defaultPort: null,
    ...overrides,
  };
}

/**
 * The type each synthetic declaration is read under, by the port it names: the type whose SQL engine row that port
 * selected before the rows were keyed by type id, and no type for no port. The label keeps the port, so each digest
 * stays under the key it was committed with.
 */
const TYPE_OF_PORT: ReadonlyMap<number | null, DatabaseType | undefined> = new Map<
  number | null,
  DatabaseType | undefined
>([
  [null, undefined],
  [5432, "postgres"],
  [3306, "mysql"],
  [1433, "mssql"],
  [1521, "oracle"],
  [8091, "couchbase"],
  [8888, "druid"],
  [8123, "clickhouse"],
]);

/** A declaration and the type it is read under. */
interface Declaration {
  readonly type: DatabaseType | undefined;
  readonly caps: ProviderCapabilities;
}

/** Declarations no shipped provider makes, each reaching one arm or two at once, with the type each is read under. */
function syntheticDeclarations(): Record<string, Declaration> {
  const out: Record<string, Declaration> = {};
  const quotings = [undefined, "double", "double-always", "backtick", "backtick-always"] as const;
  for (const [port, type] of TYPE_OF_PORT) {
    const add = (label: string, overrides: Partial<ProviderCapabilities>): void => {
      out[label] = { type, caps: base({ defaultPort: port, ...overrides }) };
    };
    for (const quoting of quotings) {
      add(`sql port=${port} quoting=${quoting}`, { identifierQuoting: quoting });
    }
    add(`sql port=${port} window`, {
      previewTimeWindow: {
        column: "time",
        since: "now() - INTERVAL '1 hour'",
        note: "the last hour",
        examples: ["SELECT {column} FROM {table}", "-- a $& {table}\nnext"],
      },
    } as Partial<ProviderCapabilities>);
    add(`sql port=${port} projection`, {
      previewProjection: {
        rules: [
          { type: "^geometry$", expression: "ST_AsText({column})" },
          { type: "^float", expression: null },
        ],
        unprojectedNote: "no columns",
        omittedNote: "they cannot be read",
      },
    } as Partial<ProviderCapabilities>);
    add(`sql port=${port} no-terminator no-constant`, {
      statementTerminator: "none",
      supportsConstantPredicate: false,
    } as Partial<ProviderCapabilities>);
    for (const language of ["promql", "cypher", "influxql", "json"] as const) {
      add(`${language} port=${port}`, { queryLanguage: language });
      add(`${language} port=${port} backtick`, { queryLanguage: language, identifierQuoting: "backtick" });
    }
  }
  // The two portless declarations name no engine, so they are read under no type.
  out["json schema-level"] = {
    type: undefined,
    caps: base({
      queryLanguage: "json",
      containerLevels: [{ id: "schema", label: "Database", labelPlural: "Databases" }],
    } as unknown as Partial<ProviderCapabilities>),
  };
  out["host dialect constructor"] = {
    type: undefined,
    caps: base({ queryLanguage: "json", queryDialect: "constructor" as ProviderCapabilities["queryDialect"] }),
  };
  return out;
}

/** An answer, or the refusal it throws, so a refusal is an answer and not a failed run. */
function attempt(generate: () => unknown): unknown {
  try {
    return generate();
  } catch (error) {
    return `THROWS ${(error as Error).message}`;
  }
}

/** Every answer for one declaration read under `type`, in a fixed order. */
function answers(type: DatabaseType | undefined, caps: ProviderCapabilities): unknown[] {
  const out: unknown[] = [];
  for (const name of NAMES) {
    out.push(attempt(() => quoteIdentifier(name, type, caps)));
    out.push(attempt(() => quoteIdentifier(name, type, caps, { always: true })));
    out.push(attempt(() => quoteTypedName(name, type, caps)));
  }
  for (const path of PATHS) {
    out.push(attempt(() => quoteObjectPath(path, type, caps)));
    out.push(attempt(() => quoteObjectPath(path, type, caps, { always: true })));
    out.push(attempt(() => generateCountQuery(path, type, caps)));
    for (const columns of COLUMN_SETS) {
      for (const scope of SCOPES) {
        out.push(attempt(() => generateTableQuery(path, type, caps, columns, scope)));
        out.push(attempt(() => generateSelectQuery(path, columns, type, caps, scope)));
      }
    }
    out.push(attempt(() => generateTableQuery(path, type, caps)));
    for (const action of ROW_ACTIONS) {
      out.push(attempt(() => generateRowActionQuery(path, action, caps, { kind: "Pod" })));
      out.push(attempt(() => generateRowActionQuery(path, action, caps, { kind: "Deployment", readOnly: true })));
    }
  }
  return out;
}

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The oracle: one digest per declaration, keyed by its label, as one JSON object with a final newline. */
export async function generatorCorpusDigests(): Promise<string> {
  const out: Record<string, string> = {};
  const realLog = console.log;
  console.log = () => undefined;
  try {
    const providers = await Promise.all(
      SHIPPED_DATABASE_TYPES.map((type) => createDatabaseProvider(CENSUS_CONNECTION[type])),
    );
    for (const [index, type] of SHIPPED_DATABASE_TYPES.entries()) {
      out[`provider ${type}`] = digest(answers(type, providers[index].getCapabilities()));
    }
  } finally {
    console.log = realLog;
  }
  for (const [label, { type, caps }] of Object.entries(syntheticDeclarations()))
    out[label] = digest(answers(type, caps));
  return `${JSON.stringify(out, null, 1)}\n`;
}

if (import.meta.main) {
  process.stdout.write(await generatorCorpusDigests());
  process.exit(0);
}
