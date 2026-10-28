/**
 * The ClickHouse agent profile's open-time proof (`verifyAgentProfile`), against a scripted server whose answers were
 * read from ClickHouse 26.7.1.1315 for the users the live check seeds (tests/live/clickhouse-agent-boundary.ts): the
 * least-privilege user is admitted, and each user the live check refuses is refused here by the same step.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError } from "@/lib/db/errors";
import {
  type AgentProofQuery,
  CLICKHOUSE_AGENT_PRIVILEGES,
  CLICKHOUSE_CHECKED_RELEASES,
  CLICKHOUSE_LOCAL_TABLE_ENGINES,
  CLICKHOUSE_READONLY_EXEMPT_PRIVILEGES,
  CLICKHOUSE_REFUSED_TABLE_ENGINES,
  CLICKHOUSE_SOURCE_PRIVILEGES,
  readGrantLine,
  verifyAgentProfile,
} from "@/lib/db/providers/sql/clickhouse/agent-boundary";
import { type ClickHouseQueryResult, ClickHouseTransportError } from "@/lib/db/providers/sql/clickhouse/transport";

/**
 * `SELECT arrayStringConcat(groupArray(name), ',') FROM (SELECT name FROM system.table_engines ORDER BY name)` on
 * 26.7.1.1315: every engine the checked release lists, so the two lists are held to cover it exactly.
 */
const ENGINES_26_7 =
  "AggregatingMergeTree,Alias,ArrowFlight,AzureBlobStorage,AzureQueue,Buffer,COSN,CoalescingMergeTree,CollapsingMergeTree,DeltaLake,DeltaLakeAzure,DeltaLakeLocal,DeltaLakeS3,Dictionary,Distributed,EmbeddedRocksDB,Executable,ExecutablePool,File,FileLog,FuzzJSON,FuzzQuery,GCS,GenerateRandom,GraphiteMergeTree,HDFS,Hive,Hudi,Iceberg,IcebergAzure,IcebergHDFS,IcebergLocal,IcebergS3,JDBC,Join,Kafka,KeeperMap,Log,Loop,MaterializedPostgreSQL,MaterializedView,Memory,Merge,MergeTree,MongoDB,MySQL,NATS,Null,ODBC,OSS,Paimon,PaimonAzure,PaimonHDFS,PaimonLocal,PaimonS3,PostgreSQL,QueryRunner,RabbitMQ,Redis,Remote,RemoteSecure,ReplacingMergeTree,ReplicatedAggregatingMergeTree,ReplicatedCoalescingMergeTree,ReplicatedCollapsingMergeTree,ReplicatedGraphiteMergeTree,ReplicatedMergeTree,ReplicatedReplacingMergeTree,ReplicatedSummingMergeTree,ReplicatedVersionedCollapsingMergeTree,S3,S3Queue,SQLite,Set,StripeLog,SummingMergeTree,TimeSeries,TinyLog,URL,VersionedCollapsingMergeTree,View,WindowView,YTsaurus".split(
    ",",
  );

/** The source privileges an unrestricted user's `SHOW GRANTS FINAL` lists on 26.7.1.1315, beside READ and WRITE. */
const SOURCE_GRANTS_26_7 =
  "FILE, URL, REMOTE, MONGO, REDIS, MYSQL, POSTGRES, SQLITE, ODBC, JDBC, HDFS, S3, HIVE, AZURE, KAFKA, NATS, RABBITMQ, YTSAURUS, ARROW FLIGHT, SOURCES".split(
    ", ",
  );

function result(rows: Record<string, unknown>[], fieldNames: string[] | null = null): ClickHouseQueryResult {
  return {
    rows,
    fieldNames: fieldNames ?? Object.keys(rows[0] ?? {}),
    columnTypes: null,
    executionTimeMs: 1,
    mutationCount: 0,
    rawText: null,
  };
}

function refused(code: number): ClickHouseTransportError {
  return new ClickHouseTransportError(`Code: ${code}. DB::Exception: refused`, code);
}

const GRANTS_COLUMN = "GRANTS FINAL";

type Answer = ClickHouseQueryResult | ClickHouseTransportError | Error;

/** The least-privilege user `agent_ro`, as 26.7.1.1315 answered each step of the proof for it. */
function leastPrivilege(): Record<string, Answer> {
  return {
    identity: result([{ version: "26.7.1.1315", user: "agent_ro", readonly: "1" }]),
    lowerReadonly: refused(164),
    write: refused(497),
    grants: result(
      [
        { [GRANTS_COLUMN]: "GRANT SELECT ON demo.customers TO agent_ro" },
        { [GRANTS_COLUMN]: "GRANT SELECT ON demo.orders TO agent_ro" },
      ],
      [GRANTS_COLUMN],
    ),
    queryLog: refused(497),
    objects: result([], ["database", "name", "engine"]),
    dictionaries: refused(497),
    functions: result([], ["name", "origin"]),
  };
}

