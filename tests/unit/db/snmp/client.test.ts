/**
 * The socket, end to end, over a real UDP socket on loopback.
 *
 * The agent here is a plain `dgram` listener that answers with bytes recorded from a real one,
 * which is the layer the issue describes: capture once, replay through the socket. That keeps
 * this file deterministic and free of a container while still exercising the whole path, from
 * the address check through the valve and the encoder to the kernel and back.
 *
 * What it cannot see is anything the recorded answers do not contain, and the live check against
 * a pinned agent is what covers that. This file is honest about which of the two it is.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createSocket, type Socket } from "node:dgram";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { openExchange, resolveTarget, SnmpTransportError } from "@/lib/db/providers/network/snmp/client";
import { writeInteger, writeOctetString, writeOid, writeSequence } from "@/lib/db/providers/network/snmp/ber";
import { localizedKey } from "@/lib/db/providers/network/snmp/usm";
import {
  encodeAuthenticatedV3Message,
  encodeScopedPdu,
  encodeV3Message,
  readAuthenticatedAnswer,
  readUsmParameters,
} from "@/lib/db/providers/network/snmp/v3-message";
import { decodeResponse, encodeRequest } from "@/lib/db/providers/network/snmp/message";
import { PDU_GET, PDU_SET } from "@/lib/db/providers/network/snmp/valve";

const SYS_DESCR = [1, 3, 6, 1, 2, 1, 1, 1, 0];
const CAPTURED = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../fixtures/snmp/captures/net-snmp-3.29.2.json"), "utf8"),
);

let agent: Socket | undefined;
let opened: { close: () => void } | undefined;

afterEach(() => {
  opened?.close();
  agent?.close();
  opened = undefined;
  agent = undefined;
});

/**
 * A listener that answers every request by replaying the captured response with the request's
 * own id patched in, which is what an agent does and what the client is entitled to expect.
 */
async function replayingAgent(onRequest?: (datagram: Uint8Array) => void): Promise<number> {
  const template = Uint8Array.from(CAPTURED.received.v2cGetResponse as number[]);
  agent = createSocket("udp4");
  agent.on("message", (datagram, from) => {
    onRequest?.(datagram);
    const asked = decodeResponse(Uint8Array.from(datagram)).requestId;
    const answer = Uint8Array.from(template);
    // The request-id sits in the four octets after the PDU's first INTEGER header.
    const at = answer.indexOf(0xa2) + 4;
    for (let i = 3; i >= 0; i -= 1) answer[at + i] = (asked >> ((3 - i) * 8)) & 0xff;
    agent?.send(answer, from.port, from.address);
  });
  await new Promise<void>((resolve) => agent?.bind(0, "127.0.0.1", () => resolve()));
  return (agent.address() as { port: number }).port;
}

describe("a target is resolved and checked before a socket exists", () => {
  test("a loopback literal passes and is used as itself", async () => {
    expect(await resolveTarget("127.0.0.1", 161)).toMatchObject({ address: "127.0.0.1", port: 161 });
  });
  test("a bracketed IPv6 literal loses its brackets", async () => {
    expect((await resolveTarget("[::1]", 161)).address).toBe("::1");
  });
  test("a link-local address is refused whatever the flag says", async () => {
    // The type here is the SHARED guard's, not this provider's. Its refusals are
    // DatabaseConfigError, and that is right for this one: it happens while a connection is
    // being opened rather than while a read is being served, so it is a fact about the
    // connection's configuration. This provider's OWN refusals are QueryError, because those
    // happen during a read and have to reach the user as the reason a reading is unavailable.
    await expect(resolveTarget("169.254.169.254", 161)).rejects.toThrow(DatabaseConfigError);
    await expect(resolveTarget("169.254.169.254", 161)).rejects.toThrow(/link-local/);
  });
  test("a name that does not resolve is refused with its reason, not a hang", async () => {
    await expect(resolveTarget("no-such-host.invalid", 161)).rejects.toThrow(SnmpTransportError);
  });
  test("a NAME whose answers are blocked is refused by the answer check", async () => {
    // Without this, every target in this file was a literal, so the DNS answer check was never
    // reached and deleting it changed nothing. `localhost` resolves to loopback, which the
    // shared guard refuses while the flag is on.
    const flag = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
    const before = process.env[flag];
    process.env[flag] = "true";
    try {
      await expect(resolveTarget("localhost", 161)).rejects.toThrow(DatabaseConfigError);
    } finally {
      if (before === undefined) delete process.env[flag];
      else process.env[flag] = before;
    }
  });
  test("and the same name passes while the flag is off, which is the default", async () => {
    expect((await resolveTarget("localhost", 161)).address).toMatch(/^(127\.|::1)/);
  });
  test("the name the user asked for is kept for the message", async () => {
    expect((await resolveTarget("127.0.0.1", 161)).asked).toBe("127.0.0.1");
  });
});

