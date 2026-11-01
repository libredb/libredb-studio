/**
 * The Elasticsearch agent read-only path's statement check. The reader admits one SELECT, an EXPLAIN of one, or the
 * agent's own SYS COLUMNS read, written so that a reader and the 9.1.4 lexer split it into the same tokens, and names
 * the one index expression it reads; the server's answer about that expression then refuses a hidden or system target.
 * Every refusal is pinned in its full sentence, and every request the check sends in its order.
 */
import { describe, expect, test } from "bun:test";
import { QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import {
  agentIndexReference,
  assertReferenceVisible,
  CHARACTER_REFUSAL,
  COMMENT_REFUSAL,
  DOT_INDEX_REFUSAL,
  expressionRefusal,
  FROM_REFUSAL,
  hiddenTargetRefusal,
  NUMBER_REFUSAL,
  resolveFailedRefusal,
  STATEMENT_REFUSAL,
  SUBQUERY_REFUSAL,
  UNREADABLE_REFUSAL,
  unresolvedRefusal,
} from "@/lib/db/providers/sql/search/elasticsearch-agent-index-fence";
import type {
  SearchDataStreamMarks,
  SearchResolvedTargets,
  SearchTransport,
} from "@/lib/db/providers/sql/search/transport";

function thrown(run: () => void): QueryError {
  try {
    run();
  } catch (error) {
    return error as QueryError;
  }
  throw new Error("nothing was thrown");
}

function refusedWith(sql: string, sentence: string): void {
  const error = thrown(() => agentIndexReference(sql));
  expect(error).toBeInstanceOf(RefusedBeforeSendError);
  expect(error.message).toBe(sentence);
}

describe("agentIndexReference: the statements it admits, and the index expression each reads", () => {
  test.each([
    ["SELECT 1", null],
    ["SELECT customer FROM probe_orders", "probe_orders"],
    ['SELECT customer FROM "probe_orders"', "probe_orders"],
    ['SELECT COUNT(*) AS n FROM "*"', "*"],
    ['SELECT COUNT(*) AS n FROM "probe_*,-probe_shapes"', "probe_*,-probe_shapes"],
    ['SELECT COUNT(*) AS n FROM "logs-2026.11.01"', "logs-2026.11.01"],
    ["select customer from probe_orders p where p.customer is not null", "probe_orders"],
    ['SELECT "p".customer FROM probe_orders AS "p" ORDER BY 1 DESC LIMIT 5', "probe_orders"],
    ["SELECT k, COUNT(*) AS n FROM probe_buckets GROUP BY k HAVING COUNT(*) > 1", "probe_buckets"],
    ["SELECT k FROM probe_buckets x LIMIT 101", "probe_buckets"],
    ["SELECT .5 AS x, 1.5 AS y, 2 AS z, 1 - -1 AS w, 4 / 2 AS v, 5 % 2 AS u", null],
    ["SELECT a FROM probe_orders WHERE a <> 1 AND a != 2 AND a <= 3 AND a >= 0 AND a = a", "probe_orders"],
    ["SELECT customer FROM probe_orders WHERE note = '-- a /* b */' OR note LIKE '.%'", "probe_orders"],
    ['SELECT "a--b", "c/*d" FROM probe_orders', "probe_orders"],
    ['SELECT note AS "total (est.)", "say ""hi""" FROM probe_orders', "probe_orders"],
    ["SELECT EXTRACT(YEAR FROM created) AS y FROM probe_orders", "probe_orders"],
    ["SELECT ABS(EXTRACT(DAY FROM (created))) AS d FROM probe_orders", "probe_orders"],
    ["SELECT total::long AS t, a@b FROM probe_orders", "probe_orders"],
    // A word that ends in a digit is no number: the point after it qualifies a name.
    ["SELECT t1.customer, x2._y FROM probe_orders t1", "probe_orders"],
    ["SELECT customer\r\n\tFROM\nprobe_orders", "probe_orders"],
    ["SELECT 'café' AS c, \"naïve\" FROM probe_orders", "probe_orders"],
    // A backslash is an ordinary character inside both quotes, as the engine reads it.
    ["SELECT customer FROM probe_orders WHERE customer = 'x\\'", "probe_orders"],
    ["SELECT 'it''s' AS s FROM probe_orders", "probe_orders"],
    ["EXPLAIN SELECT customer FROM probe_orders", "probe_orders"],
    ["EXPLAIN (PLAN PARSED) SELECT customer FROM probe_orders", "probe_orders"],
    ["explain (plan executable format text verify true) select 1", null],
    ["SYS COLUMNS", "*"],
    ['SYS COLUMNS "probe_orders"', "probe_orders"],
    ["sys columns", "*"],
  ])("admits %p, reading %p", (sql, reference) => {
    expect(agentIndexReference(sql)).toBe(reference);
  });
});

describe("agentIndexReference: what it refuses before anything is sent", () => {
  test.each([
    "SELECT 1 AS a /* x */",
    "/**/SELECT 1",
    "SELECT 1 /* /* */ */ AS a",
    "SELECT 1 /* a",
    "SELECT 1 AS a -- x",
    "SELECT 1 AS a -- x\r, 2 AS b",
    "SELECT 1 AS a -- x\r\nFROM t",
    "SELECT 1--1",
    "SELECT 1 AS a --",
  ])("refuses %p: a comment", (sql) => {
    refusedWith(sql, COMMENT_REFUSAL);
  });

  test.each([
    "SELECT 1;",
    "SELECT customer FROM `probe_orders`",
    "SELECT [customer] FROM probe_orders",
    "SELECT {fn LCASE(customer)} AS c FROM probe_orders",
    "SELECT ? AS x",
    "SELECT 1 # x",
    "SELECT $1",
    "SELECT 1 AS a\\b",
    "SELECT 1 | 2, ~1, 1 & 2, 1 ^ 2",
    "ſELECT 1",
    "SELECT 1 AS a FROM t",
    "SELECT 1 FROM t",
    "SELECT 1\u000bFROM t",
    "SELECT 1\u000cAS a",
    "﻿SELECT 1",
    "SELECT 'a\u0000b' AS x",
    "SELECT 'a\u0085b' AS x",
    "SELECT '\ud800' AS x",
    "SELECT a:b FROM t",
    "SELECT a:::int FROM t",
    "SELECT 1 AS x FROM cluster:t",
  ])("refuses %p: a character outside the set", (sql) => {
    refusedWith(sql, CHARACTER_REFUSAL);
  });

  test.each([
    "SELECT 1e5 AS x",
    "SELECT 1.5e3 AS x",
    "SELECT .5e2 AS x",
    "SELECT 1.E5 AS x",
    "SELECT 2x AS x",
    "SELECT 1.5AS x",
    "SELECT 1_000 AS x",
    "SELECT 1@x AS x",
    "SELECT 1._x AS x",
  ])("refuses %p: a number written otherwise than in plain digits", (sql) => {
    refusedWith(sql, NUMBER_REFUSAL);
  });

  test.each(["SELECT 'abc", 'SELECT "abc', "SELECT 'it''s", 'SELECT customer FROM "probe_orders'])(
    "refuses %p: a quote that never closes",
    (sql) => {
      refusedWith(sql, UNREADABLE_REFUSAL);
    },
  );

  test.each([
    "",
    "   ",
    "SHOW TABLES",
    "SHOW COLUMNS IN probe_orders",
    "DESCRIBE probe_orders",
    "DESC probe_orders",
    "SYS TABLES",
    "SYS COLUMNS TABLE LIKE '%'",
    "SYS COLUMNS probe_orders",
    'SYS COLUMNS "a" "b"',
    "SYS COLUMNS \"a\" LIKE '%'",
    "SYS TYPES",
    "DEBUG SELECT 1",
    "EXPLAIN SHOW TABLES",
    "EXPLAIN DESC LIKE '%'",
    "EXPLAIN EXPLAIN SELECT 1",
    "EXPLAIN DEBUG SELECT 1",
    "EXPLAIN (PLAN PARSED) SHOW TABLES",
    "EXPLAIN ('x') SELECT 1",
    "EXPLAIN (PLAN PARSED SELECT 1",
    "EXPLAIN",
    "(SELECT 1)",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "VALUES (1)",
    "TABLE probe_orders",
    "INSERT INTO probe_orders (id) VALUES (2)",
  ])("refuses %p: not a SELECT, an EXPLAIN of one, or the agent's catalog read", (sql) => {
    refusedWith(sql, STATEMENT_REFUSAL);
  });

  test.each([
    "SELECT * FROM (SELECT * FROM probe_orders) s",
    "SELECT a FROM t WHERE a IN (SELECT a FROM u)",
    "SELECT EXISTS (SELECT 1) AS e",
    "SELECT (SELECT 1) AS x",
    "SELECT 1 AS x WITH y",
    "EXPLAIN SELECT (SELECT 1) AS x",
  ])("refuses %p: a second SELECT or a WITH", (sql) => {
    refusedWith(sql, SUBQUERY_REFUSAL);
  });

  test.each([
    "SELECT a FROM t JOIN u ON t.a = u.a",
    "SELECT a FROM t, u",
    "SELECT a FROM t x, u y",
    "SELECT a FROM FROZEN t",
    "SELECT a FROM t::data",
    'SELECT a FROM "t"::failures',
    "SELECT a FROM t PIVOT (SUM(b) FOR c IN ('x'))",
    "SELECT a FROM t.u",
    'SELECT a FROM "t"."u"',
    "SELECT a FROM (t)",
    "SELECT a FROM",
    "SELECT a FROM 123",
    "SELECT a FROM t FROM u",
    "SELECT a FROM t WHERE b IN (1) FROM u",
    "SELECT CAST(a FROM t) AS x",
    "SELECT a FROM t AS",
    "SELECT a FROM t AS x.y",
    "SELECT a FROM t x y",
  ])("refuses %p: a FROM that does not name one index expression alone", (sql) => {
    refusedWith(sql, FROM_REFUSAL);
  });

  test.each([
    ['SELECT a FROM ""', ""],
    ['SELECT a FROM "a,"', "a,"],
    ['SELECT a FROM ",a"', ",a"],
    ['SELECT a FROM "a,,b"', "a,,b"],
    ['SELECT a FROM "a b"', "a b"],
    ['SELECT a FROM "<logs-{now/d}>"', "<logs-{now/d}>"],
    ['SELECT a FROM "remote:t"', "remote:t"],
    ['SELECT a FROM "t::data"', "t::data"],
    ['SELECT a FROM "%2Et"', "%2Et"],
    ['SELECT a FROM "_all"', "_all"],
    ['SELECT a FROM "a\\b"', "a\\b"],
    ['SELECT a FROM "a?"', "a?"],
    ['SELECT a FROM "a""b"', 'a"b'],
    ['SYS COLUMNS "a b"', "a b"],
  ])("refuses %p: %p is not an index expression the reader admits", (sql, reference) => {
    refusedWith(sql, expressionRefusal(reference));
  });

  test("names the reference in the expression refusal", () => {
    expect(expressionRefusal("a b")).toBe(
      'The agent writes an Elasticsearch index expression as comma-separated names, wildcards and exclusions of letters, digits, _, -, ., * and @, with no empty name, space, date math, catalog or :: selector, and "a b" is not one',
    );
  });

  test.each([
    'SELECT a FROM ".security"',
    'SELECT a FROM ".sec*"',
    'SELECT a FROM "-.x"',
    'SELECT a FROM "*,.x"',
    'SELECT a FROM "a,.x"',
    'SYS COLUMNS ".x"',
    'EXPLAIN SELECT a FROM ".x"',
  ])("refuses %p: a name that starts with a dot, without a request", (sql) => {
    refusedWith(sql, DOT_INDEX_REFUSAL);
  });

  test("pins each refusal's full sentence", () => {
    expect(COMMENT_REFUSAL).toBe(
      "The agent sends Elasticsearch no statement that holds a comment, -- or /*, outside its quotes: an agent statement needs none, so write it without one",
    );
    expect(CHARACTER_REFUSAL).toBe(
      "The agent writes an Elasticsearch statement, outside its quotes, in ASCII letters, digits, _, @, spaces, tabs and line breaks, and the operators ( ) , . * + - / % = < > ! and ::, with no ; and no control character anywhere: this statement holds a character outside that set",
    );
    expect(NUMBER_REFUSAL).toBe(
      "The agent writes each number in an Elasticsearch statement in plain digits, with at most a point between them, no exponent, and no letter, _ or @ right after it: this statement holds a number written otherwise",
    );
    expect(UNREADABLE_REFUSAL).toBe(
      "The agent sends Elasticsearch no statement whose quote never closes, since where its names end cannot be read",
    );
    expect(STATEMENT_REFUSAL).toBe(
      "The agent sends Elasticsearch one SELECT, an EXPLAIN of one (its options in parentheses allowed), or its own column catalog read, SYS COLUMNS for every table or for one quoted table: no other EXPLAIN, no WITH, and no DESCRIBE, SHOW, SYS or DEBUG command",
    );
    expect(SUBQUERY_REFUSAL).toBe(
      "The agent sends Elasticsearch no statement with a second SELECT or a WITH in it: every index it reads must be the one written after its FROM",
    );
    expect(FROM_REFUSAL).toBe(
      "The agent's Elasticsearch FROM names one index expression, quoted or bare, with an optional alias, and then WHERE, GROUP BY, HAVING, ORDER BY, LIMIT or the end: no JOIN, second relation, subquery, FROZEN, PIVOT, catalog or :: selector, and no other FROM but one inside EXTRACT",
    );
    expect(DOT_INDEX_REFUSAL).toBe(
      "The agent names no Elasticsearch index that starts with a dot: those are the hidden and system indices, the security index among them, which a login that may read them reads through SQL; read a data stream by its own name rather than its backing index",
    );
  });

  test("names the engine and the statement on the refusal", () => {
    const error = thrown(() => agentIndexReference("SELECT 1 /* x */")) as RefusedBeforeSendError;
    expect([error.provider, error.query]).toEqual(["elasticsearch", "SELECT 1 /* x */"]);
  });
});

/** A transport that answers the check's three questions from fixed answers and records each question it was asked. */
function fakeTransport(answers: {
  readonly targets?: Readonly<Record<string, SearchResolvedTargets>>;
  readonly hiddenAliases?: readonly string[];
  readonly streams?: readonly SearchDataStreamMarks[];
  readonly fail?: "resolve" | "behind" | "aliases" | "streams";
}) {
  const asked: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const empty: SearchResolvedTargets = { indices: [], aliases: [], dataStreams: [] };
  const transport = {
    resolveTargets: async (expressions: readonly string[], signal?: AbortSignal) => {
      asked.push(`resolve ${expressions.join(" ")}`);
      signals.push(signal);
      const behind = asked.length > 1;
      if (answers.fail === (behind ? "behind" : "resolve")) throw new Error("no such index [x]");
      return answers.targets?.[expressions.join(" ")] ?? empty;
    },
    hiddenAliases: async (names: readonly string[], signal?: AbortSignal) => {
      asked.push(`aliases ${names.join(" ")}`);
      signals.push(signal);
      if (answers.fail === "aliases") throw new Error("Elasticsearch refused the credentials (HTTP 403)");
      return [...(answers.hiddenAliases ?? [])];
    },
    dataStreamMarks: async (names: readonly string[], signal?: AbortSignal) => {
      asked.push(`streams ${names.join(" ")}`);
      signals.push(signal);
      if (answers.fail === "streams")
        throw new Error("Elasticsearch answered a data stream listing the client could not read");
      return [...(answers.streams ?? [])];
    },
  } as unknown as SearchTransport;
  return { transport, asked, signals };
}

const open = (name: string) => ({ name, hidden: false, system: false });

async function checked(reference: string, transport: SearchTransport, signal?: AbortSignal): Promise<unknown> {
  return assertReferenceVisible(`SELECT * FROM "${reference}"`, reference, transport, signal).then(
    () => "admitted",
    (error: unknown) => error,
  );
}

function expectRefused(outcome: unknown, sentence: string): void {
  expect(outcome).toBeInstanceOf(RefusedBeforeSendError);
  expect((outcome as Error).message).toBe(sentence);
}

describe("assertReferenceVisible: the server's answer about the reference", () => {
  test("admits a reference the server resolves to indices it marks neither hidden nor system, in one request", async () => {
    const { transport, asked, signals } = fakeTransport({
      targets: { "probe_*": { indices: [open("probe_orders"), open("probe_buckets")], aliases: [], dataStreams: [] } },
    });
    const signal = new AbortController().signal;

    expect(await checked("probe_*", transport, signal)).toBe("admitted");
    expect(asked).toEqual(["resolve probe_*"]);
    expect(signals).toEqual([signal]);
  });

  test("refuses a reference the server resolves to nothing", async () => {
    const { transport, asked } = fakeTransport({});

    expectRefused(await checked("nomatch*", transport), unresolvedRefusal("nomatch*"));
    expect(unresolvedRefusal("nomatch*")).toBe(
      'The agent reads only an Elasticsearch index, alias or data stream the server resolves for its login, and the server resolves "nomatch*" to none',
    );
    expect(asked).toEqual(["resolve nomatch*"]);
  });

  test.each([
    ["a hidden index", { name: "hidden_logs", hidden: true, system: false }],
    ["a system index", { name: "sys", hidden: false, system: true }],
  ])("refuses a reference the server resolves to %s, after one request", async (_name, index) => {
    const { transport, asked } = fakeTransport({
      targets: { x: { indices: [open("probe_orders"), index], aliases: [], dataStreams: [] } },
    });

    expectRefused(await checked("x", transport), hiddenTargetRefusal("x"));
    expect(hiddenTargetRefusal("x")).toBe(
      'The agent reads no Elasticsearch index, alias or data stream the server marks hidden or system, and the server resolves "x" to one',
    );
    expect(asked).toEqual(["resolve x"]);
  });

  test("refuses an alias over a hidden index, read from the index's own resolution", async () => {
    const { transport, asked } = fakeTransport({
      targets: {
        logs_view: { indices: [], aliases: [{ name: "logs_view", indices: ["hidden_logs"] }], dataStreams: [] },
        hidden_logs: { indices: [{ name: "hidden_logs", hidden: true, system: false }], aliases: [], dataStreams: [] },
      },
    });

    expectRefused(await checked("logs_view", transport), hiddenTargetRefusal("logs_view"));
    expect(asked).toEqual(["resolve logs_view", "resolve hidden_logs"]);
  });

  test("refuses an alias the server marks hidden, over indices it does not", async () => {
    const { transport, asked } = fakeTransport({
      targets: {
        hidden_view: { indices: [], aliases: [{ name: "hidden_view", indices: ["probe_orders"] }], dataStreams: [] },
        probe_orders: { indices: [open("probe_orders")], aliases: [], dataStreams: [] },
      },
      hiddenAliases: ["hidden_view"],
    });

    expectRefused(await checked("hidden_view", transport), hiddenTargetRefusal("hidden_view"));
    expect(asked).toEqual(["resolve hidden_view", "resolve probe_orders", "aliases hidden_view"]);
  });

  test("admits aliases over visible indices, asking about each index behind them once", async () => {
    const { transport, asked } = fakeTransport({
      targets: {
        "p*": {
          indices: [],
          aliases: [
            { name: "porders", indices: ["probe_orders"] },
            { name: "pall", indices: ["probe_orders", "probe_buckets"] },
          ],
          dataStreams: [],
        },
        "probe_orders probe_buckets": {
          indices: [open("probe_orders"), open("probe_buckets")],
          aliases: [],
          dataStreams: [],
        },
      },
    });

    expect(await checked("p*", transport)).toBe("admitted");
    expect(asked).toEqual(["resolve p*", "resolve probe_orders probe_buckets", "aliases porders pall"]);
  });

  test("refuses an alias whose indices are not each answered", async () => {
    const { transport } = fakeTransport({
      targets: {
        pall: { indices: [], aliases: [{ name: "pall", indices: ["probe_orders", "probe_buckets"] }], dataStreams: [] },
        "probe_orders probe_buckets": { indices: [open("probe_orders")], aliases: [], dataStreams: [] },
      },
    });

    expectRefused(
      await checked("pall", transport),
      resolveFailedRefusal("pall", "the indices behind an alias were not each answered"),
    );
  });

  test.each([
    ["hidden", { name: "hidden_stream", hidden: true, system: false }],
    ["system", { name: "zsys", hidden: false, system: true }],
  ])("refuses a data stream the server marks %s", async (_name, marks) => {
    const { transport, asked } = fakeTransport({
      targets: { s: { indices: [], aliases: [], dataStreams: [marks.name] } },
      streams: [marks],
    });

    expectRefused(await checked("s", transport), hiddenTargetRefusal("s"));
    expect(asked).toEqual([`resolve s`, `streams ${marks.name}`]);
  });

  test("admits a data stream the server marks neither hidden nor system", async () => {
    const { transport, asked } = fakeTransport({
      targets: { probe_stream: { indices: [], aliases: [], dataStreams: ["probe_stream"] } },
      streams: [open("probe_stream")],
    });

    expect(await checked("probe_stream", transport)).toBe("admitted");
    expect(asked).toEqual(["resolve probe_stream", "streams probe_stream"]);
  });

  const aliasAndStream: Readonly<Record<string, SearchResolvedTargets>> = {
    x: { indices: [], aliases: [{ name: "a", indices: ["i"] }], dataStreams: ["s"] },
    i: { indices: [open("i")], aliases: [], dataStreams: [] },
  };

  test.each([
    ["resolve", "no such index [x]", ["resolve x"]],
    ["behind", "no such index [x]", ["resolve x", "resolve i"]],
    ["aliases", "Elasticsearch refused the credentials (HTTP 403)", ["resolve x", "resolve i", "aliases a"]],
    [
      "streams",
      "Elasticsearch answered a data stream listing the client could not read",
      ["resolve x", "resolve i", "aliases a", "streams s"],
    ],
  ] as const)("refuses when the %s question fails, in the server's words", async (fail, reason, questions) => {
    const { transport, asked } = fakeTransport({ targets: aliasAndStream, fail, streams: [open("s")] });

    expectRefused(await checked("x", transport), resolveFailedRefusal("x", new Error(reason)));
    expect(asked).toEqual([...questions]);
  });

  test("words a failure that is not an Error, and pins the sentence", () => {
    expect(resolveFailedRefusal("x", "gone")).toBe(
      'The agent reads only an Elasticsearch index, alias or data stream the server resolves for its login, and the server\'s answer about "x" could not be read: gone',
    );
  });
});
