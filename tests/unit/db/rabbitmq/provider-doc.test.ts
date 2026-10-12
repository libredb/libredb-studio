/**
 * `docs/providers/rabbitmq.md` quotes numbers and sentences the code owns (issue #1656).
 *
 * A value copied into prose is true only until the constant moves, and nothing else goes red when it stops being
 * true (the reasoning of `tests/unit/db/kafka/provider-doc.test.ts`, whose shape this file follows). So every named
 * constant of `limits.ts` is read back from the doc's limits table, both ways; each sampled-count sentence of the tree
 * is read back from the builder that writes it; the error sentences the doc prints are the ones `errors.ts` writes;
 * the dialog's labels and its guest warning are the declarations' own; the silent-removal statement and the memory
 * statement are printed whole; and the seed table is the one `tests/live/rabbitmq-seed.ts` seeds.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { connectionFieldLabel, DB_UI_CONFIG } from "@/lib/db-ui-config";
import type { CredentialWarning } from "@/lib/db/credential-warnings";
import {
  AMQP_PORT_REQUIRED,
  exchangesSampledFrom,
  notAStream,
  PLAINTEXT_REFUSAL,
  queuesSampledFrom,
  READ_SLOTS_FULL,
  streamsSampledFrom,
  tlsCertificateUntrusted,
  tlsClientCertificateRefused,
  TUNNEL_REFUSED,
  versionTooOld,
  vhostOrProxyNotFound,
  vhostUnavailableSentence,
} from "@/lib/db/providers/stream/rabbitmq/errors";
import * as limits from "@/lib/db/providers/stream/rabbitmq/limits";
import { renderSeedTable } from "../../../live/rabbitmq-seed";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const DOC = readFileSync(path.join(ROOT, "docs/providers/rabbitmq.md"), "utf8");
const LINES = DOC.split("\n");

/** The table row whose first cell is exactly `cell`, or undefined. */
const rowOf = (cell: string): string | undefined => LINES.find((line) => line.startsWith(`| ${cell} |`));

/** A constant as the doc prints it: numbers with thousands separators (a port without), strings quoted, limiter options spelled out. */
function printed(name: string, value: unknown): string {
  if (typeof value === "number") return name.endsWith("_PORT") ? String(value) : value.toLocaleString("en-US");
  if (typeof value === "string") return `"${value}"`;
  const options = value as { perProvider: number; perEngine: number; queueDepth: number };
  return `perProvider ${options.perProvider}, perEngine ${options.perEngine}, queueDepth ${options.queueDepth}`;
}

/** The constants the limits table prints: every RABBITMQ_ export but the limiter keys, the clock and the deadline factory. */
const CONSTANTS = Object.entries(limits).filter(
  ([name, value]) => name.startsWith("RABBITMQ_") && !name.endsWith("_LIMITER_KEY") && typeof value !== "function",
);

/** The builder's sentence with its sample number turned back into the doc's placeholder. */
const placeholder = (sentence: string, sample: number, name: string): string =>
  sentence.replace(sample.toLocaleString("en-US"), `{${name}}`).replace(String(sample), `{${name}}`);

describe("the readers find what exists and nothing that does not", () => {
  test("rowOf", () => {
    expect(rowOf("`RABBITMQ_READ_MAX_ROWS`")).toBeDefined();
    expect(rowOf("`RABBITMQ_NO_SUCH_CONSTANT`")).toBeUndefined();
    expect(CONSTANTS.length).toBeGreaterThan(30);
  });
});

describe("the limits table is the code's", () => {
  test.each(CONSTANTS)("%s is printed with its value", (name, value) => {
    expect(rowOf(`\`${name}\``)).toContain(`| ${printed(name, value)} |`);
  });

  test("every constant the table names exists", () => {
    const table = LINES.slice(LINES.indexOf("## 10. Limits"), LINES.indexOf("## 11. Error handling"));
    const named = table.flatMap((line) => /^\| `(RABBITMQ_[A-Z0-9_]+)` \|/.exec(line)?.[1] ?? []);
    expect(named.sort()).toEqual(CONSTANTS.map(([name]) => name).sort());
  });
});

describe("the tree's sampled-count sentences are the builders'", () => {
  test("a full Streams folder, and one whose page other queue types share", () => {
    expect(rowOf("Streams, full")).toContain(
      `| ${placeholder(streamsSampledFrom(987_654, 500), 987_654, "filtered_count")} |`,
    );
    const shared = placeholder(placeholder(streamsSampledFrom(987_654, 321), 987_654, "filtered_count"), 321, "held");
    expect(rowOf("Streams, full, fewer than 500 held")).toContain(`| ${shared} |`);
  });

  test("Queues above 500, without and with a complete Streams folder", () => {
    expect(rowOf("Queues, above 500")).toContain(
      `| ${placeholder(queuesSampledFrom(987_654, null), 987_654, "filtered_count")} |`,
    );
    const both = placeholder(
      placeholder(queuesSampledFrom(987_654, 123_456), 987_654, "filtered_count"),
      123_456,
      "approximate",
    );
    expect(rowOf("Queues, above 500, Streams complete")).toContain(`| ${both} |`);
  });

  test("Exchanges above 500", () => {
    expect(rowOf("Exchanges, above 500")).toContain(
      `| ${placeholder(exchangesSampledFrom(987_654), 987_654, "filtered_count")} |`,
    );
  });
});

