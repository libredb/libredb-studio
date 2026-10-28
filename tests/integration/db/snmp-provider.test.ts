/**
 * The SNMP provider, end to end over answers a real agent gave.
 *
 * The real `SnmpProvider` runs: the connection record's checks, the egress resolution, the socket,
 * the statement parser, the MIB name index, the walk's stopping rules, the table shaper and the
 * value rendering. Only the AGENT is replaced, by a server that replays datagrams recorded from
 * the pinned fixture (`docker/snmp`, Net-SNMP 5.9.4) by `tests/live/snmp-evidence.ts`. No Docker
 * runs here and nothing leaves the loopback.
 *
 * WHY A RECORDED ANSWER IS MATCHED BY WHAT THE REQUEST ASKED. Every request carries a request id
 * that changes on every run, so a recording matched byte for byte would never match twice. The key
 * is the PDU type, the objects and a GetBulk's max-repetitions, and the recorded answer is sent
 * with the live request's id written into it. That is not imitating an envelope: it is putting the
 * recorded BODY in the right envelope, and the body is the part the agent decided.
 *
 * A REQUEST NO RECORDING MATCHES IS NOT ANSWERED. It is counted and named, and the case fails on
 * it. An invented answer would make this file agree with whatever the provider does next, which is
 * the opposite of its purpose.
 *
 * MAX-REPETITIONS IS PART OF THE KEY, and that is the assertion this file was written for. Until
 * 14 October 2026 the provider computed it and dropped it on the way to the wire, so every walk
 * asked for zero repetitions; a conforming agent answers that with an empty varbind list, the walk
 * read the empty list as the end of the subtree, and a sixteen-object tree came back as "0 rows"
 * with no error anywhere. Replaying by this key means a provider that drops the field again finds
 * no recording and fails here by name rather than quietly reading nothing.
 *
 * WHAT THIS LAYER CANNOT SEE. A recording is a photograph. It cannot see the agent CHANGING its
 * behaviour - a new Net-SNMP release, a different platform, a value that only appears under load -
 * and it goes stale the moment the fixture moves. Only `tests/live/snmp-live-check.ts` against the
 * running fixture sees that, and the recordings are refreshed by the command written in
 * `tests/fixtures/snmp/captures/agent.json`. The concern #1721 wrote down for this layer, that a
 * client and an agent from the same library share their defects, does not apply: the client is
 * this repository's own and the agent is Net-SNMP.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createSocket, type Socket } from "node:dgram";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SnmpProvider } from "@/lib/db/providers/network/snmp/index";
import type { DatabaseConnection } from "@/lib/types";
import { FIXTURE_COMMUNITY } from "../../fixtures/snmp/identity";
import { keyOf, readRequest, withRequestId } from "../../helpers/snmp-capture";

const CAPTURES = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "fixtures", "snmp", "captures", "agent.json"), "utf8"),
) as { exchanges: { key: string; answer: string }[]; agent: string; regenerate: string };

const BOOK = new Map(CAPTURES.exchanges.map((entry) => [entry.key, Buffer.from(entry.answer, "base64")]));

let agent: Socket | undefined;
let opened: SnmpProvider | undefined;
/** Every datagram the replaying agent received, answered or not, so a case can say nothing was sent. */
let received = 0;

afterEach(async () => {
  await opened?.disconnect();
  opened = undefined;
  agent?.close();
  agent = undefined;
});

/** The replaying agent, and the list of requests it had no recording for. */
async function recordedAgent(missed: string[]): Promise<number> {
  agent = createSocket("udp4");
  agent.on("message", (datagram, from) => {
    received += 1;
    const bytes = Uint8Array.from(datagram);
    const request = readRequest(bytes);
    const answer = BOOK.get(keyOf(request));
    if (answer === undefined) {
      // Not answered on purpose: silence is what an agent does when it cannot answer, and the
      // name of the request is kept so the case can say WHICH one was missing.
      missed.push(keyOf(request));
      return;
    }
    agent?.send(
      withRequestId(Uint8Array.from(answer), bytes.slice(request.requestId.start, request.requestId.end)),
      from.port,
      from.address,
    );
  });
  await new Promise<void>((resolve) => agent?.bind(0, "127.0.0.1", () => resolve()));
  return (agent.address() as { port: number }).port;
}

