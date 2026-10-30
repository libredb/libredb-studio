/**
 * The agent read-only profile's check of the Couchbase user, and the statement fence in front of every agent statement,
 * against the answers a live Couchbase Server 8.0.2 gave, as `tests/fixtures/couchbase/8.0.2/agent-boundary/` records
 * them. The probe statement is pinned by its full text, and each refusal by its code and its words.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError } from "@/lib/db/errors";
import {
  couchbaseAgentProbeStatement,
  couchbaseAgentStatementRefusal,
  verifyCouchbaseAgentProfile,
  type CouchbaseAgentReader,
} from "@/lib/db/providers/document/couchbase/agent-boundary";
import { CouchbaseError, type CouchbaseQueryResult } from "@/lib/db/providers/document/couchbase/transport";

const NONCE = "0123456789abcdef01234567";
const TARGET = { user: "agent_ro", bucket: "probe", nonce: NONCE };

const role = (name: string, bucket?: string, scope?: string, collection?: string) => ({
  role: name,
  ...(bucket === undefined ? {} : { bucket_name: bucket }),
  ...(scope === undefined ? {} : { scope_name: scope }),
  ...(collection === undefined ? {} : { collection_name: collection }),
});

/** GET /whoami as capture 01 records it, for `id` holding `roles`. */
const whoami = (roles: unknown[], id = "agent_ro") => ({
  roles,
  id,
  domain: "local",
  password_change_date: "2026-10-29T23:43:52Z",
});

const SELECT_ONLY = role("query_select", "probe", "_default", "*");

/** The probe's refusal as capture 02 records the same refusal of a DELETE for a user holding no query_delete. */
const MISSING_DELETE = new CouchbaseError(
  "User does not have credentials to run DELETE queries on default:probe._default._default. Add role query_delete on default:probe._default._default to allow the statement to run.",
  13014,
);

const MUTATED: CouchbaseQueryResult = {
  rows: [],
  fieldNames: null,
  executionTimeMs: 1,
  mutationCount: 0,
  warnings: [],
};

interface Recorded {
  reader: CouchbaseAgentReader;
  sent: string[];
}

function reader(identity: unknown | Error, probe: CouchbaseQueryResult | Error = MISSING_DELETE): Recorded {
  const sent: string[] = [];
  return {
    sent,
    reader: {
      whoami: async () => {
        sent.push("GET /whoami");
        if (identity instanceof Error) throw identity;
        return identity;
      },
      probe: async (statement) => {
        sent.push(statement);
        if (probe instanceof Error) throw probe;
        return probe;
      },
    },
  };
}

async function refusal(recorded: Recorded): Promise<ExecutionProfileError> {
  try {
    await verifyCouchbaseAgentProfile(recorded.reader, TARGET);
  } catch (error) {
    if (error instanceof ExecutionProfileError) return error;
    throw error;
  }
  throw new Error("the check admitted the user");
}

describe("the check's requests", () => {
  test("the probe is a DELETE of one freshly named key in the bucket's default collection", () => {
    expect(couchbaseAgentProbeStatement(NONCE)).toBe(
      'DELETE FROM `_default` USE KEYS "libredb-agent-probe-0123456789abcdef01234567"',
    );
  });

  test("admits a user holding only query_select on a named scope of the bound bucket: GET /whoami, then the probe the server refuses", async () => {
    const recorded = reader(whoami([SELECT_ONLY]));
    await verifyCouchbaseAgentProfile(recorded.reader, TARGET);
    expect(recorded.sent).toEqual([
      "GET /whoami",
      'DELETE FROM `_default` USE KEYS "libredb-agent-probe-0123456789abcdef01234567"',
    ]);
  });

  test("admits query_select on one collection, and on several named scopes, of the bound bucket", async () => {
    await verifyCouchbaseAgentProfile(
      reader(whoami([role("query_select", "probe", "_default", "_default"), role("query_select", "probe", "s1", "*")]))
        .reader,
      TARGET,
    );
  });

  test("a group's roles are read as the user's: whoami lists them with the user's own (capture 01)", async () => {
    const error = await refusal(reader(whoami([role("data_writer", "probe", "*", "*"), SELECT_ONLY])));
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
  });

  test("sends no probe when the roles already refuse the user", async () => {
    const recorded = reader(whoami([role("admin")]));
    await refusal(recorded);
    expect(recorded.sent).toEqual(["GET /whoami"]);
  });
});

