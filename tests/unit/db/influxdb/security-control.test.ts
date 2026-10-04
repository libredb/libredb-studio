/**
 * docs/SECURITY.md names both InfluxDB types' controls (SPEC 3.6 E20, SPEC-delivery B.5): rows 3.12 (InfluxQL) and
 * 3.13 (InfluxDB 3 SQL) are new, row 0.6 gains the route table, the client and the transport's form body, and row 3.8
 * gains both policies and both providers. This test holds that every file and test those rows cite is linked by its
 * full repository path and exists; scripts/security-check.mjs, run by tests/unit/security-check.test.ts, then proves
 * every linked test runs.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PROGRAMME_CONTROL_IDS } from "../../../../scripts/security-check.mjs";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const SECURITY = readFileSync(path.join(ROOT, "docs/SECURITY.md"), "utf8");
const DIRECTORY = "src/lib/db/providers/timeseries/influxdb";
const TESTS = "tests/unit/db/influxdb";

function controlRow(id: string): { status: string; control: string; enforcedIn: string; verifiedBy: string } {
  const row = SECURITY.split("\n").find((line) => line.startsWith(`| ${id} |`)) ?? "";
  const [, control = "", status = "", enforcedIn = "", verifiedBy = ""] = row.split(" | ");
  return { status, control, enforcedIn, verifiedBy };
}

function link(file: string): string {
  return `[\`${file}\`](../${file})`;
}

const ROWS: Readonly<
  Record<string, { readonly enforcedIn: readonly string[]; readonly verifiedBy: readonly string[] }>
> = {
  "0.6": {
    enforcedIn: [`${DIRECTORY}/routes.ts`, `${DIRECTORY}/client.ts`],
    verifiedBy: [
      `${TESTS}/routes.test.ts`,
      `${TESTS}/client.test.ts`,
      `${TESTS}/client-wire.test.ts`,
      `${TESTS}/seam-guard.test.ts`,
      "tests/unit/db/http/node-transport-truncated.test.ts",
      "tests/unit/db/http/node-transport-form.test.ts",
      "tests/unit/db/http/node-transport-runtimes.test.ts",
    ],
  },
  "3.8": {
    enforcedIn: [
      `${DIRECTORY}/influxql-policy.ts`,
      `${DIRECTORY}/sql-policy.ts`,
      `${DIRECTORY}/influxql-provider.ts`,
      `${DIRECTORY}/sql-provider.ts`,
    ],
    verifiedBy: [`${TESTS}/influxql-provider.test.ts`, `${TESTS}/sql-provider.test.ts`],
  },
  "3.12": {
    enforcedIn: [
      `${DIRECTORY}/influxql-lexer.ts`,
      `${DIRECTORY}/influxql-policy.ts`,
      `${DIRECTORY}/influxql-quote.ts`,
      `${DIRECTORY}/influxql-provider.ts`,
      `${DIRECTORY}/run-database.ts`,
      `${DIRECTORY}/routes.ts`,
      "src/lib/db/destructive-commands.ts",
    ],
    verifiedBy: [
      `${TESTS}/influxql-lexer.test.ts`,
      `${TESTS}/influxql-policy.test.ts`,
      `${TESTS}/influxql-differential.test.ts`,
      `${TESTS}/influxql-quote.test.ts`,
      `${TESTS}/influxql-provider.test.ts`,
      `${TESTS}/run-database.test.ts`,
      `${TESTS}/routes.test.ts`,
      "tests/hooks/use-query-execution.test.ts",
    ],
  },
  "3.13": {
    enforcedIn: [
      `${DIRECTORY}/sql-policy.ts`,
      `${DIRECTORY}/routes.ts`,
      `${DIRECTORY}/client.ts`,
      `${DIRECTORY}/sql-objects.ts`,
      `${DIRECTORY}/run-database.ts`,
      `${DIRECTORY}/sql-provider.ts`,
      "src/lib/sql/grammar.ts",
    ],
    verifiedBy: [
      `${TESTS}/sql-policy.test.ts`,
      `${TESTS}/routes.test.ts`,
      `${TESTS}/sql-objects.test.ts`,
      `${TESTS}/run-database.test.ts`,
      `${TESTS}/sql-provider.test.ts`,
      "tests/unit/sql/grammar.test.ts",
    ],
  },
};

describe("the InfluxDB controls are programme controls", () => {
  test.each(["3.12", "3.13"])("PROGRAMME_CONTROL_IDS holds %s", (id) => {
    expect(PROGRAMME_CONTROL_IDS).toContain(id);
  });

  test.each(["3.12", "3.13"])("row %s is an implemented control", (id) => {
    expect(controlRow(id).status).toBe("Implemented");
  });

  test("row 3.12 states the InfluxQL policy and row 3.13 the DataFusion one", () => {
    expect(controlRow("3.12").control).toStartWith("On an InfluxDB (InfluxQL) connection, a statement runs only when");
    expect(controlRow("3.12").control).toContain("a refused statement is never sent and never written to history");
    expect(controlRow("3.13").control).toStartWith("On an InfluxDB 3 (SQL) connection, a statement runs only when");
    expect(controlRow("3.13").control).toContain("never against the `_internal` database");
  });

  test("row 0.6 says a statement travels in a body, never the URL query string", () => {
    expect(controlRow("0.6").control).toContain("never the URL query string");
    expect(controlRow("0.6").control).toContain("`NodeRequest.form`");
  });
});

describe.each(Object.entries(ROWS))("row %s", (id, cited) => {
  const row = controlRow(id);

  test.each([...cited.enforcedIn])("is enforced in %s, which exists", (file) => {
    expect(row.enforcedIn).toContain(link(file));
    expect(existsSync(path.join(ROOT, file))).toBe(true);
  });

  test.each([...cited.verifiedBy])("is verified by %s, which exists", (file) => {
    expect(row.verifiedBy).toContain(link(file));
    expect(existsSync(path.join(ROOT, file))).toBe(true);
  });
});

describe("the notes state what the code does", () => {
  test("Known limits names the InfluxDB (InfluxQL) row among the rows that declare a refusal and a byte bound", () => {
    expect(SECURITY).toContain(
      "The Milvus, Qdrant, InfluxDB (InfluxQL) and Oxia rows declare both (rows 3.11, 3.12 and 3.15); no other shipped engine declares either.",
    );
    expect(SECURITY).not.toContain("Milvus's and Qdrant's rows declare both");
  });

  test("note 3.12 names a word right after `::` as an operand end", () => {
    expect(SECURITY).toContain("`TRUE` or `FALSE`, or any word right after `::`)");
  });

  test("note 3.13 names the database listing's configure path", () => {
    expect(SECURITY).toContain("the database listing, a GET on `/api/v3/configure/database`,");
  });
});
