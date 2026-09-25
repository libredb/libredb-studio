/**
 * `docs/providers/kafka.md` and `docs/SECURITY.md` quote numbers and sentences the code owns (issue #1088).
 *
 * A value copied into prose is true only until the constant moves, and nothing else goes red when it
 * stops being true (the reasoning of `tests/unit/provider-docs-monitoring-citations.test.ts` and of
 * `tests/unit/db/prometheus/provider-doc.test.ts`, whose shape this file follows). So every bound the
 * provider doc quotes is read back against its constant, the dialog strings against what `DB_UI_CONFIG`
 * declares, the labels and empty states against the provider's own `getLabels()`, the refusals and the
 * size label against the modules that write them, and the absent cancellation against the presence the
 * routes detect.
 *
 * `docs/SECURITY.md` states, in its limitation on where a `user` may connect, that a Kafka broker's
 * metadata chooses further hosts, that a Kafka connection refuses an SSH tunnel for that reason, and the
 * client's unbounded decompression; each sentence is pinned inside that one bullet, so moving it out of
 * the limitation it widens fails too.
 *
 * Two sentences live in the adapter, `platformatic-client.ts`, which only its own tests, the TLS handshake
 * tests and the integration test may import (the seam guard); this file reads that source as text instead.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { connectionFieldHint, connectionFieldLabel, DB_UI_CONFIG } from "@/lib/db-ui-config";
import { KafkaProvider } from "@/lib/db/providers/stream/kafka";
import { KAFKA_DEFAULT_PORT, kafkaConnectionOptions } from "@/lib/db/providers/stream/kafka/connection-options";
import { overviewFrom } from "@/lib/db/providers/stream/kafka/monitoring";
import { KAFKA_TOPIC_LIST_CAP } from "@/lib/db/providers/stream/kafka/objects";
import { KAFKA_CELL_LIMIT, KAFKA_RESULT_BYTE_BUDGET } from "@/lib/db/providers/stream/kafka/read";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import type { DatabaseConnection } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../../helpers/census-connection";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
const DOC = read("docs/providers/kafka.md");
const LINES = DOC.split("\n");
const SECURITY = read("docs/SECURITY.md");
const ADAPTER = read("src/lib/db/providers/stream/kafka/platformatic-client.ts");
const OBJECTS = read("src/lib/db/providers/stream/kafka/objects.ts");

/** The table row whose first cell is exactly `cell`, or undefined. */
const rowOf = (cell: string): string | undefined => LINES.find((line) => line.startsWith(`| ${cell} |`));

