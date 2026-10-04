/**
 * The InfluxDB evidence harness's statement plan (tests/live/influxdb-evidence-plan.ts), held to E22 of the InfluxDB
 * design: the harness never writes. Every differential corpus entry ends in the constant hidden statement, names no
 * database but the one that does not exist, and is bound to the read principal where the line has one; no entry
 * names a write or admin route; and the plan holds every capture the design lists, once per line it names, under
 * the names the fixtures and the tests that replay them load.
 */
import { describe, expect, test } from "bun:test";
import {
  buildEvidencePlan,
  buildNowhereChecks,
  corpusEntry,
  EVIDENCE_HIDDEN_STATEMENT,
  EVIDENCE_MID_LINE_SLICES,
  EVIDENCE_NOWHERE_DATABASE,
  type EvidenceEntry,
  type EvidenceLine,
} from "../../live/influxdb-evidence-plan";
import { policyVerdict } from "../../live/influxdb-evidence-checks";

const PLAN = buildEvidencePlan();
const CORPUS = PLAN.filter((entry) => entry.kind === "corpus");

const V1 = "1.13.1";
const V2 = "2.9.1";
const V3 = "3.12.0-core";
const FILELIMIT = "3.12.0-core-filelimit";
const ALL: readonly EvidenceLine[] = [V1, V2, V3];

/** The statement text an entry sends, wherever it travels. */
function textOf(entry: EvidenceEntry): string | undefined {
  return entry.form?.q ?? entry.query?.q ?? entry.body?.q;
}

/**
 * Every database a statement names, read the way the test of E22 states it: the identifier or quoted identifier
 * after `ON`, and the first segment of a `"x"..` or `x..` source after `INTO` or `FROM`. The three-part form
 * `"x"."rp".m` names a database the same way, so its first segment is read too; a two-part `"rp".m` names none.
 */
function databasesNamedIn(text: string): string[] {
  const segment = String.raw`(?:"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*)`;
  const name = `(${segment})`;
  const unquote = (raw: string) => (raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw);
  const found: string[] = [];
  for (const match of text.matchAll(new RegExp(String.raw`\bON\s+${name}`, "gi"))) found.push(unquote(match[1]));
  for (const match of text.matchAll(
    new RegExp(String.raw`\b(?:INTO|FROM)\s+${name}\s*\.\s*(?:${segment}\s*)?\.`, "gi"),
  )) {
    found.push(unquote(match[1]));
  }
  return found;
}

const DIFFERENTIAL_IDS = [
  "b1-cr-ends-comment",
  "b2-backslash-in-regex",
  "b3-division-after-field",
  "b4-backslash-in-string",
  "b5-nul",
  "into-subquery",
  "into-explain",
  "into-lowercase",
  "c1-crlf-ends-comment",
  "c1-backslash-in-match-regex",
  "c1-division-after-tag",
  "c1-backslash-in-quoted-name",
  "c1-nul-in-string",
  "with-measurement-regex",
  "f5-division-tight",
  "f5-division-spaced",
  "f5-comment-before-division",
  "f5-regex-after-from",
  "f5-regex-after-match",
  "f5-regex-after-with-measurement",
];

