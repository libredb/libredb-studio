/**
 * The statements and vocabularies of governance contract v1 (docs/GOVERNANCE.md).
 *
 * Every statement Studio issues against a governance source comes from `src/lib/governance/contract.ts`, and the
 * manifest a control plane runs them from is generated from the same builders. These tests pin the properties a
 * control plane relies on: the schema is always quoted, columns are always named, nothing selects `*`, and the
 * heartbeat upsert never rewrites `started_at`.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  buildHeartbeatUpsert,
  buildListenerProbeStatement,
  buildListenStatement,
  buildPingListenStatement,
  buildPingNotifyStatement,
  buildQueryEventInsert,
  buildSnapshotStatements,
  CanaryResultsSchema,
  CONTRACT_OBJECTS,
  FRESHNESS_STATES,
  HEARTBEAT_COLUMNS,
  LISTENER_STATES,
  NOTIFY_CHANNEL,
  NOTIFY_KINDS,
  PING_CHANNEL_PREFIX,
  pingChannel,
  QUERY_EVENT_COLUMNS,
  QUERY_EVENT_INSERT_MAX_ROWS,
  quoteSchemaName,
  READINESS_BY_FRESHNESS,
  READINESS_STATUSES,
  READINESS_WITHOUT_GOVERNANCE,
  ReadinessBodySchema,
  SinkStateSchema,
  SkippedItemSchema,
  SkippedSchema,
  SNAPSHOT_READS,
} from "@/lib/governance/contract";

const objectNamed = (name: string) => {
  const found = CONTRACT_OBJECTS.find((object) => object.name === name);
  if (found === undefined) throw new Error(`no contract object named ${name}`);
  return found;
};

const columnsOf = (name: string): string[] => {
  const object = objectNamed(name);
  if (object.kind === "function") throw new Error(`${name} is a function and has no columns`);
  return object.columns.map((column) => column.name);
};

const checkValuesOf = (objectName: string, columnName: string): readonly string[] | undefined => {
  const object = objectNamed(objectName);
  if (object.kind === "function") return undefined;
  const check = object.columns.find((column) => column.name === columnName)?.check;
  return check?.kind === "values" ? check.values : undefined;
};

/** Every statement the module builds, for one schema name. */
function everyStatement(schema: string): string[] {
  return [
    ...Object.values(buildSnapshotStatements(schema)),
    buildListenStatement(),
    buildPingListenStatement("libredb-studio"),
    buildPingNotifyStatement(),
    buildListenerProbeStatement(),
    buildHeartbeatUpsert(schema),
    buildQueryEventInsert(schema, 1),
    buildQueryEventInsert(schema, 3),
  ];
}

