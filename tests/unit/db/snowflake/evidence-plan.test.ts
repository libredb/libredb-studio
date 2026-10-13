/**
 * The measurement plan of the Snowflake evidence harness, checked without an account: M97 records both self-service
 * registration forms a user may try on itself, the two `ADD KEY PAIR` attempts and the `SET RSA_PUBLIC_KEY_2`, between
 * the two `SHOW USER KEY PAIRS` reads, and the key body reaches each only through the run-time placeholder. Every
 * scenario of the full capture connects as the provider does, the connect `SHOW` and then the role check, which M100
 * moved into connect(), and the refusal and partition scenarios are the ones the trial measured.
 */
import { describe, expect, test } from "bun:test";
import {
  SNOWFLAKE_EVIDENCE_PLAN,
  SNOWFLAKE_EVIDENCE_SCENARIOS,
  scenarioStop,
} from "../../../live/snowflake-evidence-plan";

describe("M97", () => {
  const item = SNOWFLAKE_EVIDENCE_PLAN.find((entry) => entry.id === "M97");

  test("runs both self-service forms as the service user, between two reads of its key pairs", () => {
    expect(item?.principal).toBe("svc");
    expect(item?.statements).toEqual([
      "SHOW USER KEY PAIRS",
      "ALTER USER ADD KEY PAIR libredb_studio_<fp8> PUBLIC_KEY = '<public-key-body>'",
      "ALTER USER ADD KEY PAIR libredb_studio_<fp8> PUBLIC_KEY = '<public-key-body>'",
      "ALTER USER SET RSA_PUBLIC_KEY_2 = '<public-key-body>'",
      "SHOW USER KEY PAIRS",
    ]);
  });

  test("its question names both forms", () => {
    expect(item?.asks).toContain("ADD KEY PAIR");
    expect(item?.asks).toContain("SET RSA_PUBLIC_KEY_2");
  });
});

