/**
 * `docs/providers/kafka.md` and `docs/SECURITY.md` quote numbers and sentences the code owns (issue #1088).
 *
 * A value copied into prose is true only until the constant moves, and nothing else goes red when it
 * stops being true (the reasoning of `tests/unit/provider-docs-monitoring-citations.test.ts` and of
 * `tests/unit/db/prometheus/provider-doc.test.ts`, whose shape this file follows). So every bound the
 * provider doc quotes is read back against its constant, the dialog strings against what `DB_UI_CONFIG`
 * declares, the labels and empty states against the provider's own `getLabels()`, the refusals and the
 * size label against the modules that write them, the nullable topic columns against their declaration,
 * and the absent cancellation against the presence the routes detect.
 *
 * `docs/SECURITY.md` states, in its limitation on where a `user` may connect, that a Kafka broker's
 * metadata chooses further hosts, that a Kafka connection refuses an SSH tunnel for that reason, and the
 * client's unbounded decompression; each sentence is pinned inside that one bullet, so moving it out of
 * the limitation it widens fails too.
 *
 * Three quoted values live in the adapter, `platformatic-client.ts` (the internal-topic refusal, the
 * never-joined group id and the fetch wait), which only its own tests, the TLS handshake tests and the
 * integration test may import (the seam guard); this file reads that source as text instead.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { connectionFieldHint, connectionFieldLabel, DB_UI_CONFIG } from "@/lib/db-ui-config";
import { KafkaProvider } from "@/lib/db/providers/stream/kafka";
import { KAFKA_DEFAULT_PORT, kafkaConnectionOptions } from "@/lib/db/providers/stream/kafka/connection-options";
import { overviewFrom } from "@/lib/db/providers/stream/kafka/monitoring";
import { KAFKA_TOPIC_COLUMNS, KAFKA_TOPIC_LIST_CAP } from "@/lib/db/providers/stream/kafka/objects";
import { KAFKA_CELL_LIMIT, KAFKA_RESULT_BYTE_BUDGET } from "@/lib/db/providers/stream/kafka/read";
import { parseReadRequest } from "@/lib/db/providers/stream/kafka/request";
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

  test("the SCRAM work a broker chooses is stated as accepted, beside the decompression", () => {
    expect(limitation).toContain(
      "The Kafka client's SCRAM exchange runs PBKDF2 over the password as many times as the broker's first SCRAM answer asks, checking only the lower bound, while Apache Kafka 4.3.1 stores no credential above 16,384 iterations",
    );
  });

  test("the re-authentication a broker's session lifetime drives is stated as accepted, beside the SCRAM work", () => {
    expect(limitation).toContain(
      "A broker that answers a SASL authentication with a session lifetime (KIP-368) has the Kafka client authenticate again at 80% of it, for as long as the connection is open and with no floor",
    );
  });
});

describe("docs/providers/kafka.md states the client's exposures to a hostile broker", () => {
  test("the SCRAM work, with its measured cost, and why the provider does not bound it", () => {
    const section = DOC.slice(DOC.indexOf("### 4.2 "), DOC.indexOf("### 4.3 "));
    expect(section).toContain("**Accepted limitation: the broker chooses how much work a SCRAM exchange takes.**");
    expect(section).toContain("the client checks only the lower bound, 4,096");
    expect(section).toContain("Apache Kafka 4.3.1 stores no SCRAM credential above 16,384 iterations");
    expect(section).toContain(
      "a cap on the iteration count is requested upstream as a draft recorded in `docs/BACKLOG.md`",
    );
    expect(bulletOf(DOC, "**The broker chooses how much work a SCRAM exchange takes**")).toContain(
      "[§4.2](#42-authentication-and-never-in-the-clear-k3)",
    );
  });

  test("the re-authentication loop a session lifetime drives, with its measured cost, and why the provider does not bound it", () => {
    const section = DOC.slice(DOC.indexOf("### 4.2 "), DOC.indexOf("### 4.3 "));
    expect(section).toContain(
      "**Accepted limitation: the broker chooses how often a connection authenticates again.**",
    );
    expect(section).toContain("has the client authenticate again at 80% of it, and again after each time");
    expect(section).toContain(
      "a floor on the session lifetime the client honours is requested upstream as a draft recorded in `docs/BACKLOG.md`",
    );
    expect(bulletOf(DOC, "**The broker chooses how often a connection authenticates again**")).toContain(
      "[§4.2](#42-authentication-and-never-in-the-clear-k3)",
    );
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

  test("the glosses beside the byte budget and the cell limit are the constants' own units", () => {
    expect(rowOf("`KAFKA_RESULT_BYTE_BUDGET`")).toContain(`Bytes (${KAFKA_RESULT_BYTE_BUDGET / (1024 * 1024)} MiB)`);
    expect(rowOf("`KAFKA_CELL_LIMIT`")).toContain(`Characters (${KAFKA_CELL_LIMIT / 1024} Ki)`);
  });

  test("the default limit is the one a request without a limit takes", () => {
    const limit = parseReadRequest('{"topic":"orders"}', DEFAULT_QUERY_LIMIT).limit;
    expect(rowOf("`DEFAULT_QUERY_LIMIT`")).toContain(`; the default is ${limit} |`);
  });

  test("the fetch wait is the adapter's", () => {
    // The adapter is read as text (see the docblock); the declaration is matched whole, so a
    // renamed or recomputed constant fails here instead of reading back nothing.
    const wait = /^const KAFKA_FETCH_MAX_WAIT_MS = (\d+);$/m.exec(ADAPTER)?.[1];
    expect(wait).toBeDefined();
    expect(DOC).toContain(`A fetch waits at most ${wait} ms on the broker for new records`);
  });

  test("the default port is the dialog's and the provider's", () => {
    const quoted = /^\| \*\*Default port\*\* \| `(\d+)`/m.exec(DOC)?.[1];
    expect(quoted).toBeDefined();
    expect(quoted).toBe(DB_UI_CONFIG.kafka.defaultPort);
    expect(quoted).toBe(String(new KafkaProvider(KAFKA).getCapabilities().defaultPort));
    expect(quoted).toBe(String(KAFKA_DEFAULT_PORT));
    expect(rowOf("`port`")).toContain(`Default \`${quoted}\``);
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

  test("the refusal of a client library the installation cannot load is the one connect() raises", async () => {
    // The resolution failure section 2.5 describes, which this repository's own install never meets.
    const unresolved = Object.assign(new Error("Cannot find module 'ajv/dist/core'"), { code: "MODULE_NOT_FOUND" });
    const provider = new KafkaProvider({ ...KAFKA, user: undefined, password: undefined }, {}, async () => {
      throw unresolved;
    });
    let message = "";
    try {
      await provider.connect();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toStartWith('The Kafka client library could not be loaded: the module "ajv/dist/core"');
    expect(DOC).toContain(`\`${message}\``);
    // The section the refusal sends a reader to is the one that states what a host needs.
    expect(message).toEndWith("See docs/providers/kafka.md section 2.5");
    expect(DOC).toContain("\n### 2.5 The client, and why\n");
  });

  test("the size label is the one the overview writes", () => {
    const size = overviewFrom({ topicCount: 0, brokerConfigs: [], logDirs: [] }).databaseSize;
    const label = size.replace(/^\S+ \S+ /, "");
    expect(label).toBe("on disk, all replicas, internal topics excluded");
    expect(DOC).toContain(`"${label}"`);
  });

  test("the nullable topic columns the doc names are the ones the topic declares", () => {
    const nullable = KAFKA_TOPIC_COLUMNS.filter((c) => c.nullable).map((c) => `\`${c.name}\``);
    expect(nullable.length).toBeGreaterThan(1);
    // Matched from the start of its line, so a list that lost its first name cannot match a tail of it.
    expect(DOC).toContain(
      `\n${nullable.slice(0, -1).join(", ")} and ${nullable[nullable.length - 1]} are declared nullable`,
    );
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

  test("the internal topics the doc names are the ones the adapter refuses by name", () => {
    // Matched whole, so a renamed or recomputed set fails here instead of reading back nothing.
    const declared = /^const INTERNAL_TOPICS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\);$/m.exec(ADAPTER)?.[1];
    expect(declared).toBeDefined();
    const names = [...(declared ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(names).toEqual(["__consumer_offsets", "__transaction_state", "__share_group_state"]);
    expect(DOC).toContain(`- Internal topics (${names.map((name) => `\`${name}\``).join(", ")}, the set`);
    // The listing leaves the set out by name, not by the broker's mark alone (a broker before 3.9 marks
    // no __share_group_state), which the adapter's own tests pin and the doc says in that bullet.
    expect(bulletOf(DOC, "Internal topics")).toContain(
      "The listing leaves them out by name, even where the broker lists one as an ordinary topic",
    );
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
    expect(DB_UI_CONFIG.kafka.showSshTunnel).toBe(false);
    expect(DB_UI_CONFIG.kafka.showConnectionStringToggle).toBe(false);
    expect(new KafkaProvider(KAFKA).getCapabilities().supportsConnectionString).toBe(false);
    expect(DOC).toContain("| **SSH tunnel** | Refused");
    expect(DOC).toContain("| **Connection string** | Not supported");
  });
});