describe("contract statements", () => {
  test("every statement quotes the schema, names explicit columns and never selects *", () => {
    const objectNames = new Set(CONTRACT_OBJECTS.map((object) => object.name));
    for (const schema of ["bridge", "governance_v1"]) {
      let relationCount = 0;
      for (const sql of everyStatement(schema)) {
        expect(sql).not.toContain("*");
        expect(sql).not.toMatch(/\bbridge\./);

        const relations = [...sql.matchAll(/\b(?:FROM|INTO|JOIN)\s+(\S+)/g)].map((match) => match[1]);
        for (const relation of relations) {
          relationCount += 1;
          const qualified = /^"([^"]+)"\.([a-z0-9_]+)$/.exec(relation);
          expect(qualified?.[1]).toBe(schema);
          expect(objectNames.has(qualified?.[2] ?? "")).toBe(true);
        }

        const select = /^SELECT (.+) FROM "[^"]+"\.([a-z0-9_]+)$/.exec(sql);
        if (select !== null) {
          for (const column of select[1].split(", ")) expect(columnsOf(select[2])).toContain(column);
        }
        const insert = /^INSERT INTO "[^"]+"\.([a-z0-9_]+) \(([^)]+)\) VALUES /.exec(sql);
        if (insert !== null) {
          for (const column of insert[2].split(", ")) expect(columnsOf(insert[1])).toContain(column);
        }
      }
      // Six snapshot reads, the heartbeat and two event inserts: a vacuous pass would count none.
      expect(relationCount).toBe(9);
    }
  });

  test("the heartbeat upsert writes started_at only on insert and sets last_seen_at = now() on every conflict", () => {
    const sql = buildHeartbeatUpsert("bridge");
    const parsed =
      /^INSERT INTO "bridge"\.studio_instances_v1 \(([^)]+)\) VALUES \(([^)]+)\) ON CONFLICT \(instance_id\) DO UPDATE SET (.+)$/.exec(
        sql,
      );
    expect(parsed).not.toBeNull();
    const [, insertList, valueList, assignmentList] = parsed as RegExpExecArray;

    const inserted = insertList.split(", ");
    expect(inserted).toEqual([...HEARTBEAT_COLUMNS]);
    expect(inserted).toContain("started_at");
    expect(inserted).not.toContain("last_seen_at");
    expect(valueList.split(", ")).toEqual(inserted.map((_, index) => `$${index + 1}`));

    const assignments = assignmentList.split(", ");
    expect(assignments.at(-1)).toBe("last_seen_at = now()");
    expect(assignments.slice(0, -1)).toEqual(
      inserted
        .filter((column) => column !== "instance_id" && column !== "started_at")
        .map((column) => `${column} = EXCLUDED.${column}`),
    );
    expect(assignmentList).not.toContain("started_at");
  });

  test("the heartbeat reports every studio_instances_v1 column except last_seen_at, which the database stamps", () => {
    expect<string[]>([...HEARTBEAT_COLUMNS]).toEqual(
      columnsOf("studio_instances_v1").filter((name) => name !== "last_seen_at"),
    );
  });

  test("the snapshot is the transaction of the snapshot protocol, with the schema quoted", () => {
    const statements = buildSnapshotStatements("bridge");
    expect(Object.keys(statements)).toEqual([
      "begin",
      "contract",
      "connections",
      "grants",
      "settings",
      "revocations",
      "canary",
      "commit",
    ]);
    expect(statements.begin).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    expect(statements.contract).toBe('SELECT version, status, sunset_after, notify_channel FROM "bridge".contract');
    expect(statements.connections).toBe(
      'SELECT connection_id, name, engine, environment, group_name, color, definition, read_secret, write_secret, mcp_enabled, updated_at FROM "bridge".connections_v1',
    );
    expect(statements.grants).toBe(
      'SELECT subject, connection_id, level, expires_at, downgraded, granted_at FROM "bridge".grants_v1',
    );
    expect(statements.settings).toBe('SELECT key, value, updated_at FROM "bridge".settings_v1');
    expect(statements.revocations).toBe('SELECT subject, revoked_before FROM "bridge".session_revocations_v1');
    expect(statements.canary).toBe('SELECT kid, envelope FROM "bridge".seal_canary_v1');
    expect(statements.commit).toBe("COMMIT");
  });

  test("each snapshot read names columns of its view, and the canary read leaves created_at out", () => {
    expect(SNAPSHOT_READS.map((read) => read.object)).toEqual([
      "contract",
      "connections_v1",
      "grants_v1",
      "settings_v1",
      "session_revocations_v1",
      "seal_canary_v1",
    ]);
    for (const read of SNAPSHOT_READS) {
      for (const column of read.columns) expect(columnsOf(read.object)).toContain(column);
    }
    const canary = SNAPSHOT_READS.find((read) => read.object === "seal_canary_v1");
    expect(canary?.columns).toEqual(["kid", "envelope"]);
  });

  test("the query event insert numbers its placeholders row by row and ends with ON CONFLICT DO NOTHING", () => {
    const width = QUERY_EVENT_COLUMNS.length;
    expect(width).toBe(29);
    expect([...QUERY_EVENT_COLUMNS]).toEqual(columnsOf("query_events_v1"));

    const sql = buildQueryEventInsert("bridge", 2);
    const rows = [0, 1].map(
      (row) => `(${Array.from({ length: width }, (_, column) => `$${row * width + column + 1}`).join(", ")})`,
    );
    expect(sql).toBe(
      `INSERT INTO "bridge".query_events_v1 (${QUERY_EVENT_COLUMNS.join(", ")}) VALUES ${rows.join(", ")} ON CONFLICT DO NOTHING`,
    );
  });

  test("a batch fits PostgreSQL's 65535 bind parameters, and a row count outside 1 to the maximum is refused", () => {
    const width = QUERY_EVENT_COLUMNS.length;
    expect(QUERY_EVENT_INSERT_MAX_ROWS * width).toBeLessThanOrEqual(65535);
    expect((QUERY_EVENT_INSERT_MAX_ROWS + 1) * width).toBeGreaterThan(65535);
    expect(buildQueryEventInsert("bridge", QUERY_EVENT_INSERT_MAX_ROWS)).toContain(
      `$${QUERY_EVENT_INSERT_MAX_ROWS * width})`,
    );
    for (const rows of [0, -1, 1.5, Number.NaN, QUERY_EVENT_INSERT_MAX_ROWS + 1]) {
      expect(() => buildQueryEventInsert("bridge", rows)).toThrow(RangeError);
    }
  });

  test("the listener listens on libredb_bridge and pings itself on a channel derived from the instance id", () => {
    expect(NOTIFY_CHANNEL).toBe("libredb_bridge");
    expect(PING_CHANNEL_PREFIX).toBe("libredb_bridge_ping_");
    expect(buildListenStatement()).toBe("LISTEN libredb_bridge");

    const hex = createHash("sha256").update("libredb-studio", "utf8").digest("hex").slice(0, 16);
    expect(pingChannel("libredb-studio")).toBe(`libredb_bridge_ping_${hex}`);
    expect(buildPingListenStatement("libredb-studio")).toBe(`LISTEN libredb_bridge_ping_${hex}`);
    expect(pingChannel("studio-a")).not.toBe(pingChannel("studio-b"));
    // PostgreSQL truncates identifiers at 63 bytes, so a longer channel would collide with another instance's.
    expect(pingChannel("x".repeat(128)).length).toBeLessThanOrEqual(63);

    expect(buildPingNotifyStatement()).toBe("SELECT pg_notify($1, $2)");
    expect(buildListenerProbeStatement()).toBe("SELECT 1");
  });

  test("the schema name is quoted, and a name that is not a lowercase identifier is refused before any SQL is built", () => {
    expect(quoteSchemaName("bridge")).toBe('"bridge"');
    expect(quoteSchemaName("_gov_2")).toBe('"_gov_2"');
    expect(quoteSchemaName("a".repeat(63))).toBe(`"${"a".repeat(63)}"`);
    for (const refused of ["", "Bridge", "1bridge", 'bri"dge', "bridge;drop", "bridge.x", " bridge", "a".repeat(64)]) {
      expect(() => quoteSchemaName(refused)).toThrow(/schema name/);
    }
    expect(() => buildSnapshotStatements('x"; DROP SCHEMA bridge; --')).toThrow(/schema name/);
    expect(() => buildHeartbeatUpsert("Bridge")).toThrow(/schema name/);
    expect(() => buildQueryEventInsert("", 1)).toThrow(/schema name/);
  });
});