/** The capture list of the plan (T01), the synthetic captures aside: capture 14 and `sql-truncated-mid-line` (R39). */
const EXPECTED_CAPTURES: Readonly<Record<string, readonly EvidenceLine[]>> = {
  "ping-anon": ALL,
  "ping-auth": ALL,
  "health-anon": ALL,
  "health-auth": ALL,
  "show-databases-admin": ALL,
  "show-databases-reader": [V1, V2],
  "show-measurements-home": ALL,
  "show-tag-keys-home": ALL,
  "show-field-keys-home": ALL,
  "show-retention-policies-home": ALL,
  "show-measurements-edge": [V3],
  "preview-home": ALL,
  "preview-edge-empty": ALL,
  "group-by-room-partial": ALL,
  "regex-from-partial": ALL,
  "edge-values": ALL,
  "hostile-names": ALL,
  "parse-error": ALL,
  "db-not-found": ALL,
  "db-name-required": [V2],
  "db-param-missing": [V3],
  "unknown-measurement": [V3],
  unauthorized: ALL,
  "token-without-user": [V1],
  "reader-forbidden": [V1],
  "db-not-found-reader": [V1],
  "two-databases-admin": [V1],
  "two-databases-reader": [V1],
  "two-databases": [V3],
  "segment-after-dot": [V1, V3],
  nan: ALL,
  infinity: ALL,
  ...Object.fromEntries(DIFFERENTIAL_IDS.map((id) => [`differential/${id}`, ALL])),
  "differential/two-statements": [V3],
  "sql-preview-home": [V3],
  "sql-sparse": [V3],
  "sql-edge": [V3],
  "sql-empty": [V3],
  "sql-keyword-select": [V3],
  "sql-keyword-with": [V3],
  "sql-keyword-values": [V3],
  "sql-keyword-show-tables": [V3],
  "sql-keyword-explain": [V3],
  "sql-keyword-describe": [V3],
  "sql-parse-error": [V3],
  "sql-planning-error": [V3],
  "sql-db-not-found": [V3],
  "sql-not-implemented": [V3],
  "sql-schema-error": [V3],
  "sql-cross-database": [V3],
  "sql-truncated-zero": [V3],
  "sql-truncated": [V3],
  "filelimit-sql": [FILELIMIT],
  "filelimit-influxql": [FILELIMIT],
  "sql-databases": [V3],
  "sql-tables": [V3],
  "sql-schema-home": [V3],
  "sql-schema-hostile": [V3],
  "mispick-query-sql": [V1, V2],
  "mispick-configure-database": [V1, V2],
  "form-64k-quotes": ALL,
  "form-64k-multibyte": ALL,
  "get-64k-414": [V3],
};

/**
 * The routes the plan may send, each a read: the two version probes, the v1 query route, the 3.x SQL route and the
 * 3.x database listing. Every other route counts as one that writes, administers or mints a credential, so a route
 * nobody thought to name here is refused too.
 */
const READ_ROUTES: readonly string[] = [
  "GET /ping",
  "GET /health",
  "GET /query",
  "POST /query",
  "POST /api/v3/query_sql",
  "GET /api/v3/configure/database",
];

function isWriteOrAdmin(entry: EvidenceEntry): boolean {
  return !READ_ROUTES.includes(`${entry.method} ${entry.path}`);
}