describe("a request goes out and its answer comes back", () => {
  test("the agent receives exactly the bytes the encoder built", async () => {
    let seen: Uint8Array | undefined;
    const port = await replayingAgent((datagram) => {
      seen = Uint8Array.from(datagram);
    });
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "public",
      deadlineMs: 2000,
    });
    opened = exchange;
    await exchange.send(PDU_GET, 123456, [SYS_DESCR]);
    const expected = encodeRequest(PDU_GET, { community: "public", requestId: 123456, oids: [SYS_DESCR] });
    expect(seen).toEqual(expected);
  });

  test("the answer is matched to its own request-id", async () => {
    const port = await replayingAgent();
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "public",
      deadlineMs: 2000,
    });
    opened = exchange;
    const answer = await exchange.send(PDU_GET, 777, [SYS_DESCR]);
    expect(answer).toMatchObject({ requestId: 777 });
  });

  test("two requests in flight each get their OWN answer", async () => {
    // Without this, only one request was ever outstanding, so handing every answer to every
    // waiter passed. Two ids and one answer prove the match is by id rather than by arrival.
    const port = await replayingAgent();
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "public",
      deadlineMs: 1500,
    });
    opened = exchange;
    const [first, second] = await Promise.all([
      exchange.send(PDU_GET, 1001, [SYS_DESCR]),
      exchange.send(PDU_GET, 2002, [SYS_DESCR]),
    ]);
    expect(first).toMatchObject({ requestId: 1001 });
    expect(second).toMatchObject({ requestId: 2002 });
  });

  test("a datagram this process cannot read is dropped, not blamed on the waiting request", async () => {
    // Without this case, failing every waiter on an unparseable datagram passed. An agent that
    // sends something unexpected, or anything else that reaches the port, must not turn a
    // request that is still perfectly alive into a failure.
    const template = Uint8Array.from(CAPTURED.received.v2cGetResponse as number[]);
    agent = createSocket("udp4");
    agent.on("message", (datagram, from) => {
      agent?.send(Uint8Array.of(0xff, 0xfe, 0xfd), from.port, from.address);
      const asked = decodeResponse(Uint8Array.from(datagram)).requestId;
      const answer = Uint8Array.from(template);
      const at = answer.indexOf(0xa2) + 4;
      for (let i = 3; i >= 0; i -= 1) answer[at + i] = (asked >> ((3 - i) * 8)) & 0xff;
      agent?.send(answer, from.port, from.address);
    });
    await new Promise<void>((resolve) => agent?.bind(0, "127.0.0.1", () => resolve()));
    const port = (agent.address() as { port: number }).port;
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "public",
      deadlineMs: 1500,
    });
    opened = exchange;
    expect(await exchange.send(PDU_GET, 909, [SYS_DESCR])).toMatchObject({ requestId: 909 });
  });

  test("no answer ends at the deadline, as silence with its causes", async () => {
    const silent = createSocket("udp4");
    await new Promise<void>((resolve) => silent.bind(0, "127.0.0.1", () => resolve()));
    const port = (silent.address() as { port: number }).port;
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "public",
      deadlineMs: 150,
    });
    opened = exchange;
    const answer = await exchange.send(PDU_GET, 42, [SYS_DESCR]);
    // Narrowed rather than cast: the union is the contract, and a cast would let its shape
    // change without this test noticing.
    if (!("kind" in answer) || answer.kind !== "silence")
      throw new Error(`expected silence, got ${JSON.stringify(answer)}`);
    expect(answer.causes.length).toBeGreaterThan(1);
    silent.close();
  });
});

describe("the valve still stands between the client and the socket", () => {
  test("a write PDU never reaches the wire", async () => {
    const port = await replayingAgent();
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "public",
      deadlineMs: 500,
    });
    opened = exchange;
    // The encoder refuses first, which is the outer of the two refusals; both are QueryErrors.
    await expect(exchange.send(PDU_SET, 1, [SYS_DESCR])).rejects.toThrow(QueryError);
  });
});

