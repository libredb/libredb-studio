import { afterEach, describe, expect, test } from "bun:test";
import { createSocket, type Socket } from "node:dgram";

import {
  readChildren,
  readField,
  writeInteger,
  writeOctetString,
  writeOid,
  writeSequence,
} from "@/lib/db/providers/network/snmp/ber";
import { SnmpProvider } from "@/lib/db/providers/network/snmp";
import { StatementError } from "@/lib/db/providers/network/snmp/statement";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The provider against an agent, both ends asserted.
 *
 * The agent here is not a mock of this provider's own encoder: it is a UDP listener that reads
 * the datagram with the BER reader and answers by building one, so a request this provider
 * never sent cannot be "received" and an answer it cannot parse cannot pass. Each test says
 * what the AGENT got (version, community, the OID asked for) and what the CALLER got (the rows
 * and the values in them). A test that checked only one end would pass with the other end
 * disconnected, which is exactly the state this provider was in until now: 1,196 lines written
 * and tested, reached from production by nothing.
 */
const SYS_DESCR = [1, 3, 6, 1, 2, 1, 1, 1, 0];
const SYS_UPTIME = [1, 3, 6, 1, 2, 1, 1, 3, 0];

let agent: Socket | undefined;
let opened: SnmpProvider | undefined;

afterEach(async () => {
  await opened?.disconnect();
  opened = undefined;
  agent?.close();
  agent = undefined;
});

interface Seen {
  readonly version: number;
  readonly community: string;
  readonly oids: string[];
  readonly requestId: number;
  /**
   * The PDU's third integer. On a Get or GetNext it is the error index and means nothing here;
   * on a GetBulk it is MAX-REPETITIONS, and a GetBulk that carries zero is answered with an
   * empty varbind list by every conforming agent (RFC 3416). This provider sent exactly that
   * for a while: `firstRequest` computed the number and the call site dropped it, so every
   * `walk` and every `table` came back empty against a real agent while 448 unit tests stayed
   * green, because no test looked at this field.
   */
  readonly thirdInteger: number;
}

/** Answers a Get with one value per asked OID, and records what it was asked. */
async function listeningAgent(seen: Seen[], values: Map<string, { tag: number; bytes: Uint8Array }>): Promise<number> {
  agent = createSocket("udp4");
  agent.on("message", (datagram, from) => {
    const bytes = Uint8Array.from(datagram);
    const [versionField, communityField, pduField] = readChildren(bytes, readField(bytes, 0));
    const pdu = readChildren(bytes, pduField);
    const asked = readChildren(bytes, pdu[3]).map((entry) => readChildren(bytes, entry)[0]);
    const oids = asked.map((field) => decodeOid(bytes.slice(field.start, field.end)));
    seen.push({
      thirdInteger: [...bytes.slice(pdu[2].start, pdu[2].end)].reduce((n, b) => n * 256 + b, 0),
      version: bytes[versionField.start],
      community: new TextDecoder().decode(bytes.slice(communityField.start, communityField.end)),
      oids,
      requestId: [...bytes.slice(pdu[0].start, pdu[0].end)].reduce((n, b) => n * 256 + b, 0),
    });
    const varbinds = oids.map((oid) => {
      const value = values.get(oid) ?? { tag: 0x80, bytes: new Uint8Array(0) };
      return writeSequence([writeOid(oid.split(".").map(Number)), writeField(value.tag, value.bytes)]);
    });
    const answer = writeSequence([
      writeInteger(1),
      writeOctetString(new TextEncoder().encode("public")),
      writeSequence(
        [writeInteger(seen[seen.length - 1].requestId), writeInteger(0), writeInteger(0), writeSequence(varbinds)],
        0xa2,
      ),
    ]);
    agent?.send(answer, from.port, from.address);
  });
  await new Promise<void>((resolve) => agent?.bind(0, "127.0.0.1", () => resolve()));
  return (agent.address() as { port: number }).port;
}