describe("the differential corpus (E22)", () => {
  test("holds an entry on every engine line", () => {
    for (const line of ALL) {
      expect(CORPUS.filter((entry) => entry.line === line).length).toBeGreaterThanOrEqual(DIFFERENTIAL_IDS.length);
    }
    expect(CORPUS.some((entry) => entry.line === FILELIMIT)).toBe(false);
  });

  test("every entry's text ends in the hidden statement", () => {
    for (const entry of CORPUS) expect(textOf(entry)?.endsWith(EVIDENCE_HIDDEN_STATEMENT)).toBe(true);
  });

  test("every entry names no database but the one that does not exist", () => {
    for (const entry of CORPUS) {
      const databases = [entry.form?.db, entry.query?.db, entry.body?.db].filter((db) => db !== undefined);
      for (const db of [...databases, ...databasesNamedIn(textOf(entry) ?? "")]) {
        expect({ capture: entry.capture, db }).toEqual({ capture: entry.capture, db: EVIDENCE_NOWHERE_DATABASE });
      }
    }
  });

  test("the INTO shapes aim at the database that does not exist", () => {
    const into = CORPUS.filter((entry) => /\binto\b/i.test(textOf(entry) ?? ""));
    expect(into.length).toBe(3 * ALL.length);
    for (const entry of into) expect(databasesNamedIn(textOf(entry) ?? "")).toEqual([EVIDENCE_NOWHERE_DATABASE]);
  });

  test("every entry on 1.x and 2.x is bound to the read principal, and 3.x has only its admin token", () => {
    for (const entry of CORPUS) expect(entry.principal).toBe(entry.line === V3 ? "admin" : "read");
  });

  test("every entry is a chunked POST to /query", () => {
    for (const entry of CORPUS) {
      expect([entry.method, entry.path, entry.form?.chunked, entry.query, entry.body]).toEqual([
        "POST",
        "/query",
        "true",
        undefined,
        undefined,
      ]);
    }
  });

  test("the database reader sees a two-part and a three-part source, quoted or bare", () => {
    expect(databasesNamedIn('SELECT temp INTO "a"..x FROM b..y')).toEqual(["a", "b"]);
    expect(databasesNamedIn('SELECT temp INTO "a"."rp".x FROM b.rp.y')).toEqual(["a", "b"]);
    expect(databasesNamedIn('select temp into a . rp . x from "b\\"c"."rp"."y"')).toEqual(["a", 'b"c']);
    expect(databasesNamedIn('SELECT temp FROM "rp"."m" WHERE room = \'a\'')).toEqual([]);
    expect(databasesNamedIn('SHOW MEASUREMENTS ON "a"')).toEqual(["a"]);
  });

  test("corpusEntry joins its fixed parts to the hidden statement", () => {
    const entry = corpusEntry("probe", V2, { before: "SELECT 1/2 FROM home", separator: "; " });
    expect(entry).toMatchObject({
      capture: "differential/probe",
      line: V2,
      principal: "read",
      kind: "corpus",
      method: "POST",
      path: "/query",
    });
    expect(textOf(entry)).toBe(`SELECT 1/2 FROM home; ${EVIDENCE_HIDDEN_STATEMENT}`);
    expect(corpusEntry("probe", V3, { before: "SHOW DATABASES", separator: ";" }).principal).toBe("admin");
  });

  test("corpusEntry refuses the file-limit fixture, which has no corpus", () => {
    expect(() => corpusEntry("probe", FILELIMIT, { before: "SELECT 1", separator: ";" })).toThrow(
      "The differential corpus runs on 1.13.1, 2.9.1 and 3.12.0-core only, not on 3.12.0-core-filelimit",
    );
  });

  test("the C1 edges travel as the bytes the scanner reads", () => {
    const text = (line: EvidenceLine, id: string) =>
      textOf(CORPUS.find((entry) => entry.line === line && entry.capture === `differential/${id}`) as EvidenceEntry);
    expect(text(V1, "b1-cr-ends-comment")).toBe("SELECT count(temp) FROM home -- c\r; SHOW DATABASES");
    expect(text(V1, "c1-crlf-ends-comment")).toBe("SELECT count(temp) FROM home -- c\r\n; SHOW DATABASES");
    expect(text(V1, "b2-backslash-in-regex")).toBe("SELECT count(temp) FROM /a\\\\/ 'x/; SHOW DATABASES");
    expect(text(V1, "b4-backslash-in-string")).toBe(
      "SELECT count(temp) FROM home WHERE room = 'a\\\\'; SHOW DATABASES",
    );
    expect(text(V1, "b5-nul")).toBe("SELECT count(temp) FROM home\u0000; SHOW DATABASES");
    expect(text(V3, "two-statements")).toBe("SHOW DATABASES; SHOW DATABASES");
  });
});

