/**
 * The backlog entry on the Test Connection prefix, which RabbitMQ's own sentences reach.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const backlog = readFileSync(path.join(ROOT, "docs/BACKLOG.md"), "utf8");

describe("docs/BACKLOG.md", () => {
  test("U114 names RabbitMQ, whose own sentences the dialog attributes to the server", () => {
    const entry = backlog.slice(backlog.indexOf("### U114."), backlog.indexOf("### U115."));
    expect(entry).toContain(
      'RabbitMQ does both: its `connectWarnings()` says that AMQP port is empty, and it is the one provider that implements `testConnectionWarnings()`, so a browse-only RabbitMQ connection reads "Connected. The server reported: AMQP port is empty, ..." with up to three more cautions on the same line.',
    );
  });
});
