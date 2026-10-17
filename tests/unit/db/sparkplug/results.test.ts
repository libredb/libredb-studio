import { describe, expect, test } from "bun:test";

import type { UnresolvedValue } from "@/lib/db/providers/industrial/sparkplug/fold";
import {
  SPARKPLUG_BIRTH_TIME_VALUE,
  SPARKPLUG_LIVE_BIRTH_VALUE,
  SPARKPLUG_UNRESOLVED_ALIAS,
} from "@/lib/db/providers/industrial/sparkplug/labels";
import type { SparkplugReadQuery } from "@/lib/db/providers/industrial/sparkplug/request";
import { buildRows } from "@/lib/db/providers/industrial/sparkplug/results";
import type { MetricDefinition } from "@/lib/db/providers/industrial/sparkplug/state";
import { ReadState } from "@/lib/db/providers/industrial/sparkplug/state";
import { parseTopic } from "@/lib/db/providers/industrial/sparkplug/topics";

/*
 * WHY THIS FILE WAS MISSING UNTIL IT WAS MEASURED MISSING. `buildRows` had no test of its own: rows
 * were only ever exercised through the provider, so two changes made today - the rows for values no
 * certificate could name, and the note that explains a birth-time value - were asserted by nothing.
 * A sweep that restored the pre-fix behaviour of each of today's fixes found both still green, which
 * is the whole point of asking "would this test have been RED before the fix?".
 */

function node(
  state: ReadState,
  topic: string,
  origin: "live" | "stored",
  metrics: { name: string; alias?: string; text?: string }[],
) {
  const parsed = parseTopic(topic);
  if (parsed.kind !== "node") throw new Error(`not a node topic: ${topic}`);
  state.takeBirth(parsed, {
    origin,
    receivedAt: 1,
    metrics: metrics.map((one) => ({ ...one, datatype: 4 })),
  });
}

const query = (over: Partial<SparkplugReadQuery> = {}): SparkplugReadQuery => ({
  seconds: 3,
  limit: 100,
  includeBirths: true,
  ...over,
});

describe("a value no certificate could name is a ROW, not a silence", () => {
  const unresolved: UnresolvedValue[] = [
    { groupId: "G1", edgeNodeId: "E1", alias: "9", receivedAt: 5 },
    { groupId: "G1", edgeNodeId: "E1", deviceId: "D1", alias: "12", receivedAt: 6 },
  ];

  test("it carries the alias, an explanation, and NO name or datatype", () => {
    const rows = buildRows(new ReadState(), query(), unresolved);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      group: "G1",
      edgeNode: "E1",
      device: null,
      // Null and not a placeholder: a row that printed the alias as a name, or "unknown", would be
      // claiming a name this read does not have.
      metric: null,
      datatype: null,
      definedBy: null,
      alias: "9",
      note: SPARKPLUG_UNRESOLVED_ALIAS,
    });
    expect(rows[1]).toMatchObject({ device: "D1", alias: "12", metric: null });
  });

  test("they come AFTER everything a certificate could name", () => {
    const state = new ReadState();
    node(state, "spBv1.0/G1/NBIRTH/E1", "live", [{ name: "Temp", alias: "11" }]);
    const rows = buildRows(state, query(), unresolved);
    expect(rows.map((row) => row.metric)).toEqual(["Temp", null, null]);
  });

  test("the scope filters reach them too, so a named group does not drag in another's", () => {
    const rows = buildRows(new ReadState(), query({ group: "G2" }), unresolved);
    expect(rows).toEqual([]);
  });

  test("the row limit counts them, so a limit cannot be overrun by the unnameable", () => {
    const state = new ReadState();
    node(state, "spBv1.0/G1/NBIRTH/E1", "live", [{ name: "Temp" }]);
    const rows = buildRows(state, query({ limit: 2 }), unresolved);
    expect(rows).toHaveLength(2);
  });
});

