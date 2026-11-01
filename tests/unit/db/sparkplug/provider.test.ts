/**
 * The provider class: what it declares without connecting, what it refuses before a socket, and
 * what it answers from one read.
 *
 * Every read here goes through the reader seam with a `ReadState` built by hand, so the test drives
 * the same class the product does and no broker is involved.
 */
import { describe, expect, test } from "bun:test";
import { QUERY_DIALECTS } from "@/lib/db/query-dialects";
import {
  SPARKPLUG_DEFAULT_PORT,
  SparkplugProvider,
  type SparkplugReadOutcome,
} from "@/lib/db/providers/industrial/sparkplug";
import { ReadState } from "@/lib/db/providers/industrial/sparkplug/state";
import { parseTopic } from "@/lib/db/providers/industrial/sparkplug/topics";
import type { NodeTopic } from "@/lib/db/providers/industrial/sparkplug/topics";
import type { DatabaseConnection } from "@/lib/types";

const connection = (over: Partial<DatabaseConnection> = {}): DatabaseConnection =>
  ({ id: "c1", name: "plant", type: "mqtt", host: "broker.invalid", port: 1883, ...over }) as DatabaseConnection;

const topic = (t: string) => parseTopic(t) as NodeTopic;

function readWith(): SparkplugReadOutcome {
  const state = new ReadState();
  state.takeBirth(topic("spBv1.0/G1/NBIRTH/E1"), {
    origin: "live",
    bdSeq: "4",
    payloadTimestamp: "1760000000000",
    receivedAt: 1_000,
    metrics: [
      { name: "ints/i8", alias: "2", datatype: 1 },
      { name: "f/temp", alias: "3", datatype: 9 },
    ],
  });
  state.takeBirth(topic("spBv1.0/G1/DBIRTH/E1/D1"), {
    origin: "stored",
    bdSeq: "4",
    receivedAt: 1_000,
    // The certificate carries the value it published, as a real one does (4.1.1): the fixture used
    // to declare a name and a datatype only, so `birthTime` could be asserted on a row with no value.
    metrics: [{ name: "dev/p", alias: "40", datatype: 3, text: "7" }],
  });
  state.takeBirth(topic("spBv1.0/G2/NBIRTH/E9"), {
    origin: "rebirth",
    bdSeq: "1",
    receivedAt: 1_000,
    metrics: [{ name: "only", alias: "7", datatype: 12 }],
  });
  return { state, endReason: "the 3 second budget ended the read", messagesSeen: 12, bytesSeen: 900 };
}

const openProvider = async (over: Partial<DatabaseConnection> = {}) => {
  const provider = new SparkplugProvider(connection(over), {}, {}, async () => readWith());
  await provider.connect();
  return provider;
};

describe("what it declares without connecting", () => {
  test("read-only is declared, and no maintenance is offered", () => {
    const declared = new SparkplugProvider(connection()).getCapabilities();
    expect(declared.enforcesReadOnly).toBe(true);
    expect(declared.supportsMaintenance).toBe(false);
    expect(declared.maintenanceOperations).toEqual([]);
    expect(declared.createTable).toBeUndefined();
    expect(declared.supportsInlineRowEdit).toBe(false);
    expect(declared.supportsTransactions).toBe(false);
  });

  test("two container levels, Group then Edge node, and two object kinds", () => {
    const declared = new SparkplugProvider(connection()).getCapabilities();
    expect(declared.containerLevels?.map((level) => level.label)).toEqual(["Group", "Edge node"]);
    expect(declared.objectKinds?.map((kind) => kind.id)).toEqual(["node", "device"]);
  });

  test("the query language is json and the dialect is this provider's own, not MongoDB's", () => {
    /*
     * THIS ASSERTION USED TO PIN THE ABSENCE, and it said so: "when the registration lands, this is
     * the one that has to change". It has, and what replaced it is the thing the absence cost. A
     * `json` provider with no dialect of its own falls back to MongoDB's tab type, and the dialect
     * registry's golden file recorded exactly that before the registration: `tabType: "mongodb"`,
     * with column profiling, code generation and a count query all true. Four offers for an engine
     * that can do none of them.
     *
     * Naming the dialect is not enough on its own, so the registry is asserted beside it: a dialect
     * named but not registered is a tab type nothing can render.
     */
    const declared = new SparkplugProvider(connection()).getCapabilities();
    expect(declared.queryLanguage).toBe("json");
    expect(declared.queryDialect).toBe("sparkplug");
    expect(QUERY_DIALECTS.sparkplug).toEqual({
      tabType: "sparkplug",
      offersColumnProfiling: false,
      offersCodeGeneration: false,
      offersCountQuery: false,
    });
  });

  test("the default port is MQTT's", () => {
    expect(new SparkplugProvider(connection()).getCapabilities().defaultPort).toBe(SPARKPLUG_DEFAULT_PORT);
    expect(SPARKPLUG_DEFAULT_PORT).toBe(1883);
  });

  test("nothing a read runs can change the tree", () => {
    expect(new SparkplugProvider(connection()).getCapabilities().schemaRefreshPattern).toBe("(?!)");
  });

  test("the labels claim neither the mark nor the host application role", () => {
    const labels = JSON.stringify(new SparkplugProvider(connection()).getLabels());
    expect(labels).not.toContain("Sparkplug Compatible");
    expect(labels).not.toContain("Host Application");
    expect(labels).toContain("Edge node");
  });

  test("a read adds no limit of its own, because the budgets are the bound", () => {
    expect(new SparkplugProvider(connection()).prepareQuery('{"group":"G1"}')).toEqual({
      query: '{"group":"G1"}',
      wasLimited: false,
      limit: 0,
      offset: 0,
    });
  });
});

