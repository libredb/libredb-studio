import { describe, expect, test } from "bun:test";

import { foldMessages } from "@/lib/db/providers/industrial/sparkplug/fold";
import type { ReceivedMessage } from "@/lib/db/providers/industrial/sparkplug/session";

/*
 * THE LAYER THIS FILE COVERS DID NOT EXIST UNTIL IT WAS MEASURED MISSING. `ReadState` was built
 * thirty-four times in this suite and ZERO times in production, and `takeBirth`, `takeDeath`,
 * `takeSeq` and `resolve` each had no production caller at all. So the state layer was driven only
 * by its own tests while `connect()` refused before any of it ran, and a hundred mutations described
 * a layer the product never reached. `fold.ts` is the join, and these are its tests.
 *
 * Payloads are built BY HAND here rather than with a protobuf library, for the same reason the
 * decoder is this repository's own: a library that encodes and a library that decodes agree with
 * each other whether or not either agrees with the specification.
 */

// Sparkplug Payload: 1 timestamp (uint64), 2 metrics (repeated Metric), 3 seq (uint64).
// Metric: 1 name (string), 2 alias (uint64), 4 datatype (uint32), 11 longValue (uint64).
function varint(value: number): number[] {
  const out: number[] = [];
  let left = value;
  do {
    let digit = left % 128;
    left = Math.floor(left / 128);
    if (left > 0) digit |= 0x80;
    out.push(digit);
  } while (left > 0);
  return out;
}

function tag(field: number, wire: number): number[] {
  return varint(field * 8 + wire);
}

function uint64Field(field: number, value: number): number[] {
  return [...tag(field, 0), ...varint(value)];
}

function stringField(field: number, text: string): number[] {
  const body = [...new TextEncoder().encode(text)];
  return [...tag(field, 2), ...varint(body.length), ...body];
}

function messageField(field: number, body: number[]): number[] {
  return [...tag(field, 2), ...varint(body.length), ...body];
}

interface MetricSpec {
  readonly name?: string;
  readonly alias?: number;
  readonly datatype?: number;
  readonly longValue?: number;
  /** Field 10, the uint32 arm. 5.3's bdSeq is 64-bit but a narrow encoder may use this one. */
  readonly intValue?: number;
  /** Field 13, the IEEE-754 double arm. */
  readonly doubleValue?: number;
  /** Field 15, the string arm. */
  readonly stringValue?: string;
  /** Field 3, the metric's own timestamp (6.4.5). */
  readonly timestamp?: number;
  /** An already-encoded PropertySet for field 9. */
  readonly properties?: number[];
}

function metric(spec: MetricSpec): number[] {
  const body: number[] = [];
  if (spec.name !== undefined) body.push(...stringField(1, spec.name));
  if (spec.alias !== undefined) body.push(...uint64Field(2, spec.alias));
  if (spec.timestamp !== undefined) body.push(...uint64Field(3, spec.timestamp));
  if (spec.datatype !== undefined) body.push(...uint64Field(4, spec.datatype));
  if (spec.doubleValue !== undefined) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, spec.doubleValue, true);
    body.push(...tag(13, 1), ...bytes);
  }
  if (spec.stringValue !== undefined) body.push(...stringField(15, spec.stringValue));
  if (spec.intValue !== undefined) body.push(...uint64Field(10, spec.intValue));
  if (spec.longValue !== undefined) body.push(...uint64Field(11, spec.longValue));
  if (spec.properties !== undefined) body.push(...messageField(9, spec.properties));
  return body;
}

/** A PropertySet: field 1 repeated keys, field 2 repeated PropertyValue (int in field 3). */
function propertySet(entries: [string, number | null][]): number[] {
  const body: number[] = [];
  for (const [key] of entries) body.push(...stringField(1, key));
  for (const [, value] of entries) {
    const pv = value === null ? [] : [...uint64Field(3, value)];
    body.push(...messageField(2, pv));
  }
  return body;
}