describe("contract vocabularies", () => {
  test("the listener states are the values the heartbeat column accepts", () => {
    expect([...LISTENER_STATES]).toEqual(["listening", "reconnecting", "polling", "deaf"]);
    expect(checkValuesOf("studio_instance", "listener_state")).toEqual([...LISTENER_STATES]);
  });

  test("every freshness state maps to the readiness status and HTTP status the freshness table gives it", () => {
    expect([...FRESHNESS_STATES]).toEqual([
      "loading",
      "ok",
      "degraded",
      "unavailable",
      "misconfigured",
      "incompatible",
    ]);
    expect(READINESS_BY_FRESHNESS).toEqual({
      loading: { status: "loading", httpStatus: 503 },
      ok: { status: "ok", httpStatus: 200 },
      degraded: { status: "degraded", httpStatus: 200 },
      unavailable: { status: "degraded", httpStatus: 200 },
      misconfigured: { status: "misconfigured", httpStatus: 503 },
      incompatible: { status: "incompatible", httpStatus: 503 },
    });
    expect(READINESS_WITHOUT_GOVERNANCE).toEqual({ status: "ready", httpStatus: 200 });
    const reachable = new Set([
      READINESS_WITHOUT_GOVERNANCE.status,
      ...Object.values(READINESS_BY_FRESHNESS).map((entry) => entry.status),
    ]);
    expect([...reachable].sort()).toEqual([...READINESS_STATUSES].sort());
  });

  test("each view over a source the control plane changes names the notification kind its change sends", () => {
    const kinds = CONTRACT_OBJECTS.flatMap((object) =>
      object.kind === "view" && object.notifyKind !== null ? [object.notifyKind] : [],
    );
    expect(kinds).toEqual([...NOTIFY_KINDS]);
    expect([...NOTIFY_KINDS]).toEqual(["connections", "grants", "settings", "revocations", "canary"]);
  });
});