/** A TLV with an arbitrary tag, which `ber.ts` does not export because nothing in it needs one. */
function writeField(tag: number, content: Uint8Array): Uint8Array {
  const length = content.length < 0x80 ? Uint8Array.of(content.length) : Uint8Array.of(0x81, content.length);
  return Uint8Array.from([tag, ...length, ...content]);
}

function decodeOid(bytes: Uint8Array): string {
  const out = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  for (const octet of bytes.slice(1)) {
    value = value * 128 + (octet & 0x7f);
    if ((octet & 0x80) === 0) {
      out.push(value);
      value = 0;
    }
  }
  return out.join(".");
}

const connectionTo = (port: number): DatabaseConnection =>
  ({
    id: "e2e",
    name: "agent",
    type: "snmp",
    host: "127.0.0.1",
    port,
    password: "public",
    createdAt: new Date(),
  }) as unknown as DatabaseConnection;

describe("a statement reaches a real agent and its answer reaches the caller", () => {
  /**
   * UDP has no handshake, so opening the socket proves nothing: measured, it succeeded in 2 ms
   * against a loopback port with nothing behind it. A connection reporting success for a device
   * that is not there is worse than one that fails, because every read after it looks like an
   * empty device rather than an absent one.
   */
  test("connecting to an address with no agent fails, and names the address", async () => {
    const dead = new SnmpProvider(connectionTo(9));
    await expect(dead.connect()).rejects.toThrow(/127\.0\.0\.1:9/);
    await expect(dead.connect()).rejects.toThrow(/no agent at that address or the wrong community/);
  });

  test("connecting asks the agent one question before it reports success", async () => {
    const seen: Seen[] = [];
    const port = await listeningAgent(seen, new Map([[SYS_UPTIME.join("."), { tag: 0x43, bytes: Uint8Array.of(1) }]]));
    opened = new SnmpProvider(connectionTo(port));
    await opened.connect();
    expect(seen).toHaveLength(1);
    expect(seen[0].oids).toEqual([SYS_UPTIME.join(".")]);
  });
  test("the agent receives v2c, the community, and the object that was asked for", async () => {
    const seen: Seen[] = [];
    const port = await listeningAgent(
      seen,
      new Map([[SYS_DESCR.join("."), { tag: 0x04, bytes: new TextEncoder().encode("a test agent") }]]),
    );
    opened = new SnmpProvider(connectionTo(port));
    await opened.connect();
    await opened.query(`get ${SYS_DESCR.join(".")}`);

    // Two datagrams, and the first one is not the statement: `connect` probes sysUpTime.0 to
    // find out whether an agent is there at all, because UDP has no handshake and opening the
    // socket succeeds against an address with nothing behind it. The probe is counted here
    // rather than filtered out, so it cannot grow into something else unnoticed.
    expect(seen).toHaveLength(2);
    expect(seen[0].oids).toEqual([SYS_UPTIME.join(".")]);
    expect(seen[1].version).toBe(1); // SNMPv2c is version 1 on the wire.
    expect(seen[1].community).toBe("public");
    expect(seen[1].oids).toEqual([SYS_DESCR.join(".")]);
  });

  test("the caller receives the value the agent sent, rendered as text", async () => {
    const port = await listeningAgent(
      [],
      new Map([[SYS_DESCR.join("."), { tag: 0x04, bytes: new TextEncoder().encode("a test agent") }]]),
    );
    opened = new SnmpProvider(connectionTo(port));
    await opened.connect();
    const result = await opened.query(`get ${SYS_DESCR.join(".")}`);

    expect(result.rowCount).toBe(1);
    expect(result.fields).toEqual(["object", "value", "type"]);
    expect(result.rows[0]).toEqual({ object: SYS_DESCR.join("."), value: "a test agent", type: "text" });
  });

  /**
   * The type comes from the tag the AGENT put on the value. TimeTicks is the clearest case: the
   * same four bytes would render as a plain integer if the tag said INTEGER, and the only thing
   * that makes it a duration is the agent saying so.
   */
  test("the type a value is rendered as is the one the agent declared", async () => {
    const port = await listeningAgent(
      [],
      new Map([[SYS_UPTIME.join("."), { tag: 0x43, bytes: Uint8Array.of(0, 0x98, 0x96, 0x80) }]]),
    );
    opened = new SnmpProvider(connectionTo(port));
    await opened.connect();
    const result = await opened.query(`get ${SYS_UPTIME.join(".")}`);

    expect(result.rows[0].type).not.toBe("text");
    expect(String(result.rows[0].value)).not.toBe("");
  });

  test("two objects travel in one request, not two", async () => {
    const seen: Seen[] = [];
    const port = await listeningAgent(
      seen,
      new Map([
        [SYS_DESCR.join("."), { tag: 0x04, bytes: new TextEncoder().encode("a test agent") }],
        [SYS_UPTIME.join("."), { tag: 0x43, bytes: Uint8Array.of(0, 0x98, 0x96, 0x80) }],
      ]),
    );
    opened = new SnmpProvider(connectionTo(port));
    await opened.connect();
    const result = await opened.query(`get ${SYS_DESCR.join(".")} ${SYS_UPTIME.join(".")}`);

    expect(seen).toHaveLength(2); // the connect probe, then the statement
    expect(seen[1].oids).toEqual([SYS_DESCR.join("."), SYS_UPTIME.join(".")]);
    expect(result.rowCount).toBe(2);
  });

  /**
   * Request ids come from `node:crypto`, not from a counter that starts at one. Two reads on
   * one connection must not reuse an id: over UDP anything on the path can answer, and a
   * guessable id is an answer this provider would match to a question it did not ask.
   */
  test("two reads on one connection carry different request ids", async () => {
    const seen: Seen[] = [];
    const port = await listeningAgent(
      seen,
      new Map([[SYS_DESCR.join("."), { tag: 0x04, bytes: new TextEncoder().encode("x") }]]),
    );
    opened = new SnmpProvider(connectionTo(port));
    await opened.connect();
    await opened.query(`get ${SYS_DESCR.join(".")}`);
    await opened.query(`get ${SYS_DESCR.join(".")}`);

    expect(seen).toHaveLength(3); // the probe and two statements
    expect(new Set(seen.map((one) => one.requestId)).size).toBe(3);
  });

  /**
   * A statement this provider refuses sends NOTHING. Counting the agent's datagrams is the only
   * way to tell that apart from "sent it and threw afterwards", and the difference matters: a
   * write refused after the datagram left has already reached the device.
   */
  test("a refused statement opens no socket and sends no datagram", async () => {
    const seen: Seen[] = [];
    const port = await listeningAgent(seen, new Map());
    opened = new SnmpProvider(connectionTo(port));
    await opened.connect();
    await expect(opened.query("set sysName.0 x")).rejects.toThrow(StatementError);
    // One datagram, and it is the connect probe. The refused statement added nothing.
    expect(seen).toHaveLength(1);
    expect(seen[0].oids).toEqual([SYS_UPTIME.join(".")]);
  });

  test("an object the agent does not have comes back as no row, not as an empty one", async () => {
    const port = await listeningAgent([], new Map());
    opened = new SnmpProvider(connectionTo(port));
    await opened.connect();
    const result = await opened.query(`get ${SYS_DESCR.join(".")}`);
    expect(result.rowCount).toBe(0);
    expect(result.rows).toEqual([]);
  });

  /**
   * The overview is the agent describing itself, and it is the one place this provider can
   * answer from the device rather than from its own tables.
   */
  test("the overview carries what the agent says about itself", async () => {
    const port = await listeningAgent(
      [],
      new Map([
        [SYS_DESCR.join("."), { tag: 0x04, bytes: new TextEncoder().encode("Linux agent 6.1") }],
        [SYS_UPTIME.join("."), { tag: 0x43, bytes: Uint8Array.of(0, 0x98, 0x96, 0x80) }],
      ]),
    );
    opened = new SnmpProvider(connectionTo(port));
    await opened.connect();
    const overview = await opened.getOverview();
    expect(overview.version).toBe("Linux agent 6.1");
    expect(overview.uptime).not.toBe("");
    // An agent is not a database: these are zero because it HAS none, not as a placeholder.
    expect(overview.tableCount).toBe(0);
    expect(overview.maxConnections).toBe(0);
  });

  /**
   * The connection's cautions and the bundled MIB notices ride with the FIRST result and then
   * stop. A notice repeated on every read is a notice an operator stops reading.
   */
  test("the first result carries the notices and the second does not", async () => {
    const port = await listeningAgent(
      [],
      new Map([[SYS_DESCR.join("."), { tag: 0x04, bytes: new TextEncoder().encode("x") }]]),
    );
    opened = new SnmpProvider(connectionTo(port));
    await opened.connect();
    const first = await opened.query(`get ${SYS_DESCR.join(".")}`);
    const second = await opened.query(`get ${SYS_DESCR.join(".")}`);
    expect((first.warnings ?? []).length).toBeGreaterThan(0);
    expect(second.warnings).toBeUndefined();
  });

  /**
   * A table's columns are whatever the agent had. A short column is an ABSENCE in its row and
   * never a shift of the rows below it, which is the whole reason the table builder exists.
   */
  test("a table keeps a short column as an absence rather than shifting its rows", async () => {
    const TABLE = [1, 3, 6, 1, 2, 1, 2, 2];
    const values = new Map([
      [`${TABLE.join(".")}.1.1`, { tag: 0x02, bytes: Uint8Array.of(1) }],
      [`${TABLE.join(".")}.1.2`, { tag: 0x02, bytes: Uint8Array.of(2) }],
      [`${TABLE.join(".")}.2.1`, { tag: 0x04, bytes: new TextEncoder().encode("eth0") }],
    ]);
    const seen: Seen[] = [];
    const port = await walkingAgent(seen, values);
    opened = new SnmpProvider(connectionTo(port));
    await opened.connect();
    const result = await opened.query(`table ${TABLE.join(".")}`);
    expect(result.rowCount).toBe(2);
    const second = result.rows.find((row) => row.index === "2");
    expect(second?.column1).toBe("2");
    // Row 2 has no second column on the agent, so the cell says so.
    expect(second?.column2).toBe("absent");
  });

  // WHAT THIS CATCHES, measured on 14 October 2026 against a real net-snmp agent: `firstRequest`
  // computed a max-repetitions and the call site passed `undefined`, so every walk went out asking
  // for ZERO repetitions. A conforming agent answers that with an empty varbind list (RFC 3416),
  // the walk read the empty list as the end of the subtree, and a sixteen-object tree came back as
  // "0 rows" with no error anywhere. Four hundred and forty-eight unit tests were green, because
  // none of them looked at this field of the datagram.
  test("a walk asks for more than zero repetitions, which is the difference between rows and silence", async () => {
    const TABLE = [1, 3, 6, 1, 2, 1, 2, 2];
    const values = new Map([
      [`${TABLE.join(".")}.1.1`, { tag: 0x02, bytes: Uint8Array.of(1) }],
      [`${TABLE.join(".")}.1.2`, { tag: 0x02, bytes: Uint8Array.of(2) }],
    ]);
    const seen: Seen[] = [];
    const port = await walkingAgent(seen, values);
    opened = new SnmpProvider(connectionTo(port));
    await opened.connect();
    const result = await opened.query(`walk ${TABLE.join(".")}`);
    // The probe that opens the connection is a Get; the walk's own datagram is the one after it.
    const walkRequest = seen[seen.length - 1];
    expect(walkRequest.thirdInteger).toBeGreaterThan(0);
    expect(result.rowCount).toBe(2);
  });

  // The other half of the same wire: a GetBulk over-reads on purpose, and the objects past the
  // subtree belong to the next branch. They were being put in the grid: a sixteen-object subtree
  // came back as fifty rows carrying a neighbour's objects, while the walk's own note said sixteen.
  test("objects past the subtree are not rows, even when the agent sends them", async () => {
    const TABLE = [1, 3, 6, 1, 2, 1, 2, 2];
    const values = new Map([
      [`${TABLE.join(".")}.1.1`, { tag: 0x02, bytes: Uint8Array.of(1) }],
      // Outside the subtree: the agent answers with it, the walk must not count it.
      ["1.3.6.1.2.1.3.1.1", { tag: 0x02, bytes: Uint8Array.of(9) }],
    ]);
    const seen: Seen[] = [];
    const port = await walkingAgent(seen, values);
    opened = new SnmpProvider(connectionTo(port));
    await opened.connect();
    const result = await opened.query(`walk ${TABLE.join(".")}`);
    expect(result.rowCount).toBe(1);
    expect(result.rows.every((row) => String(row.object).startsWith(`${TABLE.join(".")}.`))).toBe(true);
  });
});

