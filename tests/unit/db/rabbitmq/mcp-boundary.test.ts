/**
 * MCP's `run_rabbitmq_read` boundary test, from the capture of tests/fixtures/rabbitmq/4.3.6/mcp-boundary/ (recorded
 * by its run.sh against a fresh digest-pinned broker, each call made through the tool's own handler with the
 * factory's agent read-only acquisition, the way the MCP route makes it).
 *
 * The positive control: the administrator's raw no-ack `basic.get`, which the closed table never sends, removes a
 * message. The boundary: with the admission removed, the provider's own reader refuses every request the admission
 * does, a classic queue is refused at the type check, and a classic and a quorum queue declared under a stream's name
 * are refused by the broker's 406; every queue holds what it held. The data scope: a user with read permission on one
 * stream of `/` is refused another virtual host in the same words whether the stream exists or not, and whether the
 * virtual host exists or not, and a stream of `/` outside its read pattern by the broker; the administrator reads the other virtual host, offsets and sizes only;
 * an exchange's name is refused as not a stream in `/` and in the one sentence in the other virtual host; and no answer
 * holds a message marker. The limits: timeout_ms at its minimum, and a cancel that ends the wait while the read runs on
 * to the provider's deadline, keeping the seed's one read slot until then.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import {
  RABBITMQ_AGENT_STOP_SENTENCES,
  rabbitmqAgentUnreadable,
} from "@/lib/db/providers/stream/rabbitmq/agent-metadata-read";
import { readRabbitMQAgentStatement } from "@/lib/db/providers/stream/rabbitmq/agent-statement";
import { notAStream } from "@/lib/db/providers/stream/rabbitmq/errors";
import { MCP_CANCELLED_TEXT } from "@/lib/mcp/output";
import { timeoutText } from "@/lib/mcp/tools/read-query-limits";

type Counts = Readonly<Record<string, number>>;

interface Recorded {
  readonly acquired: readonly string[];
  readonly isError: boolean;
  readonly text: string;
  readonly rows?: readonly Record<string, unknown>[];
  readonly truncated?: string | null;
  readonly hint?: string | null;
}

interface Capture {
  readonly $captured: { readonly image: string; readonly version: string };
  readonly markers: Readonly<Record<string, string>>;
  readonly before: Counts;
  readonly accepted: Readonly<Record<string, Recorded>>;
  readonly cut: Recorded;
  readonly admission: Readonly<
    Record<string, { readonly statement: string; readonly fenced: Recorded; readonly unfenced: Recorded }>
  >;
  readonly boundary: Readonly<Record<"classic" | "swapClassic" | "swapQuorum", Recorded>>;
  readonly scope: Readonly<
    Record<
      | "otherVhostStream"
      | "otherVhostMissing"
      | "absentVhostStream"
      | "privateStream"
      | "missingStream"
      | "exchange"
      | "otherVhostExchange"
      | "broadOtherVhost",
      Recorded
    >
  >;
  readonly timeout: Recorded;
  readonly cancel: {
    readonly answer: Recorded;
    readonly answeredAfterMs: number;
    readonly timeoutMs: number;
    readonly readSettled: { readonly afterMs: number; readonly outcome: string };
    readonly waiting: {
      readonly answer: Recorded;
      readonly startedAfterMs: number;
      readonly answeredAfterMs: number;
      readonly timeoutMs: number;
      readonly dials: number;
    };
    readonly after: { readonly answer: Recorded; readonly dials: number };
  };
  readonly after: Counts;
  readonly control: { readonly take: string; readonly after: Counts };
}

const DIR = posix.join(import.meta.dir.replaceAll("\\", "/"), "../../../fixtures/rabbitmq/4.3.6/mcp-boundary");
const capture = JSON.parse(readFileSync(posix.join(DIR, "mcp-boundary.json"), "utf8")) as Capture;
const DIGEST = "sha256:8dd6e3570ddaa2ef82a6c3a8950e79c1f73893adfbdddbc374fc1f1ac8a0f5dd";
const ENGINE_REFUSAL = "The database refused or failed the call: ";

/** Every answer the capture holds: each is checked for markers. */
const answers: readonly Recorded[] = [
  ...Object.values(capture.accepted),
  capture.cut,
  ...Object.values(capture.admission).flatMap(({ fenced, unfenced }) => [fenced, unfenced]),
  ...Object.values(capture.boundary),
  ...Object.values(capture.scope),
  capture.timeout,
  capture.cancel.answer,
  capture.cancel.waiting.answer,
  capture.cancel.after.answer,
];

