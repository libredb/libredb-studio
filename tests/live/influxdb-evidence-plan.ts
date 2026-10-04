/**
 * The statement plan of the InfluxDB evidence harness (InfluxDB design section 8, E22): every request
 * tests/live/influxdb-evidence.ts sends to the `influxdb1`, `influxdb2`, `influxdb3` and `influxdb3-filelimit`
 * services of docker/influxdb/README.md, built here and nowhere else, so a unit test can read the whole list
 * (tests/unit/live/influxdb-evidence-plan.test.ts). Pure: no I/O and no import.
 *
 * The harness never writes. A differential corpus entry is built only by `corpusEntry`, from fixed parts and the
 * constant hidden statement `SHOW DATABASES`, aimed at a database that exists on no server, and on 1.13.1 and 2.9.1
 * bound to the read principal (3.12.0 Core has only its admin token); the runner checks that binding before it
 * sends one. Every other statement passes its type's policy first (`language` names which), admin principal
 * included. No entry names a write, admin or token route; docker/influxdb/seed.sh is the only writer, and the
 * harness never imports or runs it. After the run, `buildNowhereChecks` asks each server, as admin, what the
 * database that does not exist holds, and the runner fails loudly on any series.
 *
 * Principals: `read` is the 1.x user `reader` (READ on home) or the 2.x read-only token for bucket home, `admin` the
 * 1.x admin user, the 2.x operator token or the 3.x admin token, `anonymous` no credential. One capture sends its
 * principal another way: `token-without-user` sends the 1.x reader's password as `Authorization: Token <password>`.
 * A "statement" entry with no `language` carries no statement text (the `/ping`, `/health` and configure reads).
 */

export const EVIDENCE_HIDDEN_STATEMENT = "SHOW DATABASES";
/** Exists on no line; every corpus entry and every `INTO` shape names this database or none. */
export const EVIDENCE_NOWHERE_DATABASE = "studio_evidence_nowhere";

export type EvidenceLine = "1.13.1" | "2.9.1" | "3.12.0-core" | "3.12.0-core-filelimit";
export type EvidencePrincipal = "anonymous" | "admin" | "read";

export interface EvidenceEntry {
  /** The capture name, written as tests/fixtures/influxdb/<line>/<capture>.json. */
  readonly capture: string;
  readonly line: EvidenceLine;
  readonly principal: EvidencePrincipal;
  readonly kind: "corpus" | "statement" | "raw";
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly form?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, string>>;
  /** Which policy the runner runs before sending the entry's text. */
  readonly language?: "influxql" | "sql";
  /**
   * The server is expected to end the body before it is complete (capture 10), with this cut: nothing at all, or
   * after whole lines, which is all 3.12.0 produces (R39).
   */
  readonly expectCut?: "zero-byte" | "line-end";
}

/**
 * The synthetic captures the runner derives instead of sending (R39): the body of `source`, a `line-end` cut on
 * `line`, sliced inside its last line and written as `capture`, labelled `synthetic` with the source and the offset.
 */
export const EVIDENCE_MID_LINE_SLICES: readonly {
  readonly capture: string;
  readonly source: string;
  readonly line: EvidenceLine;
}[] = [{ capture: "sql-truncated-mid-line", source: "sql-truncated", line: "3.12.0-core" }];

const V1: EvidenceLine = "1.13.1";
const V2: EvidenceLine = "2.9.1";
const V3: EvidenceLine = "3.12.0-core";
const FILELIMIT: EvidenceLine = "3.12.0-core-filelimit";
const ENGINE_LINES: readonly EvidenceLine[] = [V1, V2, V3];

/** The 64 KiB reads of capture 15: the influxdb text cap, in bytes. */
const FORM_BYTES = 65_536;

/** The principal that reads where the line has one: 3.x Core has only its admin token. */
function readerOf(line: EvidenceLine): EvidencePrincipal {
  return line === V1 || line === V2 ? "read" : "admin";
}

/** An InfluxQL read as the provider sends it: a chunked `POST /query` with a form body. */
function influxql(
  capture: string,
  line: EvidenceLine,
  principal: EvidencePrincipal,
  q: string,
  options: { readonly db?: string; readonly chunkSize?: string } = {},
): EvidenceEntry {
  const db: Readonly<Record<string, string>> = options.db === undefined ? {} : { db: options.db };
  return {
    capture,
    line,
    principal,
    kind: "statement",
    method: "POST",
    path: "/query",
    form: { ...db, q, chunked: "true", chunk_size: options.chunkSize ?? "1000" },
    language: "influxql",
  };
}