function payload(spec: { timestamp?: number; seq?: number; metrics?: MetricSpec[] }): Uint8Array {
  const body: number[] = [];
  if (spec.timestamp !== undefined) body.push(...uint64Field(1, spec.timestamp));
  for (const one of spec.metrics ?? []) body.push(...messageField(2, metric(one)));
  if (spec.seq !== undefined) body.push(...uint64Field(3, spec.seq));
  return Uint8Array.from(body);
}

let clock = 1_000;
function received(topic: string, body: Uint8Array | undefined): ReceivedMessage {
  clock += 1;
  return {
    topic,
    ...(body === undefined ? {} : { payload: body }),
    payloadBytes: body?.length ?? 0,
    receivedAt: clock,
  };
}

/** Int64, the datatype a bdSeq metric carries (5.3). */
const INT64 = 4;

describe("a read's messages become the state the panels answer from", () => {
  test("a birth defines a metric and the data that follows is named by it", () => {
    const { state, unresolved } = foldMessages([
      received(
        "spBv1.0/G1/NBIRTH/E1",
        payload({
          timestamp: 100,
          seq: 0,
          metrics: [
            { name: "bdSeq", datatype: INT64, longValue: 7 },
            { name: "Temp", alias: 11, datatype: INT64 },
          ],
        }),
      ),
      received("spBv1.0/G1/NDATA/E1", payload({ seq: 1, metrics: [{ alias: 11, longValue: 42 }] })),
    ]);

    const nodes = state.all();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.groupId).toBe("G1");
    expect(nodes[0]?.edgeNodeId).toBe("E1");
    expect(nodes[0]?.birth?.bdSeq).toBe("7");
    expect(nodes[0]?.birth?.origin).toBe("live");
    // The alias resolved, so nothing is reported as unnameable.
    expect(unresolved).toEqual([]);
    expect(state.summary().unresolvedValues).toBe(0);
  });

  test("a value under an alias no certificate defines is REPORTED, not dropped", () => {
    /*
     * THE DEFECT THIS TEST EXISTS FOR. Rows are built from birth certificates, so a value whose
     * alias no certificate names produced no row AND no count: a read that saw a thousand values it
     * could not name said exactly what a read that saw none said. The provider's own rule is that a
     * read reports what it saw, why it stopped and what it can prove it lost.
     */
    const { unresolved, state } = foldMessages([
      received("spBv1.0/G1/NDATA/E1", payload({ seq: 0, metrics: [{ alias: 9, longValue: 1 }] })),
      received("spBv1.0/G1/DDATA/E1/D1", payload({ seq: 1, metrics: [{ alias: 9, longValue: 2 }] })),
    ]);

    expect(unresolved).toHaveLength(2);
    expect(unresolved[0]).toMatchObject({ groupId: "G1", edgeNodeId: "E1", alias: "9" });
    expect(unresolved[1]).toMatchObject({ groupId: "G1", edgeNodeId: "E1", deviceId: "D1", alias: "9" });
    expect(state.summary().unresolvedValues).toBe(2);
  });

  test("a metric carrying its own name is never unresolved, whatever this read holds", () => {
    const { unresolved } = foldMessages([
      received("spBv1.0/G1/NDATA/E1", payload({ seq: 0, metrics: [{ name: "Temp", longValue: 5 }] })),
    ]);
    expect(unresolved).toEqual([]);
  });

  test("a stored certificate is marked stored, so its values are birth-time values", () => {
    const { state } = foldMessages([
      received(
        "$sparkplug/certificates/spBv1.0/G1/NBIRTH/E1",
        payload({ metrics: [{ name: "Temp", alias: 3, datatype: INT64 }] }),
      ),
    ]);
    expect(state.all()[0]?.birth?.origin).toBe("stored");
  });

  test("a death whose bdSeq does NOT match the birth is IGNORED, which is the whole point of 6.4.25", () => {
    /*
     * A MUTATION ESCAPED HERE TOO, and this one is the rule rather than a detail: passing `undefined`
     * instead of the death's bdSeq broke nothing, because the only death in these tests MATCHED and a
     * matching death and an unmatched one both applied. 6.4.25 exists because "timing with Will
     * Messages may result in NDEATH messages arriving after a new/next NBIRTH message", so a death
     * carrying a PREVIOUS session's bdSeq must not kill the node that just came back.
     */
    const { state } = foldMessages([
      received("spBv1.0/G1/NBIRTH/E1", payload({ metrics: [{ name: "bdSeq", datatype: INT64, longValue: 9 }] })),
      received("spBv1.0/G1/NDATA/E1", payload({ seq: 1, metrics: [{ name: "Temp", datatype: INT64, longValue: 1 }] })),
      // The stale death: bdSeq 8 belongs to the session before this birth.
      received("spBv1.0/G1/NDEATH/E1", payload({ metrics: [{ name: "bdSeq", datatype: INT64, longValue: 8 }] })),
    ]);
    // The node is still the one that published during this read, not a dead one.
    expect(state.all()[0]?.liveness.kind).toBe("published-during-read");
    expect(state.summary().deathsSeen).toBe(0);
  });

  test("a death is applied, and the node says a death was seen rather than going quiet", () => {
    const { state } = foldMessages([
      received("spBv1.0/G1/NBIRTH/E1", payload({ metrics: [{ name: "bdSeq", datatype: INT64, longValue: 4 }] })),
      received("spBv1.0/G1/NDEATH/E1", payload({ metrics: [{ name: "bdSeq", datatype: INT64, longValue: 4 }] })),
    ]);
    expect(state.all()[0]?.liveness.kind).toBe("death-seen-in-this-read");
  });
});

