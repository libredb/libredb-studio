/**
 * The RabbitMQ names ADDING_A_PROVIDER carries beyond the provider doc: the DatabaseType lines of its registration
 * example, the QueryTab example and the queryDialect row, which name every member of their unions, the providers index
 * line, and the driver-free ids, since the provider reads the broker with a client of this repository's own.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const guide = readFileSync(path.join(ROOT, "docs/ADDING_A_PROVIDER.md"), "utf8");

describe("docs/ADDING_A_PROVIDER.md", () => {
  test("the DatabaseType lines before and after the example's addition end with rabbitmq", () => {
    expect(guide).toContain("| 'bigquery' | 'mqtt' | 'firestore' | 'rabbitmq';\n");
    expect(guide).toContain("| 'bigquery' | 'mqtt' | 'firestore' | 'rabbitmq' | 'cockroachdb';\n");
  });

  test("the QueryTab example and the queryDialect row name rabbitmq", () => {
    expect(guide).toContain("| 'mqtt' | 'firestore' | 'rabbitmq';  // Add your type here if needed");
    expect(guide).toContain("\\| 'mqtt' \\| 'firestore' \\| 'rabbitmq' \\| 'kubectl' \\| undefined`");
  });

  test("the providers index line names rabbitmq after firestore", () => {
    const line = guide
      .split("\n")
      .find((candidate) => candidate.startsWith("**[docs/providers/](./providers/README.md)**"));
    expect(line).toContain("· firestore · rabbitmq ·");
  });

  test("the driver-free ids count rabbitmq", () => {
    expect(guide).toContain("nineteen shipped ids do:");
    expect(guide).toContain("`databend`, `kubernetes`, `bigquery`, `firestore` and `rabbitmq`");
  });
});
