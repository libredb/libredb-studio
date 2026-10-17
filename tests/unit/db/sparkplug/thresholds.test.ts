/**
 * Every threshold, tested from BOTH sides.
 *
 * A test that only uses values outside a bound cannot see the bound move inward, and a test that
 * only uses values inside it cannot see it move outward. A sibling session measured the cost: its
 * tests sampled 7 and 250 around a threshold, so moving the threshold to 200 broke nothing. The
 * pairs below are n-1 and n at every bound this provider decides.
 *
 * The behaviour was already correct when these tests were written. That is the point: the bounds
 * were right and nothing held them, so a change to a comparison operator or an off-by-one in a
 * range check would have passed the whole suite.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { SparkplugProvider } from "@/lib/db/providers/industrial/sparkplug";
import { MAX_ROWS, MAX_WINDOW_SECONDS } from "@/lib/db/providers/industrial/sparkplug/constants";
import { parseReadQuery } from "@/lib/db/providers/industrial/sparkplug/request";
import { birthReplaces, ReadState } from "@/lib/db/providers/industrial/sparkplug/state";
import { parseTopic } from "@/lib/db/providers/industrial/sparkplug/topics";
import type { NodeTopic } from "@/lib/db/providers/industrial/sparkplug/topics";
import type { DatabaseConnection } from "@/lib/types";

const connection = (over: Partial<DatabaseConnection> = {}): DatabaseConnection =>
  ({ id: "c1", name: "plant", type: "mqtt", host: "broker.invalid", port: 1883, ...over }) as DatabaseConnection;
const reader = async () => ({ state: new ReadState(), endReason: "budget", messagesSeen: 0, bytesSeen: 0 });
const topic = (t: string) => parseTopic(t) as NodeTopic;

describe("the console window, at 1 and 300 as well as 0 and 301", () => {
  test.each([[1], [2], [299], [MAX_WINDOW_SECONDS]])("%i seconds is accepted", (seconds) => {
    expect(parseReadQuery(JSON.stringify({ seconds })).seconds).toBe(seconds);
  });

  test.each([[0], [-1], [MAX_WINDOW_SECONDS + 1]])("%i seconds is refused", (seconds) => {
    expect(() => parseReadQuery(JSON.stringify({ seconds }))).toThrow(QueryError);
  });
});

describe("the row bound, at 1 and 10,000 as well as 0 and 10,001", () => {
  test.each([[1], [2], [9_999], [MAX_ROWS]])("a limit of %i is accepted", (limit) => {
    expect(parseReadQuery(JSON.stringify({ limit })).limit).toBe(limit);
  });

  test.each([[0], [-1], [MAX_ROWS + 1]])("a limit of %i is refused", (limit) => {
    expect(() => parseReadQuery(JSON.stringify({ limit }))).toThrow(QueryError);
  });
});

describe("the port range, at 1 and 65,535 as well as 0 and 65,536", () => {
  test.each([[1], [1883], [65_535]])("port %i is accepted", async (port) => {
    await expect(new SparkplugProvider(connection({ port }), {}, reader).connect()).resolves.toBeUndefined();
  });

  test.each([[0], [65_536], [-1]])("port %i is refused", async (port) => {
    await expect(new SparkplugProvider(connection({ port }), {}, reader).connect()).rejects.toThrow(
      DatabaseConfigError,
    );
  });
});

describe("a birth with an EQUAL block sequence replaces, because a rebirth carries the same one", () => {
  test("equal replaces, which a strict comparison would get wrong", () => {
    /*
     * MEASURED on 13 October 2026 against Eclipse Mosquitto 2.0.22: a rebirth answer carried its
     * block sequence UNCHANGED, which specification 5.17 requires. So a comparison that demanded a
     * strictly greater value would drop every rebirth, and a rebirth is one of the three ways this
     * reader ever learns a definition. The equal case is the one that matters most here and it was
     * the one not tested.
     */
    expect(birthReplaces("7", "7")).toBe(true);
    expect(birthReplaces("7", "8")).toBe(true);
    expect(birthReplaces("8", "7")).toBe(false);
  });

  test("and a rebirth with the same block sequence really does replace the definition", () => {
    const state = new ReadState();
    const nbirth = topic("spBv1.0/G1/NBIRTH/E1");
    state.takeBirth(nbirth, {
      origin: "live",
      bdSeq: "7",
      receivedAt: 1,
      metrics: [{ name: "old", alias: "2", datatype: 1 }],
    });
    state.takeBirth(nbirth, {
      origin: "rebirth",
      bdSeq: "7",
      receivedAt: 2,
      metrics: [{ name: "fresh", alias: "2", datatype: 1 }],
    });
    expect(state.all()[0].birth?.metrics[0].name).toBe("fresh");
  });
});

describe("the sequence wrap, on both sides of 255", () => {
  const data = () => topic("spBv1.0/G1/NDATA/E1");

  test("255 then 0 is a continuation", () => {
    const state = new ReadState();
    state.takeSeq(data(), 255);
    state.takeSeq(data(), 0);
    expect(state.all()[0].seqGaps).toHaveLength(0);
  });

  test("255 then 1 IS a gap, which the wrap test alone could not see", () => {
    // The pair that makes the modulus observable: a reader that treated any value after 255 as a
    // continuation would pass the test above and fail here.
    const state = new ReadState();
    state.takeSeq(data(), 255);
    state.takeSeq(data(), 1);
    expect(state.all()[0].seqGaps).toEqual([{ expected: 0, saw: 1 }]);
  });

  test("254 then 255 is a continuation, and 254 then 0 is a gap", () => {
    const first = new ReadState();
    first.takeSeq(data(), 254);
    first.takeSeq(data(), 255);
    expect(first.all()[0].seqGaps).toHaveLength(0);

    const second = new ReadState();
    second.takeSeq(data(), 254);
    second.takeSeq(data(), 0);
    expect(second.all()[0].seqGaps).toEqual([{ expected: 255, saw: 0 }]);
  });
});