describe("a host's STATE is JSON, not a protobuf payload", () => {
  /*
   * A DEFECT CAUGHT BY READING A COMMENT AGAINST ITS OWN CODE. The comment said "STATE carries a
   * JSON body rather than metrics (6.4.27)" and sat one line BELOW the call that had already handed
   * that body to the protobuf decoder, so every STATE message was refused and no host state was ever
   * recorded. The claim was right; the order was wrong.
   */
  function stateMessage(hostId: string, body: string) {
    return received(`spBv1.0/STATE/${hostId}`, new TextEncoder().encode(body));
  }

  test("an online host is read, with its own timestamp", () => {
    const { state, refusals } = foldMessages([stateMessage("primary", '{"online":true,"timestamp":1736}')]);
    expect(refusals).toEqual({});
    expect(state.hostStates.get("primary")).toEqual({ online: true, timestamp: "1736" });
  });

  test("an offline host is read as offline, not as a missing host", () => {
    const { state } = foldMessages([stateMessage("primary", '{"online":false,"timestamp":9}')]);
    // `false` and not absent: an offline host application is a fact, and 5.10 makes every edge node
    // waiting on it publish a death, so the two are different things for a reader.
    expect(state.hostStates.get("primary")?.online).toBe(false);
  });

  test("a host id containing a slash is one id, not a group named STATE", () => {
    const { state } = foldMessages([stateMessage("NBIRTH/e1", '{"online":true}')]);
    expect(state.hostStates.get("NBIRTH/e1")?.online).toBe(true);
    expect(state.all()).toHaveLength(0);
  });

  test("a STATE body this reader cannot read is named for OUR read, and the fold carries on", () => {
    // The label is a statement about this reader and not a verdict on the publisher: Sparkplug 2.2
    // carried host state as the plain strings `ONLINE` and `OFFLINE`, so a body that is not JSON is
    // not automatically a malformed one, and an operator should not be sent to their vendor by it.
    const { state, refusals } = foldMessages([
      stateMessage("primary", "not json at all"),
      received("spBv1.0/G1/NBIRTH/E1", payload({ metrics: [{ name: "Temp", datatype: INT64 }] })),
    ]);
    expect(Object.keys(refusals)).toEqual(["a STATE body this reader could not read as JSON"]);
    expect(state.all()).toHaveLength(1);
  });

  test("a host's state is NEVER turned into an edge node's liveness", () => {
    const { state } = foldMessages([stateMessage("primary", '{"online":false}')]);
    // No node is invented for a host, and no node's liveness moves because a host went offline.
    expect(state.all()).toHaveLength(0);
  });
});

