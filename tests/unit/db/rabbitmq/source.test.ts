/**
 * The detail documents: a queue's, a stream's and an exchange's labelled JSON parts, the fields dropped from every
 * part, the "Messages" statement, the "Access" statement from one tracking GET, the exchange's two bindings GETs one
 * after the other, and the permissions sentence on a part the account may not read.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { isSourcePartStatement, isSourcePartUnavailable } from "@/lib/db/object-kinds";
import type { ObjectSourceDocument, ObjectSourcePart } from "@/lib/db/types";
import { readConnectionOptions } from "@/lib/db/providers/stream/rabbitmq/connection-options";
import { quoteName } from "@/lib/db/providers/stream/rabbitmq/errors";
import { RabbitMQProvider } from "@/lib/db/providers/stream/rabbitmq/index";
import {
  createManagementClient,
  rabbitmqBindingsLimiter,
  rabbitmqManagementLimiter,
} from "@/lib/db/providers/stream/rabbitmq/management/client";
import { readSource } from "@/lib/db/providers/stream/rabbitmq/source";
import { createTrackingProbe } from "@/lib/db/providers/stream/rabbitmq/tracking-probe";
import { rabbitmqConnection } from "../../../helpers/rabbitmq-connection";
import {
  createManagementStub,
  hangUntilAbort,
  jsonOk,
  type ManagementStub,
  manualDeadlines,
  SAMPLE_BODIES,
  SAMPLE_NODE,
  type StubAnswer,
} from "../../../helpers/rabbitmq-management-stub";

const CAPABILITIES = new RabbitMQProvider(rabbitmqConnection()).getCapabilities();
const NOW = Date.UTC(2026, 9, 12, 9, 30, 0);

function readers() {
  const stub = createManagementStub();
  const deadlines = manualDeadlines();
  const client = createManagementClient({
    endpoint: readConnectionOptions(rabbitmqConnection()).management,
    transport: stub.factory,
    deadlineSignal: deadlines.factory,
    queryTimeoutMs: 60_000,
    lifetime: new AbortController().signal,
    limiters: { management: rabbitmqManagementLimiter(), bindings: rabbitmqBindingsLimiter() },
  });
  return {
    stub,
    deadlines,
    readers: { client, tracking: createTrackingProbe(client), capabilities: CAPABILITIES, now: () => NOW },
  };
}

/** The answers of a queue detail in vhost "/" named `name`. */
function answerQueue(
  stub: ManagementStub,
  name: string,
  detail: unknown,
  extras: { extensions?: StubAnswer; tracking?: StubAnswer } = {},
) {
  const encoded = encodeURIComponent(name);
  stub.answer(`GET /api/queues/%2F/${encoded}`, jsonOk(detail));
  stub.answer(`GET /api/queues/%2F/${encoded}/bindings`, jsonOk(SAMPLE_BODIES["queue-bindings"]));
  stub.answer("GET /api/policies/%2F", jsonOk(SAMPLE_BODIES.policies));
  stub.answer("GET /api/operator-policies/%2F", jsonOk([]));
  stub.answer("GET /api/extensions", extras.extensions ?? jsonOk(SAMPLE_BODIES.extensions));
  stub.answer(`GET /api/stream/%2F/${encoded}/tracking`, extras.tracking ?? { status: 503, body: "{}" });
}

const textOf = (part: ObjectSourcePart) => ("text" in part ? JSON.parse(part.text) : undefined);
const byId = (document: ObjectSourceDocument, id: string) => document.parts.find((p) => p.id === id);