describe("what it refuses before any socket exists", () => {
  test("a connection with no host", async () => {
    const provider = new SparkplugProvider(connection({ host: "" }), {}, {}, async () => readWith());
    await expect(provider.connect()).rejects.toThrow(/needs a broker address/);
  });

  test.each([[0], [70_000], [1.5]])("a port outside 1 to 65,535 (%s)", async (port) => {
    const provider = new SparkplugProvider(connection({ port }), {}, {}, async () => readWith());
    await expect(provider.connect()).rejects.toThrow(/port between 1 and 65,535/);
  });

  test.each([["plant/line1"], ["G+"], ["G#"]])("a group name that cannot be a filter (%s)", async (database) => {
    const provider = new SparkplugProvider(connection({ database }), {}, {}, async () => readWith());
    await expect(provider.connect()).rejects.toThrow(/cannot contain/);
  });

  test("an empty group field means every group and is not refused", async () => {
    const provider = new SparkplugProvider(connection({ database: "" }), {}, {}, async () => readWith());
    await expect(provider.connect()).resolves.toBeUndefined();
  });

  test("with no reader seam the provider DIALS, and a dial that never opened is not an empty read", async () => {
    /*
     * THIS TEST HAS BEEN WRONG TWICE, in two different ways, and both are worth keeping written
     * down because they are different mistakes.
     *
     * First it asserted /shared MQTT transport/, pinning a sentence that stopped being true the
     * moment this provider got its own session. A test that holds a false sentence makes the false
     * sentence read as a verified one, which is worse than not testing it at all.
     *
     * Then the refusal it was built on stopped existing: an empty seam no longer means the provider
     * cannot read, it means the provider dials for itself. What is worth asserting now is the thing
     * wiring the dial actually exposed - that a socket which never opened is reported as a failure
     * naming the address, and not as a read that saw nothing. "0 rows, ended: dial-failed" reads as
     * a quiet broker; a user who typed the wrong host needs to be told the connection was not made.
     *
     * Driven through the seam rather than a socket, so this stays a unit test.
     */
    const provider = new SparkplugProvider(connection({ host: "broker.invalid", port: 1883 }), {}, {}, async () => ({
      state: new ReadState(),
      endReason: "dial-failed",
      messagesSeen: 0,
      bytesSeen: 0,
    }));

    await expect(provider.connect()).rejects.toThrow(/broker\.invalid:1883/);
    // And the old claim must not come back under a new name.
    await expect(provider.connect()).rejects.not.toThrow(/shared MQTT transport/);
  });

  test("the tree lists the node's metrics and its devices, with a status only where one is due", async () => {
    /*
     * COVERAGE SAID THIS PATH WAS NEVER WALKED. `objects.ts` is tested indirectly, through the
     * provider, and that is a legitimate route: 89 percent of its functions and 81 percent of its
     * lines are covered that way. But `listObjects` with a POPULATED state, and the liveness status
     * wired today, were in the uncovered 19 percent, which is the half that matters most: a status
     * is what a reader acts on.
     */
    // STORED and not live, which my own comment said and my first version did not do: a birth that
    // arrived DURING the read is a publication, so a live one would make the node "published during
    // this read". A stored certificate is the copy the broker already had.
    const quiet = new ReadState();
    quiet.takeBirth(topic("spBv1.0/G1/NBIRTH/E1"), { origin: "stored", receivedAt: 1, metrics: [] });
    quiet.takeBirth(topic("spBv1.0/G1/DBIRTH/E1/D1"), { origin: "stored", receivedAt: 1, metrics: [] });

    const provider = new SparkplugProvider(connection(), {}, {}, async () => ({
      state: quiet,
      endReason: "time-budget",
      messagesSeen: 0,
      bytesSeen: 0,
    }));
    await provider.connect();

    const nodes = await provider.listObjects(["G1", "E1"], "node");
    expect(nodes.map((one) => one.name)).toEqual(["E1"]);
    // A node seen only through a stored certificate published nothing during the read, so it carries
    // the one status a read can honestly give. The word "online" appears nowhere.
    expect(nodes[0]?.status).toBe("not seen in this read");

    const devices = await provider.listObjects(["G1", "E1"], "device");
    expect(devices.map((one) => one.name)).toEqual(["D1"]);

    // And the long form of that status, which is the sentence the short word must not be read
    // without: a quiet node and a gone node look the same from a read.
    const document = await provider.readObjectSource(["G1", "E1"], "node");
    // Narrowed before reading `text`, which also asserts the part is the AVAILABLE kind rather than
    // the `unavailable` one: a sentence nobody can read is not a sentence that reached a reader.
    const liveness = document.parts.find((part) => part.id === "liveness");
    expect(liveness !== undefined && "text" in liveness).toBe(true);
    if (liveness !== undefined && "text" in liveness) {
      expect(liveness.text).toContain("not evidence that it is gone");
    }
  });

  test("a node that published during the read carries NO status, because that is the ordinary case", async () => {
    const live = new ReadState();
    const node = topic("spBv1.0/G1/NBIRTH/E1");
    live.takeBirth(node, { origin: "live", receivedAt: 1, metrics: [] });
    live.takeSeq(node, 0);

    const provider = new SparkplugProvider(connection(), {}, {}, async () => ({
      state: live,
      endReason: "time-budget",
      messagesSeen: 1,
      bytesSeen: 10,
    }));
    await provider.connect();
    const nodes = await provider.listObjects(["G1", "E1"], "node");
    expect(nodes[0]?.status).toBeUndefined();
  });

  test("a death seen in the read is its own status, and the Source tab carries the sentence", async () => {
    const died = new ReadState();
    const node = topic("spBv1.0/G1/NBIRTH/E1");
    died.takeBirth(node, { origin: "live", bdSeq: "7", receivedAt: 1, metrics: [] });
    died.takeDeath(topic("spBv1.0/G1/NDEATH/E1"), "7", 2);

    const provider = new SparkplugProvider(connection(), {}, {}, async () => ({
      state: died,
      endReason: "time-budget",
      messagesSeen: 2,
      bytesSeen: 20,
    }));
    await provider.connect();
    expect((await provider.listObjects(["G1", "E1"], "node"))[0]?.status).toBe("death seen in this read");

    // The long form lives beside the certificate, and names the bdSeq it was matched to.
    const document = await provider.readObjectSource(["G1", "E1"], "node");
    const liveness = document.parts.find((part) => part.id === "liveness");
    expect(liveness !== undefined && "text" in liveness).toBe(true);
    if (liveness !== undefined && "text" in liveness) {
      expect(liveness.text).toContain("bdSeq 7");
    }
  });

  test("a death that carries no bdSeq is still a death, and the sentence names no bdSeq it does not have", async () => {
    const died = new ReadState();
    died.takeBirth(topic("spBv1.0/G1/NBIRTH/E1"), { origin: "live", receivedAt: 1, metrics: [] });
    died.takeDeath(topic("spBv1.0/G1/NDEATH/E1"), undefined, 2);

    const provider = new SparkplugProvider(connection(), {}, {}, async () => ({
      state: died,
      endReason: "time-budget",
      messagesSeen: 2,
      bytesSeen: 20,
    }));
    await provider.connect();
    const document = await provider.readObjectSource(["G1", "E1"], "node");
    const liveness = document.parts.find((part) => part.id === "liveness");
    expect(liveness !== undefined && "text" in liveness ? liveness.text : undefined).toBe(
      "A death message arrived during this read.",
    );
  });

  test("the four connection refusals each send a reader somewhere different", async () => {
    /*
     * MEASURED, AND THE MEASUREMENT SAYS WHY THIS TEST IS THE SENTENCES AND NOT A FIELD. All four
     * throw a `QueryError` carrying the same `ApiErrorCode`, so today the only thing that tells them
     * apart is the English. A count settled whether to add a typed field instead of guessing: of the
     * fifteen error subclasses in `src/lib/db`, exactly ONE carries a typed distinguishing reason,
     * and it is this provider's own `PayloadRefused`. Fourteen do not. So a typed field here would be
     * this session inventing a convention from its own single example, which is why the gap is
     * written down for a later change rather than closed with a mechanism of this module's own.
     *
     * What CAN be held today is that the four sentences do different work, because the four send an
     * operator to four different places: the address, the credentials, the filter, and the broker.
     */
    const messages: string[] = [];
    for (const endReason of ["dial-failed", "connect-refused", "subscription-refused", "wildcards-unavailable"]) {
      const provider = new SparkplugProvider(connection({ host: "plant.example", port: 1883 }), {}, {}, async () => ({
        state: new ReadState(),
        endReason,
        messagesSeen: 0,
        bytesSeen: 0,
      }));
      const error = await provider.connect().then(
        () => undefined,
        (caught: unknown) => caught as Error,
      );
      expect(error, endReason).toBeDefined();
      messages.push(error?.message ?? "");
    }

    // Four distinct sentences, and every one names the address it failed against.
    expect(new Set(messages).size).toBe(4);
    for (const message of messages) expect(message).toContain("plant.example:1883");

    // And each names ITS OWN next step, which is the thing a shared code would not carry.
    expect(messages[0]).toMatch(/check the address/);
    expect(messages[1]).toMatch(/would not accept is this client/);
    expect(messages[2]).toMatch(/NOT a quiet plant/);
    expect(messages[3]).toMatch(/no narrower filter/);
  });

  test("every other end reason IS a read, including a broker that closed on us", async () => {
    // The other half of the pair, and the reason the two are separate values: a connection that
    // worked and then ended has what it saw and why it stopped, so it must not be thrown away.
    for (const endReason of ["time-budget", "message-budget", "byte-budget", "broker-closed", "frame-refused"]) {
      const provider = new SparkplugProvider(connection(), {}, {}, async () => ({
        state: new ReadState(),
        endReason,
        messagesSeen: 0,
        bytesSeen: 0,
      }));
      await expect(provider.connect()).resolves.toBeUndefined();
    }
  });

  test("a surface asked before connect says the connection is not open", async () => {
    const provider = new SparkplugProvider(connection(), {}, {}, async () => readWith());
    await expect(provider.listContainers()).rejects.toThrow(/not open/);
  });
});