/** A SQL read on `POST /api/v3/query_sql`, answered as JSON lines. */
function sql(
  capture: string,
  line: EvidenceLine,
  principal: EvidencePrincipal,
  q: string,
  options: { readonly db?: string; readonly expectCut?: EvidenceEntry["expectCut"] } = {},
): EvidenceEntry {
  return {
    capture,
    line,
    principal,
    kind: "statement",
    method: "POST",
    path: "/api/v3/query_sql",
    body: { db: options.db ?? "home", q, format: "jsonl" },
    language: "sql",
    ...(options.expectCut === undefined ? {} : { expectCut: options.expectCut }),
  };
}

/** A request that carries no statement text. */
function textless(
  capture: string,
  line: EvidenceLine,
  principal: EvidencePrincipal,
  path: string,
  query?: Readonly<Record<string, string>>,
): EvidenceEntry {
  return {
    capture,
    line,
    principal,
    kind: "statement",
    method: "GET",
    path,
    ...(query === undefined ? {} : { query }),
  };
}

/**
 * The only builder of a differential corpus entry (capture 8): its text is `parts.before + parts.separator +
 * EVIDENCE_HIDDEN_STATEMENT`, its database the one that does not exist, and its principal the read principal on
 * 1.13.1 and 2.9.1 and the admin token on 3.12.0-core, whose `/query` runs a separate Rust parser (R19).
 */
export function corpusEntry(
  id: string,
  line: EvidenceLine,
  parts: { readonly before: string; readonly separator: string },
): EvidenceEntry {
  if (!ENGINE_LINES.includes(line)) {
    throw new Error(`The differential corpus runs on 1.13.1, 2.9.1 and 3.12.0-core only, not on ${line}`);
  }
  return {
    capture: `differential/${id}`,
    line,
    principal: readerOf(line),
    kind: "corpus",
    method: "POST",
    path: "/query",
    form: {
      db: EVIDENCE_NOWHERE_DATABASE,
      q: `${parts.before}${parts.separator}${EVIDENCE_HIDDEN_STATEMENT}`,
      chunked: "true",
      chunk_size: "1000",
    },
  };
}

const NOWHERE = `"${EVIDENCE_NOWHERE_DATABASE}"`;

/**
 * The parts of capture 8. B1 to B5 are J1 1.2's bypass shapes, cut to end in the hidden statement; the INTO shapes
 * are J1 1.3's, aimed at the database that does not exist; the C1 entries are each lexical edge in a second
 * position; the R13 entry is the `WITH MEASUREMENT = /.../` source; the F5 entries are kiro F5's division and regex
 * shapes; the R42 entries separate two statements with whitespace or a comment alone, which 3.12.0 runs as two.
 * Every `\` here is one backslash on the wire.
 */
const CORPUS_PARTS: readonly (readonly [string, string, string])[] = [
  ["b1-cr-ends-comment", "SELECT count(temp) FROM home -- c", "\r; "],
  ["b2-backslash-in-regex", "SELECT count(temp) FROM /a\\\\/ 'x/", "; "],
  ["b3-division-after-field", "SELECT temp::field / 2 FROM home LIMIT 1", "; "],
  ["b4-backslash-in-string", "SELECT count(temp) FROM home WHERE room = 'a\\\\'", "; "],
  ["b5-nul", "SELECT count(temp) FROM home", "\u0000; "],
  ["into-subquery", `SELECT * FROM (SELECT temp INTO ${NOWHERE}..x FROM home) LIMIT 1`, "; "],
  ["into-explain", `EXPLAIN SELECT temp INTO ${NOWHERE}..x FROM home`, "; "],
  ["into-lowercase", `select temp into ${NOWHERE}..x from home`, "; "],
  ["c1-crlf-ends-comment", "SELECT count(temp) FROM home -- c", "\r\n; "],
  ["c1-backslash-in-match-regex", "SELECT count(temp) FROM home WHERE room =~ /a\\\\/ 'x/", "; "],
  ["c1-division-after-tag", "SELECT temp FROM home WHERE room::tag / 2 = 1", "; "],
  ["c1-backslash-in-quoted-name", 'SELECT count("a\\\\") FROM home', "; "],
  ["c1-nul-in-string", "SELECT count(temp) FROM home WHERE room = 'a\u0000'", "; "],
  ["with-measurement-regex", `SHOW MEASUREMENTS ON ${NOWHERE} WITH MEASUREMENT = /h.*/`, "; "],
  ["f5-division-tight", "SELECT 1/2 FROM home", "; "],
  ["f5-division-spaced", "SELECT 1 / 2 FROM home", "; "],
  ["f5-comment-before-division", "SELECT 1 /* c */ / 2 FROM home", "; "],
  ["f5-regex-after-from", "SELECT * FROM /.*/", "; "],
  ["f5-regex-after-match", "SELECT * FROM home WHERE room =~ /kitchen.*/", "; "],
  ["f5-regex-after-with-measurement", "SHOW MEASUREMENTS WITH MEASUREMENT = /h.*/", "; "],
  ["r42-space-show", "SHOW DATABASES", " "],
  ["r42-tab-show", "SHOW DATABASES", "\t"],
  ["r42-newline-show", "SHOW DATABASES", "\n"],
  ["r42-comment-show", "SHOW DATABASES", "/* c */"],
  ["r42-space-select", "SELECT count(temp) FROM home", " "],
];