/** Answers a GetBulk by returning every value past the asked OID, in order, like an agent walks. */
async function walkingAgent(seen: Seen[], values: Map<string, { tag: number; bytes: Uint8Array }>): Promise<number> {
  const ordered = [...values.entries()].sort((a, b) => compareOidText(a[0], b[0]));
  agent = createSocket("udp4");
  agent.on("message", (datagram, from) => {
    const bytes = Uint8Array.from(datagram);
    const [, communityField, pduField] = readChildren(bytes, readField(bytes, 0));
    const pdu = readChildren(bytes, pduField);
    const askedField = readChildren(bytes, readChildren(bytes, pdu[3])[0])[0];
    const asked = decodeOid(bytes.slice(askedField.start, askedField.end));
    seen.push({
      thirdInteger: [...bytes.slice(pdu[2].start, pdu[2].end)].reduce((n, b) => n * 256 + b, 0),
      version: bytes[readChildren(bytes, readField(bytes, 0))[0].start],
      community: new TextDecoder().decode(bytes.slice(communityField.start, communityField.end)),
      oids: [asked],
      requestId: [...bytes.slice(pdu[0].start, pdu[0].end)].reduce((n, b) => n * 256 + b, 0),
    });
    const after = ordered.filter(([oid]) => compareOidText(oid, asked) > 0).slice(0, 10);
    const varbinds =
      after.length === 0
        ? [writeSequence([writeOid(asked.split(".").map(Number)), writeField(0x82, new Uint8Array(0))])]
        : after.map(([oid, value]) =>
            writeSequence([writeOid(oid.split(".").map(Number)), writeField(value.tag, value.bytes)]),
          );
    agent?.send(
      writeSequence([
        writeInteger(1),
        writeOctetString(new TextEncoder().encode("public")),
        writeSequence(
          [writeInteger(seen[seen.length - 1].requestId), writeInteger(0), writeInteger(0), writeSequence(varbinds)],
          0xa2,
        ),
      ]),
      from.port,
      from.address,
    );
  });
  await new Promise<void>((resolve) => agent?.bind(0, "127.0.0.1", () => resolve()));
  return (agent.address() as { port: number }).port;
}