describe("the tree one read produces", () => {
  test("the groups the read saw, in code point order", async () => {
    const provider = await openProvider();
    expect((await provider.listContainers()).map((c) => c.name)).toEqual(["G1", "G2"]);
  });

  test("the edge nodes of one group", async () => {
    const provider = await openProvider();
    expect((await provider.listContainers(["G1"])).map((c) => c.name)).toEqual(["E1"]);
    expect((await provider.listContainers(["G2"])).map((c) => c.name)).toEqual(["E9"]);
  });

  test("names are ordered by CODE POINT, which the default sort gets wrong", async () => {
    /*
     * THE NAMES MATTER. Every other test here uses ASCII group ids, where the default sort and
     * code point order agree, so a mutation replacing `sort(compareCodePoints)` with `sort()`
     * passed all of them. A group id is "any UTF-8 string", so the difference is reachable.
     *
     * U+10000 is a surrogate pair starting at U+D800, so `Array.prototype.sort` puts it BEFORE
     * U+FFFD (65533). By code point U+FFFD comes first, which is also UTF-8 byte order.
     */
    const astral = String.fromCodePoint(0x10000);
    const replacement = "\uFFFD";
    expect([astral, replacement].sort()).toEqual([astral, replacement]);

    const state = new ReadState();
    for (const group of [astral, replacement]) {
      state.takeBirth(parseTopic(`spBv1.0/${group}/NBIRTH/E1`) as NodeTopic, {
        origin: "live",
        bdSeq: "0",
        receivedAt: 1,
        metrics: [{ name: "m", alias: "2", datatype: 1 }],
      });
    }
    const provider = new SparkplugProvider(connection(), {}, {}, async () => ({
      state,
      endReason: "budget",
      messagesSeen: 2,
      bytesSeen: 20,
    }));
    await provider.connect();
    expect((await provider.listContainers()).map((c) => c.name)).toEqual([replacement, astral]);
  });

  test("a third level is not listed, because a device is an object and not a level", async () => {
    const provider = await openProvider();
    expect(await provider.listContainers(["G1", "E1"])).toEqual([]);
  });

  test("the counts under one edge node", async () => {
    const provider = await openProvider();
    expect(await provider.countObjects(["G1", "E1"])).toEqual({ node: { count: 1 }, device: { count: 1 } });
  });

  test("an edge node with no certificate produces no node object", async () => {
    const state = new ReadState();
    state.takeSeq(topic("spBv1.0/G3/NDATA/E3"), 1);
    const provider = new SparkplugProvider(connection(), {}, {}, async () => ({
      state,
      endReason: "budget",
      messagesSeen: 1,
      bytesSeen: 10,
    }));
    await provider.connect();
    expect(await provider.listObjects(["G3", "E3"], "node")).toEqual([]);
    expect(await provider.countObjects(["G3", "E3"])).toEqual({ node: { count: 0 }, device: { count: 0 } });
  });

  test("the columns of an object are the metrics its certificate declared, typed by datatype", async () => {
    const provider = await openProvider();
    const detail = await provider.describeObject(["G1", "E1"], "node");
    expect(detail.columns.map((column) => [column.name, column.type])).toEqual([
      ["f/temp", "Float"],
      ["ints/i8", "Int8"],
    ]);
    expect(detail.indexes).toEqual([]);
    expect(detail.foreignKeys).toEqual([]);
  });

  test("no column is nullable, because a certificate cannot say so", async () => {
    const provider = await openProvider();
    const detail = await provider.describeObject(["G1", "E1"], "node");
    expect(detail.columns.every((column) => column.nullable === false)).toBe(true);
    expect(detail.columns.every((column) => column.isPrimary === false)).toBe(true);
  });
});

