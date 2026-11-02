/**
 * The OpenSearch agent read-only path's statement check. The reader admits one SELECT or the agent's own one-table
 * DESCRIBE TABLES LIKE read, written so that a reader and both of the 3.8.0 plugin's SQL engines split it into the same
 * tokens, and names the one index expression it reads; the server's answer about that expression then refuses a hidden
 * or system target, which includes an index of a family a bundled plugin writes into, or one whose name starts with a
 * dot. Every refusal is pinned in its full sentence, and every request the check sends
 * in its order: the server's own resolution of the expression, the indices the SQL endpoint reads for it, and the
 * resolution of each index read only through an alias.
 */
import { describe, expect, test } from "bun:test";
import { QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import {
  agentIndexReference,
  assertReferenceVisible,
  CHARACTER_REFUSAL,
  COMMENT_REFUSAL,
  checkOpenSearchAgentStatement,
  disagreementRefusal,
  DOT_INDEX_REFUSAL,
  EXCLUSION_REFUSAL,
  expressionRefusal,
  FROM_REFUSAL,
  hiddenTargetRefusal,
  NUMBER_REFUSAL,
  resolveFailedRefusal,
  STATEMENT_REFUSAL,
  SUBQUERY_REFUSAL,
  UNREADABLE_REFUSAL,
  unresolvedRefusal,
} from "@/lib/db/providers/sql/search/opensearch-agent-index-fence";
import type { SearchResolvedTargets, SearchTransport } from "@/lib/db/providers/sql/search/transport";

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
    ["SELECT customer FROM `probe_orders`", "probe_orders"],
    ["SELECT COUNT(*) AS n FROM `*`", "*"],
    ["SELECT COUNT(*) AS n FROM `probe_*,probe-orders,x-*`", "probe_*,probe-orders,x-*"],
    ["SELECT COUNT(*) AS n FROM `logs-2026.11.01`", "logs-2026.11.01"],
    ["SELECT m FROM `probe-ds`", "probe-ds"],
    ["select customer from probe_orders p where p.customer is not null", "probe_orders"],
    ["SELECT `p`.customer FROM probe_orders AS `p` ORDER BY 1 DESC LIMIT 5", "probe_orders"],
    ["SELECT k, COUNT(*) AS n FROM probe_buckets GROUP BY k HAVING COUNT(*) > 1", "probe_buckets"],
    ["SELECT k FROM probe_buckets x LIMIT 101 OFFSET 100", "probe_buckets"],
    ["SELECT .5 AS x, 1.5 AS y, 2 AS z, 1 - -1 AS w, 4 / 2 AS v, 5 % 2 AS u", null],
    ["SELECT a FROM probe_orders WHERE a <> 1 AND a != 2 AND a <= 3 AND a >= 0 AND a = a", "probe_orders"],
    ["SELECT customer FROM probe_orders WHERE note = '-- a /* b */ # c' OR note LIKE '.%'", "probe_orders"],
    ["SELECT customer FROM probe_orders WHERE note = 'say \"hi\"'", "probe_orders"],
    ["SELECT 'it''s' AS s FROM probe_orders", "probe_orders"],
    ["SELECT EXTRACT(YEAR FROM `@timestamp`) AS y FROM `probe-ds`", "probe-ds"],
    ["SELECT ABS(EXTRACT(DAY FROM (created))) AS d FROM probe_orders", "probe_orders"],
    // A word that ends in a digit is no number: the point after it qualifies a name.
    ["SELECT t1.customer, x2._y FROM probe_orders t1", "probe_orders"],
    ["SELECT customer\r\n\tFROM\nprobe_orders", "probe_orders"],
    ["SELECT 'café' AS c, `naïve` FROM probe_orders", "probe_orders"],
    ["DESCRIBE TABLES LIKE 'probe_orders'", "probe_orders"],
  ])("admits %p, reading %p", (sql, reference) => {
    expect(agentIndexReference(sql)).toBe(reference);
  });
});

