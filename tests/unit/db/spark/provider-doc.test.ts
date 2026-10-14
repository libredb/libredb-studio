import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { IMPORT_NO_TARGET, importRefusal } from "@/components/DataImportModal";
import { packOperationsInventory } from "@/lib/agent/context-snapshot";
import { MCP_EXPOSABLE } from "@/lib/db/compatibility";
import { readIpcColumns } from "@/lib/db/providers/sql/spark/arrow";
import { SPARK_FIELD_SENTENCES } from "@/lib/db/providers/sql/spark/connection-options";
import {
  SPARK_ARROW_CHUNK_BYTES,
  SPARK_ARROW_MAX_RECORDS_PER_BATCH,
  SPARK_CONTROL_DEADLINE_MS,
  SPARK_DEFAULT_PORT,
  SPARK_DESCRIBE_OBJECTS_MAX,
  SPARK_HEARTBEAT_INTERVAL_MS,
  SPARK_MIN_VERSION,
  SPARK_NAMESPACE_MAX_PARTS,
  SPARK_NAMESPACE_WALK_MAX,
  SPARK_RECEIVE_CAP_BYTES,
  SPARK_SCHEMA_MAX_DEPTH,
  SPARK_SCHEMA_MAX_FIELDS,
  SPARK_STREAM_MAX_RECEIVED_BYTES,
} from "@/lib/db/providers/sql/spark/constants";
import { SPARK_ERROR_SENTENCES } from "@/lib/db/providers/sql/spark/errors";
import { SPARK_OBJECT_KINDS, SPARK_PROVIDER_SENTENCES, SparkProvider } from "@/lib/db/providers/sql/spark/index";
import { SPARK_INTROSPECT_SENTENCES } from "@/lib/db/providers/sql/spark/introspect";
import { SPARK_MONITORING_LABELS } from "@/lib/db/providers/sql/spark/monitoring";
import { SPARK_CUT_WARNINGS } from "@/lib/db/providers/sql/spark/result-stream";
import { SPARK_PASTE_SENTENCES } from "@/lib/db/providers/sql/spark/sc-uri";
import { columnsFromArrow } from "@/lib/db/providers/sql/spark/schema";
import { SPARK_STATEMENT_SENTENCES } from "@/lib/db/providers/sql/spark/statement-shape";
import { cellValue } from "@/lib/db/providers/sql/spark/values";
import { DB_UI_CONFIG, SPARK_FIELD_HINTS } from "@/lib/db-ui-config";
import { MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";
import { type ConfirmCodeForm, resolveSqlGrammar } from "@/lib/sql/grammar";
import { CENSUS_CONNECTION } from "../../../helpers/census-connection";
import { captureBytes, readSparkCapture } from "../../../helpers/spark-captures";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const DOC = readFileSync(path.join(ROOT, "docs/providers/spark.md"), "utf8");
const flat = (text: string): string => text.replace(/\s*\n\s*/g, " ");
const FLAT_DOC = flat(DOC);
const MIB = 1024 * 1024;
const n = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const capabilities = new SparkProvider(CENSUS_CONNECTION.spark).getCapabilities();

const HEADINGS = [
  "## 1. What it is",
  "## 2. Connecting",
  "## 3. The recommended Spark setup",
  "## 4. Sessions and scripts",
  "## 5. How a statement runs",
  "## 6. Results",
  "## 7. The tree",
  "## 8. Features",
  "## 9. The confirmation gate",
  "## 10. Security",
  "## 11. Errors",
  "## 12. Embedded package",
  "## 13. Testing and evidence",
];

/** The section under the heading line `heading`, up to the next heading of its level or above. */
function sectionOf(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`no heading ${heading}`);
  const level = heading.indexOf(" ");
  const inFence = (at: number) => lines.slice(0, at).filter((line) => line.startsWith("```")).length % 2 === 1;
  const end = lines.findIndex(
    (line, at) => at > start && /^#{1,6} /.test(line) && line.indexOf(" ") <= level && !inFence(at),
  );
  return lines.slice(start, end < 0 ? lines.length : end).join("\n");
}

/** How section 9 names a code form: its words, its prefix, its word before a string, the call it reads, or `$$...$$`. */
function namedForm(form: ConfirmCodeForm): string {
  if ("prefix" in form) return form.prefix;
  if ("wordThenLiteral" in form) return `${form.wordThenLiteral} '<command>'`;
  if ("quotedCall" in form) return form.quotedCall;
  if ("computedCall" in form) return `${form.computedCall}(...)(...)`;
  if ("dollarQuoted" in form) return "$$...$$";
  return form.join(" ");
}

/** The cells of every body row of the first table in `text`. */
function tableRows(text: string): string[][] {
  const rows = text.split("\n").filter((line) => line.startsWith("| "));
  return rows.slice(2).map((line) =>
    line
      .slice(2, -2)
      .split(" | ")
      .map((cell) => cell.trim()),
  );
}