function stepOf(sql: string): string {
  if (sql.startsWith("SELECT version()")) return "identity";
  if (sql === "SELECT 1 SETTINGS readonly = 0") return "lowerReadonly";
  if (sql.startsWith("CREATE DATABASE IF NOT EXISTS")) return "write";
  if (sql === "SHOW GRANTS FINAL") return "grants";
  if (sql.includes("system.query_log")) return "queryLog";
  if (sql.includes("system.tables")) return "objects";
  if (sql.includes("system.dictionaries")) return "dictionaries";
  if (sql.includes("system.functions")) return "functions";
  throw new Error(`unscripted statement: ${sql}`);
}

function server(overrides: Record<string, Answer> = {}): { query: AgentProofQuery; sent: string[] } {
  const answers = { ...leastPrivilege(), ...overrides };
  const sent: string[] = [];
  const query: AgentProofQuery = async (sql) => {
    sent.push(sql);
    const answer = answers[stepOf(sql)];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { query, sent };
}

async function refusal(overrides: Record<string, Answer>, database = "demo"): Promise<ExecutionProfileError> {
  try {
    await verifyAgentProfile(server(overrides).query, database);
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionProfileError);
    return error as ExecutionProfileError;
  }
  throw new Error("expected the profile to be refused");
}

function grants(...lines: string[]): ClickHouseQueryResult {
  return result(
    lines.map((line) => ({ [GRANTS_COLUMN]: line })),
    [GRANTS_COLUMN],
  );
}

describe("verifyAgentProfile admits", () => {
  test("the least-privilege user, after every step in order", async () => {
    const { query, sent } = server();
    await verifyAgentProfile(query, "demo");
    expect(sent.map(stepOf)).toEqual([
      "identity",
      "lowerReadonly",
      "write",
      "grants",
      "queryLog",
      "objects",
      "dictionaries",
      "functions",
    ]);
    expect(sent[2]).toBe("CREATE DATABASE IF NOT EXISTS `demo`");
  });

  test("the write refused under readonly, the query log switched off, and no dictionary listed", async () => {
    await expect(
      verifyAgentProfile(
        server({ write: refused(164), queryLog: refused(60), dictionaries: result([], ["database", "name"]) }).query,
        "demo",
      ),
    ).resolves.toBeUndefined();
  });

  test("column grants, SHOW grants, partial revokes and a user with no grant at all", async () => {
    await expect(
      verifyAgentProfile(
        server({
          grants: grants(
            "GRANT SHOW TABLES ON demo.* TO agent_cols",
            "GRANT SELECT(id, total) ON demo.orders TO agent_cols",
            "GRANT SELECT ON `my db`.`t, x` TO agent_cols",
            "REVOKE SELECT ON demo.url_tbl FROM agent_cols",
          ),
        }).query,
        "demo",
      ),
    ).resolves.toBeUndefined();
    await expect(verifyAgentProfile(server({ grants: grants() }).query, "demo")).resolves.toBeUndefined();
  });

  test("quotes the bound database for the write probe", async () => {
    const { query, sent } = server();
    await verifyAgentProfile(query, "we`ird\\db");
    expect(sent[2]).toBe("CREATE DATABASE IF NOT EXISTS `we\\`ird\\\\db`");
  });
});