describe("the roles", () => {
  test.each([
    ["query_update", [SELECT_ONLY, role("query_update", "probe", "*", "*")], "query_update[probe:*:*]"],
    ["query_insert", [role("query_insert", "probe", "*", "*"), SELECT_ONLY], "query_insert[probe:*:*]"],
    ["query_delete", [role("query_delete", "probe", "*", "*"), SELECT_ONLY], "query_delete[probe:*:*]"],
    ["data_writer", [role("data_writer", "probe", "*", "*"), SELECT_ONLY], "data_writer[probe:*:*]"],
    ["bucket_admin", [role("bucket_admin", "probe"), SELECT_ONLY], "bucket_admin[probe]"],
    ["admin", [role("admin")], "admin"],
    ["query_select on every bucket", [role("query_select", "*", "*", "*")], "query_select[*:*:*]"],
    [
      "query_select on every scope of the bucket, the _system scope among them (capture 09)",
      [role("query_select", "probe", "*", "*")],
      "query_select[probe:*:*]",
    ],
    [
      "query_select on the _system scope",
      [role("query_select", "probe", "_system", "*"), SELECT_ONLY],
      "query_select[probe:_system:*]",
    ],
    [
      "query_select on a collection of the _system scope",
      [role("query_select", "probe", "_system", "_mobile"), SELECT_ONLY],
      "query_select[probe:_system:_mobile]",
    ],
    [
      "query_select on a second bucket",
      [role("query_select", "other", "*", "*"), SELECT_ONLY],
      "query_select[other:*:*]",
    ],
    [
      "query_execute_functions",
      [role("query_execute_functions", "probe", "_default"), SELECT_ONLY],
      "query_execute_functions[probe:_default]",
    ],
    [
      "query_execute_external_functions",
      [role("query_execute_external_functions", "probe", "_default"), SELECT_ONLY],
      "query_execute_external_functions[probe:_default]",
    ],
    [
      "query_execute_global_functions",
      [role("query_execute_global_functions"), SELECT_ONLY],
      "query_execute_global_functions",
    ],
    ["query_system_catalog", [role("query_system_catalog"), SELECT_ONLY], "query_system_catalog"],
    ["query_external_access", [role("query_external_access"), SELECT_ONLY], "query_external_access"],
    [
      "query_use_sequences",
      [SELECT_ONLY, role("query_use_sequences", "probe", "_default")],
      "query_use_sequences[probe:_default]",
    ],
    [
      "data_reader, a read, and still not query_select",
      [role("data_reader", "probe", "*", "*"), SELECT_ONLY],
      "data_reader[probe:*:*]",
    ],
    [
      "a role this check has never seen",
      [role("query_something_new", "probe", "*", "*"), SELECT_ONLY],
      "query_something_new[probe:*:*]",
    ],
    ["Community Edition's bucket_full_access", [role("bucket_full_access", "probe")], "bucket_full_access[probe]"],
    ["Community Edition's ro_admin", [role("ro_admin")], "ro_admin"],
  ])("refuses %s, naming the role as Couchbase spells it", async (_name, roles, named) => {
    const error = await refusal(reader(whoami(roles)));
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toContain(named);
    expect(error.message).toStartWith(
      "The agent read-only execution profile needs a Couchbase user whose only roles are query_select on named scopes of the bucket probe;",
    );
  });

  test("names every role it refuses in one refusal", async () => {
    const error = await refusal(
      reader(whoami([role("query_system_catalog"), role("query_update", "probe", "*", "*"), SELECT_ONLY])),
    );
    expect(error.message).toBe(
      "The agent read-only execution profile needs a Couchbase user whose only roles are query_select on named scopes of the bucket probe; the user agent_ro also holds query_system_catalog, query_update[probe:*:*], which reach past them, so the connection is refused. A role on every scope of the bucket reaches its _system scope too, which holds Sync Gateway's and the query optimizer's own documents. Give the agent a user whose only roles are query_select[probe:<scope>], one for each scope it reads.",
    );
  });

  test("refuses a user holding no role at all as too narrow", async () => {
    const error = await refusal(reader(whoami([])));
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_NARROW");
    expect(error.message).toBe(
      "The agent read-only execution profile needs a Couchbase user holding query_select on a named scope of the bucket probe, and the user agent_ro holds none, so it cannot read it. Give it the role query_select[probe:<scope>] for each scope it reads.",
    );
  });

  test("matches the bucket exactly, case included", async () => {
    const error = await refusal(reader(whoami([role("query_select", "Probe", "_default", "*")])));
    expect(error.message).toContain("query_select[Probe:_default:*]");
  });

  test.each([
    ["not an object", "ok"],
    ["no roles array", { id: "agent_ro" }],
    ["a role entry that is not an object", whoami(["query_select"])],
    ["a role name that is not a string", whoami([{ role: 7 }])],
    [
      "a bucket that is not a string",
      whoami([{ role: "query_select", bucket_name: 1, scope_name: "*", collection_name: "*" }]),
    ],
    ["query_select without its scope", whoami([{ role: "query_select", bucket_name: "probe", collection_name: "*" }])],
    ["query_select without its collection", whoami([{ role: "query_select", bucket_name: "probe", scope_name: "*" }])],
    ["another user's identity", whoami([SELECT_ONLY], "agent_other")],
    ["no identity", { roles: [SELECT_ONLY] }],
  ])("refuses an answer it cannot read: %s", async (_name, answer) => {
    const recorded = reader(answer);
    const error = await refusal(recorded);
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toBe(
      "The agent read-only execution profile could not read the roles of the Couchbase user agent_ro from GET /whoami in the shape the server answers them, so its reach is unproven and the connection is refused.",
    );
    expect(recorded.sent).toEqual(["GET /whoami"]);
  });

  test("lets a failure to reach GET /whoami leave as it came", async () => {
    const failure = new CouchbaseError("Couchbase rejected the credentials (HTTP 401)", 401);
    await expect(verifyCouchbaseAgentProfile(reader(failure).reader, TARGET)).rejects.toBe(failure);
  });
});

