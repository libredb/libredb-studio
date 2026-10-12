/**
 * The RabbitMQ names ADDING_A_PROVIDER carries beyond the provider doc: the DatabaseType lines of its registration
 * example, the QueryTab example and the queryDialect row, which name every member of their unions, the providers index
 * line, and the driver-free ids, since the provider reads the broker with a client of this repository's own; and the
 * backlog entry on the Test Connection prefix, which RabbitMQ's own sentences reach.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const guide = readFileSync(path.join(ROOT, "docs/ADDING_A_PROVIDER.md"), "utf8");
const backlog = readFileSync(path.join(ROOT, "docs/BACKLOG.md"), "utf8");

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

describe("docs/BACKLOG.md", () => {
  test("U114 names RabbitMQ, whose own sentences the dialog attributes to the server", () => {
    const entry = backlog.slice(backlog.indexOf("### U114."), backlog.indexOf("### U115."));
    expect(entry).toContain(
      'RabbitMQ does both: its `connectWarnings()` says that AMQP port is empty, and it is the one provider that implements `testConnectionWarnings()`, so a browse-only RabbitMQ connection reads "Connected. The server reported: AMQP port is empty, ..." with up to three more cautions on the same line.',
    );
  });
});