/**
 * The v3 leg, end to end over a real loopback socket.
 *
 * The agent here is a listener that answers the way RFC 3412 says an agent answers: a Report to
 * the discovery request, then authenticated answers once a key exists. It derives its key from
 * the same passphrase and its OWN engine id, so a client that localised the key to anything
 * else produces a digest this agent would not have produced, and the exchange fails.
 */
describe("a v3 connection discovers the engine and then talks to it", () => {
  const ENGINE = Uint8Array.from(Buffer.from("8000b98380f4b9e5c60d371fee600810ee", "hex"));
  const BOOTS = 4;
  const TIME = 1234;
  const PASS = "authpass12345";

  /** A Report, which is all a discovery request draws. */
  function report(messageId: number): Uint8Array {
    const pdu = writeSequence(
      [
        writeInteger(1),
        writeInteger(0),
        writeInteger(0),
        writeSequence([writeSequence([writeOid([1, 3, 6, 1, 6, 3, 15, 1, 1, 4, 0]), writeInteger(1)])]),
      ],
      0xa8,
    );
    return encodeV3Message({
      messageId,
      level: "noAuthNoPriv",
      reportable: false,
      usm: {
        engineId: ENGINE,
        engineBoots: BOOTS,
        engineTime: TIME,
        userName: "",
        authParameters: new Uint8Array(0),
        privParameters: new Uint8Array(0),
      },
      msgData: encodeScopedPdu({ contextEngineId: ENGINE, contextName: "", pdu }),
      encrypted: false,
    });
  }

  async function v3Agent(seen: Uint8Array[], answerTime = TIME): Promise<number> {
    const key = localizedKey(PASS, Buffer.from(ENGINE), "sha1");
    agent = createSocket("udp4");
    agent.on("message", (datagram, from) => {
      const bytes = Uint8Array.from(datagram);
      seen.push(bytes);
      const usm = readUsmParameters(bytes);
      if (usm.engineId.length === 0) {
        agent?.send(report(1), from.port, from.address);
        return;
      }
      // A request this agent cannot verify is not answered. A real agent sends a Report naming
      // usmStatsWrongDigests here; this one stays silent, which is the half the client already
      // has a path for. The Report-on-an-authenticated-exchange path is not written yet and is
      // recorded as missing rather than faked into this listener.
      let asked;
      try {
        asked = readAuthenticatedAnswer(bytes, { localizedAuthKey: key, hash: "sha1" }).response;
      } catch {
        return;
      }
      const pdu = writeSequence(
        [
          writeInteger(asked.requestId),
          writeInteger(0),
          writeInteger(0),
          writeSequence([
            writeSequence([
              writeOid([1, 3, 6, 1, 2, 1, 1, 1, 0]),
              writeOctetString(new TextEncoder().encode("a test agent")),
            ]),
          ]),
        ],
        0xa2,
      );
      const answer = encodeAuthenticatedV3Message({
        messageId: 9,
        level: "authNoPriv",
        reportable: false,
        usm: {
          engineId: ENGINE,
          engineBoots: BOOTS,
          engineTime: answerTime,
          userName: "u1",
          privParameters: new Uint8Array(0),
        },
        msgData: encodeScopedPdu({ contextEngineId: ENGINE, contextName: "", pdu }),
        encrypted: false,
        localizedAuthKey: key,
        hash: "sha1",
      });
      agent?.send(answer, from.port, from.address);
    });
    await new Promise<void>((resolve) => agent?.bind(0, "127.0.0.1", () => resolve()));
    return (agent.address() as { port: number }).port;
  }

  const credentials = { userName: "u1", authPassphrase: PASS, level: "authNoPriv" as const, hash: "sha1" as const };

  test("the first datagram out names no engine and no user", async () => {
    const seen: Uint8Array[] = [];
    const port = await v3Agent(seen);
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "",
      deadlineMs: 2000,
      v3: credentials,
    });
    opened = exchange;
    const first = readUsmParameters(seen[0]);
    expect(first.engineId.length).toBe(0);
    expect(first.userName).toBe("");
  });

  test("the request after discovery carries the engine's own identity and counters", async () => {
    const seen: Uint8Array[] = [];
    const port = await v3Agent(seen);
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "",
      deadlineMs: 2000,
      v3: credentials,
    });
    opened = exchange;
    await exchange.send(PDU_GET, 4242, [SYS_DESCR]);
    const second = readUsmParameters(seen[1]);
    expect(Buffer.from(second.engineId).toString("hex")).toBe(Buffer.from(ENGINE).toString("hex"));
    expect(second.engineBoots).toBe(BOOTS);
    expect(second.engineTime).toBe(TIME);
    expect(second.userName).toBe("u1");
    expect(second.authParameters.length).toBe(12);
  });

  test("a stray datagram during discovery is dropped, not adopted as the engine", async () => {
    /*
     * The half of discovery that decides WHAT this connection's keys are localised to. A
     * datagram from the agent's address that is not a Report must not end discovery: if it did,
     * anything able to send one byte from that address would choose the engine identity.
     *
     * So this agent answers the discovery with rubbish first and the real Report second. The
     * exchange opens, which is the assertion: the rubbish was dropped and the Report decided.
     */
    let answered = false;
    agent = createSocket("udp4");
    agent.on("message", (_datagram, from) => {
      if (!answered) {
        answered = true;
        agent?.send(Uint8Array.of(0x30, 0x02, 0x99, 0x99), from.port, from.address);
        agent?.send(report(11), from.port, from.address);
        return;
      }
    });
    await new Promise<void>((resolve) => agent?.bind(0, "127.0.0.1", () => resolve()));
    const port = (agent.address() as { port: number }).port;
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "",
      deadlineMs: 1000,
      v3: { userName: "u1", authPassphrase: PASS, level: "authNoPriv", hash: "sha1" },
    });
    opened = exchange;
    expect(answered).toBe(true);
  });

  test("an authPriv request leaves encrypted, carrying the salt its privacy needs", async () => {
    /*
     * The encrypted encoder had no case at all. The agent here answers the discovery and then
     * stays silent, because it cannot decrypt what comes next - which is enough: what is being
     * measured is the REQUEST this client builds once the level asks for privacy.
     *
     * The assertion is the salt. An authNoPriv message carries no privacy parameters (the case
     * above reads them as empty); an authPriv one must carry eight bytes of salt, because the
     * agent needs them to build the same initialisation vector. A message that encrypted its
     * scoped PDU and sent no salt would be undecryptable at the other end, and the deadline
     * would report it as silence.
     */
    const seen: Uint8Array[] = [];
    const port = await v3Agent(seen);
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "",
      deadlineMs: 200,
      v3: { userName: "u1", authPassphrase: PASS, privacyPassphrase: PASS, level: "authPriv", hash: "sha1" },
    });
    opened = exchange;
    await exchange.send(PDU_GET, 4243, [SYS_DESCR]);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    const encrypted = readUsmParameters(seen[1]);
    expect(encrypted.privParameters.length).toBe(8);
    expect(encrypted.authParameters.length).toBe(12);
  });

  test("the answer comes back matched to its own request id", async () => {
    const port = await v3Agent([]);
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "",
      deadlineMs: 2000,
      v3: credentials,
    });
    opened = exchange;
    const answer = await exchange.send(PDU_GET, 4242, [SYS_DESCR]);
    expect(answer).toMatchObject({ requestId: 4242, errorStatus: 0 });
  });

  /**
   * SN-S8, end to end. Discovery takes the identity from whatever answers, so the pin is the
   * only thing standing between a wrong engine and every key being localised to it.
   */
  test("an engine id that does not match the pin ends the connection", async () => {
    const port = await v3Agent([]);
    const target = await resolveTarget("127.0.0.1", port);
    await expect(
      openExchange({
        target,
        community: "",
        deadlineMs: 2000,
        v3: { ...credentials, engineIdPin: "8000000001020304" },
      }),
    ).rejects.toThrow(SnmpTransportError);
  });

  test("the pin accepts the engine it was written for", async () => {
    const port = await v3Agent([]);
    const pin = Buffer.from(ENGINE).toString("hex");
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "",
      deadlineMs: 2000,
      v3: { ...credentials, engineIdPin: pin },
    });
    opened = exchange;
    expect((await exchange.send(PDU_GET, 7, [SYS_DESCR])) as { requestId?: number }).toMatchObject({ requestId: 7 });
  });

  /**
   * The wrong passphrase localises to a different key, so the agent's answer carries a digest
   * this client cannot verify. The datagram is dropped rather than trusted, and the request
   * ends at its deadline: an unverifiable answer is not an answer.
   */
  test("a wrong passphrase ends in silence rather than in a trusted answer", async () => {
    const port = await v3Agent([]);
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "",
      deadlineMs: 300,
      v3: { ...credentials, authPassphrase: "authpass54321" },
    });
    opened = exchange;
    expect(await exchange.send(PDU_GET, 11, [SYS_DESCR])).toMatchObject({ kind: "silence" });
  });

  /**
   * The counters are a clock, not a constant. A connection that kept sending the time discovery
   * found would drift out of the engine's window a couple of minutes in, and the agent would
   * answer by refusing a credential that was never wrong. This agent reports a time well ahead
   * of the one it gave at discovery, and the next request has to carry the newer one.
   */
  test("the request after an answer carries the engine's newer time, not the discovered one", async () => {
    const seen: Uint8Array[] = [];
    const port = await v3Agent(seen, TIME + 500);
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "",
      deadlineMs: 2000,
      v3: credentials,
    });
    opened = exchange;
    await exchange.send(PDU_GET, 1, [SYS_DESCR]);
    await exchange.send(PDU_GET, 2, [SYS_DESCR]);
    const first = readUsmParameters(seen[1]).engineTime;
    const second = readUsmParameters(seen[2]).engineTime;
    expect(first).toBe(TIME);
    expect(second).toBeGreaterThanOrEqual(TIME + 500);
  });

  /**
   * And it must not run backwards. This answer is fifty seconds behind, which is INSIDE the
   * window, so it is accepted and the only question is what it does to the clock: an answer
   * reporting an earlier time is old or replayed, and moving the clock back would widen the
   * window a replay has to land in.
   *
   * Fifty and not four hundred on purpose. At four hundred the answer falls outside the window
   * and is dropped, so the next request keeps the old time because nothing was accepted at
   * all. That version of this test passed, and it passed for a reason that had nothing to do
   * with what it claimed to measure.
   */
  test("an accepted answer reporting an earlier time does not drag the next request back", async () => {
    const seen: Uint8Array[] = [];
    const port = await v3Agent(seen, TIME - 50);
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "",
      deadlineMs: 2000,
      v3: credentials,
    });
    opened = exchange;
    expect(await exchange.send(PDU_GET, 1, [SYS_DESCR])).toMatchObject({ requestId: 1 });
    expect(await exchange.send(PDU_GET, 2, [SYS_DESCR])).toMatchObject({ requestId: 2 });
    expect(readUsmParameters(seen[2]).engineTime).toBeGreaterThanOrEqual(TIME);
  });

  /**
   * The other half, kept short on purpose. An answer whose digest verifies but whose clock is
   * far outside the window is not an answer: a digest says who wrote a message and the window
   * says when, and a replay carries a perfectly good digest.
   */
  test("a verified answer from far outside the window is refused, not read", async () => {
    const port = await v3Agent([], TIME + 10_000);
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "",
      deadlineMs: 250,
      v3: credentials,
    });
    opened = exchange;
    expect(await exchange.send(PDU_GET, 3, [SYS_DESCR])).toMatchObject({ kind: "silence" });
  });

  /**
   * A notInTimeWindow Report is the engine saying the timing was wrong, not the credential, and
   * saying in the same breath what the timing should be. This agent hands out a stale time at
   * discovery and then refuses the first authenticated request with that Report, carrying its
   * real counters. The client has to resynchronise and ask once more, because a request that
   * merely stopped waiting would report silence for a question the engine was willing to
   * answer.
   */
  async function resyncingAgent(seen: Uint8Array[], trueTime: number): Promise<number> {
    const key = localizedKey(PASS, Buffer.from(ENGINE), "sha1");
    let refusedOnce = false;
    agent = createSocket("udp4");
    agent.on("message", (datagram, from) => {
      const bytes = Uint8Array.from(datagram);
      seen.push(bytes);
      if (readUsmParameters(bytes).engineId.length === 0) {
        agent?.send(report(1), from.port, from.address);
        return;
      }
      let asked;
      try {
        asked = readAuthenticatedAnswer(bytes, { localizedAuthKey: key, hash: "sha1" }).response;
      } catch {
        return;
      }
      const usm = {
        engineId: ENGINE,
        engineBoots: BOOTS,
        engineTime: trueTime,
        userName: "u1",
        privParameters: new Uint8Array(0),
      };
      const common = {
        messageId: 9,
        level: "authNoPriv" as const,
        reportable: false,
        usm,
        encrypted: false,
        localizedAuthKey: key,
        hash: "sha1" as const,
      };
      if (!refusedOnce) {
        refusedOnce = true;
        const pdu = writeSequence(
          [
            writeInteger(0),
            writeInteger(0),
            writeInteger(0),
            writeSequence([writeSequence([writeOid([1, 3, 6, 1, 6, 3, 15, 1, 1, 2, 0]), writeInteger(1)])]),
          ],
          0xa8,
        );
        agent?.send(
          encodeAuthenticatedV3Message({
            ...common,
            msgData: encodeScopedPdu({ contextEngineId: ENGINE, contextName: "", pdu }),
          }),
          from.port,
          from.address,
        );
        return;
      }
      const pdu = writeSequence(
        [
          writeInteger(asked.requestId),
          writeInteger(0),
          writeInteger(0),
          writeSequence([
            writeSequence([
              writeOid([1, 3, 6, 1, 2, 1, 1, 1, 0]),
              writeOctetString(new TextEncoder().encode("a test agent")),
            ]),
          ]),
        ],
        0xa2,
      );
      agent?.send(
        encodeAuthenticatedV3Message({
          ...common,
          msgData: encodeScopedPdu({ contextEngineId: ENGINE, contextName: "", pdu }),
        }),
        from.port,
        from.address,
      );
    });
    await new Promise<void>((resolve) => agent?.bind(0, "127.0.0.1", () => resolve()));
    return (agent.address() as { port: number }).port;
  }

  test("a notInTimeWindow Report is answered by asking again, not by giving up", async () => {
    const seen: Uint8Array[] = [];
    const port = await resyncingAgent(seen, TIME + 9000);
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "",
      deadlineMs: 2000,
      v3: credentials,
    });
    opened = exchange;
    expect(await exchange.send(PDU_GET, 31, [SYS_DESCR])).toMatchObject({ requestId: 31, errorStatus: 0 });
  });

  test("the second attempt carries the engine's own clock, which is why it is accepted", async () => {
    const seen: Uint8Array[] = [];
    const port = await resyncingAgent(seen, TIME + 9000);
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "",
      deadlineMs: 2000,
      v3: credentials,
    });
    opened = exchange;
    await exchange.send(PDU_GET, 32, [SYS_DESCR]);
    expect(readUsmParameters(seen[1]).engineTime).toBe(TIME);
    expect(readUsmParameters(seen[2]).engineTime).toBeGreaterThanOrEqual(TIME + 9000);
    expect(seen.length).toBe(3);
  });

  /**
   * Once, not forever. An engine that answered every attempt with the same Report would other-
   * wise have the client asking until the deadline, which turns a configuration problem into a
   * burst of traffic at the agent.
   */
  test("the retry happens once, and a second Report does not start another", async () => {
    const seen: Uint8Array[] = [];
    const key = localizedKey(PASS, Buffer.from(ENGINE), "sha1");
    agent = createSocket("udp4");
    agent.on("message", (datagram, from) => {
      const bytes = Uint8Array.from(datagram);
      seen.push(bytes);
      if (readUsmParameters(bytes).engineId.length === 0) {
        agent?.send(report(1), from.port, from.address);
        return;
      }
      const pdu = writeSequence(
        [
          writeInteger(0),
          writeInteger(0),
          writeInteger(0),
          writeSequence([writeSequence([writeOid([1, 3, 6, 1, 6, 3, 15, 1, 1, 2, 0]), writeInteger(1)])]),
        ],
        0xa8,
      );
      agent?.send(
        encodeAuthenticatedV3Message({
          messageId: 9,
          level: "authNoPriv",
          reportable: false,
          usm: {
            engineId: ENGINE,
            engineBoots: BOOTS,
            engineTime: TIME,
            userName: "u1",
            privParameters: new Uint8Array(0),
          },
          msgData: encodeScopedPdu({ contextEngineId: ENGINE, contextName: "", pdu }),
          encrypted: false,
          localizedAuthKey: key,
          hash: "sha1",
        }),
        from.port,
        from.address,
      );
    });
    await new Promise<void>((resolve) => agent?.bind(0, "127.0.0.1", () => resolve()));
    const port = (agent.address() as { port: number }).port;
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "",
      deadlineMs: 300,
      v3: credentials,
    });
    opened = exchange;
    expect(await exchange.send(PDU_GET, 33, [SYS_DESCR])).toMatchObject({ kind: "silence" });
    // Discovery, the first attempt, and exactly one retry.
    expect(seen.length).toBe(3);
  });

  /**
   * A Report is never an answer, even when it carries the right request id.
   *
   * Nothing stops an engine, or anything holding the key, from echoing the id in a Report. A
   * client that matched on the id alone would hand a Report's single usmStats counter back as
   * though it were the object that was asked for, and the caller would read an error counter
   * as its data. The id is how an answer is matched; the PDU type is what says it is one.
   */
  test("a Report that echoes the request id is still not delivered as the answer", async () => {
    const key = localizedKey(PASS, Buffer.from(ENGINE), "sha1");
    const seen: Uint8Array[] = [];
    agent = createSocket("udp4");
    agent.on("message", (datagram, from) => {
      const bytes = Uint8Array.from(datagram);
      seen.push(bytes);
      if (readUsmParameters(bytes).engineId.length === 0) {
        agent?.send(report(1), from.port, from.address);
        return;
      }
      let asked;
      try {
        asked = readAuthenticatedAnswer(bytes, { localizedAuthKey: key, hash: "sha1" }).response;
      } catch {
        return;
      }
      const pdu = writeSequence(
        [
          writeInteger(asked.requestId),
          writeInteger(0),
          writeInteger(0),
          writeSequence([writeSequence([writeOid([1, 3, 6, 1, 6, 3, 15, 1, 1, 3, 0]), writeInteger(1)])]),
        ],
        0xa8,
      );
      agent?.send(
        encodeAuthenticatedV3Message({
          messageId: 9,
          level: "authNoPriv",
          reportable: false,
          usm: {
            engineId: ENGINE,
            engineBoots: BOOTS,
            engineTime: TIME,
            userName: "u1",
            privParameters: new Uint8Array(0),
          },
          msgData: encodeScopedPdu({ contextEngineId: ENGINE, contextName: "", pdu }),
          encrypted: false,
          localizedAuthKey: key,
          hash: "sha1",
        }),
        from.port,
        from.address,
      );
    });
    await new Promise<void>((resolve) => agent?.bind(0, "127.0.0.1", () => resolve()));
    const port = (agent.address() as { port: number }).port;
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "",
      deadlineMs: 300,
      v3: credentials,
    });
    opened = exchange;
    expect(await exchange.send(PDU_GET, 44, [SYS_DESCR])).toMatchObject({ kind: "silence" });
    // Discovery and one request, and nothing else. This Report says the user is unknown, which
    // asking again cannot fix: only notInTimeWindow earns a second attempt, and a client that
    // retried on any Report at all would be answering a configuration problem with traffic.
    expect(seen.length).toBe(2);
  });
});