/** The preview text of SPEC 6.6 for a measurement of database home. */
function previewOf(measurement: string): string {
  return [
    "-- Newest points of the last hour, LIMIT 50 per series. No row means no point is newer: widen 1h below.",
    `SELECT * FROM "home".."${measurement}" WHERE time > now() - 1h ORDER BY time DESC LIMIT 50`,
  ].join("\n");
}

/** A read padded in a trailing comment to exactly `FORM_BYTES` bytes, with the padding repeated from `unit`. */
function paddedTo64KiB(unit: string): string {
  const head = 'SELECT count(temp) FROM "home".."home" -- ';
  const encoder = new TextEncoder();
  const room = FORM_BYTES - encoder.encode(head).length;
  const unitBytes = encoder.encode(unit).length;
  return head + unit.repeat(Math.floor(room / unitBytes)) + "-".repeat(room % unitBytes);
}

const QUOTE_HEAVY = paddedTo64KiB(`"'`);
const MULTIBYTE = paddedTo64KiB("€");

function perEngineLine(line: EvidenceLine): EvidenceEntry[] {
  const reader = readerOf(line);
  const entries: EvidenceEntry[] = [
    // 1: the version bodies.
    textless("ping-anon", line, "anonymous", "/ping"),
    textless("ping-auth", line, "admin", "/ping"),
    textless("health-anon", line, "anonymous", "/health"),
    textless("health-auth", line, "admin", "/health"),
    // 2: the catalog reads.
    influxql("show-databases-admin", line, "admin", "SHOW DATABASES"),
    influxql("show-measurements-home", line, reader, 'SHOW MEASUREMENTS ON "home"', { db: "home" }),
    influxql("show-tag-keys-home", line, reader, 'SHOW TAG KEYS ON "home" FROM "home"', { db: "home" }),
    influxql("show-field-keys-home", line, reader, 'SHOW FIELD KEYS ON "home" FROM "home"', { db: "home" }),
    influxql("show-retention-policies-home", line, reader, 'SHOW RETENTION POLICIES ON "home"', { db: "home" }),
    // 3: the tree preview, with rows and empty.
    influxql("preview-home", line, reader, previewOf("home"), { db: "home" }),
    influxql("preview-edge-empty", line, reader, previewOf("edge"), { db: "home" }),
    // 4: series partial across documents (K5).
    influxql("group-by-room-partial", line, reader, 'SELECT "temp" FROM "home".."home" GROUP BY "room"', {
      db: "home",
      chunkSize: "2",
    }),
    influxql("regex-from-partial", line, reader, "SELECT * FROM /.*/", { db: "home", chunkSize: "2" }),
    // 5: the edge values and the hostile names.
    influxql("edge-values", line, reader, 'SELECT * FROM "home".."edge"', { db: "home" }),
    influxql("hostile-names", line, reader, 'SELECT * FROM "home".."we\\"ird name;x", "home".."edge cases,m"', {
      db: "home",
    }),
    // 6: the errors every line answers.
    influxql("parse-error", line, reader, 'SELECT count(temp) FROM "home".."home" WHERE', { db: "home" }),
    influxql("db-not-found", line, line === V1 ? "admin" : reader, "SELECT count(temp) FROM home", { db: "nope" }),
    influxql("unauthorized", line, "anonymous", "SHOW DATABASES"),
    // 7: a read whose value is NaN. `sqrt(-1.0)` alone is refused on 1.x and 2.x ("field must contain at least
    // one variable") and answers zero bytes on 3.x, so the square root takes a field below zero.
    influxql("nan", line, reader, 'SELECT sqrt("temp" - 100) FROM "home".."home" LIMIT 1', { db: "home" }),
    // R33: a read whose value is infinite, which no line can write as JSON.
    influxql("infinity", line, reader, 'SELECT log("temp", 1) FROM "home".."home" LIMIT 1', { db: "home" }),
    // 15: a 64 KiB statement travels as a form body.
    influxql("form-64k-quotes", line, reader, QUOTE_HEAVY, { db: "home" }),
    influxql("form-64k-multibyte", line, reader, MULTIBYTE, { db: "home" }),
    // 8: the differential corpus.
    ...CORPUS_PARTS.map(([id, before, separator]) => corpusEntry(id, line, { before, separator })),
  ];
  return entries;
}