describe("the probe", () => {
  test("refuses a server that ran the DELETE for a user whose roles hold no query_delete", async () => {
    const error = await refusal(reader(whoami([SELECT_ONLY]), MUTATED));
    expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect(error.message).toBe(
      "The agent read-only execution profile needs a server that enforces its users' roles; this server ran a DELETE in the bucket probe for the user agent_ro, whose only roles are query_select, so its enforcement is unproven and the connection is refused.",
    );
  });

  test("refuses any other answer of the server than the missing grant, the message carried", async () => {
    const error = await refusal(
      reader(
        whoami([SELECT_ONLY]),
        new CouchbaseError("Keyspace not found in CB datastore: default:probe._default._default", 12003),
      ),
    );
    expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect(error.message).toBe(
      "The agent read-only execution profile needs a server that enforces its users' roles; this server answered a DELETE in the bucket probe for the user agent_ro with \"Keyspace not found in CB datastore: default:probe._default._default\" (code 12003) rather than refusing it for a missing role, so its enforcement is unproven and the connection is refused. The check deletes one freshly named key in the bucket's _default collection, which must exist.",
    );
  });

  test("lets a failure to reach the server leave as it came", async () => {
    const lost = new CouchbaseError("Couchbase request failed: connection refused", 0, true);
    await expect(verifyCouchbaseAgentProfile(reader(whoami([SELECT_ONLY]), lost).reader, TARGET)).rejects.toBe(lost);
    const other = new TypeError("socket hang up");
    await expect(verifyCouchbaseAgentProfile(reader(whoami([SELECT_ONLY]), other).reader, TARGET)).rejects.toBe(other);
  });
});

