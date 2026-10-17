/**
 * The topic parser's traps, each one a measured case from section 4.8 of the proposal.
 *
 * Every test here fails loudly if the parse is done by splitting on `/` and trusting positions,
 * which is the mistake each case was found by.
 */
import { describe, expect, test } from "bun:test";
import { groupIdIsFilterSafe, parseTopic, readFilters } from "@/lib/db/providers/industrial/sparkplug/topics";
import { listGroups } from "@/lib/db/providers/industrial/sparkplug/objects";
import { ReadState } from "@/lib/db/providers/industrial/sparkplug/state";

describe("the code-point order breaks a tie by length", () => {
  // The tail of `compareCodePoints`: where one name is a PREFIX of the other every code point
  // matches and only the length decides. Coverage found this branch unwalked.
  test("a prefix sorts before the longer name that contains it", () => {
    const state = new ReadState();
    for (const group of ["Line", "Line1", "Lin"]) {
      const parsed = parseTopic(`spBv1.0/${group}/NBIRTH/E1`);
      if (parsed.kind !== "node") throw new Error(group);
      state.takeBirth(parsed, { origin: "live", receivedAt: 1, metrics: [] });
    }
    expect(listGroups(state).map((one) => one.name)).toEqual(["Lin", "Line", "Line1"]);
  });
});

describe("a Sparkplug 2.2 host's state is outside what this read subscribes to", () => {
  /*
   * ISSUE #1720 ASKS THIS OUTRIGHT (its open question 10): what does v1 show for a 2.2 host's
   * `STATE/<host_id>` carrying `ONLINE` or `OFFLINE`? The measured answer is that it shows nothing,
   * and the reason is the TOPIC rather than the body: 2.2 put host state at `STATE/<scada_host_id>`
   * (2.2 section 7.5), outside the `spBv1.0` namespace, while 3.0 moved it to
   * `spBv1.0/STATE/<host_id>` as JSON. Every filter this read sends is under `spBv1.0`, so a 2.2
   * host's state never reaches this provider at all.
   *
   * Written as a test rather than a sentence because it is the kind of fact that looks like a defect
   * later: someone with a 2.2 host will see no host state and reach for the parser.
   */
  test("the 2.2 topic is not in this namespace, and the 3.0 one is", () => {
    const old = parseTopic("STATE/primary");
    expect(old.kind).toBe("rejected");
    if (old.kind === "rejected") expect(old.reason).toBe("not-sparkplug-b");

    const current = parseTopic("spBv1.0/STATE/primary");
    expect(current.kind).toBe("host-state");
  });

  test("no filter this read sends could carry the 2.2 topic", () => {
    for (const filter of readFilters(undefined)) expect(filter.startsWith("STATE/")).toBe(false);
    for (const filter of readFilters("G1")) expect(filter.startsWith("STATE/")).toBe(false);
  });
});

describe("the level count is held from BOTH sides (KURAL 112)", () => {
  /*
   * A THRESHOLD TESTED FROM ONE SIDE MEASURES ITSELF AND NOT THE THRESHOLD. Shifting `levels.length
   * < 3` to `< 2` broke no test, so nothing held the line at three: 4.1 puts the namespace, the
   * group and the message type at fixed levels, and a topic with only two of them names no message.
   */
  test("two levels is too few, and three is the shortest topic that parses", () => {
    const short = parseTopic("spBv1.0/G1");
    expect(short.kind).toBe("rejected");
    if (short.kind === "rejected") expect(short.reason).toBe("too-few-levels");

    // Three levels is STATE, the one form where the third level is not a message type.
    const three = parseTopic("spBv1.0/STATE/primary");
    expect(three.kind).toBe("host-state");
  });
});

describe("STATE stands in the group position and the host id is every level after it", () => {
  test("a plain host id", () => {
    expect(parseTopic("spBv1.0/STATE/IamHost")).toEqual({ kind: "host-state", hostId: "IamHost" });
  });

  test("a host id containing a slash is NOT a group named STATE", () => {
    // 6.4.27 lets a host id be any UTF-8 string, `/` included. Read positionally this looks like
    // an NBIRTH of a group called STATE, which is the trap.
    expect(parseTopic("spBv1.0/STATE/NBIRTH/e1")).toEqual({ kind: "host-state", hostId: "NBIRTH/e1" });
  });

  test("a group literally named STATE is read as host state, and cannot be anything else", () => {
    // 4.1.2 does not forbid a group named STATE, and such a group's topics are byte for byte what
    // host state looks like. This asserts the limit rather than a wish: the group is unreachable,
    // which is what the proposal's section 4.8 says too.
    expect(parseTopic("spBv1.0/STATE/NBIRTH")).toEqual({ kind: "host-state", hostId: "NBIRTH" });
    expect(parseTopic("spBv1.0/STATE/NBIRTH/E1")).toEqual({ kind: "host-state", hostId: "NBIRTH/E1" });
  });
});