// The holes a sentence with parameters is printed with in the doc.
const PORT = "<port>" as unknown as number;
const N = "<n>" as unknown as number;
const LIMIT = "<limit>" as unknown as number;
const HOLES: Readonly<Record<string, readonly unknown[]>> = {
  notConnected: ["<host>", PORT],
  tlsPlaintextServer: ["<host>", PORT],
  tlsPortExpected: ["<host>", PORT],
  tlsNameMismatch: ["<host>"],
  notSparkConnect: ["<host>", PORT],
  tokenlessCaution: ["<host>", PORT],
  tokenUnchecked: ["<host>", PORT],
  versionTooOld: ["<version>"],
  versionUnreadable: ["<text>"],
  streamFailed: ["<status text>"],
  setupFailed: ["<step>", "<status text>"],
  emptyStatus: ["<code name>"],
  batchTooLarge: [N],
  deadline: [N],
  deadlineBeforeSend: [N],
  setupDeadline: ["<step>", N],
  compressed: ["<codec>"],
  unreadable: ["<what>"],
  cellUnreadable: ["<type>", "<column>"],
  noKind: ["<kind>"],
  noColumns: ["<kind>"],
  noSource: ["<kind>"],
  badLimit: [LIMIT],
};

/** Every sentence of a record, a function called with its holes; a key with no holes fails, so a new key is decided. */
function sentences(record: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(record).map(([key, value]) => {
    if (typeof value === "string") return value;
    const holes = HOLES[key];
    if (typeof value !== "function" || holes === undefined) throw new Error(`no hole values for ${key}`);
    return (value as (...args: unknown[]) => string)(...holes);
  });
}