function connectionTo(port: number): DatabaseConnection {
  return {
    id: "snmp-integration",
    name: "snmp integration",
    type: "snmp",
    host: "127.0.0.1",
    port,
    password: FIXTURE_COMMUNITY,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as DatabaseConnection;
}

/*
 * The deadline is raised for this layer, and it is not a mask.
 *
 * The provider's default is five seconds, which is a sensible thing to wait for a device on a
 * network. The agent here is a socket in this same process, so the only thing that deadline can
 * measure is how busy the machine is: under the full suite, at load 24 with eighteen workers, one
 * case timed out while the same file passed alone three times and under an artificial load of
 * ten spinners. A green suite then depends on the host rather than on the provider.
 *
 * Fifteen seconds still ends a hung exchange - the case fails either way, and the missed-request
 * list names it - but it stops this file from reporting the machine as a defect. The price is
 * measured rather than guessed: a request no recording matches now costs fifteen seconds in that
 * one case instead of five, because the agent here answers a miss with silence on purpose. The
 * real deadline is measured where it means something, against the live agent in
 * `tests/live/snmp-live-check.ts`, which uses this engine's own default.
 *
 * Asking for it only works because of a defect fixed with this file: the provider read the
 * deadline off the connection record, where no such field exists, so every caller got five
 * seconds whatever it asked for. The case below holds the option now being read.
 */
const DEADLINE_MS = 15_000;

/**
 * The budget each case below is given, and it is declared rather than defaulted.
 *
 * The exchange's own deadline is fifteen seconds and bun's default budget is five, so a request
 * the fixture cannot answer kills the CASE before the DEADLINE ends the exchange. What the reader
 * then sees is a nameless timeout, while the fixture's own diagnosis - the `missed` list, which
 * names the request that had no recording - is never asserted. The declaration is not a mask: the
 * deadline still ends a hung exchange, and a case that fails now fails as `missed: [...]`.
 *
 * Measured on 16 October 2026: the cases run in about a millisecond each, so the budget below is
 * never the thing that ends them.
 */
const CASE_BUDGET_MS = 20_000;

async function open(missed: string[]): Promise<SnmpProvider> {
  const port = await recordedAgent(missed);
  opened = new SnmpProvider(connectionTo(port), { queryTimeout: DEADLINE_MS });
  await opened.connect();
  return opened;
}

describe("the provider reads what a real agent answered", () => {
  test("the recordings name where they came from and how to refresh them", () => {
    // A recording whose source cannot be named is a recording nobody can refresh, and one nobody
    // refreshes becomes a description of the past that the suite keeps agreeing with.
    expect(CAPTURES.agent).toContain("5.9.4");
    expect(CAPTURES.regenerate).toContain("tests/live/snmp-evidence.ts");
    expect(BOOK.size).toBeGreaterThanOrEqual(8);
  });

  test(
    "a get answers with the value the agent holds, by numeric object",
    async () => {
      const missed: string[] = [];
      const provider = await open(missed);
      const result = await provider.query("get 1.3.6.1.2.1.1.5.0");
      expect(missed).toEqual([]);
      expect(result.rows).toEqual([{ object: "1.3.6.1.2.1.1.5.0", value: "live-test-agent", type: "text" }]);
    },
    CASE_BUDGET_MS,
  );

  test(
    "a written name reads the same object as its identifier",
    async () => {
      const missed: string[] = [];
      const provider = await open(missed);
      const result = await provider.query("get sysName.0");
      expect(missed).toEqual([]);
      expect(result.rows[0]?.value).toBe("live-test-agent");
    },
    CASE_BUDGET_MS,
  );

  test(
    "a walk returns every object of its subtree and no more",
    async () => {
      const missed: string[] = [];
      const provider = await open(missed);
      const result = await provider.query("walk 1.3.6.1.4.1.8072.9999.9999");
      expect(missed).toEqual([]);
      // Sixteen is what `snmpwalk` reads from the same subtree of the same fixture.
      expect(result.rowCount).toBe(16);
      expect(result.rows.every((row) => String(row.object).startsWith("1.3.6.1.4.1.8072.9999.9999."))).toBe(true);
      expect(result.rows[0]?.value).toBe("1000");
    },
    CASE_BUDGET_MS,
  );

  test(
    "a walk of the system group reads the group, not the agent",
    async () => {
      const missed: string[] = [];
      const provider = await open(missed);
      const result = await provider.query("walk system");
      expect(missed).toEqual([]);
      expect(result.rowCount).toBe(38);
    },
    CASE_BUDGET_MS,
  );

  test(
    "a table shapes its columns by index",
    async () => {
      const missed: string[] = [];
      const provider = await open(missed);
      const result = await provider.query("table 1.3.6.1.4.1.8072.9999.9999.10.1");
      expect(missed).toEqual([]);
      expect(result.rowCount).toBe(3);
      expect(result.rows.map((row) => row.column2)).toEqual(["sensor-one", "sensor-two", "sensor-three"]);
    },
    CASE_BUDGET_MS,
  );

  test(
    "an object the agent does not have is no row, and is not an error",
    async () => {
      const missed: string[] = [];
      const provider = await open(missed);
      const result = await provider.query("get 1.3.6.1.4.1.8072.9999.9999.404.0");
      expect(missed).toEqual([]);
      expect(result.rowCount).toBe(0);
    },
    CASE_BUDGET_MS,
  );

  test(
    "the deadline a caller asks for is the deadline the exchange uses",
    async () => {
      /*
       * The defect this case exists for: `deadlineMs` was read from the connection record, which
       * carries no such field, so the option was dead and every exchange waited the engine default.
       * Nothing noticed, because five seconds is a perfectly ordinary thing to wait.
       *
       * Measured rather than read off the code, and the shape of the measurement took two attempts.
       * A port with nothing behind it does NOT work: on loopback the kernel answers a closed UDP
       * port with an unreachable message and the provider fails in under a millisecond, so the
       * deadline is never consulted. SILENCE is what consults it, and the agent below is silent by
       * design for a request it has no recording of. With 1000 ms asked for, the query ends well
       * inside the 5000 ms this engine would otherwise have used.
       *
       * WHY 1000 AND NOT 200, WHICH IS WHAT THIS ASKED FOR FIRST. The deadline applies to `connect()`
       * too: it sends a probe Get, and that probe is answered by the agent below rather than ignored.
       * MEASURED on 16 October 2026, under a loaded machine running the whole suite: the probe's
       * round trip on loopback passed 200 ms and `connect()` threw `No SNMP agent answered`, so the
       * case failed on the deadline it was asserting rather than on the behaviour. 1000 ms is five
       * times the headroom and still 4000 ms clear of the engine default, which is what the
       * assertion below reads: a build that ignored the option would spend 5000.
       */
      const missed: string[] = [];
      const port = await recordedAgent(missed);
      const impatient = new SnmpProvider(connectionTo(port), { queryTimeout: 1000 });
      await impatient.connect();
      opened = impatient;
      const started = Date.now();
      await impatient.query("get 1.3.6.1.4.1.8072.9999.9999.55555.0").catch(() => undefined);
      const spent = Date.now() - started;
      expect(missed).toHaveLength(1);
      expect(spent).toBeLessThan(4500);
    },
    CASE_BUDGET_MS,
  );

  test("a walk asks for repetitions, and a walk that does not finds no recording", async () => {
    // The assertion this file exists for, stated twice: the recording exists under a key that
    // carries max-repetitions, and the walk that reads it is the one that asked for them.
    expect([...BOOK.keys()].some((key) => key.startsWith("pdu=165 max=50"))).toBe(true);
    expect([...BOOK.keys()].some((key) => key.startsWith("pdu=165 max=0"))).toBe(false);
  });

  test(
    "health is one recorded Get, and carries what the fixture says about itself",
    async () => {
      const missed: string[] = [];
      const provider = await open(missed);
      const health = await provider.getHealth();
      expect(missed).toEqual([]);
      // The description the fixture's snmpd.conf sets, read back through the provider.
      expect(health.description).toBe("LibreDB live-check agent, net-snmp, 127.0.0.1 port 1161");
      expect(Number(health.uptime)).toBeGreaterThan(0);
      expect(health).not.toHaveProperty("activeConnections");
    },
    CASE_BUDGET_MS,
  );

  test(
    "listing and describing send the agent nothing",
    async () => {
      const missed: string[] = [];
      const provider = await open(missed);
      const before = received;
      const tables = await provider.listObjects([], "table");
      const groups = await provider.listObjects([], "scalars");
      const detail = await provider.describeObject(["system"], "scalars");
      const batch = await provider.describeObjects([], "table");
      expect(received).toBe(before);
      expect(tables.map((object) => object.name)).toContain("ifTable");
      expect(groups.map((object) => object.name)).toContain("system");
      expect(detail.columns.map((column) => column.name)).toContain("sysDescr");
      expect(batch.details).toHaveLength(tables.length);
    },
    CASE_BUDGET_MS,
  );
});