describe("a metric's VALUE reaches the state, which is what the issue asks for", () => {
  /*
   * THE SECOND AND LARGER CASE OF A LAYER NOTHING CALLED. `ReadState` was the first; this one is
   * `values.ts` - 321 lines, every datatype 0 to 34, 35 tests and 13 mutations - with ZERO production
   * callers, because the fold resolved an alias and then threw the value away. The earlier sweep
   * missed it for a reason worth writing down: that sweep was looking at `ReadState`, so it found
   * what it was looking for and stopped.
   *
   * The issue asks outright that a metric show "the last value the read carried with its timestamp",
   * `is_historical`, `is_transient` and `is_null`.
   */
  test("a value arrives under the datatype its CERTIFICATE declared, not the field that carried it", () => {
    const { state } = foldMessages([
      received("spBv1.0/G1/NBIRTH/E1", payload({ metrics: [{ name: "Temp", alias: 11, datatype: INT64 }] })),
      received("spBv1.0/G1/NDATA/E1", payload({ seq: 1, metrics: [{ alias: 11, longValue: 42 }] })),
    ]);
    const observed = state.valueOf("G1", "E1", undefined, "Temp");
    expect(observed?.text).toBe("42");
    expect(observed?.datatype).toBe(INT64);
    expect(observed?.name).toBe("Temp");
  });

  test("when the two DISAGREE, the certificate's datatype wins and the message's is ignored", () => {
    /*
     * SP-S7 ITSELF, AND A MUTATION ESCAPED UNTIL THIS TEST EXISTED. Swapping the precedence so the
     * message's own datatype came first broke nothing, because every other test had the two AGREE:
     * a test where both answers are the same measures neither. 6.4.6 says a data message cannot name
     * or type its values, so a publisher that puts a datatype on a data metric is not the authority.
     *
     * Datatype 12 is String and 4 is Int64. The certificate says Int64 and the data message claims
     * String while carrying a long: read under the certificate this is the number, read under the
     * message it is a value with no string field, which the value layer reports as a mismatch.
     */
    const STRING = 12;
    const { state } = foldMessages([
      received("spBv1.0/G1/NBIRTH/E1", payload({ metrics: [{ name: "Temp", alias: 11, datatype: INT64 }] })),
      received("spBv1.0/G1/NDATA/E1", payload({ seq: 1, metrics: [{ alias: 11, datatype: STRING, longValue: 42 }] })),
    ]);
    const observed = state.valueOf("G1", "E1", undefined, "Temp");
    expect(observed?.datatype).toBe(INT64);
    expect(observed?.text).toBe("42");
    expect(observed?.problem).toBeUndefined();
  });

  test("the LAST value in the window wins, not the first", () => {
    // 6.4.5 lets one window carry the same metric many times, and a row is one line: showing the
    // first would show the oldest.
    const { state } = foldMessages([
      received("spBv1.0/G1/NBIRTH/E1", payload({ metrics: [{ name: "Temp", alias: 11, datatype: INT64 }] })),
      received("spBv1.0/G1/NDATA/E1", payload({ seq: 1, metrics: [{ alias: 11, longValue: 1 }] })),
      received("spBv1.0/G1/NDATA/E1", payload({ seq: 2, metrics: [{ alias: 11, longValue: 2 }] })),
      received("spBv1.0/G1/NDATA/E1", payload({ seq: 3, metrics: [{ alias: 11, longValue: 3 }] })),
    ]);
    expect(state.valueOf("G1", "E1", undefined, "Temp")?.text).toBe("3");
  });

  test("an EMPTY name is not a name, so the alias still decides", () => {
    /*
     * FOUND BY AN END-TO-END READ OVER A REAL SOCKET, AND UNREACHABLE BY EVERY TEST ABOVE. The
     * helpers here build a nameless metric by OMITTING the field; a publisher may instead set it to
     * the empty string, and reading that as "this metric names itself" stored the value under "" and
     * left the metric the certificate DID name with no value at all. The row showed `value: null`
     * for a metric whose data message carried 42.
     */
    const { state } = foldMessages([
      received("spBv1.0/G1/NBIRTH/E1", payload({ metrics: [{ name: "Temp", alias: 11, datatype: INT64 }] })),
      received("spBv1.0/G1/NDATA/E1", payload({ seq: 1, metrics: [{ name: "", alias: 11, longValue: 42 }] })),
    ]);
    expect(state.valueOf("G1", "E1", undefined, "Temp")?.text).toBe("42");
    expect(state.valueOf("G1", "E1", undefined, "")).toBeUndefined();
  });

  test("a metric carrying its OWN name and datatype is read without a certificate", () => {
    const { state } = foldMessages([
      received("spBv1.0/G1/NDATA/E1", payload({ seq: 0, metrics: [{ name: "Flow", datatype: INT64, longValue: 7 }] })),
    ]);
    expect(state.valueOf("G1", "E1", undefined, "Flow")?.text).toBe("7");
  });

  test("a device's value is kept apart from its node's metric of the same name", () => {
    const { state } = foldMessages([
      received("spBv1.0/G1/NBIRTH/E1", payload({ metrics: [{ name: "Temp", alias: 1, datatype: INT64 }] })),
      received("spBv1.0/G1/DBIRTH/E1/D1", payload({ metrics: [{ name: "Temp", alias: 2, datatype: INT64 }] })),
      received("spBv1.0/G1/NDATA/E1", payload({ seq: 1, metrics: [{ alias: 1, longValue: 10 }] })),
      received("spBv1.0/G1/DDATA/E1/D1", payload({ seq: 2, metrics: [{ alias: 2, longValue: 20 }] })),
    ]);
    expect(state.valueOf("G1", "E1", undefined, "Temp")?.text).toBe("10");
    expect(state.valueOf("G1", "E1", "D1", "Temp")?.text).toBe("20");
  });

  test("a metric the window carried no value for has NO observed value, which is not a value of nothing", () => {
    const { state } = foldMessages([
      received("spBv1.0/G1/NBIRTH/E1", payload({ metrics: [{ name: "Temp", alias: 11, datatype: INT64 }] })),
    ]);
    expect(state.valueOf("G1", "E1", undefined, "Temp")).toBeUndefined();
  });
});