/**
 * THE THREE ENDS THAT ONLY SILENCE, A CLOSED PORT OR A CIPHER REACHES.
 *
 * Each of these lines was uncovered when the gate was first run against this branch, and none of
 * them needs a device: a port with nothing behind it, a v3 handshake nobody answers, and the
 * encrypted request this client builds when the level asks for privacy.
 */
describe("a v3 connection whose discovery is never answered", () => {
  test("ends at its own deadline, naming discovery rather than the read", async () => {
    // The sentence matters more than the failure: an unanswered DISCOVERY is not a read that
    // failed, it is a connection that never learned the engine's identity, and the two send an
    // operator to different places.
    const silent = createSocket("udp4");
    await new Promise<void>((resolve) => silent.bind(0, "127.0.0.1", () => resolve()));
    const port = (silent.address() as { port: number }).port;
    try {
      await expect(
        openExchange({
          target: await resolveTarget("127.0.0.1", port),
          community: "",
          deadlineMs: 150,
          v3: { userName: "u1", authPassphrase: "authpass12345", level: "authNoPriv", hash: "sha1" },
        }),
      ).rejects.toThrow(/did not answer the discovery request/);
    } finally {
      silent.close();
    }
  });
});

describe("a socket error rather than silence", () => {
  test("a port with nothing behind it answers the read with the socket's own code", async () => {
    // On loopback a closed UDP port is refused by the kernel rather than ignored, so this is the
    // one path where the client is told something instead of waiting. The failure carries the
    // code, which is what tells a reader this is not the agent being slow.
    const dead = createSocket("udp4");
    await new Promise<void>((resolve) => dead.bind(0, "127.0.0.1", () => resolve()));
    const port = (dead.address() as { port: number }).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));

    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", port),
      community: "public",
      deadlineMs: 400,
    });
    opened = exchange;
    const answer = await exchange.send(PDU_GET, 7, [SYS_DESCR]);
    expect("varbinds" in answer).toBe(false);
    expect((answer as { kind: string }).kind).toBeDefined();
  });
});