/** The text after the untrusted-content notice: what the broker's refusal reached the client as. */
const refusalOf = (answer: Recorded): string => answer.text.slice(answer.text.indexOf(ENGINE_REFUSAL));

test("was captured on the pinned image", () => {
  expect(capture.$captured.version).toBe("4.3.6");
  expect(capture.$captured.image).toBe(`rabbitmq:4.3.6-management@${DIGEST}`);
});

describe("the boundary", () => {
  test("the positive control: the administrator's raw no-ack basic.get removes a message", () => {
    expect(capture.control.take).toBe("get-ok");
    expect(capture.after["/q-classic"] - capture.control.after["/q-classic"]).toBe(1);
  });

  test("every MCP call left every queue holding what it held", () => {
    expect(capture.after).toEqual(capture.before);
  });

  test.each(Object.entries(capture.admission))(
    "%s is refused by the admission before anything is acquired, and by the provider's reader without it",
    (_name, { statement, fenced, unfenced }) => {
      expect(fenced.isError).toBe(true);
      expect(fenced.acquired).toEqual([]);
      expect(fenced.text).toStartWith("The read request was refused before it reached the broker (");
      expect(unfenced.isError).toBe(true);
      expect(unfenced.acquired).toEqual(["agent-read-only"]);
      const reading = readRabbitMQAgentStatement(statement);
      if (reading.ok) throw new Error(`the provider's reader admits ${statement}`);
      expect(unfenced.text).toBe(`The statement was refused before it reached the database: ${reading.message}`);
    },
  );

  test("with the admission removed, a classic queue is refused at the type check", () => {
    expect(refusalOf(capture.boundary.classic)).toBe(`${ENGINE_REFUSAL}${notAStream("q-classic", "classic").message}`);
  });

  test("a classic and a quorum queue under a stream's name, the type check answered as a stream, meet the 406", () => {
    expect(refusalOf(capture.boundary.swapClassic)).toBe(
      `${ENGINE_REFUSAL}${notAStream("st-swap-classic", "").message}`,
    );
    expect(refusalOf(capture.boundary.swapQuorum)).toBe(`${ENGINE_REFUSAL}${notAStream("st-swap-quorum", "").message}`);
  });
});

describe("the reads", () => {
  test("each admitted start answers offsets and body sizes alone, under the agent read-only profile", () => {
    for (const [name, answer] of Object.entries(capture.accepted)) {
      expect({ name, isError: answer.isError, acquired: answer.acquired }).toEqual({
        name,
        isError: false,
        acquired: ["agent-read-only"],
      });
      for (const row of answer.rows ?? []) expect(Object.keys(row)).toEqual(["offset", "body_bytes"]);
    }
    expect(capture.accepted.first.rows?.map((row) => row.offset)).toEqual([0, 1, 2, 3, 4]);
    expect(capture.accepted.last.rows?.map((row) => row.offset)).toEqual([4]);
    expect(capture.accepted.offset.rows?.map((row) => row.offset)).toEqual([2, 3]);
    expect(capture.accepted.next.rows).toEqual([]);
  });

  test("a read past max_rows is cut to it, and the hint reads on by offset", () => {
    expect(capture.cut.rows).toHaveLength(2);
    expect(capture.cut.truncated).toBe("max_rows");
    expect(capture.cut.hint).toContain('start the next read at {"offset": n}');
  });

  test("no answer holds a message's body, header, property or routing key", () => {
    const text = JSON.stringify(answers);
    for (const marker of Object.values(capture.markers)) {
      expect({ marker, answered: text.includes(marker) }).toEqual({ marker, answered: false });
    }
  });
});