describe("a metric's Quality is read, and an unnamed code keeps its number", () => {
  const INT64 = 4;
  function withQuality(props: number[] | undefined) {
    const { state } = foldMessages([
      received("spBv1.0/G1/NBIRTH/E1", payload({ metrics: [{ name: "Temp", alias: 11, datatype: INT64 }] })),
      received(
        "spBv1.0/G1/NDATA/E1",
        payload({
          seq: 1,
          metrics: [{ alias: 11, longValue: 5, ...(props === undefined ? {} : { properties: props }) }],
        }),
      ),
    ]);
    return state.valueOf("G1", "E1", undefined, "Temp");
  }

  test("the three codes 6.4.9 names are read as numbers", () => {
    for (const code of [0, 192, 500]) {
      expect(withQuality(propertySet([["Quality", code]]))?.quality, `code ${code}`).toBe(code);
    }
  });

  test("a bdSeq in the INT field is read, which a test setting only the long field cannot show", () => {
    /*
     * A MUTATION ESCAPED: swapping `longValue ?? intValue` to the other order broke nothing, because
     * every test here sets only the long field, so the two orders give the same answer and the test
     * measures neither. 5.3 makes bdSeq an Int64/UInt64 and a publisher may put it in either field.
     */
    const { state } = foldMessages([
      received("spBv1.0/G1/NBIRTH/E1", payload({ metrics: [{ name: "bdSeq", datatype: INT64, intValue: 9 }] })),
    ]);
    expect(state.all()[0]?.birth?.bdSeq).toBe("9");
  });

  test("when BOTH fields carry a bdSeq the long one decides, which is the declared width", () => {
    // The case that distinguishes the order. 5.3's type is 64-bit, so the 64-bit field is the one
    // the declaration points at; the int field is what a narrow encoder falls back to.
    const { state } = foldMessages([
      received(
        "spBv1.0/G1/NBIRTH/E1",
        payload({ metrics: [{ name: "bdSeq", datatype: INT64, intValue: 1, longValue: 2 }] }),
      ),
    ]);
    expect(state.all()[0]?.birth?.bdSeq).toBe("2");
  });

  test("a code the specification does not name is still carried", () => {
    // The number is the publisher's word. Mapping an unrecognised code onto one of the three would
    // report a quality nobody claimed.
    expect(withQuality(propertySet([["Quality", 7]]))?.quality).toBe(7);
  });

  test("a metric with no Quality property has none, rather than a default", () => {
    expect(withQuality(undefined)?.quality).toBeUndefined();
    expect(withQuality(propertySet([["Other", 1]]))?.quality).toBeUndefined();
  });

  test("a PropertySet whose two arrays disagree in length has NO answer, not a guessed one", () => {
    /*
     * A PropertySet is two parallel arrays and only position ties them together, so a payload with
     * three keys and two values has no entry for the third key. Taking the value at an index the
     * keys do not reach would report a quality against a name the publisher never set it on.
     */
    const keysOnly = [
      ...stringField(1, "A"),
      ...stringField(1, "Quality"),
      ...messageField(2, [...uint64Field(3, 192)]),
    ];
    expect(withQuality(keysOnly)?.quality).toBeUndefined();

    // AND THE CASE THAT ACTUALLY DISTINGUISHES THE CHECK, which the one above does not. With two
    // keys and one value, a reader without the length check looks up index 1, finds nothing, and
    // answers undefined anyway: the same result either way, so that case measures nothing. With ONE
    // key and TWO values, `Quality` is at index 0 and `values[0]` EXISTS, so an unchecked reader
    // reports 192 from a payload whose pairing cannot be trusted. A mutation removing the check
    // survived until this was written.
    const extraValues = [
      ...stringField(1, "Quality"),
      ...messageField(2, [...uint64Field(3, 192)]),
      ...messageField(2, [...uint64Field(3, 500)]),
    ];
    expect(withQuality(extraValues)?.quality).toBeUndefined();
  });
});