describe("heartbeat and readiness shapes", () => {
  test("a skipped item carries kind, id, code and optionally level and path, and never a value", () => {
    expect(
      SkippedItemSchema.safeParse({
        kind: "connection",
        id: "3f2c8a14-5b6e-4c0d-9a7f-1e2d3c4b5a69",
        level: "write",
        path: "ssl.mode",
        code: "WRITE_SECRET_UNOPENABLE",
      }).success,
    ).toBe(true);
    expect(
      SkippedItemSchema.safeParse({ kind: "setting", id: "query.timeoutMs", code: "SETTING_INVALID" }).success,
    ).toBe(true);
    expect(
      SkippedItemSchema.safeParse({ kind: "setting", id: "query.timeoutMs", code: "SETTING_INVALID", value: 5 })
        .success,
    ).toBe(false);
    expect(SkippedItemSchema.safeParse({ kind: "user", id: "x", code: "SETTING_INVALID" }).success).toBe(false);
    expect(SkippedItemSchema.safeParse({ kind: "connection", id: "x", code: "NOT_A_CODE" }).success).toBe(false);
    expect(SkippedItemSchema.safeParse({ kind: "connection", id: "", code: "DEFINITION_INVALID" }).success).toBe(false);
  });

  test("the skipped column holds at most 500 items, the limit of its CHECK", () => {
    const item = { kind: "connection", id: "a", code: "DEFINITION_INVALID" };
    expect(SkippedSchema.safeParse(Array.from({ length: 500 }, () => item)).success).toBe(true);
    expect(SkippedSchema.safeParse(Array.from({ length: 501 }, () => item)).success).toBe(false);
  });

  test("the sink state is six fields with non-negative counters and a five-character SQLSTATE", () => {
    const idle = { queued: 0, dropped: 0, rejected: 0, lastFlushAt: null, backingOff: false, lastSqlstate: null };
    expect(SinkStateSchema.safeParse(idle).success).toBe(true);
    expect(
      SinkStateSchema.safeParse({ ...idle, lastFlushAt: "2026-10-14T12:00:04.000Z", lastSqlstate: "57P01" }).success,
    ).toBe(true);
    expect(SinkStateSchema.safeParse({ ...idle, queued: -1 }).success).toBe(false);
    expect(SinkStateSchema.safeParse({ ...idle, lastSqlstate: "timeout" }).success).toBe(false);
    expect(SinkStateSchema.safeParse({ ...idle, lastFlushAt: "yesterday" }).success).toBe(false);
    expect(SinkStateSchema.safeParse({ ...idle, statement: "SELECT 1" }).success).toBe(false);
  });

  test("the canary maps a key id to ok or an envelope code", () => {
    expect(CanaryResultsSchema.safeParse({ "0123456789abcdef": "ok", fedcba9876543210: "UNKNOWN_KID" }).success).toBe(
      true,
    );
    expect(CanaryResultsSchema.safeParse({ "0123456789abcdef": "OK" }).success).toBe(false);
    expect(CanaryResultsSchema.safeParse({ "0123456789ABCDEF": "ok" }).success).toBe(false);
    expect(CanaryResultsSchema.safeParse({ "0123456789abcdef": "SETTING_INVALID" }).success).toBe(false);
  });

  test("the readiness body is status, contract and an optional detail", () => {
    expect(ReadinessBodySchema.safeParse({ status: "ready", contract: { supported: [1], active: null } }).success).toBe(
      true,
    );
    expect(
      ReadinessBodySchema.safeParse({
        status: "incompatible",
        contract: { supported: [1], active: null },
        detail: "no common contract version",
      }).success,
    ).toBe(true);
    expect(
      ReadinessBodySchema.safeParse({ status: "unavailable", contract: { supported: [1], active: 1 } }).success,
    ).toBe(false);
    expect(ReadinessBodySchema.safeParse({ status: "ok", contract: { supported: [], active: 1 } }).success).toBe(false);
    expect(
      ReadinessBodySchema.safeParse({ status: "ok", contract: { supported: [1], active: 1 }, extra: true }).success,
    ).toBe(false);
  });
});