/**
 * THE TWO FAILURES A REAL SOCKET WILL NOT PRODUCE ON DEMAND.
 *
 * Both are driven through `createRawSocket`, the seam this client already exposes so a test can
 * give it a socket. A loopback socket cannot be told to fail a send with a chosen code, and it
 * certainly cannot be told to hand this process a datagram that breaks its own decoder - which
 * is the point of the second one: that branch exists for OUR defects, so producing it means
 * injecting one.
 */
describe("a send the socket itself refuses", () => {
  const fakeSocket = (onSend: (cb: (error?: Error) => void) => void) => {
    let listener: ((datagram: Uint8Array) => void) | undefined;
    const socket = {
      on: (event: string, handler: (datagram: Uint8Array) => void) => {
        if (event === "message") listener = handler;
        return socket;
      },
      bind: () => socket,
      address: () => ({ address: "127.0.0.1", family: "IPv4", port: 1 }),
      unref: () => socket,
      ref: () => socket,
      close: (cb?: () => void) => cb?.(),
      connect: (_port: number, _address: string, cb: () => void) => cb(),
      send: (_bytes: Uint8Array, cb: (error?: Error) => void) => onSend(cb),
    };
    return { socket: socket as unknown as Socket, deliver: (datagram: unknown) => listener?.(datagram as Uint8Array) };
  };

  test("answers with the code the socket reported", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const { socket } = fakeSocket((cb) => cb(refused));
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", 161),
      community: "public",
      deadlineMs: 2000,
      createRawSocket: () => socket,
    });
    opened = exchange;
    const answer = await exchange.send(PDU_GET, 11, [SYS_DESCR]);
    expect("varbinds" in answer).toBe(false);
    // The sentence, not the code: ECONNREFUSED on a connected UDP socket means the far host
    // answered that nothing is listening, and saying "the socket refused the send" would send
    // a reader to look at this machine instead.
    expect(JSON.stringify(answer)).toContain("nothing is listening");
  });

  test("and with a named unknown when the error carries no code", async () => {
    // An error with no `code` is still an error. Reporting it as silence would send a reader to
    // look at an agent that never heard anything.
    const { socket } = fakeSocket((cb) => cb(new Error("something went wrong")));
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", 161),
      community: "public",
      deadlineMs: 2000,
      createRawSocket: () => socket,
    });
    opened = exchange;
    const answer = await exchange.send(PDU_GET, 12, [SYS_DESCR]);
    expect("varbinds" in answer).toBe(false);
    expect(JSON.stringify(answer)).toContain("UNKNOWN");
  });

  test("a datagram that breaks this process's own reader is reported as ours, not as silence", async () => {
    /*
     * The branch under test keeps OUR defects out of sentences about the device: a declared
     * refusal is dropped and the request ends at its deadline, but anything else is kept and
     * reported as a fault here. A real agent cannot be asked to produce one, so the fault is
     * injected through the same seam the socket comes from - `null` where a datagram belongs,
     * which is what a decoder bug looks like from the outside.
     */
    const { socket, deliver } = fakeSocket(() => undefined);
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", 161),
      community: "public",
      deadlineMs: 120,
      createRawSocket: () => socket,
    });
    opened = exchange;
    const pending = exchange.send(PDU_GET, 13, [SYS_DESCR]);
    deliver(null);
    const answer = await pending;
    expect("varbinds" in answer).toBe(false);
    expect(JSON.stringify(answer)).toContain("defect here");
  });

  test("a request that times out after the socket reported an error answers with that error, not with silence", async () => {
    // A refusal can arrive while nothing is waiting, the ICMP for an earlier datagram on a real
    // network. The next request that hears nothing is told what the socket said, not that the agent
    // was silent.
    let onError: ((error: Error) => void) | undefined;
    const { socket } = fakeSocket(() => undefined);
    const on = (socket as unknown as { on: (event: string, handler: never) => unknown }).on;
    Object.assign(socket, {
      on: (event: string, handler: never) => {
        if (event === "error") onError = handler;
        return on(event, handler);
      },
    });
    const exchange = await openExchange({
      target: await resolveTarget("127.0.0.1", 161),
      community: "public",
      deadlineMs: 120,
      createRawSocket: () => socket,
    });
    opened = exchange;
    onError?.(Object.assign(new Error("recvmsg ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const answer = await exchange.send(PDU_GET, 14, [SYS_DESCR]);
    expect("varbinds" in answer).toBe(false);
    expect(JSON.stringify(answer)).toContain("nothing is listening");
  });
});