describe("a queue's detail", () => {
  test("Queue, Counts, Bindings, Consumers, the Messages statement and the Access statement, in that order", async () => {
    const { stub, readers: r } = readers();
    answerQueue(stub, "payments", SAMPLE_BODIES.queue);
    const document = await readSource(r, ["/", "payments"], "queue");
    expect(document.parts.map((p) => [p.id, p.label])).toEqual([
      ["queue", "Queue"],
      ["counts", "Counts (sampled at 2026-10-12T09:30:00.000Z)"],
      ["bindings", "Bindings"],
      ["consumers", "Consumers"],
      ["messages", "Messages"],
      ["access", "Access"],
    ]);
    const queue = textOf(document.parts[0]);
    expect(queue).toEqual({
      type: "quorum",
      durable: true,
      auto_delete: false,
      exclusive: false,
      arguments: { "x-queue-type": "quorum", "x-dead-letter-exchange": "dlx" },
      policy: {
        name: "pol-maxlen",
        pattern: "^q-",
        apply_to: "queues",
        definition: { "max-length": 10000 },
        priority: 1,
      },
      operator_policy: null,
      effective_policy_definition: { "max-length": 10000 },
      delivery_limit: 20,
      dead_letter_exchange: "dlx",
      dead_letter_routing_key: null,
      state: "running",
      node: SAMPLE_NODE,
      leader: SAMPLE_NODE,
      members: [SAMPLE_NODE],
      online: [SAMPLE_NODE],
    });
    expect(textOf(document.parts[1])).toEqual({
      messages: 3,
      messages_ready: 3,
      messages_unacknowledged: 0,
      consumers: 1,
      note: "The broker samples these counts; they can lag by up to about 10 seconds.",
    });
    expect(textOf(document.parts[3])).toEqual({
      count: 1,
      consumers: [
        {
          exclusive: false,
          ack_required: true,
          prefetch_count: 10,
          active: true,
          activity_status: "up",
          consumer_timeout: 1800000,
        },
      ],
    });
    const messages = document.parts[4];
    expect(isSourcePartStatement(messages)).toBe(true);
    expect(isSourcePartUnavailable(messages) && messages.unavailable).toBe(
      "RabbitMQ cannot show a queue's messages without taking them, so Studio does not read classic or quorum queues.",
    );
    const access = document.parts[5];
    expect(isSourcePartStatement(access) && access.unavailable).toBe(
      'This account can read classic or quorum queue "payments" in virtual host "/": a client using it could take its messages. Studio never does; narrow the read permission to stream names.',
    );
  });

  test("keeps none of the dropped fields: consumer tags, channels, peers, owners, deliveries, the last actor", async () => {
    const { stub, readers: r } = readers();
    answerQueue(stub, "payments", SAMPLE_BODIES.queue);
    const text = JSON.stringify(await readSource(r, ["/", "payments"], "queue"));
    for (const dropped of [
      "ctag-marker",
      "consumer-argument-marker",
      "10.0.0.9",
      "other-user",
      "owner-marker",
      "admin-marker",
      "open_files",
      "deliveries",
      "incoming",
      "channel_details",
    ])
      expect(text).not.toContain(dropped);
  });

  test("a 401 tracking answer adds no Access part, and the plugin list is read once per probe", async () => {
    const { stub, readers: r } = readers();
    answerQueue(stub, "payments", SAMPLE_BODIES.queue, { tracking: { status: 401, body: "{}" } });
    expect(byId(await readSource(r, ["/", "payments"], "queue"), "access")).toBeUndefined();
    await readSource(r, ["/", "payments"], "queue");
    expect(stub.keys().filter((k) => k === "GET /api/extensions")).toHaveLength(1);
    expect(stub.keys().filter((k) => k.endsWith("/tracking"))).toHaveLength(2);
  });

  test("an unchecked tracking status, 404 or 500, adds no Access part and is not held", async () => {
    const { stub, readers: r } = readers();
    for (const status of [404, 500]) {
      answerQueue(stub, "payments", SAMPLE_BODIES.queue, { tracking: { status, body: "{}" } });
      // oxlint-disable-next-line no-await-in-loop -- one status at a time: the second answer replaces the first on one stub.
      expect(byId(await readSource(r, ["/", "payments"], "queue"), "access")).toBeUndefined();
    }
    expect(stub.keys().filter((k) => k.endsWith("/tracking"))).toHaveLength(2);
  });

  test("without the plugin there is no tracking GET and no Access part", async () => {
    const { stub, readers: r } = readers();
    answerQueue(stub, "payments", SAMPLE_BODIES.queue, { extensions: jsonOk([{ javascript: "dispatcher.js" }]) });
    const document = await readSource(r, ["/", "payments"], "queue");
    expect(byId(document, "access")).toBeUndefined();
    expect(stub.keys().some((k) => k.endsWith("/tracking"))).toBe(false);
  });

  test("a name holding '; ' and a sentence, and one holding U+202E, are quoted and escaped in the Access statement", async () => {
    const rlo = String.fromCodePoint(0x202e);
    for (const name of ["a; Studio says all is well", `evil${rlo}gnp.exe`]) {
      const { stub, readers: r } = readers();
      answerQueue(stub, name, SAMPLE_BODIES.queue);
      // oxlint-disable-next-line no-await-in-loop -- one name at a time, so a failure names its own name.
      const access = byId(await readSource(r, ["/", name], "queue"), "access");
      const sentence = access !== undefined && isSourcePartStatement(access) ? access.unavailable : "";
      expect(sentence).toContain(`quorum queue ${quoteName(name)} in virtual host`);
      expect(quoteName(name).startsWith('"')).toBe(true);
      expect(sentence).not.toContain(rlo);
    }
  });

  test("bindings the account may not read carry the permissions sentence; the rest of the detail is shown", async () => {
    const { stub, readers: r } = readers();
    answerQueue(stub, "payments", SAMPLE_BODIES.queue);
    stub.answer("GET /api/queues/%2F/payments/bindings", { status: 401, body: "{}" });
    stub.answer("GET /api/policies/%2F", { status: 401, body: "{}" });
    const document = await readSource(r, ["/", "payments"], "queue");
    expect(byId(document, "bindings")).toEqual({
      id: "bindings",
      label: "Bindings",
      unavailable: 'This user has no permissions on virtual host "/": grant them to show its queues and exchanges.',
    });
    expect(textOf(document.parts[0]).policy).toBe("pol-maxlen");
  });

  test("bindings cut at 1,000 rows say how many were not kept", async () => {
    const { stub, readers: r } = readers();
    answerQueue(stub, "payments", SAMPLE_BODIES.queue);
    const rows = Array.from({ length: 1_200 }, (_, i) => ({
      source: "ex",
      destination: "payments",
      destination_type: "queue",
      routing_key: `k${i}`,
      arguments: {},
    }));
    stub.answer("GET /api/queues/%2F/payments/bindings", jsonOk(rows));
    const bindings = textOf(byId(await readSource(r, ["/", "payments"], "queue"), "bindings") as ObjectSourcePart);
    expect(bindings.bindings).toHaveLength(1_000);
    expect(bindings.not_kept).toBe(200);
  });

  test("a missing queue fails the detail with the refresh sentence", async () => {
    const { stub, readers: r } = readers();
    answerQueue(stub, "gone", SAMPLE_BODIES.queue);
    stub.answer("GET /api/queues/%2F/gone", jsonOk({ error: "Object Not Found", reason: "Not Found" }, 404));
    await expect(readSource(r, ["/", "gone"], "queue")).rejects.toThrow(
      'Virtual host "/" has no queue, stream or exchange "gone", or the virtual host does not exist: refresh the tree.',
    );
  });

  test("the caller's character bound cuts a part and marks it", async () => {
    const { stub, readers: r } = readers();
    answerQueue(stub, "payments", SAMPLE_BODIES.queue);
    const document = await readSource(r, ["/", "payments"], "queue", 40);
    const queue = document.parts[0];
    expect("text" in queue && queue.text.length).toBe(40);
    expect("truncated" in queue && queue.truncated?.limit).toBe(40);
  });
});