describe("the whole plan (E22)", () => {
  test("no entry names a write, admin or token route", () => {
    expect(
      [...PLAN, ...buildNowhereChecks()]
        .filter(isWriteOrAdmin)
        .map((entry) => `${entry.line} ${entry.method} ${entry.path}`),
    ).toEqual([]);
  });

  test("the route check refuses each route E22 names", () => {
    const probe = (method: "GET" | "POST", path: string) =>
      isWriteOrAdmin({ capture: "x", line: V3, principal: "admin", kind: "raw", method, path });
    for (const path of [
      "/write",
      "/api/v2/write",
      "/api/v3/write_lp",
      "/api/v2/query",
      "/api/v3/configure/token/admin",
      "/api/v3/configure/table",
      "/api/v3/engine/x",
      "/api/v3/plugin_test/wal",
      "/api/v2/authorizations/token",
      "/api/v2/authorizations",
      "/api/v2/buckets",
      "/api/v2/delete",
      "/api/v2/orgs",
      "/api/v3/configure/database/retention_period",
      "/query/x",
      "/debug/vars",
    ]) {
      expect(probe("POST", path)).toBe(true);
    }
    expect(probe("POST", "/api/v3/configure/database")).toBe(true);
    expect(probe("GET", "/api/v3/query_sql")).toBe(true);
    expect(probe("POST", "/ping")).toBe(true);
    expect(probe("GET", "/api/v3/configure/database")).toBe(false);
    expect(probe("POST", "/query")).toBe(false);
  });

  test("the route check passes exactly the read routes, and the plan and the read after the run use each", () => {
    const sent = [...PLAN, ...buildNowhereChecks()].map((entry) => `${entry.method} ${entry.path}`);
    expect([...new Set(sent)].sort()).toEqual([...READ_ROUTES].sort());
  });

  test("the SQL preview capture is the generator's text as it reaches the server, bound by the limiter", () => {
    const generated = [
      "-- Newest rows of the last hour. No row means no row is newer: widen INTERVAL '1 hour' below.",
      `SELECT * FROM "home" WHERE "time" >= now() - INTERVAL '1 hour' ORDER BY "time" DESC`,
    ].join("\n");
    const preview = PLAN.find((entry) => entry.capture === "sql-preview-home") as EvidenceEntry;
    expect(textOf(preview)).toBe(`${generated} LIMIT 50`);
  });

  test("holds every capture of the list once per line it names, and nothing else", () => {
    const seen = new Map<string, EvidenceLine[]>();
    for (const entry of PLAN) seen.set(entry.capture, [...(seen.get(entry.capture) ?? []), entry.line]);
    expect([...seen.keys()].sort()).toEqual(Object.keys(EXPECTED_CAPTURES).sort());
    for (const [capture, lines] of seen) {
      expect({ capture, lines: [...lines].sort() }).toEqual({ capture, lines: [...EXPECTED_CAPTURES[capture]].sort() });
    }
  });

  test("names a policy for every statement it sends, and the anonymous principal only where no credential is the point", () => {
    for (const entry of PLAN) {
      const text = textOf(entry);
      if (text === undefined) {
        expect(entry.language).toBeUndefined();
        continue;
      }
      if (entry.kind === "corpus") continue;
      expect({ capture: entry.capture, language: entry.language }).toEqual({
        capture: entry.capture,
        language: entry.path === "/query" ? "influxql" : "sql",
      });
    }
    const anonymous = PLAN.filter((entry) => entry.principal === "anonymous").map((entry) => entry.capture);
    expect([...new Set(anonymous)].sort()).toEqual(["health-anon", "ping-anon", "unauthorized"]);
  });

  test("sends 1.x and 2.x reads with the read principal wherever the capture is not about a principal", () => {
    const principalCaptures = new Set([
      "ping-auth",
      "health-auth",
      "show-databases-admin",
      "db-not-found",
      "two-databases-admin",
    ]);
    for (const entry of PLAN) {
      if (entry.line === V3 || entry.line === FILELIMIT || entry.principal === "anonymous") continue;
      if (principalCaptures.has(entry.capture)) continue;
      expect({ capture: entry.capture, principal: entry.principal }).toEqual({
        capture: entry.capture,
        principal: "read",
      });
    }
  });

  test("the 64 KiB reads are 65,536 bytes, and the 414 GET sends the quote-heavy text", () => {
    const bytes = (text: string | undefined) => new TextEncoder().encode(text ?? "").length;
    const byCapture = (line: EvidenceLine, capture: string) =>
      PLAN.find((entry) => entry.line === line && entry.capture === capture) as EvidenceEntry;
    for (const line of ALL) {
      for (const capture of ["form-64k-quotes", "form-64k-multibyte"]) {
        const entry = byCapture(line, capture);
        expect([entry.method, entry.path, entry.form?.chunked, bytes(textOf(entry))]).toEqual([
          "POST",
          "/query",
          "true",
          65_536,
        ]);
      }
    }
    expect(textOf(byCapture(V1, "form-64k-multibyte"))).toContain("€");
    const get = byCapture(V3, "get-64k-414");
    expect([get.kind, get.method, get.path, get.form]).toEqual(["raw", "GET", "/query", undefined]);
    expect(get.query?.q).toBe(textOf(byCapture(V3, "form-64k-quotes")));
  });

  test("marks only the two truncation captures as cut, each with the cut 3.12.0 gives it (R39)", () => {
    expect(
      PLAN.filter((entry) => entry.expectCut !== undefined).map((entry) => [entry.capture, entry.expectCut]),
    ).toEqual([
      ["sql-truncated-zero", "zero-byte"],
      ["sql-truncated", "line-end"],
    ]);
  });

  test("sql-truncated-mid-line is never sent: it is sliced from the line-end capture sql-truncated (R39)", () => {
    expect(EVIDENCE_MID_LINE_SLICES).toEqual([
      { capture: "sql-truncated-mid-line", source: "sql-truncated", line: V3 },
    ]);
    for (const slice of EVIDENCE_MID_LINE_SLICES) {
      expect(PLAN.some((entry) => entry.capture === slice.capture)).toBe(false);
      const source = PLAN.find((entry) => entry.line === slice.line && entry.capture === slice.source);
      expect(source?.expectCut).toBe("line-end");
    }
  });
});