describe("the certificate behind an object", () => {
  test("a stored certificate says it is stored", async () => {
    const provider = await openProvider();
    const document = await provider.readObjectSource(["G1", "E1", "D1"], "device");
    const part = document.parts[0];
    expect("origin" in part ? part.origin : undefined).toBe("stored");
  });

  test("a live certificate is rendered rather than stored", async () => {
    const provider = await openProvider();
    const document = await provider.readObjectSource(["G1", "E1"], "node");
    const part = document.parts[0];
    expect("origin" in part ? part.origin : undefined).toBe("rendered");
    expect("text" in part ? part.text : "").toContain('"bdSeq": "4"');
  });

  test("no certificate gives a sentence that says why, not an empty document", async () => {
    const state = new ReadState();
    state.takeSeq(topic("spBv1.0/G4/NDATA/E4"), 0);
    const provider = new SparkplugProvider(connection(), {}, {}, async () => ({
      state,
      endReason: "budget",
      messagesSeen: 1,
      bytesSeen: 1,
    }));
    await provider.connect();
    const document = await provider.readObjectSource(["G4", "E4"], "node");
    const part = document.parts[0];
    expect("unavailable" in part ? part.unavailable : "").toContain("QoS 0 and not retained");
  });
});

describe("the console read", () => {
  test("one row per declared metric, with where the definition came from", async () => {
    const provider = await openProvider();
    const result = await provider.query('{"group":"G1","edgeNode":"E1"}');
    expect(result.rowCount).toBe(3);
    // The provenance columns are part of the contract, not decoration: a row's name and datatype
    // are only as good as the certificate they were resolved against.
    expect(result.fields).toContain("definedBy");
    expect(result.fields).toContain("birthTime");
    expect(result.fields).toContain("bdSeq");
    const stored = result.rows.find((row) => row.metric === "dev/p");
    // `definedBy` says which certificate named the metric; `birthTime` says the VALUE in this row is
    // the one that certificate carried, which is why the row below is `true` and the live one is not:
    // the live node's metric reached this read through a data message.
    expect(stored).toMatchObject({ device: "D1", definedBy: "stored", birthTime: true, value: "7" });
    const live = result.rows.find((row) => row.metric === "f/temp");
    expect(live).toMatchObject({ device: null, definedBy: "live", birthTime: false });
  });

  test("the window REACHES THE READER, and two windows reach it differently", async () => {
    /*
     * THE DEFECT THIS TEST WAS WRITTEN FOR. The first version of the console accepted `seconds` up
     * to 300, printed it back in the result's own sentence, and then served rows from the read the
     * CONNECT had already performed. A user who asked for 42 seconds was told they got 42 and got
     * 3. A number a user can set, that is echoed back and changes nothing, is worse than a field
     * that is not offered: it reads as a measurement of something.
     *
     * So the assertion is on what the READER was handed, not on the sentence. The sentence was
     * already right while the behaviour was wrong, which is exactly why asserting the sentence
     * alone did not catch it.
     */
    const gorulen: number[] = [];
    const provider = new SparkplugProvider(connection(), {}, {}, async (request) => {
      gorulen.push(request.windowSeconds);
      return readWith();
    });
    await provider.connect();
    await provider.query('{"seconds":42}');
    await provider.query('{"seconds":7}');
    await provider.query("{}");
    // The connect read uses the default; then the three console reads use what they asked for.
    expect(gorulen).toEqual([3, 42, 7, 3]);
  });

  test("the window in the scope line is the window ASKED FOR, not a constant", async () => {
    /*
     * TWO CASES THAT DISAGREE, and the rule is why. The only test here used the default window, so
     * hardcoding `3` in the scope sentence would have passed it: the test said "the window is
     * named" and not "the RIGHT window is named". This is the third time the same class of fault
     * has turned up in my own tests, after a bdSeq pair that a 32-bit comparison answers
     * identically and an ordering test whose ASCII names both sorts agree on.
     */
    const provider = await openProvider();
    const varsayilan = await provider.query("{}");
    const ongorulen = await provider.query('{"seconds":42}');
    expect(varsayilan.warnings?.[0]?.message).toContain("3 second window");
    expect(ongorulen.warnings?.[0]?.message).toContain("42 second window");
    expect(ongorulen.warnings?.[0]?.message).not.toContain("3 second window");
  });

  test("the row bound in the scope line is the bound ASKED FOR", async () => {
    const provider = await openProvider();
    expect((await provider.query("{}")).warnings?.[0]?.message).toContain("10,000 rows");
    expect((await provider.query('{"limit":7}')).warnings?.[0]?.message).toContain("7 rows");
  });

  test("the scope line names the scope ASKED FOR, and the three scopes differ", async () => {
    const provider = await openProvider();
    const everyGroup = await provider.query("{}");
    const oneGroup = await provider.query('{"group":"G1"}');
    const oneNode = await provider.query('{"group":"G1","edgeNode":"E1"}');
    expect(everyGroup.warnings?.[0]?.message).toContain("every group");
    expect(oneGroup.warnings?.[0]?.message).toContain("group G1");
    expect(oneGroup.warnings?.[0]?.message).not.toContain("every group");
    expect(oneNode.warnings?.[0]?.message).toContain("edge node G1/E1");
  });

  test("a limit is honoured, and two different limits give two different counts", async () => {
    const provider = await openProvider();
    expect((await provider.query('{"limit":2}')).rowCount).toBe(2);
    expect((await provider.query('{"limit":3}')).rowCount).toBe(3);
    // And the unbounded read is larger than both, so neither number is the whole result.
    expect((await provider.query("{}")).rowCount).toBeGreaterThan(3);
  });

  test("a row's bdSeq is its OWN certificate's, and two certificates carry different ones", async () => {
    // The fixture gives G1/E1 bdSeq 4 and G2/E9 bdSeq 1. A row that reported a constant, or null,
    // would pass a single-case assertion.
    const provider = await openProvider();
    const rows = (await provider.query("{}")).rows;
    expect(rows.find((row) => row.edgeNode === "E1")?.bdSeq).toBe("4");
    expect(rows.find((row) => row.edgeNode === "E9")?.bdSeq).toBe("1");
  });

  test("definedBy carries all three origins, not just the two easy ones", async () => {
    const provider = await openProvider();
    const rows = (await provider.query("{}")).rows;
    expect(new Set(rows.map((row) => row.definedBy))).toEqual(new Set(["stored", "live", "rebirth"]));
  });

  test("a row's liveness is its node's, and two nodes differ", async () => {
    const state = new ReadState();
    const live = parseTopic("spBv1.0/GA/NBIRTH/EA") as NodeTopic;
    const gone = parseTopic("spBv1.0/GB/NBIRTH/EB") as NodeTopic;
    for (const [t, bd] of [
      [live, "1"],
      [gone, "2"],
    ] as const) {
      state.takeBirth(t, {
        origin: "live",
        bdSeq: bd,
        receivedAt: 1,
        metrics: [{ name: "m", alias: "2", datatype: 1 }],
      });
    }
    state.takeDeath(parseTopic("spBv1.0/GB/NDEATH/EB") as NodeTopic, "2", 5_000);
    const provider = new SparkplugProvider(connection(), {}, {}, async () => ({
      state,
      endReason: "budget",
      messagesSeen: 3,
      bytesSeen: 30,
    }));
    await provider.connect();
    const rows = (await provider.query("{}")).rows;
    expect(rows.find((row) => row.edgeNode === "EA")?.liveness).toBe("published-during-read");
    expect(rows.find((row) => row.edgeNode === "EB")?.liveness).toBe("death-seen-in-this-read");
  });

  test("both warning lines travel with the result: what was asked, and what it could not answer", async () => {
    const provider = await openProvider();
    const result = await provider.query("{}");
    // The scope first, because a row count alone reads as a total.
    expect(result.warnings?.[0]?.message).toContain("3 second window over every group");
    // Then the read's own account of itself, which carries the budget that ended it.
    expect(result.warnings?.[1]?.message).toContain("3 second budget");
    expect(result.warnings?.[1]?.message).toContain("birth certificates");
  });

  test("a sequence gap is reported in the result, not swallowed", async () => {
    const state = new ReadState();
    const node = parseTopic("spBv1.0/G5/NDATA/E5") as NodeTopic;
    state.takeSeq(node, 1);
    state.takeSeq(node, 9);
    const provider = new SparkplugProvider(connection(), {}, {}, async () => ({
      state,
      endReason: "the 3 second budget ended the read",
      messagesSeen: 2,
      bytesSeen: 20,
    }));
    await provider.connect();
    const result = await provider.query("{}");
    expect(result.warnings?.[1]?.message).toContain("1 sequence gaps");
    expect(result.warnings?.[1]?.message).toContain("did not see every message");
  });

  test("an edge node that published without a certificate is counted and named in the result", async () => {
    const state = new ReadState();
    state.takeSeq(parseTopic("spBv1.0/G6/NDATA/E6") as NodeTopic, 1);
    const provider = new SparkplugProvider(connection(), {}, {}, async () => ({
      state,
      endReason: "budget",
      messagesSeen: 1,
      bytesSeen: 10,
    }));
    await provider.connect();
    const result = await provider.query("{}");
    expect(result.rowCount).toBe(0);
    expect(result.warnings?.[1]?.message).toContain("published without a birth certificate");
  });

  test("an unknown field is named rather than ignored", async () => {
    // A silently dropped key reads as a filter that was applied. "edgenode" for "edgeNode" is the
    // case that costs a user an hour.
    const provider = await openProvider();
    await expect(provider.query('{"edgenode":"E1"}')).rejects.toThrow(/is not a field of a Sparkplug read/);
  });

  test("a window outside 1 to 300 seconds is refused", async () => {
    const provider = await openProvider();
    await expect(provider.query('{"seconds":0}')).rejects.toThrow(/between 1 and 300/);
    await expect(provider.query('{"seconds":301}')).rejects.toThrow(/between 1 and 300/);
  });

  test("includeBirths false drops the stored certificates and keeps the live ones", async () => {
    const provider = await openProvider();
    const all = await provider.query("{}");
    const live = await provider.query('{"includeBirths":false}');
    expect(live.rowCount).toBeLessThan(all.rowCount);
    expect(live.rows.every((row) => row.definedBy !== "stored")).toBe(true);
  });

  test("includeBirths takes a boolean and says so", async () => {
    const provider = await openProvider();
    await expect(provider.query('{"includeBirths":"yes"}')).rejects.toThrow(/true or false/);
  });

  test("a filter narrows the rows", async () => {
    const provider = await openProvider();
    expect((await provider.query('{"group":"G2"}')).rowCount).toBe(1);
    expect((await provider.query('{"group":"G1","edgeNode":"E1","device":"D1"}')).rowCount).toBe(1);
  });

  test.each([["group"], ["edgeNode"], ["device"]])(
    "an empty or non-string %s filter is refused by name",
    async (key) => {
      const provider = await openProvider();
      const scope = key === "device" ? { group: "G1", edgeNode: "E1" } : key === "edgeNode" ? { group: "G1" } : {};
      for (const value of ["", 7]) {
        await expect(provider.query(JSON.stringify({ ...scope, [key]: value }))).rejects.toThrow(
          `"${key}" is a non-empty string when it is given.`,
        );
      }
    },
  );

  test.each([[0], [10_001], [1.5]])("a limit outside 1 to 10,000 is refused (%s)", async (limit) => {
    const provider = await openProvider();
    await expect(provider.query(JSON.stringify({ limit }))).rejects.toThrow(/whole number between 1 and/);
  });

  test("a rebirth request is refused with the reason, not ignored", async () => {
    const provider = await openProvider();
    await expect(provider.query('{"rebirth":true}')).rejects.toThrow(/command to somebody else's equipment/);
  });

  test("a host id is refused, because this connection cannot have one", async () => {
    const provider = await openProvider();
    await expect(provider.query('{"hostId":"IamHost"}')).rejects.toThrow(/publishes nothing/);
  });

  test("a device with no edge node is refused", async () => {
    const provider = await openProvider();
    await expect(provider.query('{"device":"D1"}')).rejects.toThrow(/needs its "edgeNode"/);
  });

  test.each([["not json"], ["[1,2]"], ['"text"']])(
    "a request that is not a JSON object is refused (%s)",
    async (text) => {
      const provider = await openProvider();
      await expect(provider.query(text)).rejects.toThrow(/JSON object/);
    },
  );

  test("an empty request reads every group", async () => {
    const provider = await openProvider();
    expect((await provider.query("")).rowCount).toBe(4);
  });
});

describe("the surfaces a broker does not have", () => {
  test("health before a read is unknown rather than zero", async () => {
    const provider = new SparkplugProvider(connection(), {}, {}, async () => readWith());
    const health = await provider.getHealth();
    expect(health.databaseSize).toBe("unknown");
    expect(health.cacheHitRatio).toBe("unknown");
  });

  test("health after a read counts what was seen, and still claims no cache", async () => {
    const provider = await openProvider();
    const health = await provider.getHealth();
    expect(health.databaseSize).toContain("2 edge nodes");
    expect(health.databaseSize).toContain("1 devices");
    // ASSERTED AFTER CONNECT TOO, and a mutation run is why. The before-connect test covered one
    // of the two returns; changing the other to a made-up ratio passed every test.
    expect(health.cacheHitRatio).toBe("unknown");
  });

  test("the overview names the payload convention and never claims an uptime", async () => {
    const provider = await openProvider();
    const overview = await provider.getOverview();
    expect(overview.version).toContain("Sparkplug B");
    expect(overview.uptime).toBe("unknown");
    expect(overview.tableCount).toBe(0);
    expect(overview.indexCount).toBe(0);
  });

  test("the word online appears on no surface", async () => {
    const provider = await openProvider();
    const text = JSON.stringify([await provider.getHealth(), await provider.getOverview()]);
    expect(text.toLowerCase()).not.toContain("online");
  });

  test.each([
    ["getSlowQueries"],
    ["getActiveSessions"],
    ["getTableStats"],
    ["getIndexStats"],
    ["getStorageStats"],
  ] as const)("%s answers an empty list rather than inventing one", async (method) => {
    const provider = await openProvider();
    expect(await provider[method]()).toEqual([]);
  });

  test("maintenance is refused with the sentence that says why", async () => {
    const provider = await openProvider();
    await expect(provider.runMaintenance()).rejects.toThrow(/actuation/);
  });

  test("disconnect holds nothing open", async () => {
    const provider = await openProvider();
    await provider.disconnect();
    await expect(provider.listContainers()).rejects.toThrow(/not open/);
  });

  /*
    THREE PLACES THE HOUSE COVERAGE GATE SAID NOTHING WALKED, measured from the runner's own lcov
    rather than a merged one: `src/lib/db/providers/industrial/sparkplug/index.ts` carried nine
    uncovered lines, at 354-356, 434-438 and 557. All three are reachable through this provider
    with the state these tests already build, so the gap was in the asking and not in the code.

    The batch and the metrics below are the kind of surface a reader never names: a tree panel
    calls `describeObjects` once instead of calling `describeObject` in a loop, and the monitoring
    panel asks for metrics on every engine. Neither had a case.
  */
  test("the batch describes every object the same listing names, one by one", async () => {
    const provider = await openProvider();
    const listed = await provider.listObjects(["G1", "E1"], "node");
    const batch = await provider.describeObjects(["G1", "E1"], "node");
    // The same objects, in the same order, and the number is written: a batch that quietly
    // answered for one of two would still satisfy a comparison of the first entry alone.
    expect(batch.details.length).toBe(listed.length);
    expect(batch.details.map((one) => one.path)).toEqual(listed.map((one) => one.path));
    // And the same columns the one-at-a-time call gives, which is what makes the batch a
    // shortcut rather than a second answer.
    for (const detail of batch.details) {
      const alone = await provider.describeObject(detail.path, "node");
      expect(detail.columns).toEqual(alone.columns);
      expect({ indexes: detail.indexes, foreignKeys: detail.foreignKeys }).toEqual({ indexes: [], foreignKeys: [] });
    }
  });

  test("performance metrics are empty, because a birth certificate publishes none", async () => {
    const provider = await openProvider();
    expect(await provider.getPerformanceMetrics()).toEqual({});
  });

  /*
    The caution a quiet window carries. `connectWarnings` is read by the dialog after a successful
    connect, and the branch that produces the sentence only exists when the read saw nothing - so a
    provider whose read saw messages has to answer with an empty list, and that half is the control:
    without it, a method that always returned the sentence would pass the case above it.
  */
  test("a window that passed in silence is reported as a caution, and a busy one is not", async () => {
    const quiet = new ReadState();
    const silent = new SparkplugProvider(connection(), {}, {}, async () => ({
      state: quiet,
      endReason: "time-budget",
      messagesSeen: 0,
      bytesSeen: 0,
      elapsedMs: 3000,
    }));
    await silent.connect();
    await silent.query('{"seconds":3}');
    const warnings = silent.connectWarnings();
    expect(warnings.length).toBe(1);
    expect(warnings[0]?.message).toContain("sent nothing for 3 seconds");
    // Not an error, and the sentence says which two things a reader should look at.
    expect(warnings[0]?.message).toContain("idle plant");

    const busy = await openProvider();
    await busy.query('{"seconds":1}');
    expect(busy.connectWarnings()).toEqual([]);
  });
});