const TWO_DATABASES = 'SELECT count(v) FROM "home".."numbers", "edge".."numbers"';
const SEGMENT_AFTER_DOT = 'SELECT count(temp) FROM "home". "autogen". "home"';

/** The entries only 1.13.1 answers (captures 2, 6 and 13). */
function v1Only(): EvidenceEntry[] {
  return [
    influxql("show-databases-reader", V1, "read", "SHOW DATABASES"),
    influxql("token-without-user", V1, "read", "SHOW DATABASES"),
    influxql("reader-forbidden", V1, "read", "SHOW USERS"),
    influxql("db-not-found-reader", V1, "read", "SELECT count(temp) FROM home", { db: "nope" }),
    influxql("two-databases-admin", V1, "admin", TWO_DATABASES),
    influxql("two-databases-reader", V1, "read", TWO_DATABASES),
    influxql("segment-after-dot", V1, "read", SEGMENT_AFTER_DOT, { db: EVIDENCE_NOWHERE_DATABASE }),
    ...mispick(V1),
  ];
}

/** The entries only 2.9.1 answers (captures 2, 6 and 13). */
function v2Only(): EvidenceEntry[] {
  return [
    influxql("show-databases-reader", V2, "read", "SHOW DATABASES"),
    influxql("db-name-required", V2, "read", "SELECT count(temp) FROM home"),
    ...mispick(V2),
  ];
}

/** Capture 13: an `influxdb3` connection pointed at a 1.x or 2.x server. */
function mispick(line: EvidenceLine): EvidenceEntry[] {
  return [
    sql("mispick-query-sql", line, "read", "SELECT 1"),
    textless("mispick-configure-database", line, "read", "/api/v3/configure/database", { format: "json" }),
  ];
}