describe("the policy over the plan (E22)", () => {
  test("every text but a corpus entry's is allowed by its type's policy", () => {
    const refused: string[] = [];
    for (const entry of [...PLAN, ...buildNowhereChecks()]) {
      const text = textOf(entry);
      if (text === undefined || entry.kind === "corpus") continue;
      // The runner's own choice of policy; tests/unit/live/influxdb-evidence-checks.test.ts shows it reads the language.
      const verdict = policyVerdict(entry.language ?? "influxql", text);
      if (!verdict.allowed) refused.push(`${entry.line} ${entry.capture}: ${verdict.message}`);
    }
    expect(refused).toEqual([]);
  });

  test("every text the policy check reads names its language, so the runner never guesses the policy", () => {
    const unnamed = [...PLAN, ...buildNowhereChecks()].filter(
      (entry) => entry.kind !== "corpus" && textOf(entry) !== undefined && entry.language === undefined,
    );
    expect(unnamed.map((entry) => `${entry.line} ${entry.capture}`)).toEqual([]);
  });
});

describe("the read after the run (E22)", () => {
  test("asks each engine line, as admin, what the database that does not exist holds", () => {
    const checks = buildNowhereChecks();
    expect(checks.map((entry) => entry.line)).toEqual([...ALL]);
    for (const entry of checks) {
      expect([entry.capture, entry.kind, entry.principal, entry.method, entry.path, entry.language]).toEqual([
        "nowhere-check",
        "statement",
        "admin",
        "POST",
        "/query",
        "influxql",
      ]);
      expect(databasesNamedIn(textOf(entry) ?? "")).toEqual([EVIDENCE_NOWHERE_DATABASE]);
      expect(entry.form?.db).toBe(EVIDENCE_NOWHERE_DATABASE);
    }
  });
});
