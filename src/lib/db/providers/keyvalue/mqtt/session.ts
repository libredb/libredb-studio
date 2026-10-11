/**
 * One MQTT connection and one read over it (`docs/providers/mqtt.md` sections 4 and 5).
 *
 * THE READ IS A SAMPLE AND THE SESSION SAYS SO. MQTT has no command that lists topics: the tree is whatever a
 * subscription delivered before our own budget ended the read. Nothing here infers that a read was complete,
 * and nothing infers that it was incomplete from how long the wire was quiet; measured across twelve cases the
 * quiet gap before a lossless read (214 ms to 4,013 ms) and before a lossy one (5,954 ms to 19,894 ms) do not
 * separate, and the ordering is inverted. What the session can prove, it reports. Nothing else.
 *
 * Bytes out go through the valve, which is why no PUBLISH and no Will can leave. Bytes in are framed here,
 * against the inbound limit, before `mqtt-packet`'s parser ever sees them: the parser buffers an announced
 * length as it arrives, so a limit applied after it would already have allocated the body.
 */
import { connect as netConnect, isIP, type Socket } from "node:net";
import { checkServerIdentity, connect as tlsConnect, type PeerCertificate } from "node:tls";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import {
  MQTT_CLIENT_ID_PREFIX,
  MQTT_CLIENT_ID_RANDOM_BYTES,
  MQTT_CONNECT_TIMEOUT_MS,
  MQTT_KEEP_ALIVE_SECONDS,
  MQTT_MAX_STRING_BYTES,
  MQTT_NOTHING_CAME_BACK,
  MQTT_PING_INTERVAL_MS,
  MQTT_READ_BUDGET_BYTES,
  MQTT_READ_BUDGET_MESSAGES,
  MQTT_READ_BUDGET_MS,
  MQTT_REFUSED_FILTER_PREFIXES,
  MQTT_TYPE,
  MQTT_WILDCARD_FILTER,
} from "./constants";
import { encodeConnect, encodeDisconnect, encodePingReq, encodeSubscribe } from "./encoder";
import { guardOutboundPacket, inspectInboundPacket } from "./valve";

/** What one topic looked like when it was last seen. */
export interface MqttTopicRow {
  /**
   * The server's own Message Expiry Interval, in seconds, or undefined when the message carried none.
   *
   * IT IS THE SERVER'S ANSWER AND NOTHING IS COMPUTED FROM IT. The wire carries what is left of a message's
   * lifetime, never its age: age would be the publisher's original value minus what arrived, and the first
   * term is never transmitted. Two brokers of the five we measured do not reduce it at all, which is a
   * departure from [MQTT-3.3.2-6], and a client cannot tell a conforming number from a non conforming one.
   */
  readonly lifetimeSeconds?: number;
  /** Whether the broker marked this message retained, which is the only way a quiet topic is ever seen. */
  readonly retained: boolean;
  /** The payload's size. The payload itself is not held unless `keepPayloadFor` named this topic. */
  readonly payloadBytes: number;
  /** The payload, present only for the one topic `keepPayloadFor` named. */
  readonly payload?: Uint8Array;
}

/** Why a read stopped. Always written, never an empty string, and never a guess. */
export type MqttEndReason =
  | "budget-time"
  | "budget-messages"
  | "budget-bytes"
  | "server-disconnect"
  | "subscription-refused"
  | "transport-closed";

/** What every read reports, whatever happened. */
export interface MqttReadOutcome {
  readonly topics: ReadonlyMap<string, MqttTopicRow>;
  /**
   * `incomplete` only where it can be proved, `unknown` everywhere else. `complete` is not a value: MQTT
   * gives no way to establish it, and no tool we surveyed has found one either.
   */
  readonly scope: "incomplete" | "unknown";
  readonly endReason: MqttEndReason;
  /**
   * The broker's own reason code, where the end had one: the first refusal in the SUBACK.
   *
   * CARRIED BECAUSE THE SENTENCE NEEDS IT. The code was read, reduced to "at least one refusal" and thrown
   * away, so every refusal in Table 3-8 produced the same remedy - "try a branch, such as sensors/#" - which
   * is wrong for a broker that supports no wildcard at all, and wrong again for a malformed filter.
   */
  readonly endCode?: number;
  /** Bytes a packet over the inbound limit cost us, by topic where the topic was readable. */
  readonly provenLoss: readonly string[];
  /** Messages taken off the wire. A count with no denominator, because MQTT publishes none. */
  readonly messages: number;
  /** How long the read ran, in milliseconds. Reported, never interpreted. */
  readonly elapsedMs: number;
}