/** The bytes of the first `<key>.data` anywhere in a captured answer. */
function firstBytes(value: unknown, key: string): Uint8Array | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstBytes(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const holder = record[key];
  if (typeof holder === "object" && holder !== null && "data" in holder)
    return captureBytes((holder as { data: unknown }).data);
  for (const child of Object.values(record)) {
    const found = firstBytes(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

describe("docs/providers/spark.md", () => {
  test("has the thirteen sections in order", () => {
    expect(DOC.split("\n").filter((line) => line.startsWith("## "))).toEqual(HEADINGS);
  });

  test("quotes every sentence of each record word for word", () => {
    const all = [
      ...sentences(SPARK_FIELD_SENTENCES),
      ...sentences(SPARK_PASTE_SENTENCES),
      ...sentences(SPARK_STATEMENT_SENTENCES),
      ...sentences(SPARK_ERROR_SENTENCES),
      ...sentences(SPARK_PROVIDER_SENTENCES),
      ...sentences(SPARK_MONITORING_LABELS),
      ...sentences(SPARK_INTROSPECT_SENTENCES),
      ...sentences(SPARK_CUT_WARNINGS),
      ...Object.values(SPARK_FIELD_HINTS),
    ];
    // The failure lists every sentence the doc does not yet quote, exactly as the doc must print it.
    expect(all.filter((sentence) => !FLAT_DOC.includes(flat(sentence)))).toEqual([]);
  });

  test("lists the refusals made before any call together in section 4, each sentence quoted", () => {
    const sessions = flat(sectionOf(DOC, "## 4. Sessions and scripts"));
    expect(sentences(SPARK_STATEMENT_SENTENCES).filter((sentence) => !sessions.includes(flat(sentence)))).toEqual([]);
  });

  test("states the paste's token decoding and TLS rule as Spark's 4.2.0 clients read an sc:// address", () => {
    const paste = flat(sectionOf(DOC, "### 2.5 Paste URL"));
    for (const phrase of [
      "percent-decoded",
      "`use_ssl=true`",
      "`use_ssl=false`",
      "`localhost`",
      "clears the paste box",
    ]) {
      expect(paste).toContain(phrase);
    }
    expect(paste).toContain(flat(SPARK_PASTE_SENTENCES.tokenEscape));
  });

  test("names the fields by the dialog's labels, in the dialog's order", () => {
    const ui = DB_UI_CONFIG.spark;
    const firstCells = tableRows(sectionOf(DOC, "### 2.1 Fields")).map((cells) => cells[0]);
    expect(firstCells).toEqual(ui.connectionFields.map((field) => ui.fieldLabels?.[field] ?? field));
  });

  test("lists exactly the features the provider declares off", () => {
    const off: string[] = [];
    if (capabilities.supportsSqlFormat === false) off.push("Format");
    if (capabilities.supportsInlineRowEdit === false) off.push("Inline row edit");
    if (capabilities.supportsCreateTable === false) off.push("Create Table");
    if (importRefusal(capabilities) !== null) off.push("Import Data");
    if (capabilities.supportsTestDataGeneration === false) off.push("Test data generation");
    if (capabilities.supportsResultPagination === false) off.push("Load More");
    if (capabilities.supportsColumnProfiling === false) off.push("Column profiler");
    if (capabilities.supportsTransactions === false) off.push("Transactions");
    if (capabilities.supportsMaintenance === false && capabilities.maintenanceOperations?.length === 0)
      off.push("Maintenance");
    expect(tableRows(sectionOf(DOC, "### 8.6 Off in this version")).map((cells) => cells[0])).toEqual(off);
  });

  test("the Import Data row quotes the import dialog's refusal, which no kind that takes row writes lifts", () => {
    expect(importRefusal(capabilities)).toBe(IMPORT_NO_TARGET);
    expect(SPARK_OBJECT_KINDS.some((kind) => kind.acceptsRowWrites === true)).toBe(false);
    const row = tableRows(sectionOf(DOC, "### 8.6 Off in this version")).find((cells) => cells[0] === "Import Data");
    expect(row?.[1]).toContain(`\`${IMPORT_NO_TARGET}\``);
  });

  test("states the capabilities the features section describes", () => {
    const features = flat(sectionOf(DOC, "## 8. Features"));
    expect(capabilities.explainFormat).toBe("spark-text");
    expect(features).toContain("`EXPLAIN FORMATTED <statement>`");
    expect(MCP_EXPOSABLE.spark).toBe(true);
    for (const tool of ["`list_connections`", "`inspect_schema`", "`run_read_query`"]) expect(features).toContain(tool);
    expect(capabilities.declaresForeignKeys).toBe(false);
    expect(flat(sectionOf(DOC, "## 7. The tree"))).toContain("no foreign keys");
    const exportText = flat(sectionOf(DOC, "### 8.5 Export"));
    expect(exportText).toContain("`MAP('mode', 'FAILFAST')`");
    expect(exportText).toContain("A nested `bigint` past 2^53 fails its INSERT, a known limit.");
  });

  test("quotes the plan walk's count of the catalogs it does not name as the packing writes it, in Spark's level words", () => {
    const levels = capabilities.containerLevels;
    if (levels === undefined || levels.length !== 2) throw new Error("Spark declares a catalog and a namespace level");
    const [catalog, namespace] = levels;
    // The note past the catalogs the walk names, written for <n> of them and for one.
    const note = (count: number): string => {
      const packed = packOperationsInventory({
        objects: [],
        connectionId: "spark",
        fingerprint: "doc",
        capturedAtMs: 0,
        unreadContainers: {
          count: 0,
          label: namespace.label,
          labelPlural: namespace.labelPlural,
          read: ["spark_catalog.default"],
          unlistedParentsNotNamed: { count, label: catalog.label, labelPlural: catalog.labelPlural },
        },
      });
      const found = packed.match(new RegExp(`${count} more [^.]*\\.`));
      if (found === null) throw new Error(`the packing wrote no count of ${count} catalogs`);
      return found[0];
    };
    const plan = flat(sectionOf(DOC, "### 8.3 Plan mode and agent operations"));
    for (const count of [N, 1]) expect(plan).toContain(`\`${note(count)}\``);
  });

  test("names every confirmation form and session key the grammar declares", () => {
    const grammar = resolveSqlGrammar("spark");
    const gate = flat(sectionOf(DOC, "## 9. The confirmation gate"));
    for (const form of grammar.confirmForms ?? []) expect(gate).toContain(`\`${form.join(" ")}\``);
    for (const form of grammar.confirmCodeForms ?? []) expect(gate).toContain(`\`${namedForm(form)}\``);
    for (const key of grammar.confirmConfigKeys ?? []) expect(gate).toContain(`\`${key}\``);
    expect(gate).toContain("a second look, not a boundary");
  });

  test("says how the editor reads raw strings, `/*+` and `--` comments, as the grammar does", () => {
    const grammar = resolveSqlGrammar("spark");
    const gate = flat(sectionOf(DOC, "## 9. The confirmation gate"));
    expect(grammar.rawStrings).toBe(true);
    expect(grammar.hintsAreCode).toBe(true);
    expect(grammar.lineCommentBackslashContinues).toBe(true);
    expect(grammar.lineCommentEndsAtCarriageReturn).toBe(true);
    expect(gate).toContain("`r'...'`");
    expect(gate).toContain("`/*+`");
    expect(gate).toContain("a backslash right before a line feed continues a `--` comment onto the next line");
    expect(gate).toContain("a lone carriage return ends a `--` comment");
  });

  test("quotes the bounds the code holds", () => {
    for (const phrase of [
      `${SPARK_RECEIVE_CAP_BYTES / MIB} MiB`,
      `${SPARK_ARROW_CHUNK_BYTES / MIB} MiB`,
      `${SPARK_STREAM_MAX_RECEIVED_BYTES / MIB} MiB`,
      `${n(MAX_UNLIMITED_ROWS)} rows`,
      `${n(SPARK_ARROW_MAX_RECORDS_PER_BATCH)} rows a batch`,
      `${SPARK_HEARTBEAT_INTERVAL_MS / 1000} s`,
      `${SPARK_CONTROL_DEADLINE_MS / 1000} s deadline`,
      `${n(SPARK_NAMESPACE_WALK_MAX)} namespaces`,
      `${SPARK_NAMESPACE_MAX_PARTS} levels`,
      `${n(SPARK_DESCRIBE_OBJECTS_MAX)} objects`,
      `depth of ${SPARK_SCHEMA_MAX_DEPTH}`,
      `${n(SPARK_SCHEMA_MAX_FIELDS)} fields`,
      `port ${SPARK_DEFAULT_PORT}`,
    ]) {
      expect(FLAT_DOC).toContain(phrase);
    }
  });

  test("the kinds table lists every kind, in the code's order", () => {
    const firstCells = tableRows(sectionOf(DOC, "### 7.2 Kinds")).map((cells) => cells[0]);
    expect(firstCells).toEqual(SPARK_OBJECT_KINDS.map((kind) => `\`${kind.id}\``));
  });

  test("the type table's cells are what the decoder gives for the captured every-type row", () => {
    const capture = readSparkCapture("4.2.0", "every-type-relation");
    if (capture.outcome !== "pass") throw new Error("the every-type capture is an error capture");
    const bytes = firstBytes(capture.payload, "arrow_batch");
    if (bytes === undefined) throw new Error("the every-type capture holds no arrow_batch data");
    const batch = readIpcColumns(bytes);
    const columns = columnsFromArrow(batch);
    const table = new Map(tableRows(sectionOf(DOC, "### 6.1 Types")).map((cells) => [cells[0], cells[2]]));
    expect(table.size).toBe(columns.length);
    columns.forEach((column, index) => {
      const value = cellValue(column, batch.columns[index], 0);
      expect(table.get(`\`${column.name}\``)).toBe(`\`${typeof value === "string" ? value : JSON.stringify(value)}\``);
    });
  });

  test("names the types the cell refusal writes `an` before, as the sentence writes them", () => {
    const nested = flat(sectionOf(DOC, "### 6.2 Nested values"));
    for (const type of ["int", "array"]) {
      expect(nested).toContain(`\`an ${type} value\``);
      expect(SPARK_ERROR_SENTENCES.cellUnreadable(type, "<column>")).toContain(` an ${type} value `);
    }
  });

  test("states the floor and the tested versions", () => {
    const what = flat(sectionOf(DOC, "## 1. What it is"));
    expect(what).toContain(`Spark ${SPARK_MIN_VERSION.major}.${SPARK_MIN_VERSION.minor} or later`);
    expect(what).toContain("4.1.3");
    expect(what).toContain("4.2.0");
  });

  test("names every mode of the capture harness's usage in section 13", () => {
    const harness = readFileSync(path.join(ROOT, "tests/live/spark-evidence.ts"), "utf8");
    const usage = harness.match(/const USAGE =\s*"([^"]*)"/)?.[1];
    if (usage === undefined) throw new Error("tests/live/spark-evidence.ts declares no USAGE");
    const modes = usage.match(/--[a-z]+/g) ?? [];
    expect(modes).toStrictEqual(["--setup", "--capture", "--readme", "--surfaces"]);
    const testing = flat(sectionOf(DOC, "## 13. Testing and evidence"));
    expect(modes.filter((mode) => !testing.includes(mode))).toStrictEqual([]);
  });

  test("states every security topic the provider owes its reader", () => {
    const security = flat(sectionOf(DOC, "## 10. Security"));
    for (const topic of ["no engine-side read-only mode", "D212", "3.22", "web UI", "global temp", "loopback"]) {
      expect(security).toContain(topic);
    }
    expect(flat(sectionOf(DOC, "### 8.7 Object edit (#789)"))).toContain("not in this version");
  });

  test("puts no secret in an example and names no private record", () => {
    for (const match of DOC.matchAll(/password:\s*"([^"]*)"/g)) expect(match[1]).toBe("${SPARK_TOKEN}");
    expect(DOC).not.toMatch(/Bearer\s+(?!<token>)\S{8,}/);
    expect(DOC).not.toMatch(/\b[DLP]\d{2}-C\d+\b/);
    expect(DOC).not.toMatch(/\/home\/|PRIVATE-FINDINGS|design record/);
    // No en dash (U+2013) and no em dash (U+2014), written by code point so this file carries neither.
    expect(DOC).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
  });
});
