/**
 * The agent read's boundary test, from the captures of tests/fixtures/rabbitmq/<version>/agent-boundary/ (each
 * recorded by its run.sh against a fresh digest-pinned broker, as a user tagged management with no configure and no
 * write permission and a read pattern of every name).
 *
 * The positive control: each take and purge the agent's closed table never sends, sent raw by that user past every
 * Studio check, removes messages, so a read permission is no boundary. The boundary: the provider's agent read leaves
 * every queue's message count as it was, answers no marker of a body, header, property or routing key, refuses a
 * classic and a quorum queue at the type check, and, with the type check answered as a stream for a queue declared
 * under a stream's name, is refused by the broker's 406 with nothing lost.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { notAStream } from "@/lib/db/providers/stream/rabbitmq/errors";

type Counts = Readonly<Record<string, number>>;

interface Capture {
  readonly $captured: { readonly image: string; readonly version: string };
  readonly markers: Readonly<Record<string, string>>;
  readonly queues: Readonly<Record<string, string>>;
  readonly before: Counts;
  readonly editor: { readonly value: { readonly rows: readonly Record<string, unknown>[] } };
  readonly refused: readonly {
    readonly name: string;
    readonly before: Counts;
    readonly outcome: Record<string, unknown>;
    readonly after: Counts;
  }[];
  readonly agent: readonly {
    readonly statement: string;
    readonly countsBefore: Counts;
    readonly answer: { readonly value?: unknown; readonly error?: string };
    readonly countsAfter: Counts;
  }[];
  readonly backstop: Capture["agent"];
}

const ROOT = posix.join(import.meta.dir.replaceAll("\\", "/"), "../../../fixtures/rabbitmq");
const VERSIONS = [
  ["4.3.6", "sha256:8dd6e3570ddaa2ef82a6c3a8950e79c1f73893adfbdddbc374fc1f1ac8a0f5dd"],
  ["4.2.9", "sha256:9e9fd21d60f060acc9ecbd847cd1dcb87e6550bdb0297c27e79a40bfe1766ce4"],
] as const;

const load = (version: string): Capture =>
  JSON.parse(readFileSync(posix.join(ROOT, version, "agent-boundary", "boundary.json"), "utf8")) as Capture;

const removed = (call: Capture["refused"][number], queue: string) => call.before[queue] - call.after[queue];

describe.each(VERSIONS)("RabbitMQ %s", (version, digest) => {
  const capture = load(version);
  const call = (name: string) => {
    const found = capture.refused.find((each) => each.name === name);
    if (found === undefined) throw new Error(`no capture of ${name}`);
    return found;
  };

  test("was captured on the pinned image", () => {
    expect(capture.$captured.version).toBe(version);
    expect(capture.$captured.image).toBe(`rabbitmq:${version}-management@${digest}`);
  });

  test("the positive control: a read permission takes and purges, so no account can be the boundary", () => {
    const { classic, quorum, purge } = capture.queues;
    expect(removed(call("basic.get no-ack, classic"), classic)).toBe(1);
    expect(removed(call("basic.get no-ack, quorum"), quorum)).toBe(1);
    expect(removed(call("basic.consume and ack, no x-stream-offset, classic"), classic)).toBe(1);
    expect(removed(call("basic.consume and ack, no x-stream-offset, quorum"), quorum)).toBe(1);
    expect(call("queue.purge over AMQP").outcome).toEqual({ outcome: "ok", detail: { purged: 3 } });
    expect(removed(call("queue.purge over AMQP"), purge)).toBe(3);
    expect(call("DELETE /api/queues/{vhost}/{name}/contents").outcome).toEqual({ outcome: "http", status: 204 });
    expect(removed(call("DELETE /api/queues/{vhost}/{name}/contents"), purge)).toBe(3);
    expect(removed(call("POST /api/queues/{vhost}/{name}/get, ack_requeue_false"), classic)).toBe(1);
  });

  test("the backstop: x-stream-offset on a classic or quorum queue is refused with 406 and nothing is lost", () => {
    for (const name of ["basic.consume with x-stream-offset, classic", "basic.consume with x-stream-offset, quorum"]) {
      expect(call(name).outcome).toEqual({ outcome: "closed", replyCode: 406, scope: "channel" });
      expect(call(name).after).toEqual(call(name).before);
    }
  });

  test("a publish and a declare are the only calls the account is refused, with 403", () => {
    for (const name of ["basic.publish", "queue.declare of a new queue"]) {
      expect(call(name).outcome).toEqual({ outcome: "closed", replyCode: 403, scope: "channel" });
      expect(call(name).after).toEqual(call(name).before);
    }
  });

  test("the stream holds every marker, as the editor's read shows, and no chunk time beside the offset", () => {
    const [first] = capture.editor.value.rows;
    const text = JSON.stringify(first);
    for (const marker of ["body", "header", "routingKey", "messageId", "correlationId", "appId", "type"]) {
      expect(text).toContain(capture.markers[marker] as string);
    }
    expect(Object.keys(first?.headers as Record<string, unknown>)).toEqual([capture.markers.headerName]);
  });

  test("the agent's reads answer offsets and body sizes, no marker, and leave every queue as it was", () => {
    const [all, one, classic, quorum] = capture.agent;
    expect(all?.answer.value).toMatchObject({
      fields: ["offset", "body_bytes"],
      rows: [0, 1, 2, 3, 4].map((offset) => ({ offset, body_bytes: 19 })),
      rowCount: 5,
    });
    expect(one?.answer.value).toMatchObject({ rows: [{ offset: 3, body_bytes: 19 }] });
    expect(classic?.answer.error).toBe(`QueryError: ${notAStream(capture.queues.classic, "classic").message}`);
    expect(quorum?.answer.error).toBe(`QueryError: ${notAStream(capture.queues.quorum, "quorum").message}`);
    for (const read of capture.agent) {
      expect(read.countsAfter).toEqual(read.countsBefore);
      const text = JSON.stringify(read.answer);
      for (const marker of Object.values(capture.markers)) expect(text).not.toContain(marker);
    }
  });

  test("a queue declared under a stream's name after the check delivers nothing: the 406 backstop, nothing lost", () => {
    expect(capture.backstop).toHaveLength(2);
    for (const read of capture.backstop) {
      const stream = (JSON.parse(read.statement) as { stream: string }).stream;
      expect(read.answer.error).toBe(`QueryError: ${notAStream(stream, "").message}`);
      expect(read.countsAfter).toEqual(read.countsBefore);
      expect(read.countsBefore[stream]).toBe(1);
    }
  });
});