describe("the protocol's own words are not reserved, and a user may use them", () => {
  /*
   * KURAL 54's addition, and it is a real collision rather than a hypothetical. 5.3 identifies the
   * birth-death sequence as a metric NAMED `bdSeq`; there is no field number for it, so finding it
   * means matching a name. Nothing stops an edge node publishing a metric of its own under that
   * name, and the sibling finding that produced this rule was a parser that took the FIRST match
   * and cut the document in half while the result still looked well formed.
   */
  test("TWO metrics named bdSeq make the birth-death sequence ambiguous, and neither is taken", () => {
    const { state, ambiguousBdSeq } = foldMessages([
      received(
        "spBv1.0/G1/NBIRTH/E1",
        payload({
          metrics: [
            { name: "bdSeq", datatype: INT64, longValue: 4 },
            { name: "bdSeq", datatype: INT64, longValue: 99 },
          ],
        }),
      ),
    ]);

    expect(ambiguousBdSeq).toBe(1);
    // NEITHER, and not the first: a wrong bdSeq makes a death match the wrong birth, which is
    // reported to a user as a node that died when it did not.
    expect(state.all()[0]?.birth?.bdSeq).toBeUndefined();
    // Both are still DEFINED metrics; only the sequence they claim to be is refused.
    expect(state.all()[0]?.birth?.metrics).toHaveLength(2);
  });

  test("a user metric named seq, timestamp, metrics or template changes nothing", () => {
    const { state, unresolved, ambiguousBdSeq } = foldMessages([
      received(
        "spBv1.0/G1/NBIRTH/E1",
        payload({
          timestamp: 500,
          seq: 0,
          metrics: [
            { name: "bdSeq", datatype: INT64, longValue: 2 },
            { name: "seq", alias: 1, datatype: INT64 },
            { name: "timestamp", alias: 2, datatype: INT64 },
            { name: "metrics", alias: 3, datatype: INT64 },
            { name: "template", alias: 4, datatype: INT64 },
          ],
        }),
      ),
      received("spBv1.0/G1/NDATA/E1", payload({ seq: 1, metrics: [{ alias: 3, longValue: 8 }] })),
    ]);

    const birth = state.all()[0]?.birth;
    expect(ambiguousBdSeq).toBe(0);
    // The payload's own `timestamp` and `seq` are read from their FIELD NUMBERS, so a metric that
    // happens to be called either of them cannot stand in for them.
    expect(birth?.payloadTimestamp).toBe("500");
    expect(birth?.bdSeq).toBe("2");
    expect(birth?.metrics.map((one) => one.name)).toEqual(["bdSeq", "seq", "timestamp", "metrics", "template"]);
    // And the alias of the metric named `metrics` resolves like any other.
    expect(unresolved).toEqual([]);
  });
});