describe("agentIndexReference: what it refuses before anything is sent", () => {
  test.each([
    "SELECT 1 AS a /* x */",
    "/**/SELECT 1",
    "SELECT 1 AS a -- x",
    "SELECT 1--1",
    "SELECT 1 AS a # , 2 AS b",
    "SELECT customer # FROM probe_orders",
  ])("refuses %p: a comment", (sql) => {
    refusedWith(sql, COMMENT_REFUSAL);
  });

  test.each([
    "SELECT 1;",
    'SELECT "secret" FROM probe_hidden',
    'SELECT a FROM "probe_hidden"',
    "SELECT [customer] FROM probe_orders",
    "SELECT ? AS x",
    "SELECT $1",
    "SELECT 'a\\'b' AS x FROM probe_orders",
    "SELECT 'a\\' AS x",
    "SELECT 1 | 2, ~1, 1 & 2, 1 ^ 2",
    "ſELECT 1",
    "SELECT 1\u000bFROM t",
    "﻿SELECT 1",
    "SELECT 'a\u0000b' AS x",
    "SELECT '\ud800' AS x",
    "SELECT a:b FROM t",
    "SELECT id FROM @opensearch.probe_orders",
    "SELECT 1 AS x FROM cluster:t",
    // The plugin ends a bare name at an `@`, which starts a name of its own: `pa@b` is the table `pa` aliased `@b`.
    "SELECT a@b FROM probe_orders",
    "SELECT v FROM pa@b",
    "SELECT v FROM pa@b LIMIT 1001 OFFSET 0",
    "SELECT v FROM probe_hid@x",
    "SELECT 1@x AS x",
  ])("refuses %p: a character outside the set", (sql) => {
    refusedWith(sql, CHARACTER_REFUSAL);
  });

  test.each([
    "SELECT 1e5 AS x",
    "SELECT 1.5e3 AS x",
    "SELECT .5e2 AS x",
    "SELECT 2x AS x",
    "SELECT 1_000 AS x",
    "SELECT 1._x AS x",
  ])("refuses %p: a number written otherwise than in plain digits", (sql) => {
    refusedWith(sql, NUMBER_REFUSAL);
  });

  test.each(["SELECT 'abc", "SELECT 'it''s", "SELECT customer FROM `probe_orders", "SELECT * FROM `probe``hidden`"])(
    "refuses %p: a quote that never closes, or a backtick inside a backtick name",
    (sql) => {
      refusedWith(sql, UNREADABLE_REFUSAL);
    },
  );

  test.each([
    "",
    "   ",
    "SHOW TABLES LIKE %",
    "SHOW TABLES LIKE probe%",
    "DESCRIBE TABLES LIKE %",
    "describe tables like %",
    "DESCRIBE TABLES",
    "DESCRIBE TABLES LIKE probe_orders",
    "DESCRIBE TABLES LIKE `probe_orders`",
    "DESCRIBE TABLES LIKE % COLUMNS LIKE %",
    "DESCRIBE TABLES LIKE 'a' 'b'",
    "DESCRIBE probe_orders",
    "EXPLAIN SELECT id FROM probe_orders",
    "(SELECT 1)",
    "WITH x AS (SELECT 1) SELECT * FROM x",
    "VALUES (1)",
    "TABLE probe_orders",
    "DELETE FROM probe_orders",
    "INSERT INTO probe_orders (id) VALUES (2)",
  ])("refuses %p: not a SELECT or the agent's one-table catalog read", (sql) => {
    refusedWith(sql, STATEMENT_REFUSAL);
  });

  test.each([
    "SELECT * FROM (SELECT * FROM probe_orders) s",
    "SELECT id FROM probe_orders WHERE id IN (SELECT id FROM probe_hidden)",
    "SELECT EXISTS (SELECT 1) AS e",
    "SELECT 1 AS x WITH y",
    "SELECT a FROM t UNION SELECT a FROM u",
  ])("refuses %p: a second SELECT or a WITH", (sql) => {
    refusedWith(sql, SUBQUERY_REFUSAL);
  });

  test.each([
    "SELECT o.id FROM probe_orders o JOIN probe_hidden h ON o.id = h.id",
    "SELECT a FROM probe_orders, probe_hidden",
    "SELECT a FROM t x, u y",
    "SELECT * FROM probe_orders/_doc",
    "SELECT a FROM t.u",
    "SELECT id FROM `probe_orders`.`x`",
    "SELECT id FROM `@opensearch`.probe_orders",
    "SELECT a FROM .probe_dot",
    "SELECT a FROM probe*",
    "SELECT a FROM probe-ds",
    "SELECT a FROM (t)",
    "SELECT a FROM",
    "SELECT a FROM 123",
    "SELECT a FROM t FROM u",
    "SELECT a FROM t WHERE b IN (1) FROM u",
    "SELECT TRIM(BOTH 'x' FROM a) AS x FROM t",
    "SELECT a FROM t AS",
    "SELECT a FROM t AS x.y",
    "SELECT a FROM t x y",
  ])("refuses %p: a FROM that does not name one index expression alone", (sql) => {
    refusedWith(sql, FROM_REFUSAL);
  });

  test.each([
    ["SELECT a FROM ``", ""],
    ["SELECT a FROM `a,`", "a,"],
    ["SELECT a FROM `a,,b`", "a,,b"],
    ["SELECT a FROM `a b`", "a b"],
    ["SELECT a FROM `<logs-{now/d}>`", "<logs-{now/d}>"],
    ["SELECT a FROM `remote:t`", "remote:t"],
    ["SELECT a FROM `%2Et`", "%2Et"],
    ["SELECT a FROM `_all`", "_all"],
    ["SELECT a FROM _all", "_all"],
    ["SELECT a FROM `@opensearch.probe_orders`", "@opensearch.probe_orders"],
    ["SELECT a FROM `a?`", "a?"],
    ['SELECT a FROM `a"b`', 'a"b'],
    ["DESCRIBE TABLES LIKE 'a b'", "a b"],
    ["DESCRIBE TABLES LIKE ''", ""],
  ])("refuses %p: %p is not an index expression the reader admits", (sql, reference) => {
    refusedWith(sql, expressionRefusal(reference));
  });

  test("names the reference in the expression refusal", () => {
    expect(expressionRefusal("a b")).toBe(
      'The agent writes an OpenSearch index expression as comma-separated names and wildcards of letters, digits, _, -, ., * and @, none empty and none starting with _ or @, with no space, date math, remote cluster or datasource, and "a b" is not one',
    );
  });

  test.each([
    "SELECT a FROM `.opendistro_security`",
    "SELECT a FROM `.plugins-ml-config`",
    "SELECT a FROM `.ds-probe-ds-000001`",
    "SELECT a FROM `.sec*`",
    "SELECT a FROM `-.x`",
    "SELECT a FROM `*,.x`",
    "DESCRIBE TABLES LIKE '.opendistro_security'",
  ])("refuses %p: a name that starts with a dot, without a request", (sql) => {
    refusedWith(sql, DOT_INDEX_REFUSAL);
  });

  test.each([
    "SELECT a FROM `probe_*,-probe_shapes`",
    "SELECT a FROM `-probe_orders`",
    "SELECT a FROM `*,-x`",
    "SELECT a FROM `a,-`",
    "DESCRIBE TABLES LIKE 'a,-b'",
  ])("refuses %p: an exclusion, without a request", (sql) => {
    refusedWith(sql, EXCLUSION_REFUSAL);
  });

  test("pins each refusal's full sentence", () => {
    expect(COMMENT_REFUSAL).toBe(
      "The agent sends OpenSearch no statement that holds a comment, --, /* or #, outside its quotes: an agent statement needs none, so write it without one",
    );
    expect(CHARACTER_REFUSAL).toBe(
      "The agent writes an OpenSearch statement, outside its quotes, in ASCII letters, digits, _, spaces, tabs and line breaks, and the operators ( ) , . * + - / % = < > !, with names quoted in backticks and strings in single quotes, and no backslash, ; or control character anywhere: this statement holds a character outside that set",
    );
    expect(NUMBER_REFUSAL).toBe(
      "The agent writes each number in an OpenSearch statement in plain digits, with at most a point between them, no exponent, and no letter or _ right after it: this statement holds a number written otherwise",
    );
    expect(UNREADABLE_REFUSAL).toBe(
      "The agent sends OpenSearch no statement whose quote never closes or whose backtick-quoted name holds a backtick, since where its names end cannot be read",
    );
    expect(STATEMENT_REFUSAL).toBe(
      "The agent sends OpenSearch one SELECT, or its own one-table column catalog read, DESCRIBE TABLES LIKE with one quoted table: no other DESCRIBE or SHOW command, and not the every-table read, DESCRIBE TABLES LIKE %",
    );
    expect(SUBQUERY_REFUSAL).toBe(
      "The agent sends OpenSearch no statement with a second SELECT or a WITH in it: every index it reads must be the one written after its FROM",
    );
    expect(FROM_REFUSAL).toBe(
      "The agent's OpenSearch FROM names one index expression, bare or in backticks, with an optional alias, and then WHERE, GROUP BY, HAVING, ORDER BY, LIMIT or the end: no JOIN, comma, second relation, subquery, qualifier or datasource, and no other FROM but one inside EXTRACT",
    );
    expect(EXCLUSION_REFUSAL).toBe(
      "The agent writes no exclusion, a part that starts with -, in an OpenSearch index expression: name the indices to read, or a wildcard that reaches only them",
    );
    expect(DOT_INDEX_REFUSAL).toBe(
      "The agent writes no name that starts with a dot in an OpenSearch index expression: the security index and the other system indices are named that way, and a login that may read one reads it through SQL; read a data stream by its own name rather than its backing index",
    );
  });

  test("names the engine and the statement on the refusal", () => {
    const error = thrown(() => agentIndexReference("SELECT 1 /* x */")) as RefusedBeforeSendError;
    expect([error.provider, error.query]).toEqual(["opensearch", "SELECT 1 /* x */"]);
  });
});