describe("the data scope", () => {
  test("another virtual host is refused in the same words whether the stream exists and whether the virtual host exists", () => {
    expect(refusalOf(capture.scope.otherVhostStream)).toBe(
      `${ENGINE_REFUSAL}${rabbitmqAgentUnreadable("tenant-b", "st-other")}`,
    );
    expect(refusalOf(capture.scope.otherVhostMissing)).toBe(
      `${ENGINE_REFUSAL}${rabbitmqAgentUnreadable("tenant-b", "st-missing")}`,
    );
    expect(refusalOf(capture.scope.absentVhostStream)).toBe(
      `${ENGINE_REFUSAL}${rabbitmqAgentUnreadable("tenant-absent", "st-other")}`,
    );
  });

  test("a stream of its own virtual host outside its read pattern is refused by the broker", () => {
    expect(refusalOf(capture.scope.privateStream)).toBe(
      `${ENGINE_REFUSAL}This user may not read stream "st-private": its read permission pattern on "/" does not match the name.`,
    );
    expect(refusalOf(capture.scope.missingStream)).toBe(
      `${ENGINE_REFUSAL}${rabbitmqAgentUnreadable("/", "st-missing")}`,
    );
  });

  test("an exchange's name is refused as not a stream in its own virtual host, and in the one sentence in another", () => {
    expect(refusalOf(capture.scope.exchange)).toBe(`${ENGINE_REFUSAL}${notAStream("ex-mcp", "").message}`);
    expect(refusalOf(capture.scope.otherVhostExchange)).toBe(
      `${ENGINE_REFUSAL}${rabbitmqAgentUnreadable("tenant-b", "ex-other")}`,
    );
  });

  test("the administrator reads the other virtual host, offsets and body sizes only", () => {
    expect(capture.scope.broadOtherVhost.isError).toBe(false);
    expect(capture.scope.broadOtherVhost.rows?.map((row) => Object.keys(row))).toEqual([
      ["offset", "body_bytes"],
      ["offset", "body_bytes"],
    ]);
  });
});

describe("the wait", () => {
  test("a read past timeout_ms at its minimum is answered as the timeout", () => {
    expect(capture.timeout.text).toBe(timeoutText(500));
  });

  test("a cancel ends the wait at once, and the read runs on until the provider's deadline, the time left, ends it", () => {
    expect(capture.cancel.answer.text).toBe(MCP_CANCELLED_TEXT);
    expect(capture.cancel.answeredAfterMs).toBeLessThan(1_000);
    expect(capture.cancel.readSettled.afterMs).toBeGreaterThanOrEqual(capture.cancel.timeoutMs - 100);
    const left = Number(/within (\d+)ms/.exec(capture.cancel.readSettled.outcome)?.[1]);
    expect(left).toBeGreaterThan(capture.cancel.timeoutMs - 100);
    expect(left).toBeLessThanOrEqual(capture.cancel.timeoutMs);
    expect(capture.cancel.readSettled.outcome).toBe(RABBITMQ_AGENT_STOP_SENTENCES.deadline(left));
  });

  test("the cancelled read keeps the seed's read slot: a call on that seed waits, and is answered as its timeout", () => {
    const { waiting } = capture.cancel;
    expect(waiting.startedAfterMs).toBeLessThan(capture.cancel.timeoutMs);
    expect(waiting.answeredAfterMs).toBeLessThan(capture.cancel.readSettled.afterMs);
    expect(waiting.answer.text).toBe(timeoutText(waiting.timeoutMs));
    expect(waiting.dials).toBe(1);
  });

  test("the deadline frees the slot: a call after the read settled reads at once on a connection of its own", () => {
    expect(capture.cancel.after.answer.isError).toBe(false);
    expect(capture.cancel.after.answer.rows).toHaveLength(1);
    expect(capture.cancel.after.dials).toBe(2);
  });
});