describe("the device level is read from the message type, never guessed", () => {
  test("NBIRTH has no device level", () => {
    expect(parseTopic("spBv1.0/G1/NBIRTH/E1")).toEqual({
      kind: "node",
      groupId: "G1",
      messageType: "NBIRTH",
      edgeNodeId: "E1",
      stored: false,
    });
  });

  test("DBIRTH has one", () => {
    expect(parseTopic("spBv1.0/G1/DBIRTH/E1/D1")).toEqual({
      kind: "node",
      groupId: "G1",
      messageType: "DBIRTH",
      edgeNodeId: "E1",
      deviceId: "D1",
      stored: false,
    });
  });

  test("a device level on a node message breaks 4.1.5 and is marked malformed", () => {
    expect(parseTopic("spBv1.0/G1/NDATA/E1/D1")).toMatchObject({ kind: "rejected", reason: "device-level-unexpected" });
  });

  test("a missing device level on a device message is marked malformed", () => {
    expect(parseTopic("spBv1.0/G1/DDATA/E1")).toMatchObject({ kind: "rejected", reason: "device-level-missing" });
  });

  test("an EMPTY device level is malformed too, not a device with no name", () => {
    // A trailing slash is a legal MQTT topic, so `.../DDATA/E1/` arrives as a device level that is
    // the empty string. A mutation run found this case untested: narrowing the check to
    // `tail.length === 0` passed every other test while letting a device named "" into the tree.
    expect(parseTopic("spBv1.0/G1/DDATA/E1/")).toMatchObject({ kind: "rejected", reason: "device-level-missing" });
    expect(parseTopic("spBv1.0/G1/DBIRTH/E1/")).toMatchObject({ kind: "rejected", reason: "device-level-missing" });
  });

  test("an empty edge node level is malformed", () => {
    expect(parseTopic("spBv1.0/G1/NBIRTH/")).toMatchObject({ kind: "rejected", reason: "empty-level" });
  });

  test("an empty group level is malformed", () => {
    expect(parseTopic("spBv1.0//NBIRTH/E1")).toMatchObject({ kind: "rejected", reason: "empty-level" });
  });
});

describe("the stored-birth root is stripped and remembered", () => {
  test("a stored NBIRTH parses to the same node with stored true", () => {
    expect(parseTopic("$sparkplug/certificates/spBv1.0/G1/NBIRTH/E1")).toEqual({
      kind: "node",
      groupId: "G1",
      messageType: "NBIRTH",
      edgeNodeId: "E1",
      stored: true,
    });
  });

  test("a stored DBIRTH keeps its device level", () => {
    expect(parseTopic("$sparkplug/certificates/spBv1.0/G1/DBIRTH/E1/D1")).toMatchObject({
      stored: true,
      deviceId: "D1",
    });
  });
});

describe("another namespace is not this specification", () => {
  test.each([
    ["spAv1.0/G1/NBIRTH/E1", "Sparkplug A"],
    ["spCv4.0/G1/NBIRTH/E1", "the 4.0 draft"],
    ["$SYS/broker/version", "a broker's own tree"],
  ])("%s is refused (%s)", (topic) => {
    expect(parseTopic(topic)).toMatchObject({ kind: "rejected", reason: "not-sparkplug-b" });
  });
});

describe("an unknown message type is refused with its own reason", () => {
  test("a typo is not read as a message type", () => {
    expect(parseTopic("spBv1.0/G1/NBIRTHH/E1")).toMatchObject({ kind: "rejected", reason: "unknown-message-type" });
  });
});

describe("a group name that cannot be filtered is refused before any socket", () => {
  test.each([
    ["G1", true],
    ["plant/line1", false],
    ["G+", false],
    ["G#", false],
    ["", false],
  ])("%s is filter safe: %s", (group, safe) => {
    expect(groupIdIsFilterSafe(group)).toBe(safe);
  });
});

describe("the read's filters never overlap, because an overlap costs a second copy", () => {
  /**
   * MQTT 5.0 3.3.4 lets a server deliver "further copies of the message, one for each additional
   * matching subscription". Two filters overlap when one matches a topic the other also matches.
   * This is the property, checked rather than eyeballed, because the first version of
   * `readFilters` DID overlap: it added `spBv1.0/STATE/#` beside `spBv1.0/#`, which already
   * matches every STATE topic.
   */
  function matches(filter: string, topic: string): boolean {
    const f = filter.split("/");
    const t = topic.split("/");
    for (let i = 0; i < f.length; i++) {
      if (f[i] === "#") return true;
      if (f[i] === "+") {
        if (t[i] === undefined) return false;
        continue;
      }
      if (f[i] !== t[i]) return false;
    }
    return f.length === t.length;
  }

  const topics = [
    "spBv1.0/G1/NBIRTH/E1",
    "spBv1.0/G1/DDATA/E1/D1",
    "spBv1.0/STATE/IamHost",
    "spBv1.0/STATE/NBIRTH/e1",
    "$sparkplug/certificates/spBv1.0/G1/NBIRTH/E1",
    "$sparkplug/certificates/spBv1.0/G1/DBIRTH/E1/D1",
  ];

  test.each([[undefined], ["G1"]])("no topic matches two filters at once (group: %s)", (group) => {
    const filters = readFilters(group);
    for (const topic of topics) {
      const hits = filters.filter((f) => matches(f, topic));
      expect(hits.length).toBeLessThanOrEqual(1);
    }
  });

  test("with no group named, the group filter already covers host state", () => {
    const filters = readFilters();
    expect(filters.some((f) => matches(f, "spBv1.0/STATE/IamHost"))).toBe(true);
    expect(filters).not.toContain("spBv1.0/STATE/#");
  });

  test("with a group named, host state needs its own filter", () => {
    const filters = readFilters("G1");
    expect(filters).toContain("spBv1.0/STATE/#");
    expect(filters.some((f) => matches(f, "spBv1.0/STATE/IamHost"))).toBe(true);
  });

  test("a named group's filters do not reach another group", () => {
    const filters = readFilters("G1");
    expect(filters.some((f) => matches(f, "spBv1.0/G2/NBIRTH/E9"))).toBe(false);
  });
});