/**
 * A transport that answers the check's questions from fixed answers and records each question it was asked: `resolve`
 * for the server's index resolution and `read` for the indices the SQL endpoint reads for the expression.
 */
function fakeTransport(answers: {
  readonly targets?: Readonly<Record<string, SearchResolvedTargets>>;
  readonly read?: Readonly<Record<string, readonly string[]>>;
  readonly fail?: "resolve" | "behind" | "read";
}) {
  const asked: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const empty: SearchResolvedTargets = { indices: [], aliases: [], dataStreams: [] };
  let resolutions = 0;
  const transport = {
    resolveTargets: async (expressions: readonly string[], signal?: AbortSignal) => {
      asked.push(`resolve ${expressions.join(" ")}`);
      signals.push(signal);
      resolutions++;
      if (answers.fail === (resolutions > 1 ? "behind" : "resolve")) throw new Error("no such index [x]");
      return answers.targets?.[expressions.join(" ")] ?? empty;
    },
    sqlTableIndices: async (expression: string, signal?: AbortSignal) => {
      asked.push(`read ${expression}`);
      signals.push(signal);
      if (answers.fail === "read") throw new Error("OpenSearch refused the credentials (HTTP 403)");
      return [...(answers.read?.[expression] ?? [])];
    },
  } as unknown as SearchTransport;
  return { transport, asked, signals };
}

