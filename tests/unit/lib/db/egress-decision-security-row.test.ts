/**
 * docs/SECURITY.md control 0.6 names the egress decision (FND-2 slice 2a): DB_HTTP_BLOCK_PRIVATE_HOSTS is read once
 * per process by one core module, an invalid value stops a standalone boot by name, and where no boot runs the
 * provider factory takes the decision first. scripts/security-check.mjs, run by tests/unit/security-check.test.ts,
 * proves every file the row links exists and every test it links runs.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const SECURITY = readFileSync(path.join(ROOT, "docs/SECURITY.md"), "utf8");
const ROW = SECURITY.split("\n").find((line) => line.startsWith("| 0.6 |")) ?? "";
const [, control, , enforcedIn, verifiedBy] = ROW.split(" | ");
const LIMITS = SECURITY.slice(SECURITY.indexOf("## Known limits"));
const GUARD_BULLET = LIMITS.slice(
  LIMITS.indexOf("- **The HTTP destination guard is opt-in and address-based.**"),
  LIMITS.indexOf("- **A PostgreSQL-wire cancel"),
);
const API_ROW =
  readFileSync(path.join(ROOT, "docs/API_DOCS.md"), "utf8")
    .split("\n")
    .find((line) => line.startsWith("| `DB_HTTP_BLOCK_PRIVATE_HOSTS` |")) ?? "";

describe("control 0.6 names the egress decision", () => {
  test.each([
    "src/lib/db/egress-decision.ts",
    "src/lib/config/egress-preflight.ts",
    "src/instrumentation.ts",
    "src/lib/db/factory.ts",
    "src/lib/db/providers/network/snmp/client.ts",
    "src/lib/db/providers/industrial/modbus/client.ts",
    "src/lib/db/providers/network/netconf/dial.ts",
    "src/lib/db/providers/industrial/sparkplug/session.ts",
    "src/lib/db/providers/industrial/mtconnect/connection-options.ts",
    "src/lib/db/providers/vector/qdrant/connection-options.ts",
    "src/lib/db/providers/vector/weaviate/connection-options.ts",
    "src/lib/db/providers/objectstore/s3/connection-options.ts",
    "src/lib/db/providers/stream/rabbitmq/connection-options.ts",
    "src/lib/db/auth/google/token-source.ts",
    "src/lib/db/providers/document/firestore/transport.ts",
    "src/lib/db/providers/timeseries/influxdb/connection-options.ts",
    "src/lib/db/providers/platform/kubernetes/connection-options.ts",
  ])("enforced in %s", (file) => {
    expect(enforcedIn).toContain(`[\`${file}\`](../${file})`);
  });

  test.each([
    "tests/unit/lib/db/egress-decision.test.ts",
    "tests/unit/db/snmp/client.test.ts",
    "tests/integration/db/snmp-provider.test.ts",
    "tests/unit/lib/config/egress-preflight.test.ts",
    "tests/unit/instrumentation.test.ts",
    "tests/isolated/factory.test.ts",
    "tests/unit/lib/db/egress-decision-security-row.test.ts",
    "tests/unit/lib/db/provider-environment-scan.test.ts",
    "tests/security/provider-egress-decision.test.ts",
    "tests/unit/db/http/egress-policy-socket-dials.test.ts",
    "tests/unit/db/http/egress-policy-origins.test.ts",
    "tests/unit/db/http/egress-policy-origins-named-hosts.test.ts",
  ])("verified by %s", (file) => {
    expect(verifiedBy).toContain(`[\`${file}\`](../${file})`);
  });

  test("the control says the setting is read once and an invalid value stops the boot by name", () => {
    expect(control).toContain(
      "`DB_HTTP_BLOCK_PRIVATE_HOSTS` is read once per process by one core module, and by no provider's own code:",
    );
    expect(control).toContain("a standalone server refuses to boot on a value other than");
    expect(control).toContain("the provider factory takes the decision before any cache, tunnel or provider");
    expect(control).toContain("(trimmed, any case)");
    expect(control).toContain("logs the decision once, at info level,");
  });

  test("the control says the factory hands the decision to every provider but Spark, and which origins and requests are checked against it", () => {
    expect(control).toContain(
      "refuses such a value by name, and the factory hands the decision to every provider but Spark, which passes no guard, so the address literal of each origin ClickHouse, Druid, Elasticsearch, OpenSearch, Trino, libSQL, Databend, Snowflake, Prometheus, InfluxDB, InfluxDB 3, Couchbase, Firestore, MTConnect, Qdrant, Weaviate, S3-compatible object storage, Kubernetes, RabbitMQ's management API and the Google token source build, the HTTP requests of ClickHouse, Druid, Elasticsearch, OpenSearch, Trino, libSQL and Prometheus, Couchbase's own fetch and TLS paths, the AMQP, MQTT, Modbus, NETCONF and Sparkplug B dials and SNMP's name lookup are checked against the decision their provider was handed, and every other guarded path against the same decision, which core's guard reads on the provider's behalf",
    );
  });

  test("Known limits says the decision is logged once, at info level, and a change waits for a restart", () => {
    expect(GUARD_BULLET).toContain(
      "Studio reads the variable once per process, logs which way it decided and whether that is the default in one info line, which a `LOG_LEVEL` of `warn` or `error` hides,",
    );
    expect(GUARD_BULLET).toContain("A change to the variable takes effect when the process restarts.");
  });

  test("Known limits names SNMP's agent lookup as covered, as row 0.6 does", () => {
    expect(GUARD_BULLET).toContain("SNMP's agent lookup is covered too");
  });

  test("Known limits lists every engine whose connections pass the guard, and row 0.6 and the API_DOCS row point to it", () => {
    expect(GUARD_BULLET).toContain(
      "When enabled, it covers ClickHouse, Druid, Elasticsearch, OpenSearch, Trino, libSQL, Databend, BigQuery, Snowflake, Couchbase, Firestore, Prometheus, MTConnect, RabbitMQ's management API, Qdrant, Weaviate, InfluxDB (InfluxQL), InfluxDB 3 (SQL), S3-compatible object storage and Kubernetes HTTP requests, the dials of RabbitMQ's AMQP, MQTT, Modbus, NETCONF and Sparkplug B, and SNMP's agent lookup,",
    );
    expect(GUARD_BULLET).toContain("That list is complete: an engine it does not name, Kafka included,");
    expect(control).toContain("the engines that Known limits lists under the HTTP destination guard");
    expect(API_ROW).toContain(
      '[`SECURITY.md`](./SECURITY.md#known-limits) "Known limits" lists under the HTTP destination guard',
    );
  });
});