describe("verifyAgentProfile refuses the server", () => {
  test("a release outside the checked set", async () => {
    const error = await refusal({ identity: result([{ version: "26.8.1.1", user: "agent_ro", readonly: "1" }]) });
    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(error.message).toBe(
      "The agent read-only profile is checked on ClickHouse 26.7, and this server is 26.8.1.1: its privileges and table engines have not been checked, so it is refused",
    );
  });

  test.each([
    [{ version: "26.7", user: "agent_ro", readonly: "1" }],
    [{ version: "26.7.1.1315", readonly: "1" }],
    [{ user: "agent_ro", readonly: "1" }],
  ])("an identity it cannot read: %p", async (row) => {
    expect((await refusal({ identity: result([row]) })).reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
  });

  test("readonly not in force", async () => {
    const error = await refusal({ identity: result([{ version: "26.7.1.1315", user: "agent_ro", readonly: "0" }]) });
    expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect(error.message).toContain("did not apply readonly = 1");
  });

  // Measured: a user whose settings profile marks readonly CHANGEABLE_IN_READONLY runs it and answers 1.
  test("a user who can lower readonly", async () => {
    const error = await refusal({ lowerReadonly: result([{ "1": 1 }]) });
    expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect(error.message).toContain("lower readonly");
  });

  test("a lower readonly refused with another code than 164", async () => {
    expect((await refusal({ lowerReadonly: refused(452) })).reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
  });

  test.each([[result([])], [refused(81)]])("a write the server did not refuse with 164 or 497: %#", async (answer) => {
    const error = await refusal({ write: answer });
    expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect(error.message).toContain("did not refuse a write");
  });

  test("a failure that never reached the server is thrown as it is", async () => {
    const lost = new ClickHouseTransportError("ClickHouse request failed: fetch failed", 0);
    await expect(verifyAgentProfile(server({ write: lost }).query, "demo")).rejects.toBe(lost);
  });
});

describe("verifyAgentProfile refuses the principal", () => {
  test.each([
    ["REMOTE", "GRANT REMOTE ON *.* TO agent_remote", "a source grant"],
    ["URL", "GRANT URL ON *.* TO agent_readurl", "a source grant"],
    ["BACKUP", "GRANT BACKUP ON demo.* TO agent_backup", "readonly does not refuse"],
    ["NAMED COLLECTION", "GRANT NAMED COLLECTION ON nc_probe TO agent_named", "readonly does not refuse"],
    ["ALTER DATABASE SETTINGS", "GRANT ALTER DATABASE SETTINGS ON demo.* TO agent_alterdb", "readonly does not refuse"],
    ["UNDROP TABLE", "GRANT UNDROP TABLE ON demo.* TO agent_undrop", "readonly does not refuse"],
    ["KILL QUERY", "GRANT KILL QUERY ON *.* TO agent_kill", "readonly does not refuse"],
    ["INSERT", "GRANT SELECT, INSERT ON demo.* TO agent_rw", "not a read"],
  ])("a %s grant, by name", async (privilege, line, reason) => {
    const error = await refusal({ grants: grants("GRANT SELECT ON demo.orders TO u", line) });
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toContain(`holds ${privilege} ON`);
    expect(error.message).toContain(reason);
  });

  test("a grant held with the grant option", async () => {
    const error = await refusal({ grants: grants("GRANT SELECT ON demo.orders TO agent_go WITH GRANT OPTION") });
    expect(error.message).toBe(
      'ClickHouse user "agent_ro" holds a grant WITH GRANT OPTION on demo.orders, so the agent read-only profile is refused',
    );
  });

  test.each([
    "GRANT SELECT ON *.* TO u",
    "GRANT SELECT ON system.query_log TO u",
    "GRANT SELECT ON `system`.* TO u",
    "GRANT SHOW TABLES ON INFORMATION_SCHEMA.* TO u",
    "GRANT SELECT ON sys*.* TO u",
    "GRANT SELECT ON demo TO u",
  ])("a read beyond named databases: %p", async (line) => {
    const error = await refusal({ grants: grants(line) });
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toContain("server's own schemas");
  });

  test.each([
    "GRANT r_remote TO agent_inherit",
    "SELECT 1",
    "GRANT SELECT ON `demo.orders TO u",
    "GRANT SELECT(id ON demo.orders TO u",
    "GRANT SELECT ON demo.orders FROM u",
  ])("a grant line it cannot read: %p", async (line) => {
    const error = await refusal({ grants: grants(line) });
    expect(error.message).toContain("cannot read");
  });

  test("a grant answer whose cell is not text", async () => {
    expect((await refusal({ grants: result([{ [GRANTS_COLUMN]: 1 }], [GRANTS_COLUMN]) })).message).toContain(
      "cannot read",
    );
  });

  test("a grant answer that describes no column", async () => {
    expect((await refusal({ grants: result([], []) })).message).toContain("answered no grants");
  });

  test.each([[result([])], [refused(81)]])("a readable query log: %#", async (answer) => {
    const error = await refusal({ queryLog: answer });
    expect(error.message).toContain("can read system.query_log");
  });

  test("the object check names every local engine and refuses definer and NONE views", async () => {
    const { query, sent } = server();
    await verifyAgentProfile(query, "demo");
    expect(sent.find((sql) => stepOf(sql) === "objects")).toBe(
      "SELECT database, name, engine FROM system.tables WHERE engine NOT IN (" +
        "'MergeTree', 'ReplacingMergeTree', 'SummingMergeTree', 'AggregatingMergeTree', 'CollapsingMergeTree', " +
        "'VersionedCollapsingMergeTree', 'GraphiteMergeTree', 'CoalescingMergeTree', 'ReplicatedMergeTree', " +
        "'ReplicatedReplacingMergeTree', 'ReplicatedSummingMergeTree', 'ReplicatedAggregatingMergeTree', " +
        "'ReplicatedCollapsingMergeTree', 'ReplicatedVersionedCollapsingMergeTree', 'ReplicatedGraphiteMergeTree', " +
        "'ReplicatedCoalescingMergeTree', 'Memory', 'Log', 'TinyLog', 'StripeLog', 'Null', 'Set', 'Join', 'View', " +
        "'MaterializedView') " +
        "OR (engine IN ('View', 'MaterializedView') AND (definer != '' OR match(create_table_query, 'SQL SECURITY (DEFINER|NONE)'))) " +
        "ORDER BY database, name LIMIT 5",
    );
  });

  test("a visible table of a refused engine, named with its engine", async () => {
    const error = await refusal({
      objects: result([
        { database: "demo", name: "url_tbl", engine: "URL" },
        { database: "demo", name: "v_urltbl", engine: "View" },
      ]),
    });
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toContain("can see demo.url_tbl (URL), demo.v_urltbl (View)");
  });

  test("a readable dictionary", async () => {
    const error = await refusal({ dictionaries: result([{ database: "", name: "dict_regions_config" }]) });
    expect(error.message).toContain("the dictionary .dict_regions_config");
  });

  test("dictionaries refused with another code than 497", async () => {
    expect((await refusal({ dictionaries: refused(60) })).message).toContain("answered code 60");
  });

  test("the function check reads every function that is neither built in nor SQL", async () => {
    const { query, sent } = server();
    await verifyAgentProfile(query, "demo");
    expect(sent.find((sql) => stepOf(sql) === "functions")).toBe(
      "SELECT name, origin FROM system.functions WHERE origin NOT IN ('System', 'SQLUserDefined') ORDER BY name LIMIT 5",
    );
  });

  // Measured: an executable function from the server's configuration answered the least-privilege user under
  // readonly = 1 with no grant, and its program ran.
  test("a visible executable user-defined function, by name", async () => {
    const error = await refusal({
      functions: result([
        { name: "libredb_lb_udf_echo", origin: "ExecutableUserDefined" },
        { name: "libredb_lb_udf_pool", origin: "ExecutableUserDefined" },
      ]),
    });
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toBe(
      'ClickHouse user "agent_ro" can call libredb_lb_udf_echo (ExecutableUserDefined), libredb_lb_udf_pool (ExecutableUserDefined), each a user-defined function that runs code outside SQL, which readonly does not hold; the agent read-only profile takes a server whose functions are built in or SQL only, so it is refused',
    );
  });
});

describe("the checked lists", () => {
  test("the checked release is the one the lists were read from", () => {
    expect(CLICKHOUSE_CHECKED_RELEASES).toEqual(["26.7"]);
  });

  test("the local and refused engine lists cover 26.7's engines exactly, without overlap", () => {
    const covered = [...CLICKHOUSE_LOCAL_TABLE_ENGINES, ...CLICKHOUSE_REFUSED_TABLE_ENGINES];
    expect(new Set(covered).size).toBe(covered.length);
    expect([...covered].sort()).toEqual([...ENGINES_26_7].sort());
  });

  test("every source grant 26.7 lists is a source privilege, and none is admitted", () => {
    for (const privilege of SOURCE_GRANTS_26_7) expect(CLICKHOUSE_SOURCE_PRIVILEGES).toContain(privilege);
    for (const privilege of [...CLICKHOUSE_SOURCE_PRIVILEGES, ...CLICKHOUSE_READONLY_EXEMPT_PRIVILEGES]) {
      expect(CLICKHOUSE_AGENT_PRIVILEGES).not.toContain(privilege);
    }
  });
});

describe("readGrantLine", () => {
  test("reads the privileges without their column lists", () => {
    expect(readGrantLine("GRANT SELECT(id, total), SHOW TABLES ON demo.orders TO u")).toEqual({
      revoke: false,
      privileges: ["SELECT", "SHOW TABLES"],
      target: "demo.orders",
      grantOption: false,
    });
  });

  test("reads a revoke and a grant option", () => {
    expect(readGrantLine("REVOKE SELECT ON demo.t FROM u")?.revoke).toBe(true);
    expect(readGrantLine("GRANT SELECT ON demo.t TO u WITH GRANT OPTION")?.grantOption).toBe(true);
  });
});