describe("a row says where its definition came from, in words and not only a flag", () => {
  test("a stored certificate's row carries the birth-time sentence BESIDE the birth-time value", () => {
    const state = new ReadState();
    // The certificate carries a value, which is what a real one does (4.1.1) and what a live read
    // against a broker showed this file had never built: every metric here used to be a name and a
    // datatype with no value, so the sentence below was asserted on a row whose value was empty.
    node(state, "$sparkplug/certificates/spBv1.0/G1/NBIRTH/E1", "stored", [{ name: "Temp", text: "61" }]);
    const rows = buildRows(state, query());
    expect(rows[0]?.value).toBe("61");
    expect(rows[0]?.birthTime).toBe(true);
    // The flag was already there and the sentence was not, which is a fact carried without its
    // explanation: the specification says a stored certificate's values cannot be expected to be
    // current, and a reader who sees only `birthTime: true` has not been told that.
    expect(rows[0]?.note).toBe(SPARKPLUG_BIRTH_TIME_VALUE);
  });

  test("a live certificate's row carries NO note, because there is nothing to explain", () => {
    const state = new ReadState();
    node(state, "spBv1.0/G1/NBIRTH/E1", "live", [{ name: "Temp" }]);
    const rows = buildRows(state, query());
    expect(rows[0]?.birthTime).toBe(false);
    expect(rows[0]?.note).toBe("");
  });
});

describe("a row carries the last value the read saw, which the issue asks for by name", () => {
  function withValue(state: ReadState, topic: string, metric: string, over: Record<string, unknown> = {}) {
    const parsed = parseTopic(topic);
    if (parsed.kind !== "node") throw new Error(topic);
    state.takeValue(parsed, {
      name: metric,
      datatype: 4,
      text: "42",
      timestamp: "1700",
      isHistorical: false,
      isTransient: false,
      isNull: false,
      receivedAt: 9,
      ...over,
    });
  }

  test("the value, its OWN timestamp, and the three flags travel to the row", () => {
    const state = new ReadState();
    node(state, "spBv1.0/G1/NBIRTH/E1", "live", [{ name: "Temp" }]);
    withValue(state, "spBv1.0/G1/NDATA/E1", "Temp", { isHistorical: true });

    const row = buildRows(state, query())[0];
    expect(row?.value).toBe("42");
    // The metric's own timestamp (6.4.5), not the receive time: that is the one a plant reasons about.
    expect(row?.valueTime).toBe("1700");
    expect(row?.isHistorical).toBe(true);
    expect(row?.isTransient).toBe(false);
    expect(row?.isNull).toBe(false);
  });

  test("Quality travels as its number, and is NAMED only where the specification names it", () => {
    for (const [code, name] of [
      [0, "BAD"],
      [192, "GOOD"],
      [500, "STALE"],
      // Not one of the three: the number stands and no name is invented for it.
      [7, null],
    ] as const) {
      const state = new ReadState();
      node(state, "spBv1.0/G1/NBIRTH/E1", "live", [{ name: "Temp" }]);
      withValue(state, "spBv1.0/G1/NDATA/E1", "Temp", { quality: code });
      const row = buildRows(state, query())[0];
      expect(row?.quality, `code ${code}`).toBe(code);
      expect(row?.qualityName, `code ${code}`).toBe(name);
    }
  });

  test("a metric with no Quality shows null in both columns", () => {
    const state = new ReadState();
    node(state, "spBv1.0/G1/NBIRTH/E1", "live", [{ name: "Temp" }]);
    withValue(state, "spBv1.0/G1/NDATA/E1", "Temp");
    const row = buildRows(state, query())[0];
    expect(row?.quality).toBeNull();
    expect(row?.qualityName).toBeNull();
  });

  test("a metric the window carried no value for shows NULL, not an empty value", () => {
    // "No value in this window" and "a value of nothing" are different answers, and a grid that
    // showed both as blank would merge them.
    const state = new ReadState();
    node(state, "spBv1.0/G1/NBIRTH/E1", "live", [{ name: "Temp" }]);
    const row = buildRows(state, query())[0];
    expect(row?.value).toBeNull();
    expect(row?.valueTime).toBeNull();
    expect(row?.isNull).toBeNull();
  });

  test("a metric whose value IS null says so, and that is not the same as no value", () => {
    const state = new ReadState();
    node(state, "spBv1.0/G1/NBIRTH/E1", "live", [{ name: "Temp" }]);
    withValue(state, "spBv1.0/G1/NDATA/E1", "Temp", { text: "null", isNull: true });
    const row = buildRows(state, query())[0];
    expect(row?.value).toBe("null");
    expect(row?.isNull).toBe(true);
  });

  test("an unnameable value's row carries no value columns, because no datatype declared it", () => {
    const rows = buildRows(new ReadState(), query(), [{ groupId: "G1", edgeNodeId: "E1", alias: "9", receivedAt: 5 }]);
    expect(rows[0]?.value).toBeNull();
    expect(rows[0]?.isNull).toBeNull();
  });
});