describe("what a fold does with what it cannot read", () => {
  test("a payload the decoder refuses is counted and the fold carries on", () => {
    const { state, refusals } = foldMessages([
      // A length-delimited field whose length runs past the end of the payload.
      received("spBv1.0/G1/NBIRTH/E1", Uint8Array.from([...tag(2, 2), 0x7f, 0x01])),
      received("spBv1.0/G2/NBIRTH/E2", payload({ metrics: [{ name: "Temp", datatype: INT64 }] })),
    ]);

    // One refusal, and the message AFTER it still reached the state: a refusal that stopped the
    // fold would throw away everything behind it and report a larger loss as a smaller one.
    expect(Object.values(refusals).reduce((n, one) => n + one, 0)).toBe(1);
    expect(state.all().map((node) => node.edgeNodeId)).toEqual(["E2"]);
  });

  test("a topic the parser refuses is counted by its reason and is not a missing node", () => {
    const { state, rejectedTopics } = foldMessages([
      received("spAv2.0/G1/NBIRTH/E1", payload({})),
      received("spBv1.0/G1/NOPE/E1", payload({})),
    ]);
    expect(state.all()).toHaveLength(0);
    expect(Object.values(rejectedTopics).reduce((n, one) => n + one, 0)).toBe(2);
    expect(Object.keys(rejectedTopics).sort()).toEqual(["not-sparkplug-b", "unknown-message-type"]);
  });

  test("a message the byte cap stripped still proves its node exists, and claims nothing else", () => {
    const { state } = foldMessages([received("spBv1.0/G1/NDATA/E1", undefined)]);
    expect(state.all()).toHaveLength(1);
    expect(state.all()[0]?.birth).toBeUndefined();
  });
});

describe("what a birth certificate CARRIES, and not only what it declares", () => {
  /*
   * MEASURED ON A REAL BROKER. 4.1.1 requires a birth to publish every metric WITH ITS CURRENT
   * VALUE, and this fold kept only the name, the alias and the datatype. An edge node that published
   * one NBIRTH holding `Temperature` 99.9 and `ShiftName` "NIGHT-SHIFT", and then no data message at
   * all, rendered as two rows with a datatype and an EMPTY value - against a mosquitto, with the
   * bytes read off the wire by a subscriber that shares no code with this decoder.
   */
  const DOUBLE = 10;
  const STRING = 12;

  test("the value, its own timestamp and its datatype all survive the fold", () => {
    const { state } = foldMessages([
      received(
        "spBv1.0/G1/NBIRTH/E4",
        payload({
          timestamp: 500,
          seq: 0,
          metrics: [
            { name: "Temperature", alias: 40, datatype: DOUBLE, doubleValue: 99.9, timestamp: 1700 },
            { name: "ShiftName", alias: 41, datatype: STRING, stringValue: "NIGHT-SHIFT" },
          ],
        }),
      ),
    ]);
    const metrics = state.all()[0]?.birth?.metrics ?? [];
    expect(metrics.map((one) => [one.name, one.text, one.timestamp])).toEqual([
      ["Temperature", "99.9", "1700"],
      ["ShiftName", "NIGHT-SHIFT", undefined],
    ]);
  });

  test("a metric that carried NO value keeps none, so nothing is invented for it", () => {
    // The other half, and the one a careless fix breaks: reading an empty wire under a declared
    // datatype answers a mismatch, and a mismatch stored here would read as the publisher's fault.
    const { state } = foldMessages([
      received("spBv1.0/G1/NBIRTH/E5", payload({ seq: 0, metrics: [{ name: "Temp", alias: 1, datatype: DOUBLE }] })),
    ]);
    const metric = (state.all()[0]?.birth?.metrics ?? [])[0];
    expect(metric?.name).toBe("Temp");
    expect(metric?.text).toBeUndefined();
    expect(metric?.problem).toBeUndefined();
  });
});