describe("the statement fence", () => {
  test.each([
    ["SELECT d.n FROM `_default` AS d"],
    ["select 1 AS a"],
    ["SeLeCt 1 AS a"],
    ["  \n\tSELECT 1 AS a"],
    ["-- lead\nSELECT 1 AS a"],
    ["-- lead\r\nSELECT 1 AS a"],
    ["/* lead */ SELECT 1 AS a"],
    ["SELECT 1 AS a;"],
    ["SELECT 1 AS a; -- trailing"],
    ["SELECT 1 AS a; /* trailing */ \n"],
    ["SELECT 'a;b' AS a, \"c;d\" AS b, `e;f` AS c"],
    ["SELECT [1, 2][0] AS a"],
    ["SELECT 1 AS a UNION SELECT 2 AS a"],
    ["WITH a AS (SELECT RAW 1) SELECT a"],
    ["with recursive r AS (SELECT 1 AS n) SELECT RAW r.n FROM r"],
    ["SELECT 'it\\'s' AS a"],
  ])("admits %j", (sql) => {
    expect(couchbaseAgentStatementRefusal(sql)).toBeNull();
  });

  const NOT_SELECT =
    "The agent read-only execution profile sends one SQL++ statement, a SELECT (a WITH before it is fine), and nothing else; this statement does not begin with SELECT or WITH, so it was not sent. A user holding only query_select may still run UPDATE STATISTICS, BEGIN WORK, PREPARE and EXECUTE, so only a SELECT reaches the server.";

  test.each([
    ["UPDATE STATISTICS FOR `_default` INDEX ALL"],
    ["BEGIN WORK"],
    ["START TRANSACTION"],
    ["PREPARE p1 FROM SELECT 1 AS a"],
    ["EXECUTE admin_p"],
    ["EXECUTE FUNCTION default:g_inline(1)"],
    ["ADVISE SELECT * FROM `_default`"],
    ["INFER `_default`"],
    ["EXPLAIN SELECT 1"],
    ["DELETE FROM `_default`"],
    ['INSERT INTO `_default` (KEY, VALUE) VALUES ("k", {})'],
    ["(SELECT 1 AS a)"],
    ["`select` FROM x"],
    ["SELECTED"],
    ["WITHIN"],
    ["﻿SELECT 1 AS a"],
    [" SELECT 1 AS a"],
    ["# SELECT 1"],
    ["-- SELECT 1\nDELETE FROM `_default`"],
  ])("refuses %j as no SELECT", (sql) => {
    expect(couchbaseAgentStatementRefusal(sql)).toBe(NOT_SELECT);
  });

  test.each([
    ["SELECT 1 AS a; DELETE FROM `_default`"],
    ["SELECT 1 AS a;;"],
    ["SELECT 1 AS a; SELECT 2 AS b"],
    ["SELECT [1;2] AS a"],
    ["SELECT 1 AS a; 'x'"],
  ])("refuses %j as more than one statement", (sql) => {
    expect(couchbaseAgentStatementRefusal(sql)).toBe(
      "The agent read-only execution profile sends one SQL++ statement, a SELECT (a WITH before it is fine), and nothing else; this text goes on after its first statement's semicolon, so it was not sent. Send one SELECT at a time.",
    );
  });

  test.each([["SELECT 1 AS a /* x"], ["SELECT 'x AS a"], ['SELECT "x AS a'], ["SELECT `x AS a"]])(
    "refuses %j, which ends inside a comment, a string or a name",
    (sql) => {
      expect(couchbaseAgentStatementRefusal(sql)).toBe(
        "The agent read-only execution profile sends one SQL++ statement, a SELECT (a WITH before it is fine), and nothing else; this text ends inside a comment, a string or a quoted name, so where it ends cannot be read, and it was not sent.",
      );
    },
  );

  test.each([["SELECT $$x$$ AS a"], ["SELECT $t$x$t$ AS a"]])("refuses %j, a dollar run SQL++ does not have", (sql) => {
    expect(couchbaseAgentStatementRefusal(sql)).toBe(
      "The agent read-only execution profile sends one SQL++ statement, a SELECT (a WITH before it is fine), and nothing else; this text holds a dollar-quoted run ($$ ... $$), which SQL++ does not have, so where its strings end cannot be read, and it was not sent.",
    );
  });

  test.each([
    ["-- x\rDELETE FROM `_default`"],
    ["SELECT 1 AS a -- x\r, 2 AS b"],
    ["SELECT 1 AS a -- x\r\r; DELETE FROM `_default`"],
  ])("refuses %j, a carriage return inside a line comment with more text after it", (sql) => {
    expect(couchbaseAgentStatementRefusal(sql)).toBe(
      "The agent read-only execution profile sends one SQL++ statement, a SELECT (a WITH before it is fine), and nothing else; this text holds a carriage return inside a -- comment with more text after it, and the server ends the comment at that carriage return, so a reader that does not could read another statement, and it was not sent. End a comment with a line feed.",
    );
  });

  test("refuses text that holds no statement", () => {
    for (const sql of ["", "   ", "-- only a comment", "/* only */", ";"]) {
      expect(couchbaseAgentStatementRefusal(sql)).not.toBeNull();
    }
    expect(couchbaseAgentStatementRefusal("-- only a comment")).toBe(
      "The agent read-only execution profile sends one SQL++ statement, a SELECT (a WITH before it is fine), and nothing else; this text holds no statement, so nothing was sent.",
    );
  });
});