describe("a birth certificate's own values reach the row (4.1.1)", () => {
  /*
   * MEASURED ON A REAL BROKER, which is the only reason this file has these tests. An edge node
   * published one NBIRTH carrying `Temperature` 99.9 and `ShiftName` "NIGHT-SHIFT" and no data
   * message at all; the bytes were read off the wire by an independent subscriber, so the values
   * were certainly delivered. The panel showed two rows with a name, an alias, a datatype and an
   * EMPTY value, because the fold kept only the definition and dropped what the birth carried.
   */
  function born(state: ReadState, topic: string, origin: "live" | "stored", metrics: readonly MetricDefinition[]) {
    const parsed = parseTopic(topic);
    if (parsed.kind !== "node") throw new Error(`not a node topic: ${topic}`);
    state.takeBirth(parsed, { origin, receivedAt: 1, metrics });
  }

  test("a live birth's value is the row's value when the window carried no data message", () => {
    const state = new ReadState();
    born(state, "spBv1.0/G1/NBIRTH/E1", "live", [
      { name: "Temperature", alias: "40", datatype: 10, text: "99.9", timestamp: "1700" },
      { name: "ShiftName", alias: "41", datatype: 12, text: "NIGHT-SHIFT" },
    ]);
    const rows = buildRows(state, query());
    expect(rows.map((row) => [row.metric, row.value])).toEqual([
      ["ShiftName", "NIGHT-SHIFT"],
      ["Temperature", "99.9"],
    ]);
    // Its own timestamp travels with it, as a data message's does.
    expect(rows.find((row) => row.metric === "Temperature")?.valueTime).toBe("1700");
    // And the row says where the value came from, in words rather than only a flag.
    expect(rows.find((row) => row.metric === "Temperature")?.birthTime).toBe(true);
    expect(rows.find((row) => row.metric === "Temperature")?.note).toBe(SPARKPLUG_LIVE_BIRTH_VALUE);
  });

  test("a stored certificate's row now carries the value its own note explains", () => {
    // THE SECOND HALF OF THE SAME DEFECT. The row said "a birth-time value, from the copy the broker
    // had stored" beside an empty value column: a sentence about a value the row did not have.
    const state = new ReadState();
    born(state, "$sparkplug/certificates/spBv1.0/G1/NBIRTH/E1", "stored", [
      { name: "Humidity", alias: "20", datatype: 10, text: "61" },
    ]);
    const row = buildRows(state, query())[0];
    expect(row?.value).toBe("61");
    expect(row?.note).toBe(SPARKPLUG_BIRTH_TIME_VALUE);
    expect(row?.birthTime).toBe(true);
  });

  test("a data message in the window wins over the birth's value, and the row stops claiming a birth time", () => {
    const state = new ReadState();
    born(state, "$sparkplug/certificates/spBv1.0/G1/NBIRTH/E1", "stored", [
      { name: "Humidity", alias: "20", datatype: 10, text: "61" },
    ]);
    const parsed = parseTopic("spBv1.0/G1/NDATA/E1");
    if (parsed.kind !== "node") throw new Error("not a node topic");
    state.takeValue(parsed, {
      name: "Humidity",
      datatype: 10,
      text: "63.5",
      isHistorical: false,
      isTransient: false,
      isNull: false,
      receivedAt: 9,
    });
    const row = buildRows(state, query())[0];
    expect(row?.value).toBe("63.5");
    // `definedBy` still says the certificate was the stored one; `birthTime` is about the VALUE, and
    // this value is the window's. The two used to answer the same question and one of them was wrong.
    expect(row?.definedBy).toBe("stored");
    expect(row?.birthTime).toBe(false);
    expect(row?.note).toBe("");
  });

  test("a birth metric that carried no value at all keeps an empty value, and no value is invented", () => {
    const state = new ReadState();
    born(state, "spBv1.0/G1/NBIRTH/E1", "live", [{ name: "Temp", alias: "1", datatype: 10 }]);
    const row = buildRows(state, query())[0];
    expect(row?.value).toBeNull();
    expect(row?.valueTime).toBeNull();
    expect(row?.birthTime).toBe(false);
    expect(row?.note).toBe("");
  });

  test("a birth that declares a metric null says null, which is not the same as carrying nothing", () => {
    // TWO MESSAGES THAT MUST NOT LOOK ALIKE on the screen: "this metric is null" is something the
    // publisher SAID, and "this metric was never reported" is something nobody said. A row that
    // showed both as an empty value would lose the publisher's own word.
    const state = new ReadState();
    born(state, "spBv1.0/G1/NBIRTH/E1", "live", [
      { name: "Declared", alias: "1", datatype: 10, text: "null", isNull: true },
      { name: "Unreported", alias: "2", datatype: 10 },
    ]);
    const rows = buildRows(state, query());
    expect(rows.map((row) => [row.metric, row.value, row.isNull, row.birthTime])).toEqual([
      ["Declared", "null", true, true],
      ["Unreported", null, null, false],
    ]);
  });

  test("the three message flags stay NULL on a birth value, because a birth carries none of them", () => {
    /*
     * THE DECISION THIS TEST EXISTS TO PIN, and it was unpinned until an independent sweep planted
     * `false` in their place and nothing went red. `isHistorical`, `isTransient` and `quality` are a
     * DATA message's fields (6.4.5, 6.4.9). A birth carries none of them, so the row has no answer,
     * and `false` would claim one: it would say the publisher declared this value current and of no
     * declared quality, which it never did. `null` is the honest column here.
     */
    const state = new ReadState();
    born(state, "spBv1.0/G1/NBIRTH/E1", "live", [{ name: "Temp", alias: "1", datatype: 10, text: "42.5" }]);
    const row = buildRows(state, query())[0];
    expect(row?.value).toBe("42.5");
    expect([row?.isHistorical, row?.isTransient, row?.quality, row?.qualityName]).toEqual([null, null, null, null]);
    // The same three ARE answered where a data message carried them, which is what makes the nulls
    // above a measurement rather than a column nobody fills.
    const parsed = parseTopic("spBv1.0/G1/NDATA/E1");
    if (parsed.kind !== "node") throw new Error("not a node topic");
    state.takeValue(parsed, {
      name: "Temp",
      datatype: 10,
      text: "43",
      isHistorical: true,
      isTransient: false,
      isNull: false,
      quality: 192,
      receivedAt: 9,
    });
    const live = buildRows(state, query())[0];
    expect([live?.isHistorical, live?.isTransient, live?.quality, live?.qualityName]).toEqual([
      true,
      false,
      192,
      "GOOD",
    ]);
  });
});