describe("the capture scenarios", () => {
  const scenario = (name: string) => SNOWFLAKE_EVIDENCE_SCENARIOS.find((entry) => entry.name === name);
  const sqlOf = (name: string) => scenario(name)?.statements.map((statement) => statement.sql);
  const ROLE_CHECK = "SELECT CURRENT_ROLE() AS r, CURRENT_SECONDARY_ROLES() AS s";

  test("are named once each, for the measured refusal codes and the two-partition result", () => {
    const names = SNOWFLAKE_EVIDENCE_SCENARIOS.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      "connect-keypair",
      "connect-pat",
      "connect-no-warehouse",
      "refusal-390144",
      "refusal-390186",
      "refusal-403",
      "refusal-002003",
      "refusal-003001",
      "refusal-422",
      "tree-show",
      "describe-columns",
      "partitions",
      "every-type",
      "cancel",
      "role-check-match",
      "role-check-secondary",
      "refusal-404",
      "monitoring-started",
      "monitoring-suspended",
      "monitoring-started-without-monitor",
      "monitoring-suspended-without-monitor",
      "role-restricted-pat-show",
    ]);
  });

  test.each(SNOWFLAKE_EVIDENCE_SCENARIOS.map((entry) => [entry.name]))(
    "%s sends the connect SHOW and then the role check before anything else",
    (name) => {
      const [connect, roleCheck] = scenario(name)?.statements ?? [];
      expect(connect?.tag).toBe("libredb-studio:connect");
      expect(connect?.timeout).toBe(30);
      expect(roleCheck).toEqual({ sql: ROLE_CHECK, tag: "libredb-studio:role-check", timeout: 30 });
      const later = scenario(name)?.statements.slice(2) ?? [];
      expect(
        later.filter((statement) => statement.tag === "libredb-studio:connect" || statement.sql === ROLE_CHECK),
      ).toEqual([]);
    },
  );

  test("a connection with a warehouse connects through SHOW WAREHOUSES, one without through SHOW DATABASES", () => {
    for (const entry of SNOWFLAKE_EVIDENCE_SCENARIOS) {
      expect(entry.statements[0].sql).toBe(
        entry.warehouse === false ? "SHOW DATABASES LIMIT 1" : "SHOW WAREHOUSES LIKE 'STUDIO_PROBE_WH'",
      );
    }
  });

  test("connect-no-warehouse is a browse-only connection: no warehouse field, and the role check answers anyway", () => {
    expect(scenario("connect-no-warehouse")).toMatchObject({ principal: "reader", warehouse: false });
    expect(scenario("connect-no-warehouse")?.role).toBeUndefined();
    expect(sqlOf("connect-no-warehouse")).toEqual(["SHOW DATABASES LIMIT 1", ROLE_CHECK]);
  });

  test("no scenario stands for an answer the account does not give: 000606 at the role check, or another role", () => {
    const names = SNOWFLAKE_EVIDENCE_SCENARIOS.map((entry) => entry.name);
    expect(names).not.toContain("refusal-000606");
    expect(names).not.toContain("role-check-mismatch");
  });

  test("refusal-390186 is the service user under a role it does not hold, refused at the connect SHOW", () => {
    expect(scenario("refusal-390186")).toMatchObject({ principal: "svc", role: "STUDIO_NOWH" });
    expect(scenario("refusal-390186")?.warehouse).toBeUndefined();
    expect(sqlOf("refusal-390186")).toEqual(["SHOW WAREHOUSES LIKE 'STUDIO_PROBE_WH'", ROLE_CHECK]);
  });

  test("partitions reads a two-partition result of big and fetches its later partition", () => {
    expect(scenario("partitions")?.principal).toBe("svc");
    expect(scenario("partitions")?.statements[2]).toEqual({
      sql: "SELECT ID, PAD FROM STUDIO_DEMO.PROBE.BIG ORDER BY ID LIMIT 8200",
      tag: "libredb-studio:editor",
      timeout: 60,
      partitions: true,
    });
  });

  test("the monitoring panels read the state after connecting, and the started panel the history", () => {
    for (const suffix of ["", "-without-monitor"]) {
      expect(sqlOf(`monitoring-suspended${suffix}`)?.slice(2)).toEqual(["SHOW WAREHOUSES LIKE 'STUDIO_PROBE_WH'"]);
      expect(sqlOf(`monitoring-started${suffix}`)?.[2]).toBe("SHOW WAREHOUSES LIKE 'STUDIO_PROBE_WH'");
      expect(sqlOf(`monitoring-started${suffix}`)?.[3]).toContain("QUERY_HISTORY_BY_WAREHOUSE");
    }
  });

  test("only the suspended panels wait for SHOW WAREHOUSES to report the warehouse suspended", () => {
    const waiting = SNOWFLAKE_EVIDENCE_SCENARIOS.filter((entry) => entry.suspended === true).map((entry) => entry.name);
    expect(waiting).toEqual(["monitoring-suspended", "monitoring-suspended-without-monitor"]);
  });
});

describe("scenarioStop", () => {
  const [connect, roleCheck] = SNOWFLAKE_EVIDENCE_SCENARIOS[0].statements;

  test("any answer but 200 stops the scenario as a refusal", () => {
    for (const status of [202, 400, 401, 403, 404, 422, 429, 500, 503]) {
      expect(scenarioStop(connect, { status, firstCell: null }, "STUDIO_RW")).toBe("refused");
      expect(scenarioStop(roleCheck, { status, firstCell: "STUDIO_RW" }, "STUDIO_RW")).toBe("refused");
    }
  });

  test("a role check answering another role stops it, one answering the configured role goes on", () => {
    expect(scenarioStop(roleCheck, { status: 200, firstCell: "STUDIO_RO" }, "STUDIO_NOWH")).toBe("role-mismatch");
    expect(scenarioStop(roleCheck, { status: 200, firstCell: "STUDIO_RW" }, "STUDIO_RW")).toBeNull();
  });

  test("only the role check is read for its role", () => {
    expect(scenarioStop(connect, { status: 200, firstCell: "STUDIO_PROBE_WH" }, "STUDIO_RW")).toBeNull();
  });
});
