/**
 * The version rule by its three numbers, health as one GET, the overview as two GETs with no cluster name and the
 * alarm state, and the maintenance refusal.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { readConnectionOptions } from "@/lib/db/providers/stream/rabbitmq/connection-options";
import {
  createManagementClient,
  rabbitmqBindingsLimiter,
  rabbitmqManagementLimiter,
} from "@/lib/db/providers/stream/rabbitmq/management/client";
import {
  readHealth,
  readOverview,
  refuseMaintenance,
  supportedVersion,
} from "@/lib/db/providers/stream/rabbitmq/monitoring";
import { rabbitmqConnection } from "../../../helpers/rabbitmq-connection";
import { createManagementStub, jsonOk, manualDeadlines } from "../../../helpers/rabbitmq-management-stub";

const VERSION_KEY = "GET /api/overview?columns=rabbitmq_version,product_name";
const FULL_KEY = "GET /api/overview?columns=rabbitmq_version,product_name,management_version";
const ALARMS_KEY = "GET /api/health/checks/alarms";
const UNREADABLE =
  "This server's management API reports a version Studio cannot read; Studio supports RabbitMQ 4.2 and later.";

function client() {
  const stub = createManagementStub();
  return {
    stub,
    client: createManagementClient({
      endpoint: readConnectionOptions(rabbitmqConnection()).management,
      transport: stub.factory,
      deadlineSignal: manualDeadlines().factory,
      queryTimeoutMs: 60_000,
      lifetime: new AbortController().signal,
      limiters: { management: rabbitmqManagementLimiter(), bindings: rabbitmqBindingsLimiter() },
    }),
  };
}

describe("supportedVersion", () => {
  test("compares the three numbers, never the text", () => {
    for (const accepted of ["4.2.0", "4.2.9", "4.3.6", "4.10.0", "4.3.0+3f2a1b", "4.2.0-rc.1", "5.0.0", "10.0.0"])
      expect(supportedVersion(accepted)).toBe(accepted);
    for (const refused of ["4.1.9", "3.13.7", "4.1.99", "0.0.0"]) {
      let thrown: unknown;
      try {
        supportedVersion(refused);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(DatabaseConfigError);
      expect((thrown as Error).message).toBe(`This broker runs RabbitMQ ${refused}; Studio supports 4.2 and later.`);
    }
  });

  test("a value of another shape is refused without being shown", () => {
    for (const odd of [
      "4.2",
      "v4.3.6",
      "4.3.6 ",
      "12345.0.0",
      "4.3.6_x",
      "<script>",
      "x".repeat(61_440),
      `4.3.6+${"a".repeat(65)}`,
    ]) {
      let thrown: unknown;
      try {
        supportedVersion(odd);
      } catch (error) {
        thrown = error;
      }
      expect((thrown as Error).message).toBe(UNREADABLE);
    }
    expect(supportedVersion(`4.3.6+${"a".repeat(63)}`)).toContain("4.3.6+");
  });
});

describe("readHealth", () => {
  test("one GET of the version; no connection count", async () => {
    const { stub, client: c } = client();
    stub.answer(VERSION_KEY, jsonOk({ rabbitmq_version: "4.3.6", product_name: "RabbitMQ" }));
    expect(await readHealth(c)).toEqual({
      databaseSize: "N/A",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
    expect(stub.keys()).toEqual([VERSION_KEY]);
  });
});

describe("readOverview", () => {
  test("two GETs: the version with the management version, and the alarm check", async () => {
    const { stub, client: c } = client();
    stub.answer(FULL_KEY, jsonOk({ rabbitmq_version: "4.3.6", product_name: "RabbitMQ", management_version: "4.3.6" }));
    stub.answer(ALARMS_KEY, jsonOk({ status: "ok" }));
    expect(await readOverview(c)).toEqual({
      version: "RabbitMQ 4.3.6",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "No resource alarm",
      tableCount: 0,
      tableCountSampledFrom:
        "no listing, because the overview reads only the version and the alarms; the tree counts each virtual host's streams",
      indexCount: 0,
    });
    expect(stub.keys().sort()).toEqual([ALARMS_KEY, FULL_KEY].sort());
  });

  test("an active alarm is the size card's text; a different management version is named", async () => {
    const { stub, client: c } = client();
    stub.answer(FULL_KEY, jsonOk({ rabbitmq_version: "4.2.9", management_version: "4.2.10" }));
    stub.answer(ALARMS_KEY, jsonOk({ status: "failed", alarms: [{ node: "rabbit@x", resource: "disk" }] }, 503));
    const overview = await readOverview(c);
    expect(overview.version).toBe("RabbitMQ 4.2.9 (management 4.2.10)");
    expect(overview.databaseSize).toBe(
      "The broker reports an active resource alarm, so publishers are blocked; reads still work.",
    );
    expect(JSON.stringify(overview)).not.toContain("rabbit@x");
  });

  test("a management version of another shape is not shown", async () => {
    const { stub, client: c } = client();
    stub.answer(FULL_KEY, jsonOk({ rabbitmq_version: "4.3.6", management_version: "<b>x</b>" }));
    stub.answer(ALARMS_KEY, jsonOk({ status: "ok" }));
    expect((await readOverview(c)).version).toBe("RabbitMQ 4.3.6");
  });
});

describe("refuseMaintenance", () => {
  test("refuses with its sentence", () => {
    expect(() => refuseMaintenance()).toThrow(QueryError);
  });
});