describe("the error table prints the sentences errors.ts writes", () => {
  test("the fixed sentences", () => {
    for (const sentence of [PLAINTEXT_REFUSAL, TUNNEL_REFUSED, AMQP_PORT_REQUIRED, READ_SLOTS_FULL]) {
      expect(DOC).toContain(`| ${sentence} |`);
    }
  });

  test("the sentences with a name, a type or a version", () => {
    expect(DOC).toContain(`| ${vhostUnavailableSentence("SAMPLE").replace('"SAMPLE"', "{vhost}")} |`);
    expect(DOC).toContain(
      `| ${notAStream("SAMPLE", "classic").message.replace('"SAMPLE"', "{name}").replace("classic", "{type}")} |`,
    );
    expect(DOC).toContain(`| ${versionTooOld("9.8.7").message.replace("9.8.7", "{version}")} |`);
    expect(DOC).toContain(`| ${vhostOrProxyNotFound("SAMPLE").message.replace('"SAMPLE"', "{vhost}")} |`);
  });

  test("the two TLS sentences beside the plain listener's, on both endpoints", () => {
    expect(DOC).toContain(`| ${tlsCertificateUntrusted("{host}:{port}").message} |`);
    expect(DOC).toContain(`| ${tlsClientCertificateRefused("{host}:{port}").message} |`);
  });
});

describe("the dialog's words are the declarations'", () => {
  const RABBITMQ = DB_UI_CONFIG.rabbitmq;

  test("each field label of the fields table", () => {
    for (const [field, fallback] of [
      ["amqpPort", ""],
      ["apiPath", ""],
      ["allowInsecureAuth", ""],
    ] as const) {
      expect(DOC).toContain(`| \`${field}\` | ${connectionFieldLabel(RABBITMQ, field, fallback)} |`);
    }
  });

  test("the guest warning the dialog shows is the one the seed section states", () => {
    const pair = (RABBITMQ.credentialWarnings ?? []).find((warning: CredentialWarning) => warning.kind === "pair");
    expect(pair?.message).toBeDefined();
    expect(DOC).toContain(pair?.message as string);
  });
});

describe("statements the provider makes, printed whole", () => {
  test("the silent removal of values AMQP 0-9-1 cannot hold", () => {
    expect(DOC).toContain(
      "On RabbitMQ 4.3.7 and later, values that AMQP 0-9-1 cannot represent are removed by the broker before Studio sees the message, for example uuid, char, decimal and described values in application properties and annotations at any depth, map entries whose key is not a string of at most 255 bytes, and a content type or encoding over 255 bytes. On every version, NaN and infinite floating-point values are removed. A header published over AMQP 0-9-1 whose value is a table or an array, and whose name does not start with x-, is not stored by a stream. Nothing in the message says a value was removed, and a nested map or list can arrive empty. Studio shows the message as the broker delivered it. To see those values, read the stream over AMQP 1.0 or the stream protocol.",
    );
  });

  test("the read request's keys, each written once", () => {
    expect(DOC).toContain(
      "One JSON object with the keys `vhost`, `stream`, `from` and `limit`, and no other, each written once:\n",
    );
  });

  test("the routing key column names the stream for a message stored without a routing key, as the row does", () => {
    expect(rowOf("4")).toBe(
      "| 4 | `routing_key` | string | The publisher's first routing key; the stream name for a message stored without one, as an AMQP 1.0 publish to the queue address is |",
    );
  });

  test("the transfer cap's warning, with the message's offset and before it is known", () => {
    expect(DOC).toContain(
      "One read transfers at most 64 MiB; a message larger than that cannot be shown.\nThe warning names the offset to read from to continue past it, or, when the cap is reached before the message's offset arrives, says that Studio cannot name it.",
    );
  });

  test("the memory bound of a read", () => {
    expect(DOC).toContain(
      "Body bytes are kept up to 262,144 per message and 8 MiB per result; a larger body is kept as a prefix and the rest is discarded frame by frame without buffering. Peak RSS stays under the process baseline plus 3 times the result budget plus a fixed allowance that does not grow with the bytes discarded.",
    );
  });

  test("the queue check's plugin, and that reads do not need it", () => {
    expect(DOC).toContain(
      "Studio checks for readable classic or quorum queues only when the broker has the rabbitmq_stream_management plugin; without it, check the read pattern by hand.\nStream reads do not need the plugin.",
    );
  });
});

describe("the seed table is the seed's", () => {
  test("the rows between the markers equal what the seed creates", () => {
    const start = DOC.indexOf("<!-- seed-table:start -->\n") + "<!-- seed-table:start -->\n".length;
    const end = DOC.indexOf("<!-- seed-table:end -->");
    expect(DOC.slice(start, end).trim()).toBe(renderSeedTable());
  });
});