/** The bullet of `text` that starts with `head`, up to the next top-level bullet or heading, or undefined. */
function bulletOf(text: string, head: string): string | undefined {
  const start = text.indexOf(`\n- ${head}`);
  if (start < 0) return undefined;
  const rest = text.slice(start + 1);
  const end = rest.search(/\n(- |#)/);
  return end < 0 ? rest : rest.slice(0, end);
}

const KAFKA: DatabaseConnection = CENSUS_CONNECTION.kafka;

describe("the readers find what exists and nothing that does not", () => {
  test("rowOf and bulletOf", () => {
    // Control for every containment check below: a reader that matched nothing would fail them
    // loudly, but one that matched everything, or ran past its own bullet, would pass them all.
    expect(rowOf("`KAFKA_CELL_LIMIT`")).toBeDefined();
    expect(rowOf("`KAFKA_NO_SUCH_CONSTANT`")).toBeUndefined();
    const limitation = bulletOf(SECURITY, "**A `user` can connect to any host and port");
    expect(limitation).toBeDefined();
    expect(limitation).not.toContain("Local login credentials are not hashed");
    expect(bulletOf(SECURITY, "**No such limitation")).toBeUndefined();
  });
});

describe("docs/SECURITY.md states the Kafka widening of the any-host limitation", () => {
  const limitation = bulletOf(SECURITY, "**A `user` can connect to any host and port") ?? "";

  test("a Kafka broker's metadata chooses the further hosts, with the connection's credentials (K2)", () => {
    expect(limitation).toContain(
      "A Kafka broker's metadata chooses the further hosts Studio connects to, with the connection's SASL credentials",
    );
    expect(limitation).toContain(
      "Use TLS with verify-full so credentials reach only hosts whose certificate the configured CA vouches for.",
    );
  });

  test("a Kafka connection refuses an SSH tunnel, for the same reason", () => {
    expect(limitation).toContain("A Kafka connection refuses an SSH tunnel");
  });

  test("the client's decompression before any bound is stated as accepted (K5)", () => {
    expect(limitation).toContain("decompresses every batch of a fetch response whole");
    expect(limitation).toContain("about 1,029 to 1 for gzip and 32,692 to 1 for zstd");
  });
});

describe("docs/providers/kafka.md quotes the bounds the code uses", () => {
  test.each([
    ["`KAFKA_RESULT_BYTE_BUDGET`", KAFKA_RESULT_BYTE_BUDGET],
    ["`KAFKA_CELL_LIMIT`", KAFKA_CELL_LIMIT],
    ["`KAFKA_TOPIC_LIST_CAP`", KAFKA_TOPIC_LIST_CAP],
    ["`DEFAULT_QUERY_LIMIT`", DEFAULT_QUERY_LIMIT],
    ["`KAFKA_DEFAULT_PORT`", KAFKA_DEFAULT_PORT],
  ])("the %s row states its value", (cell, value) => {
    expect(rowOf(cell)).toContain(`\`${value}\``);
  });

  test("the default port is the dialog's too", () => {
    expect(String(KAFKA_DEFAULT_PORT)).toBe("9092");
    expect(DOC).toContain("| **Default port** | `9092`");
  });
});

describe("docs/providers/kafka.md quotes the strings the provider writes", () => {
  const labels = new KafkaProvider(KAFKA).getLabels();

  test("the dialog's SASL label and hint are the declared ones", () => {
    expect(DOC).toContain(`Labelled "${connectionFieldLabel(DB_UI_CONFIG.kafka, "saslMechanism", "")}"`);
    expect(DOC).toContain(`with the hint "${connectionFieldHint(DB_UI_CONFIG.kafka, "saslMechanism")}"`);
  });

  test("the labels and empty states are the provider's", () => {
    expect(DOC).toContain(`\`selectAction\` "${labels.selectAction}"`);
    expect(DOC).toContain(`\`generateAction\` "${labels.generateAction}"`);
    expect(DOC).toContain(`"${labels.slowQueriesEmptyState}"`);
    expect(DOC).toContain(`"${labels.sessionsEmptyState}"`);
  });

  test("the SSH tunnel refusal is the one connect() raises", () => {
    let message = "";
    try {
      kafkaConnectionOptions(
        { ...KAFKA, sshTunnel: { enabled: true, host: "b", port: 22, username: "u", authMethod: "password" } },
        1000,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toStartWith("Kafka does not run through an SSH tunnel");
    expect(DOC).toContain(message);
  });

  test("the size label is the one the overview writes", () => {
    const size = overviewFrom({ topicCount: 0, brokerConfigs: [], logDirs: [] }).databaseSize;
    const label = size.replace(/^\S+ \S+ /, "");
    expect(label).toBe("on disk, all replicas, internal topics excluded");
    expect(DOC).toContain(`"${label}"`);
  });

  test("the redacted value and the internal-topic refusal are the modules' own text", () => {
    const redacted = "redacted by the broker";
    expect(OBJECTS).toContain(`"${redacted}"`);
    expect(DOC).toContain(`"${redacted}"`);
    const internal =
      "is internal to Kafka, and the client this provider uses drops internal topics from its metadata, so it is not readable here";
    expect(ADAPTER).toContain(internal);
    expect(DOC).toContain(internal);
  });

  test("the never-joined group id is the adapter's", () => {
    expect(ADAPTER).toContain('export const KAFKA_SENTINEL_GROUP_ID = "libredb-studio-never-joined";');
    expect(DOC).toContain("`libredb-studio-never-joined`");
  });
});

describe("docs/providers/kafka.md says what the provider does not do", () => {
  test("no cancelQuery, which the routes detect by presence", () => {
    expect("cancelQuery" in new KafkaProvider(KAFKA)).toBe(false);
    expect(DOC).toContain("| **Query cancellation** | None");
  });

  test("no SSH tunnel and no connection string, as the dialog declares", () => {
    expect(DOC).toContain("| **SSH tunnel** | Refused");
    expect(DOC).toContain("| **Connection string** | Not supported");
  });
});