describe("a stream's detail", () => {
  test("Stream, Counts with the stream's note, Bindings and Consumers; no Messages, no Access, no tracking GET", async () => {
    const { stub, readers: r } = readers();
    answerQueue(stub, "st-orders", {
      ...SAMPLE_BODIES.queue,
      type: "stream",
      arguments: { "x-queue-type": "stream", "x-max-age": "7D", "x-max-length-bytes": 1_000_000 },
      readers: { [SAMPLE_NODE]: 0 },
    });
    const document = await readSource(r, ["/", "st-orders"], "stream");
    expect(document.parts.map((p) => p.label)).toEqual([
      "Stream",
      "Counts (sampled at 2026-10-12T09:30:00.000Z)",
      "Bindings",
      "Consumers",
    ]);
    expect(textOf(document.parts[0]).arguments).toEqual({
      "x-queue-type": "stream",
      "x-max-age": "7D",
      "x-max-length-bytes": 1_000_000,
    });
    expect(textOf(document.parts[1]).note).toBe(
      "A stream's message count is sampled every 5 seconds and can include compressed batches that no AMQP reader receives.",
    );
    expect(stub.keys().some((k) => k.endsWith("/tracking") || k === "GET /api/extensions")).toBe(false);
  });
});

describe("an exchange's detail", () => {
  test("the destination bindings GET starts only after the source bindings GET ended", async () => {
    const { stub, deadlines, readers: r } = readers();
    stub.answer("GET /api/exchanges/%2F/ex-topic", jsonOk(SAMPLE_BODIES.exchange));
    let sourceStarted = false;
    stub.answer(
      "GET /api/exchanges/%2F/ex-topic/bindings/source",
      hangUntilAbort(() => {
        sourceStarted = true;
      }),
    );
    stub.answer("GET /api/exchanges/%2F/ex-topic/bindings/destination", jsonOk([]));
    const pending = readSource(r, ["/", "ex-topic"], "exchange").catch((error: unknown) => error);
    await Bun.sleep(0);
    expect(sourceStarted).toBe(true);
    expect(stub.keys().some((k) => k.endsWith("/destination"))).toBe(false);
    deadlines.fire(1);
    expect(await pending).toBeInstanceOf(Error);
  });

  test("Exchange and both bindings parts; a super stream's partitions in their order", async () => {
    const { stub, readers: r } = readers();
    stub.answer(
      "GET /api/exchanges/%2F/st-invoices",
      jsonOk({ ...SAMPLE_BODIES.exchange, name: "st-invoices", type: "direct", arguments: { "x-super-stream": true } }),
    );
    stub.answer(
      "GET /api/exchanges/%2F/st-invoices/bindings/source",
      jsonOk(SAMPLE_BODIES["exchange-bindings-source"]),
    );
    stub.answer(
      "GET /api/exchanges/%2F/st-invoices/bindings/destination",
      jsonOk(SAMPLE_BODIES["exchange-bindings-destination"]),
    );
    const document = await readSource(r, ["/", "st-invoices"], "exchange");
    expect(document.parts.map((p) => [p.id, p.label])).toEqual([
      ["exchange", "Exchange"],
      ["bindings-source", "Bindings (as source)"],
      ["bindings-destination", "Bindings (as destination)"],
      ["partitions", "Super stream partitions"],
    ]);
    expect(textOf(document.parts[3])).toEqual([
      { order: 0, stream: "st-invoices-0", routing_key: "0" },
      { order: 1, stream: "st-invoices-1", routing_key: "1" },
    ]);
    expect(JSON.stringify(document)).not.toContain("admin-marker");
  });

  test("the default exchange is read as amq.default", async () => {
    const { stub, readers: r } = readers();
    stub.answer("GET /api/exchanges/%2F/amq.default", jsonOk({ ...SAMPLE_BODIES.exchange, name: "", type: "direct" }));
    stub.answer("GET /api/exchanges/%2F/amq.default/bindings/source", jsonOk([]));
    stub.answer("GET /api/exchanges/%2F/amq.default/bindings/destination", jsonOk([]));
    const document = await readSource(r, ["/", ""], "exchange");
    expect(document.path).toEqual(["/", ""]);
    expect(stub.unanswered).toEqual([]);
  });
});

describe("refusals before any GET", () => {
  test("an undeclared kind and a path of another shape", async () => {
    const { stub, readers: r } = readers();
    await expect(readSource(r, ["/", "x"], "binding")).rejects.toThrow('RabbitMQ declares no object kind "binding".');
    await expect(readSource(r, ["x"], "queue")).rejects.toBeInstanceOf(QueryError);
    expect(stub.requests).toHaveLength(0);
  });
});
