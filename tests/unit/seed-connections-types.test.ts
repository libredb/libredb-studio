/**
 * Drift guard for the types `docs/SEED_CONNECTIONS.md` names: every shipped type a seed may carry, and every engine
 * whose connection form offers `allowInsecureAuth`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";

const ROOT = path.resolve(import.meta.dir, "../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

describe("docs/SEED_CONNECTIONS.md names every type a seed may carry", () => {
  const SEED = read("docs/SEED_CONNECTIONS.md");

  test("the connections[].type row lists exactly the shipped types", () => {
    const row = SEED.split("\n").find((line) => line.startsWith("| `connections[].type` |"));
    const listed = (row?.match(/`[a-z0-9]+`/g) ?? []).map((cell) => cell.slice(1, -1)).sort();
    expect(listed).toEqual([...SHIPPED_DATABASE_TYPES].sort());
  });

  test("the example's Required comment lists exactly the shipped types", () => {
    const line = SEED.split("\n").find((candidate) => candidate.includes("# Required: postgres|"));
    const listed = (line?.split("# Required: ")[1] ?? "").trim().split("|").sort();
    expect(listed).toEqual([...SHIPPED_DATABASE_TYPES].sort());
  });
});

describe("the allowInsecureAuth field names every engine that reads it", () => {
  test("docs/SEED_CONNECTIONS.md names Db2, both InfluxDB types, Oxia, Databend, S3, MQTT, RabbitMQ and SNMP, the types whose form offers the field", () => {
    const readers = Object.entries(DB_UI_CONFIG)
      .filter(([, config]) => (config.connectionFields as readonly string[] | undefined)?.includes("allowInsecureAuth"))
      .map(([type]) => type);
    // The control: a tenth type taking the field fails here until the doc names it.
    expect(readers).toEqual(["db2", "influxdb", "influxdb3", "oxia", "databend", "s3", "mqtt", "rabbitmq", "snmp"]);
    expect(read("docs/SEED_CONNECTIONS.md")).toContain(
      "| `connections[].allowInsecureAuth` | No | absent | Db2, both InfluxDB types, Oxia, Databend, S3, MQTT, RabbitMQ and SNMP (#786):",
    );
  });
});