/** The entries only 3.12.0-core answers (captures 2, 6, 8, 9, 10, 12 and 15). */
function v3Only(): EvidenceEntry[] {
  return [
    influxql("show-measurements-edge", V3, "admin", 'SHOW MEASUREMENTS ON "edge"', { db: "edge" }),
    influxql("db-param-missing", V3, "admin", "SELECT count(temp) FROM home"),
    influxql("unknown-measurement", V3, "admin", "SELECT * FROM nope", { db: "home" }),
    influxql("two-databases", V3, "admin", TWO_DATABASES),
    influxql("segment-after-dot", V3, "admin", SEGMENT_AFTER_DOT, { db: EVIDENCE_NOWHERE_DATABASE }),
    corpusEntry("two-statements", V3, { before: "SHOW DATABASES", separator: "; " }),
    // 9: the preview as it reaches the server. SPEC 6.6's SQL text carries no LIMIT; the preview's cap travels as
    // the `limit` execution option (PREVIEW_PAGE_SIZE, 50), and the inherited limiter appends it after the ORDER BY.
    sql(
      "sql-preview-home",
      V3,
      "admin",
      [
        "-- Newest rows of the last hour. No row means no row is newer: widen INTERVAL '1 hour' below.",
        `SELECT * FROM "home" WHERE "time" >= now() - INTERVAL '1 hour' ORDER BY "time" DESC LIMIT 50`,
      ].join("\n"),
    ),
    sql("sql-sparse", V3, "admin", 'SELECT * FROM "sparse"'),
    sql("sql-edge", V3, "admin", 'SELECT * FROM "edge"'),
    sql("sql-empty", V3, "admin", `SELECT * FROM "home" WHERE "room" = 'nobody'`),
    sql("sql-keyword-select", V3, "admin", "SELECT 1"),
    sql("sql-keyword-with", V3, "admin", 'WITH t AS (SELECT "room", "temp" FROM "home") SELECT count(*) FROM t'),
    sql("sql-keyword-values", V3, "admin", "VALUES (1, 'a'), (2, 'b')"),
    sql("sql-keyword-show-tables", V3, "admin", "SHOW TABLES"),
    sql("sql-keyword-explain", V3, "admin", 'EXPLAIN SELECT count(*) FROM "home"'),
    sql("sql-keyword-describe", V3, "admin", 'DESCRIBE "home"'),
    sql("sql-parse-error", V3, "admin", 'SELECT * FROM "home" WHERE'),
    sql("sql-planning-error", V3, "admin", 'SELECT * FROM "nope"'),
    sql("sql-db-not-found", V3, "admin", "SELECT 1", { db: "nope" }),
    sql("sql-not-implemented", V3, "admin", "SHOW DATABASES"),
    sql("sql-schema-error", V3, "admin", 'SELECT "nope" FROM "home"'),
    sql("sql-cross-database", V3, "admin", "SELECT * FROM edge.iox.numbers"),
    sql("sql-truncated-zero", V3, "admin", "SELECT co/(co-co) FROM home", { expectCut: "zero-byte" }),
    // K10 over `seed.sh bench`: one host's last 5,000 seconds in time order, whose divisor is zero only on the last
    // second's row, so earlier batches stream before the failure. Unordered or over every host the failure comes
    // first and the body is empty. The server flushes whole lines, so the cut lands on a line end (R39); now and then
    // nothing arrives, so the runner repeats it. EVIDENCE_MID_LINE_SLICES derives the mid-line capture from it.
    sql(
      "sql-truncated",
      V3,
      "admin",
      `SELECT "i1" / ("i2" - 19999) AS "q" FROM "bulk" WHERE "host" = 'h00' AND "i2" >= 15000 ORDER BY "time"`,
      { db: "bench", expectCut: "line-end" },
    ),
    textless("sql-databases", V3, "admin", "/api/v3/configure/database", { format: "json" }),
    sql(
      "sql-tables",
      V3,
      "admin",
      "SELECT table_catalog, table_schema, table_name, table_type FROM information_schema.tables",
    ),
    sql("sql-schema-home", V3, "admin", "SELECT key, data_type FROM system.influxdb_schema WHERE measurement = 'home'"),
    sql(
      "sql-schema-hostile",
      V3,
      "admin",
      `SELECT key, data_type FROM system.influxdb_schema WHERE measurement = 'we"ird name;x'`,
    ),
    // 15: the same quote-heavy text as a GET request target, answered 414 on 3.12.0: the reason for POST.
    {
      capture: "get-64k-414",
      line: V3,
      principal: "admin",
      kind: "raw",
      method: "GET",
      path: "/query",
      query: { db: "home", q: QUOTE_HEAVY },
      language: "influxql",
    },
  ];
}

/** Capture 11: the file-limit fixture, on `query_sql` and on `/query` (K15). */
function fileLimit(): EvidenceEntry[] {
  return [
    sql("filelimit-sql", FILELIMIT, "admin", 'SELECT count(*) FROM "home"'),
    influxql("filelimit-influxql", FILELIMIT, "admin", 'SELECT count(temp) FROM "home".."home"', { db: "home" }),
  ];
}

/** Every request of the evidence run, in the order the runner sends them. */
export function buildEvidencePlan(): readonly EvidenceEntry[] {
  return [...ENGINE_LINES.flatMap(perEngineLine), ...v1Only(), ...v2Only(), ...v3Only(), ...fileLimit()];
}

/**
 * The admin read after the run (E22): what the database that does not exist holds on each engine line. The runner
 * fails loudly unless the answer holds no series.
 */
export function buildNowhereChecks(): readonly EvidenceEntry[] {
  return ENGINE_LINES.map((line) =>
    influxql("nowhere-check", line, "admin", `SHOW MEASUREMENTS ON ${NOWHERE}`, { db: EVIDENCE_NOWHERE_DATABASE }),
  );
}