const open = (name: string) => ({ name, hidden: false, system: false });
const stream = (name: string) => ({ name, backingIndices: [`.ds-${name}-000001`] });

async function checked(reference: string, transport: SearchTransport, signal?: AbortSignal): Promise<unknown> {
  return assertReferenceVisible(`SELECT * FROM \`${reference}\``, reference, transport, signal).then(
    () => "admitted",
    (error: unknown) => error,
  );
}

function expectRefused(outcome: unknown, sentence: string): void {
  expect(outcome).toBeInstanceOf(RefusedBeforeSendError);
  expect((outcome as Error).message).toBe(sentence);
}

describe("assertReferenceVisible: the server's answer about the reference", () => {
  test("admits a reference the server resolves to visible indices with no leading dot, which the SQL endpoint reads", async () => {
    const { transport, asked, signals } = fakeTransport({
      targets: { "probe_*": { indices: [open("probe_orders"), open("probe_buckets")], aliases: [], dataStreams: [] } },
      read: { "probe_*": ["probe_buckets", "probe_orders"] },
    });
    const signal = new AbortController().signal;

    expect(await checked("probe_*", transport, signal)).toBe("admitted");
    expect(asked).toEqual(["resolve probe_*", "read probe_*"]);
    expect(signals).toEqual([signal, signal]);
  });

  test("refuses a reference the server resolves to nothing", async () => {
    const { transport, asked } = fakeTransport({});

    expectRefused(await checked("nomatch*", transport), unresolvedRefusal("nomatch*"));
    expect(unresolvedRefusal("nomatch*")).toBe(
      'The agent reads only an OpenSearch index, alias or data stream the server resolves for its login, and the server resolves "nomatch*" to none',
    );
    expect(asked).toEqual(["resolve nomatch*"]);
  });

  test("refuses a reference the SQL endpoint reads no index for", async () => {
    const { transport, asked } = fakeTransport({
      targets: { closed_logs: { indices: [open("closed_logs")], aliases: [], dataStreams: [] } },
      read: { closed_logs: [] },
    });

    expectRefused(await checked("closed_logs", transport), unresolvedRefusal("closed_logs"));
    expect(asked).toEqual(["resolve closed_logs", "read closed_logs"]);
  });

  test.each([
    ["a hidden index", { name: "probe_hidden", hidden: true, system: false }],
    ["an index marked system", { name: "sys", hidden: false, system: true }],
    ["an index whose name starts with a dot", open(".plugins-ml-config")],
  ])("refuses a reference the server resolves to %s, after one request", async (_name, index) => {
    const { transport, asked } = fakeTransport({
      targets: { x: { indices: [open("probe_orders"), index], aliases: [], dataStreams: [] } },
    });

    expectRefused(await checked("x", transport), hiddenTargetRefusal("x"));
    expect(hiddenTargetRefusal("x")).toBe(
      'The agent reads no OpenSearch index the server marks hidden or system, no index or data stream whose name starts with a dot, and no index of a family a bundled plugin writes its own records into without either mark, and the server resolves "x" to one',
    );
    expect(asked).toEqual(["resolve x"]);
  });

  test("refuses a data stream whose name starts with a dot, after one request", async () => {
    const { transport, asked } = fakeTransport({
      targets: { "*s": { indices: [], aliases: [], dataStreams: [stream(".sys-stream")] } },
    });

    expectRefused(await checked("*s", transport), hiddenTargetRefusal("*s"));
    expect(asked).toEqual(["resolve *s"]);
  });

  test.each([
    ["a hidden index", ["probe_orders", "probe_hidden"]],
    ["a visible index", ["probe_buckets"]],
  ])(
    "refuses a reference the SQL endpoint reads an index for that the server's resolution does not name: %s",
    async (_name, read) => {
      const { transport, asked } = fakeTransport({
        targets: { x: { indices: [open("probe_orders")], aliases: [], dataStreams: [] } },
        read: { x: read },
      });

      expectRefused(await checked("x", transport), disagreementRefusal("x"));
      expect(disagreementRefusal("x")).toBe(
        'The agent reads only the OpenSearch indices the server\'s own resolution of an expression names for its login, and the SQL endpoint resolves "x" to an index that resolution does not name',
      );
      expect(asked).toEqual(["resolve x", "read x"]);
    },
  );

  test.each([
    ["a hidden index", { name: "probe_hidden", hidden: true, system: false }],
    ["an index whose name starts with a dot", open(".probe_dot")],
    ["an index of a plugin's family, marked system", { name: "top_queries-2026.11.02-1", hidden: false, system: true }],
  ])("refuses an alias over %s, read from the index's own resolution", async (_name, index) => {
    const { transport, asked } = fakeTransport({
      targets: {
        probe_over: { indices: [], aliases: [{ name: "probe_over", indices: [index.name] }], dataStreams: [] },
        [index.name]: { indices: [index], aliases: [], dataStreams: [] },
      },
      read: { probe_over: [index.name] },
    });

    expectRefused(await checked("probe_over", transport), hiddenTargetRefusal("probe_over"));
    expect(asked).toEqual(["resolve probe_over", "read probe_over", `resolve ${index.name}`]);
  });

  test("admits aliases over visible indices, asking about each index read only through them once", async () => {
    const { transport, asked } = fakeTransport({
      targets: {
        "p*": {
          indices: [open("probe_shapes")],
          aliases: [
            { name: "porders", indices: ["probe_orders"] },
            { name: "pall", indices: ["probe_orders", "probe_buckets", "probe_shapes"] },
          ],
          dataStreams: [],
        },
        "probe_orders probe_buckets": {
          indices: [open("probe_orders"), open("probe_buckets")],
          aliases: [],
          dataStreams: [],
        },
      },
      read: { "p*": ["probe_orders", "probe_buckets", "probe_shapes"] },
    });

    expect(await checked("p*", transport)).toBe("admitted");
    expect(asked).toEqual(["resolve p*", "read p*", "resolve probe_orders probe_buckets"]);
  });

  test("refuses an alias whose indices are not each answered", async () => {
    const { transport } = fakeTransport({
      targets: {
        pall: { indices: [], aliases: [{ name: "pall", indices: ["probe_orders", "probe_buckets"] }], dataStreams: [] },
        "probe_orders probe_buckets": { indices: [open("probe_orders")], aliases: [], dataStreams: [] },
      },
      read: { pall: ["probe_orders", "probe_buckets"] },
    });

    expectRefused(
      await checked("pall", transport),
      resolveFailedRefusal("pall", "the indices behind an alias were not each answered"),
    );
  });

  test("admits a data stream by its own name, its hidden backing index read through the stream", async () => {
    const { transport, asked } = fakeTransport({
      targets: { "probe-ds": { indices: [], aliases: [], dataStreams: [stream("probe-ds")] } },
      read: { "probe-ds": [".ds-probe-ds-000001"] },
    });

    expect(await checked("probe-ds", transport)).toBe("admitted");
    expect(asked).toEqual(["resolve probe-ds", "read probe-ds"]);
  });

  test("refuses an alias over a data stream it does not name: the backing index behind it is hidden", async () => {
    const { transport, asked } = fakeTransport({
      targets: {
        ds_view: { indices: [], aliases: [{ name: "ds_view", indices: [".ds-probe-ds-000001"] }], dataStreams: [] },
        ".ds-probe-ds-000001": {
          indices: [{ name: ".ds-probe-ds-000001", hidden: true, system: false }],
          aliases: [],
          dataStreams: [],
        },
      },
      read: { ds_view: [".ds-probe-ds-000001"] },
    });

    expectRefused(await checked("ds_view", transport), hiddenTargetRefusal("ds_view"));
    expect(asked).toEqual(["resolve ds_view", "read ds_view", "resolve .ds-probe-ds-000001"]);
  });

  const alias: Readonly<Record<string, SearchResolvedTargets>> = {
    x: { indices: [], aliases: [{ name: "a", indices: ["i"] }], dataStreams: [] },
    i: { indices: [open("i")], aliases: [], dataStreams: [] },
  };

  test.each([
    ["resolve", "no such index [x]", ["resolve x"]],
    ["read", "OpenSearch refused the credentials (HTTP 403)", ["resolve x", "read x"]],
    ["behind", "no such index [x]", ["resolve x", "read x", "resolve i"]],
  ] as const)("refuses when the %s question fails, in the server's words", async (fail, reason, questions) => {
    const { transport, asked } = fakeTransport({ targets: alias, read: { x: ["i"] }, fail });

    expectRefused(await checked("x", transport), resolveFailedRefusal("x", new Error(reason)));
    expect(asked).toEqual([...questions]);
  });

  test("words a failure that is not an Error, and pins the sentence", () => {
    expect(resolveFailedRefusal("x", "gone")).toBe(
      'The agent reads only an OpenSearch index, alias or data stream the server resolves for its login, and the server\'s answer about "x" could not be read: gone',
    );
  });
});

describe("checkOpenSearchAgentStatement: the reader, then the server", () => {
  test("asks the server about the reference the reader names, on the signal given", async () => {
    const { transport, asked, signals } = fakeTransport({
      targets: { probe_orders: { indices: [open("probe_orders")], aliases: [], dataStreams: [] } },
      read: { probe_orders: ["probe_orders"] },
    });
    const signal = new AbortController().signal;

    await checkOpenSearchAgentStatement("SELECT id FROM probe_orders", transport, signal);

    expect(asked).toEqual(["resolve probe_orders", "read probe_orders"]);
    expect(signals).toEqual([signal, signal]);
  });

  test("asks the server nothing for a SELECT that reads no index", async () => {
    const { transport, asked } = fakeTransport({});

    await checkOpenSearchAgentStatement("SELECT 1", transport);

    expect(asked).toEqual([]);
  });

  test("refuses what the reader refuses, before any request", async () => {
    const { transport, asked } = fakeTransport({});

    const outcome = await checkOpenSearchAgentStatement("SELECT a FROM `.opendistro_security`", transport).then(
      () => "admitted",
      (error: unknown) => error,
    );

    expectRefused(outcome, DOT_INDEX_REFUSAL);
    expect(asked).toEqual([]);
  });
});