/**
 * The transport a session writes to and reads from: a TCP or TLS socket in the product, and a scripted stream
 * in a test. The seam exists so the integration tests replay a broker's recorded bytes through the real
 * session, rather than through a copy of it that could drift.
 */
export interface MqttTransport {
  write(bytes: Buffer): void;
  on(event: "data", handler: (chunk: Buffer) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  on(event: "close", handler: () => void): void;
  once(event: string, handler: () => void): void;
  destroy(): void;
}

/** How a session opens its transport. The default dials the broker; a test passes its own. */
export type MqttTransportFactory = (options: MqttSessionOptions) => {
  readonly transport: MqttTransport;
  /** The event that means "ready to write", which differs between a plain and a TLS socket. */
  readonly readyEvent: string;
  /**
   * The event that means the TCP connection is up, when that is not the same event.
   *
   * On a plain socket the two coincide and this is absent. On a TLS socket `connect` fires when the server
   * accepts and `secureConnect` only when the handshake completes, and the gap between them is a real
   * failure with its own cause: a server that accepts and then never negotiates. Without this, a dropped
   * SYN and a stalled TLS handshake were reported in the same words, and one of the two sentences was
   * always wrong.
   */
  readonly openedEvent?: string;
};

export interface MqttSessionOptions {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  /**
   * Whether the broker's certificate is checked.
   *
   * RESOLVED BY THE CALLER, because only the caller knows the SSL mode. The house rule, stated in
   * `src/lib/types.ts` and followed by Redis, MongoDB, Couchbase, Kafka and Prometheus, is
   * `ssl.rejectUnauthorized ?? ssl.mode !== "require"`: `require` encrypts and verifies nothing, because a
   * self-hosted broker ordinarily presents a self-signed certificate and refusing it would make the ordinary
   * local TLS deployment unreachable; every `verify-` mode verifies. This provider read `?? true` instead,
   * which refused exactly that ordinary deployment while the hint under the selector promised it would be
   * accepted. `sessionOptions()` applies the rule now, and the default below is the safe one for a direct
   * call that names no mode.
   */
  readonly rejectUnauthorized?: boolean;
  /** The CA chain to verify the broker against, as PEM text, from the SSL / TLS panel's CA Certificate box. */
  readonly caCert?: string;
  /** A client certificate, as PEM text, for a broker that asks for one. */
  readonly clientCert?: string;
  /** The client certificate's private key, as PEM text. */
  readonly clientKey?: string;
  readonly user?: string;
  readonly password?: string;
  /** What to subscribe to. Empty means `#`, which never reaches a `$` root ([MQTT-4.7.2-1]). */
  readonly filter?: string;
  /**
   * Keep the payload of this one topic, and of no other.
   *
   * THE TREE HOLDS NAMES ONLY. Holding every payload is the single most effective way to become a slow reader,
   * which is when a broker starts dropping messages on our behalf, so a payload is kept only when a reader has
   * asked for that one topic by clicking it.
   */
  readonly keepPayloadFor?: string;
  /** The transport seam. Absent dials the broker over TCP or TLS. */
  readonly openTransport?: MqttTransportFactory;
  /**
   * Milliseconds between PINGREQs. Absent reads `MQTT_PING_INTERVAL_MS`, half the declared Keep Alive.
   *
   * A test shortens it, because the real interval is thirty seconds and a read ends in three: without this
   * the keep-alive could only ever be reasoned about, and a long read whose keep-alive is broken is dropped
   * by the broker rather than ended by us, which looks like a short read with no reason given.
   */
  readonly pingEveryMs?: number;
  /**
   * Milliseconds the dial itself is given. Absent reads `MQTT_CONNECT_TIMEOUT_MS`, ten seconds.
   *
   * A test shortens it, for the same reason `pingEveryMs` exists: the real clock is ten seconds, and the two
   * sentences this timeout chooses between - "did not answer at all" against "accepted the connection and
   * did not finish the handshake" - are the ones a reader acts on, so they have to be asserted rather than
   * reasoned about. Without this seam each assertion cost ten seconds of CI.
   */
  readonly dialTimeoutMs?: number;
  /**
   * The name the broker's certificate is checked against, when it is not `host`.
   *
   * Through an SSH tunnel `host` is the local forward the socket dials, and the certificate belongs to the
   * broker at the far end, so checking it against `127.0.0.1` would fail for every correctly issued
   * certificate. `sessionOptions()` sets this to the far end's host when a tunnel carries the connection.
   */
  readonly tlsIdentity?: string;
}

/**
 * The product's transport: a TCP socket, or a TLS one when the connection's SSL mode asks for it.
 *
 * THE SERVER NAME AND THE IDENTITY ARE TWO DIFFERENT THINGS, and conflating them broke verified TLS outright.
 * Node refuses an IP literal as a server name ("Setting the TLS ServerName to an IP address is not
 * permitted"), so this sent the unresolvable `mqtt.invalid` in its place - and then Node checked the
 * certificate against THAT name, so every `verify-` mode failed with `ERR_TLS_CERT_ALTNAME_INVALID` against
 * a broker addressed by IP, however correct its IP SAN. Through an SSH tunnel it was worse: the host is the
 * local forward, so the certificate was checked against `127.0.0.1` rather than against the broker.
 *
 * The answer is the one `tlsAgentOptions` in `src/lib/db/http/node-transport.ts` already gives: send a server
 * name only when the identity is a DNS name, and check the certificate against the IDENTITY, which through a
 * tunnel is the far end and never the local forward. Node's own check reads an IP SAN for an IP identity.
 */
const dialBroker: MqttTransportFactory = (options) => {
  const identity = options.tlsIdentity ?? options.host;
  const socket: Socket = options.tls
    ? (tlsConnect({
        host: options.host,
        port: options.port,
        // SNI only for a DNS name; an IP literal is refused here and needs none.
        ...(isIP(identity) === 0 ? { servername: identity } : {}),
        rejectUnauthorized: options.rejectUnauthorized ?? true,
        // The identity, not the address dialled: through a tunnel those differ, and the certificate belongs
        // to the broker at the far end.
        checkServerIdentity: (_dialled: string, certificate: PeerCertificate) =>
          checkServerIdentity(identity, certificate),
        // THE PANEL'S THREE BOXES WERE DRAWN AND DISCARDED. The SSL / TLS panel offers a CA certificate, a
        // client certificate and its key for every engine that has TLS, and none of the three reached this
        // call: a broker signed by a private CA was unreachable in `verify-ca` with the CA pasted in, and a
        // broker asking for a client certificate refused the handshake with the certificate on screen.
        ...(options.caCert === undefined ? {} : { ca: options.caCert }),
        ...(options.clientCert === undefined ? {} : { cert: options.clientCert }),
        ...(options.clientKey === undefined ? {} : { key: options.clientKey }),
      }) as unknown as Socket)
    : netConnect(options.port, options.host);
  return {
    transport: socket as unknown as MqttTransport,
    readyEvent: options.tls ? "secureConnect" : "connect",
    // Under TLS the two are different events; on a plain socket `connect` is both, so none is named.
    ...(options.tls ? { openedEvent: "connect" } : {}),
  };
};

/**
 * A client id of a fixed prefix and a mandatory random suffix.
 *
 * THE SUFFIX IS RANDOM RATHER THAN A PROCESS ID. MQTT ends the older session when a second connection arrives
 * with the same id (Session Taken Over, 0x8E, section 3.1.4), so a colliding id disconnects whoever was there
 * first. The reference client uses `getpid()`, and process ids are small and repeat across container restarts.
 */
export function newClientId(): string {
  const bytes = new Uint8Array(MQTT_CLIENT_ID_RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  return MQTT_CLIENT_ID_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The filter a read subscribes to, refused before SUBSCRIBE rather than after.
 *
 * A shared or exclusive subscription cannot be detected afterwards: every broker we measured answers SUBACK
 * Granted and then simply delivers less, while a device that needed those messages never gets them. The
 * comparison is case sensitive because `$SHARE/...` in uppercase is an ordinary topic carrying real data.
 */
export function readFilter(filter: string | undefined): string {
  // Taken exactly as given: a topic may begin or end with a space, and the Source tab subscribes to the name it
  // was handed. The connection's typed field is trimmed where it is read, in `sessionOptions()`.
  const wanted = filter === undefined || filter === "" ? MQTT_WILDCARD_FILTER : filter;
  // BOUNDED HERE, BEFORE A SOCKET EXISTS. An MQTT string holds at most 65,535 bytes, and `encodeString`
  // refuses a longer one - but it refused it inside a socket listener, where the throw was an uncaught
  // exception that ended the Node process. Refusing it here makes it what it always was: a config error,
  // named as one, before anything is dialled.
  if (Buffer.byteLength(wanted, "utf8") > MQTT_MAX_STRING_BYTES)
    throw new DatabaseConfigError(
      `A topic filter holds at most ${MQTT_MAX_STRING_BYTES.toLocaleString("en-US")} bytes, and this one is ` +
        `${Buffer.byteLength(wanted, "utf8").toLocaleString("en-US")}.`,
      MQTT_TYPE,
    );
  const refused = MQTT_REFUSED_FILTER_PREFIXES.find((prefix) => wanted.startsWith(prefix));
  if (refused !== undefined)
    throw new QueryError(
      `A filter beginning ${refused} is refused. It takes messages away from the devices subscribed beside us, ` +
        "the broker reports nothing when it happens, and a read-only tool must not be able to do that. " +
        "Type the topic filter without the prefix.",
      MQTT_TYPE,
    );
  return wanted;
}

/**
 * What a non-zero CONNACK reason code means, in the words a reader can act on (section 3.2.2.2).
 *
 * The code itself is always named, because a broker may answer one this list does not cover and a number the
 * reader can search for is worth more than a sentence that pretends to know.
 *
 * THE CODES ARE TABLE 3-1's, NOT A GUESS, AND ONE OF THEM WAS WRONG. `0x83` read "does not support this
 * protocol version" here, which is `0x84`; `0x83` is Implementation specific error, and `0x84` was missing
 * altogether. The consequence was the worst kind: a broker refusing our version got a sentence about an
 * internal fault it never reported, and the one broker failure this provider's version policy makes likely
 * fell through to the bare-number branch. `tests/unit/db/mqtt/session.test.ts` now pins each code to a word
 * of Table 3-1's own name for it.
 */
export function connackSentence(code: number): string {
  const known: Readonly<Record<number, string>> = {
    // Not a 5.0 code. A 3.1.1 broker answers the older CONNACK, whose return code 1 is "unacceptable protocol
    // version", and that is the broker this provider meets most often, so it is named rather than numbered.
    0x01: "the broker does not speak MQTT 5.0, which this provider requires: a subscription's reason code and a message's remaining lifetime exist only in 5.0",
    0x81: "the broker could not read the CONNECT packet",
    0x82: "the broker rejected the CONNECT as not allowed on this connection",
    0x83: "the broker hit an error of its own that it does not describe further",
    0x84: "the broker does not support MQTT 5.0, which this provider requires",
    0x85: "the broker refused the client id",
    0x86: "the username or password is wrong",
    0x87: "this account is not authorized to connect",
    0x88: "the broker is unavailable",
    0x89: "the broker is busy",
    0x8a: "this client is banned",
    0x8c: "the broker asked for an authentication method this provider does not offer",
    0x97: "the broker's connection quota is full",
    0x9f: "the broker's connection rate limit was reached",
  };
  const sentence = known[code];
  return sentence === undefined
    ? `The broker refused the connection with reason code ${code} (0x${code.toString(16)}).`
    : `The broker refused the connection: ${sentence} (reason code ${code}, 0x${code.toString(16)}).`;
}

interface ParsedPacket {
  readonly cmd: string;
  readonly topic?: string;
  readonly retain?: boolean;
  readonly reasonCode?: number;
  readonly granted?: readonly number[];
  readonly properties?: { readonly messageExpiryInterval?: number };
  readonly payload?: Uint8Array | { readonly length?: number };
}

/** What this provider needs of `mqtt-packet`'s parser, and nothing else of the package. */
type ParserLike = { parse(buffer: Buffer): number; on(event: string, handler: (value: unknown) => void): void };

/**
 * The decoder, loaded by the one specifier that carries no writer.
 *
 * THE IMPORT PATH IS PART OF THE GUARANTEE, AND IT WAS WRONG ONCE. This read `import("mqtt-packet")` until an
 * audit loaded that same module and generated a real PUBLISH from it: the package root is three lines,
 * `exports.parser`, `exports.generate` and `exports.writeToStream`, so the writer travelled in the bundle while
 * the comment here claimed it did not. The subpath below is `module.exports = Parser` and reaches `bl`,
 * `debug`, `events`, `./packet` and `./constants` only; `generate` and `writeToStream` are `undefined` on it
 * under both Node and bun, and `tests/unit/db/mqtt/outbound.test.ts` asserts that from the loaded module.
 *
 * This is the second half of "this provider cannot write a PUBLISH". The first half is the encoder, which has
 * no function that writes one; the valve in `valve.ts` is the third.
 */
async function newParser(): Promise<ParserLike> {
  const loaded = await import("mqtt-packet/parser.js");
  // Node's CommonJS interop hands `module.exports` back as `default`, while bun also lifts the class's
  // statics onto the namespace. Both shapes are read so this resolves under the app bundler and the runner.
  const lifted = loaded as unknown as { parser?: (options: { protocolVersion: number }) => ParserLike };
  const factory = lifted.parser ?? loaded.default?.parser;
  if (typeof factory !== "function") throw new QueryError("The MQTT decoder did not load.", MQTT_TYPE);
  return factory({ protocolVersion: 5 });
}

/**
 * THE ONE PLACE A BYTE LEAVES THIS PROVIDER, and it guards before it writes.
 *
 * The session calls nothing else: `session.ts` holds no other `.write(`, which
 * `tests/unit/db/mqtt/outbound.test.ts` asserts over this file's own source. That is what makes the valve
 * impossible to bypass by accident rather than merely present. A caller that hands this a packet outside the
 * five gets the refusal, whatever the caller believed it was sending.
 */
export function writeToTransport(transport: MqttTransport, bytes: Uint8Array): void {
  guardOutboundPacket(bytes);
  transport.write(Buffer.from(bytes));
}

/**
 * The topic of a PUBLISH we are about to throw away, when its header is already in hand.
 *
 * A LOSS WITHOUT A TOPIC DOES NOT TELL THE READER WHICH BRANCH IS MISSING, which is the whole point of
 * reporting it. The topic sits right after the Remaining Length in a PUBLISH, so it is readable from the
 * same bytes the limit was decided on, with nothing of the body allocated. Any other packet type, or a
 * header that has not fully arrived, answers undefined rather than a guess.
 */
export function topicOfSkippedPublish(
  bytes: Uint8Array,
  verdict: { readonly size: number; readonly bytes: number; readonly packetType: number },
): string | undefined {
  if (verdict.packetType !== 3) return undefined;
  const header = verdict.size - verdict.bytes;
  const at = header + 2;
  if (at > bytes.length) return undefined;
  const length = ((bytes[header] as number) << 8) | (bytes[header + 1] as number);
  if (at + length > bytes.length) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(at, at + length));
  } catch {
    // A topic that is not UTF-8 text has no name a sentence could carry without naming a different topic.
    return undefined;
  }
}

/** The sentence for one skipped message: its size always, its topic where the header gave one. */
export function skipSentence(size: number, topic: string | undefined): string {
  const bytes = `${size.toLocaleString("en-US")} bytes`;
  return topic === undefined
    ? `A message of ${bytes} was larger than this connection reads and was skipped. Its topic was not in the part of the packet we read, so the branch it belongs to cannot be named.`
    : `The message on "${topic}" is ${bytes}, larger than this connection reads, and was skipped.`;
}

/**
 * Opens a connection, subscribes once, collects what arrives until a budget ends the read, and leaves.
 *
 * Clean Start with a zero Session Expiry Interval: nothing is left behind for the broker to queue for a client
 * that is not coming back, which is itself one of the ways a broker silently drops a device's messages.
 */
export async function readTopics(options: MqttSessionOptions): Promise<MqttReadOutcome> {
  const filter = readFilter(options.filter);
  const parser = await newParser();
  const topics = new Map<string, MqttTopicRow>();
  const provenLoss: string[] = [];
  const started = Date.now();

  return new Promise<MqttReadOutcome>((resolve, reject) => {
    let settled = false;
    let messages = 0;
    /** PUBLISH packets that carried no topic name, reported as a loss when the read ends. */
    let nameless = 0;
    let bytes = 0;
    let connected = false;
    /**
     * The server accepted the TCP connection.
     *
     * Three states, not two, and the dial timeout needs all three: nothing answered, the connection was
     * accepted but the handshake never finished, and the CONNACK arrived (`connected`). Under TLS the middle
     * one is its own failure, because `connect` fires on acceptance and `secureConnect` only on completion.
     */
    let tcpOpen = false;
    let pending: Buffer = Buffer.alloc(0);
    /** Bytes of an oversized packet still to be thrown away, across however many chunks they arrive in. */
    let skipping = 0;
    let scope: "incomplete" | "unknown" = "unknown";
    /** The first refusal code the broker sent, kept for the sentence the panel shows. */
    let endCode: number | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let budget: ReturnType<typeof setTimeout> | undefined;
    /** The dial's own clock: started at dial time, cleared wherever the read ends. */
    let dial: ReturnType<typeof setTimeout> | undefined;

    const dialTimeout = options.dialTimeoutMs ?? MQTT_CONNECT_TIMEOUT_MS;
    const opened = (options.openTransport ?? dialBroker)(options);
    const socket = opened.transport;

    /**
     * Writing, with the one property a socket listener needs: IT NEVER THROWS.
     *
     * THIS KILLED THE SERVER PROCESS. Every call below runs inside a `node:net` or `node:tls` listener, and
     * a throw escaping one of those is an uncaught exception: under Node, which is what production runs
     * (`next start`, and the image's `node server.js`), the process exits 1. The tests run under bun, which
     * turns the same throw into a socket `error` event and a clean rejection, so no test in this suite could
     * see it, and a 100% line-coverage gate says nothing about it. Measured both ways on the same bundle:
     * bun rejected, Node died.
     *
     * It was reachable from ordinary input, because `encodeString` refuses a string over 65,535 bytes and
     * nothing upstream capped one. `sessionOptions()` and `readFilter()` now bound all three fields, so this
     * is the second line of defence rather than the first. It takes the packet as a function so the
     * encoding runs inside the `try` too: an encoder throw is the case this guard is for.
     */
    const write = (build: () => Uint8Array): void => {
      try {
        writeToTransport(socket, build());
      } catch (error) {
        fail(error instanceof Error ? error : new QueryError(String(error), MQTT_TYPE));
      }
    };
    /**
     * One PINGREQ, and only while the session is both connected and unfinished.
     *
     * Named rather than inline so a test can run it: an interval that fires half a keep-alive apart cannot be
     * reached inside a read that ends in three seconds, and an untested keep-alive is how a long read quietly
     * gets dropped by a broker that thinks the client is gone.
     */
    const keepAlive = (): void => {
      if (connected && !settled) write(encodePingReq);
    };

    const finish = (endReason: MqttEndReason): void => {
      if (settled) return;
      /**
       * A CONNECTION THAT NEVER ANSWERED IS NOT AN EMPTY TREE.
       *
       * The read budget is shorter than the handshake timeout, so a server that accepts the socket and then
       * says nothing would otherwise reach this with no CONNACK and resolve an empty read: the panel would
       * draw a broker with no topics and a sentence about a time budget, for a server that never agreed to
       * speak MQTT at all. That is the shape of silent failure this whole design refuses, so it fails here.
       */
      if (!connected) {
        // AND IT SAYS WHICH SILENCE IT WAS. Every pre-CONNACK end was once reported as "sent no CONNACK",
        // including the one where the broker hung up without a word.
        //
        // IT DOES NOT NAME A CAUSE IT CANNOT KNOW. A first draft of this branch told the reader that a
        // TLS-only port closes a plain connection "exactly this way". Measured against a real `node:tls`
        // server, it does not: the TLS alert arrives as bytes, frames as a CONNECT with illegal header flags,
        // and the read ends on the decoder rather than here. What does arrive here is a bare FIN with no
        // bytes at all, where that explanation would usually be wrong. So it reports the fact and stops.
        fail(
          new QueryError(
            (endReason === "transport-closed"
              ? "The broker closed the connection without answering the handshake, so it never agreed to speak MQTT 5.0."
              : "The broker accepted the connection and sent no CONNACK, so it never agreed to speak MQTT 5.0.") +
              " Nothing was read, and an empty topic tree would be a wrong answer rather than an empty one.",
            MQTT_TYPE,
          ),
        );
        return;
      }
      settled = true;
      if (ping !== undefined) clearInterval(ping);
      if (budget !== undefined) clearTimeout(budget);
      if (dial !== undefined) clearTimeout(dial);
      write(encodeDisconnect);
      socket.destroy();
      if (nameless > 0) {
        scope = "incomplete";
        provenLoss.push(
          `${nameless.toLocaleString("en-US")} ${nameless === 1 ? "message" : "messages"} arrived with no topic name ` +
            "(a Topic Alias this connection never offered), so the branch each belongs to cannot be named.",
        );
      }
      resolve({
        topics,
        scope,
        endReason,
        ...(endCode === undefined ? {} : { endCode }),
        provenLoss,
        messages,
        elapsedMs: Date.now() - started,
      });
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (ping !== undefined) clearInterval(ping);
      if (budget !== undefined) clearTimeout(budget);
      if (dial !== undefined) clearTimeout(dial);
      socket.destroy();
      reject(error);
    };

    parser.on("packet", (value) => {
      const packet = value as ParsedPacket;
      if (packet.cmd === "connack") {
        // One CONNACK per connection (MQTT 5.0 section 3.2). A second would otherwise send a second SUBSCRIBE.
        if (connected) {
          fail(
            new QueryError("The broker sent a second CONNACK on one connection, which MQTT 5.0 forbids.", MQTT_TYPE),
          );
          return;
        }
        const code = packet.reasonCode ?? 0;
        if (code !== 0) {
          fail(new QueryError(connackSentence(code), MQTT_TYPE));
          return;
        }
        connected = true;
        if (dial !== undefined) clearTimeout(dial);
        write(() => encodeSubscribe(1, [filter]));
        return;
      }
      if (packet.cmd === "suback") {
        const codes = packet.granted ?? [];
        const refused = codes.filter((code) => code >= 0x80);
        if (refused.length === codes.length && codes.length > 0) {
          scope = "incomplete";
          endCode = refused[0];
          finish("subscription-refused");
          return;
        }
        if (refused.length > 0) scope = "incomplete";
        return;
      }
      if (packet.cmd === "publish") {
        const topic = packet.topic;
        // `""` is not a topic. A broker using Topic Alias sends the name once and omits it afterwards; we
        // advertise no Topic Alias Maximum, so a conforming broker never does, but a row keyed on the empty
        // string would re-read the whole broker when clicked, because an empty filter means `#`.
        if (topic === undefined || topic === "") {
          nameless += 1;
          return;
        }
        messages += 1;
        const body = packet.payload;
        const bodyBytes = body instanceof Uint8Array ? body : undefined;
        topics.set(topic, {
          ...(packet.properties?.messageExpiryInterval === undefined
            ? {}
            : { lifetimeSeconds: packet.properties.messageExpiryInterval }),
          retained: packet.retain === true,
          payloadBytes: body?.length ?? 0,
          ...(options.keepPayloadFor === topic && bodyBytes !== undefined
            ? { payload: Uint8Array.from(bodyBytes) }
            : {}),
        });
        if (messages >= MQTT_READ_BUDGET_MESSAGES) finish("budget-messages");
        return;
      }
      if (packet.cmd === "disconnect") {
        // Before the CONNACK there is no read to report, only a refusal, and its code is the broker's reason.
        if (!connected) {
          const code = packet.reasonCode ?? 0;
          fail(
            new QueryError(
              `The broker ended the connection before answering the handshake, with reason code ${code} ` +
                `(0x${code.toString(16)}). Nothing was read.`,
              MQTT_TYPE,
            ),
          );
          return;
        }
        // The broker ended it. Whatever its reason code, the read stopped before our budget did, so what we
        // hold is provably short of what the filter matched.
        scope = "incomplete";
        finish("server-disconnect");
      }
    });

    parser.on("error", (value) =>
      fail(new QueryError(`The broker sent a packet we cannot read: ${String(value)}`, MQTT_TYPE)),
    );

    socket.on("data", (chunk: Buffer) => {
      // The read already has its answer; anything still arriving belongs to a session we have left, and
      // letting it land would put a topic in a tree whose own sentence says nothing could be read.
      if (settled) return;
      bytes += chunk.length;

      // A SKIP IN PROGRESS IS A COUNTER, NOT A BUFFER. An oversized packet is almost never in one chunk:
      // its body arrives over many, and the body of a PUBLISH is arbitrary bytes that frame as plausible
      // packets. Dropping the buffer and resuming at the next byte therefore read a message's payload as
      // if it were protocol, and the read died blaming the broker for a packet it had sent correctly.
      if (skipping > 0) {
        const taken = Math.min(skipping, chunk.length);
        skipping -= taken;
        if (skipping > 0) {
          if (bytes >= MQTT_READ_BUDGET_BYTES) finish("budget-bytes");
          return;
        }
        pending = Buffer.from(chunk.subarray(taken));
      } else {
        pending = pending.length === 0 ? chunk : (Buffer.concat([pending, chunk]) as Buffer);
      }

      for (;;) {
        const verdict = inspectInboundPacket(pending, 0);
        if (verdict.kind === "need") break;
        if (verdict.kind === "malformed") {
          fail(new QueryError(`The stream is no longer MQTT: ${verdict.reason}`, MQTT_TYPE));
          return;
        }
        if (verdict.kind === "skip") {
          // Skipped by byte count, never allocated. The skip is reported rather than hidden: a read that
          // quietly omits a large message is the loss this design exists to refuse. The topic travels with
          // it where the header carried one, because a loss without a topic does not tell the reader which
          // branch is missing.
          scope = "incomplete";
          provenLoss.push(skipSentence(verdict.bytes, topicOfSkippedPublish(pending, verdict)));
          const present = Math.min(verdict.size, pending.length);
          skipping = verdict.size - present;
          pending = skipping > 0 ? Buffer.alloc(0) : (pending.subarray(verdict.size) as Buffer);
          if (skipping > 0) break;
          continue;
        }
        parser.parse(pending.subarray(0, verdict.size));
        pending = pending.subarray(verdict.size) as Buffer;
        if (settled) return;
      }
      if (bytes >= MQTT_READ_BUDGET_BYTES) finish("budget-bytes");
    });

    socket.on("error", (error: Error) =>
      fail(new QueryError(`The broker could not be reached: ${error.message}`, MQTT_TYPE)),
    );
    socket.on("close", () => {
      if (settled) return;
      scope = "incomplete";
      finish("transport-closed");
    });

    const onReady = (): void => {
      tcpOpen = true;
      write(() =>
        encodeConnect({
          clientId: newClientId(),
          keepAliveSeconds: MQTT_KEEP_ALIVE_SECONDS,
          ...(options.user === undefined ? {} : { user: options.user }),
          ...(options.password === undefined ? {} : { password: options.password }),
        }),
      );
      // A CONNECT that could not be written has already failed the read, and starts no timer.
      if (settled) return;
      // NO SEPARATE CONNACK TIMER HERE, and an audit proved why one would be dead: it was set to
      // `MQTT_CONNECT_TIMEOUT_MS` (10s) while `budget` below is `MQTT_READ_BUDGET_MS` (3s), so the budget
      // always fired first and `finish()` turned it into the no-CONNACK failure. Measured against a socket
      // that accepts and never speaks: the read failed at 3,003 ms carrying `finish()`'s words, never this
      // timer's. The silence before the handshake is covered by `dial` below, and the silence after it by
      // `budget` plus `finish()`'s `!connected` arm.
      ping = setInterval(() => keepAlive(), options.pingEveryMs ?? MQTT_PING_INTERVAL_MS);
      budget = setTimeout(() => finish("budget-time"), MQTT_READ_BUDGET_MS);
    };

    socket.once(opened.readyEvent, onReady);
    // Under TLS, `connect` fires when the server accepts and `secureConnect` only when the handshake ends.
    // Recording the first is what lets the dial timeout tell "nothing answered" from "answered and stalled".
    if (opened.openedEvent !== undefined) {
      socket.once(opened.openedEvent, () => {
        tcpOpen = true;
      });
    }

    /**
     * THE DIAL ITSELF IS ON THE CLOCK, not only the CONNACK after it.
     *
     * Every other timer in this session starts in `onReady`, which fires on `connect` for a plain socket and
     * on `secureConnect` for a TLS one. A server that accepts the TCP connection and never completes the TLS
     * handshake therefore reached no timer at all, and the read hung for as long as the caller waited:
     * measured against a listening socket that answers nothing, the promise never settled. A reader would
     * see a connection dialog that spins with no error, which is the one outcome this provider refuses
     * everywhere else.
     */
    dial = setTimeout(() => {
      if (connected || settled) return;
      // WHICH OF THE TWO SILENCES IT WAS, because the usual cause differs and `tcpOpen` is the fact that
      // separates them. This said "accepted the connection" for both, so a dropped SYN - a firewall rule or a
      // wrong address, among the commonest failures there are - was reported as a broker that answered and
      // then went quiet, which points the reader at the broker instead of at the route.
      const seconds = (dialTimeout / 1000).toLocaleString("en-US");
      fail(
        new QueryError(
          tcpOpen
            ? `The broker at ${options.host}:${options.port} accepted the connection and did not finish ` +
                `${options.tls ? "the TLS handshake" : "the MQTT handshake"} within ${seconds} seconds.`
            : `The broker at ${options.host}:${options.port} did not answer within ${seconds} seconds. ${MQTT_NOTHING_CAME_BACK}`,
          MQTT_TYPE,
        ),
      );
    }, dialTimeout);
  });
}