/** Numeric arc order, which is the order SNMP walks in and not the order strings sort in. */
function compareOidText(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The message handler drops a datagram it cannot read, which is right: a stray or
 * malformed packet must not fail a request that is still waiting. But "cannot read" has two
 * causes that look identical from the catch, and only one of them is a fact about the device.
 *
 * The drop is therefore narrowed to the refusals this provider declares, all of which extend
 * QueryError. A fault of our own is kept and reported as ours. Without this, a defect in the
 * decoder reaches the operator as "the agent did not answer" and sends them to the agent.
 */
describe("our own fault is not reported as the agent's silence", () => {
  test("a declared refusal still drops the datagram and ends in silence", async () => {
    const port = await rawAgent(() => Uint8Array.of(0x30, 0x02, 0x99, 0x99));
    // A short deadline on purpose: the point is which SENTENCE comes back, and waiting the
    // default five seconds to read it would make this test measure the clock.
    const exchange = new SnmpProvider({ ...connectionTo(port), queryTimeout: 300 });
    // The probe draws the malformed answer, so connect is what reports it.
    await expect(exchange.connect()).rejects.toThrow(/No SNMP agent answered/);
  });

  /**
   * The control, and the reason the test above proves anything: the same listener answering
   * correctly lets the connection open. Without it, "connect failed" would be consistent with
   * the listener simply not working.
   */
  test("the same listener answering properly opens the connection", async () => {
    const port = await listeningAgent([], new Map([[SYS_UPTIME.join("."), { tag: 0x43, bytes: Uint8Array.of(1) }]]));
    opened = new SnmpProvider(connectionTo(port));
    await expect(opened.connect()).resolves.toBeUndefined();
  });
});

/** A listener that answers with whatever bytes it is told to, however malformed. */
async function rawAgent(answer: () => Uint8Array): Promise<number> {
  agent = createSocket("udp4");
  agent.on("message", (_datagram, from) => {
    agent?.send(answer(), from.port, from.address);
  });
  await new Promise<void>((resolve) => agent?.bind(0, "127.0.0.1", () => resolve()));
  return (agent.address() as { port: number }).port;
}

/**
 * Health is a real read of the agent: one Get of the two objects every agent answers about itself.
 *
 * Only what an agent reports is filled in. Every figure of the shared shape an agent has no notion
 * of says so in a sentence, and the count of connections is left out rather than sent as a zero,
 * which the shared shape's own docblock asks of a provider that cannot measure it.
 */
describe("health is read from the agent, and claims nothing the agent did not say", () => {
  test("one Get of the description and the uptime, answered with both and the round trip", async () => {
    const seen: Seen[] = [];
    const port = await listeningAgent(
      seen,
      new Map([
        [SYS_DESCR.join("."), { tag: 0x04, bytes: new TextEncoder().encode("Linux agent 6.1") }],
        [SYS_UPTIME.join("."), { tag: 0x43, bytes: Uint8Array.of(0, 0x98, 0x96, 0x80) }],
      ]),
    );
    opened = new SnmpProvider(connectionTo(port));
    await opened.connect();
    const health = await opened.getHealth();
    // The probe at connect, then the health read and nothing else.
    expect(seen.map((request) => request.oids)).toEqual([
      [SYS_UPTIME.join(".")],
      [SYS_DESCR.join("."), SYS_UPTIME.join(".")],
    ]);
    expect(health.description).toBe("Linux agent 6.1");
    expect(health.uptime).toBe("10000000");
    expect(health.roundTripMs).toBeGreaterThanOrEqual(0);
    expect(health).not.toHaveProperty("activeConnections");
    expect(health.databaseSize).toMatch(/An SNMP agent reports no database size/);
    expect(health.cacheHitRatio).toMatch(/An SNMP agent reports no cache/);
    expect(health.slowQueries).toEqual([]);
    expect(health.activeSessions).toEqual([]);
  });

  test("an object the agent does not serve is said to be missing, not rendered as a value", async () => {
    const port = await listeningAgent([], new Map([[SYS_UPTIME.join("."), { tag: 0x43, bytes: Uint8Array.of(1) }]]));
    opened = new SnmpProvider(connectionTo(port));
    await opened.connect();
    const health = await opened.getHealth();
    expect(health.uptime).toBe("1");
    expect(health.description).toBe("unavailable: the agent answered noSuchObject for sysDescr.0");
  });

  test("an agent that stops answering fails the health read rather than reporting a healthy nothing", async () => {
    const port = await listeningAgent([], new Map([[SYS_UPTIME.join("."), { tag: 0x43, bytes: Uint8Array.of(1) }]]));
    opened = new SnmpProvider({ ...connectionTo(port), queryTimeout: 300 });
    await opened.connect();
    agent?.close();
    agent = undefined;
    await expect(opened.getHealth()).rejects.toThrow(/did not answer the health read/);
  });
});
