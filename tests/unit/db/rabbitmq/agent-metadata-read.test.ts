/**
 * The agent read's projection and wording: each stop of the read loop either answered (the limit, the stream's own
 * end) or refused rather than cut, the rows built from the raw messages alone, and a failure worded with the time
 * budget or passed on as errors.ts's own sentence.
 */
import { describe, expect, test } from "bun:test";
import { QueryError, TimeoutError } from "@/lib/db/errors";
import {
  RABBITMQ_AGENT_STOP_SENTENCES,
  RABBITMQ_AGENT_STREAM_COLUMNS,
  RABBITMQ_METADATA_ONLY,
  rabbitmqAgentFailure,
  rabbitmqAgentResult,
} from "@/lib/db/providers/stream/rabbitmq/agent-metadata-read";
import type { RawMessage, StopReason } from "@/lib/db/providers/stream/rabbitmq/amqp/read-loop";
import { IDLE_WARNING, NEXT_EMPTY_WARNING, queryError } from "@/lib/db/providers/stream/rabbitmq/errors";
import { parseReadRequest } from "@/lib/db/providers/stream/rabbitmq/request";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";

const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 200, maxResultBytes: 262_144, statementTimeoutMs: 10_000 };
const encode = (text: string) => new TextEncoder().encode(text);

/** A raw message as the read loop keeps it, every field a marker no answer may hold. */
function raw(offset: bigint, bodySize = 12): RawMessage {
  return {
    offset,
    exchange: encode("marker-exchange"),
    routingKey: encode("marker-routing-key"),
    properties: {
      messageId: encode("marker-message-id"),
      headers: [{ name: encode("x-marker"), value: { tag: "S", bytes: encode("marker-header") } }],
    },
    body: encode("marker-body"),
    bodySize,
    retainedHeaderBytes: 40,
  };
}

const request = (from = "first") => parseReadRequest(JSON.stringify({ vhost: "/", stream: "orders", from, limit: 5 }));
const outcome = (stop: StopReason, messages = [raw(BigInt(3)), raw(BigInt(4), 0)]) => ({
  outcome: { messages, stop, prefetch: 5 },
  executionTime: 7,
  deadlineMs: 10_000,
});

describe("the stops that answer", () => {
  test("the limit answers every message's offset and body size, and nothing else", () => {
    const result = rabbitmqAgentResult(outcome({ kind: "limit" }), request(), BUDGET, "s");
    expect(result).toEqual({
      fields: ["offset", "body_bytes"],
      rows: [
        { offset: 3, body_bytes: 12 },
        { offset: 4, body_bytes: 0 },
      ],
      rowCount: 2,
      executionTime: 7,
    });
    expect(JSON.stringify(result)).not.toContain("marker");
  });

  test("an idle stop answers with the idle warning, and a read from next that read nothing with its own", () => {
    expect(rabbitmqAgentResult(outcome({ kind: "idle" }), request(), BUDGET, "s").warnings).toEqual([
      { message: IDLE_WARNING },
    ]);
    expect(rabbitmqAgentResult(outcome({ kind: "idle" }, []), request("next"), BUDGET, "s").warnings).toEqual([
      { message: NEXT_EMPTY_WARNING },
    ]);
    expect(rabbitmqAgentResult(outcome({ kind: "idle" }), request("next"), BUDGET, "s").warnings).toEqual([
      { message: IDLE_WARNING },
    ]);
  });
});

describe("the stops that refuse rather than cut", () => {
  test.each([
    [{ kind: "deadline" }, RABBITMQ_AGENT_STOP_SENTENCES.deadline(10_000)],
    [{ kind: "budget" }, RABBITMQ_AGENT_STOP_SENTENCES.budget],
    [{ kind: "wire" }, RABBITMQ_AGENT_STOP_SENTENCES.wire],
    [{ kind: "wire-oversize", offset: BigInt(5) }, RABBITMQ_AGENT_STOP_SENTENCES.wire],
    [{ kind: "cancel" }, RABBITMQ_AGENT_STOP_SENTENCES.cancel],
    [{ kind: "server-cancel" }, RABBITMQ_AGENT_STOP_SENTENCES.ended],
    [{ kind: "closed" }, RABBITMQ_AGENT_STOP_SENTENCES.ended],
    [{ kind: "conversion" }, RABBITMQ_AGENT_STOP_SENTENCES.conversion(2)],
  ] as [StopReason, string][])("%p", (stop, sentence) => {
    let caught: unknown;
    try {
      rabbitmqAgentResult(outcome(stop), request(), BUDGET, "the statement");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(QueryError);
    expect((caught as QueryError).message).toBe(sentence);
    expect((caught as QueryError).query).toBe("the statement");
  });

  test("the sentences name the limits and say the answer was refused, never what a message held", () => {
    expect(RABBITMQ_AGENT_STOP_SENTENCES.budget).toBe(
      "The messages' bodies passed the 8 MiB Studio holds for one read before it reached its limit, so the answer was refused rather than cut; ask for fewer messages.",
    );
    expect(RABBITMQ_AGENT_STOP_SENTENCES.wire).toBe(
      "The read passed the 64 MiB one read may transfer before it reached its limit, so the answer was refused rather than cut; ask for fewer messages.",
    );
    expect(RABBITMQ_AGENT_STOP_SENTENCES.conversion(1)).toContain("after 1 message,");
    expect(RABBITMQ_AGENT_STOP_SENTENCES.deadline(10_000)).toStartWith(
      "Read-only execution exceeded the time budget: the read did not reach its limit within 10000ms",
    );
  });
});

describe("the failures", () => {
  test("a timeout before the broker started the read is the time budget's refusal", () => {
    const worded = rabbitmqAgentFailure(new TimeoutError("waited", "rabbitmq", 4_000), 4_000, "the statement");
    expect(worded).toBeInstanceOf(QueryError);
    expect(worded?.message).toBe("Read-only execution exceeded the time budget: no answer within 4000ms");
    expect(worded?.query).toBe("the statement");
  });

  test("errors.ts's own sentences and defects pass on unchanged", () => {
    expect(rabbitmqAgentFailure(queryError("own sentence"), 4_000, "s")).toBeUndefined();
    expect(rabbitmqAgentFailure(new TypeError("defect"), 4_000, "s")).toBeUndefined();
  });
});

describe("the declarations", () => {
  test("the capability and the agent's columns name the offset and the body size alone", () => {
    expect(RABBITMQ_METADATA_ONLY).toEqual({
      "stream messages": [
        { column: "offset", kind: "count" },
        { column: "body_bytes", kind: "count" },
      ],
    });
    expect(RABBITMQ_AGENT_STREAM_COLUMNS).toEqual([
      { name: "offset", type: "integer", nullable: false, isPrimary: false },
      { name: "body_bytes", type: "integer", nullable: false, isPrimary: false },
    ]);
  });
});
