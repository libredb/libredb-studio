/**
 * One bounded read of a broker: dial, subscribe, take what the budgets allow, disconnect.
 *
 * WHAT THIS MODULE KEEPS THAT THE SHIPPED MQTT READ DOES NOT. That read returns a map keyed by
 * topic, one row per topic. A Sparkplug read depends on the ORDER of successive messages on the
 * same topic: a sequence gap is read from two consecutive data messages, a rebirth replaces the
 * definition mid-read, and the specification warns that a death can arrive after the next birth.
 * Fifty data messages on one topic have to stay fifty entries, so this read returns a SEQUENCE.
 * That difference is the whole reason this module exists rather than reusing the other one, and
 * the cost is written down: two directories carry a similar dial until a shared transport is
 * extracted, which is separate work because extracting it has to widen the shipped result shape.
 *
 * NOTHING IS DECODED ON THE RECEIVE PATH. Payloads are kept as raw bytes under a cap and decoded
 * after the read ends, so a slow decode cannot make this reader a slow consumer that a broker
 * starts dropping messages for.
 *
 * THE DIAL USES THE SHARED EGRESS RULE AND WRITES NO ADDRESS CHECK OF ITS OWN. `socketEgress`
 * refuses a blocked or link-local literal before the dial and returns the lookup that refuses a
 * blocked answer, which is the same function the shared node transport uses. A provider that wrote
 * its own address check would be a second implementation of a security rule, and the two would
 * drift.
 */
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { QueryError } from "@/lib/db/errors";
import { socketEgress } from "@/lib/db/http/egress-policy";
import { type NodeTlsMaterial, nodeTlsConnectOptions } from "@/lib/db/http/node-transport";
import {
  CLIENT_ID_PREFIX,
  CLIENT_ID_RANDOM_BYTES,
  KEEP_ALIVE_SECONDS,
  MQTT_PROTOCOL_LEVEL,
  PING_INTERVAL_MS,
} from "./constants";
import { encodeConnect, encodeDisconnect, encodePingReq, encodeSubscribe, encodeUnsubscribe } from "./encoder";

/** What ended a read. The panel names this, so it is a value and not a sentence. */
export type EndReason =
  | "time-budget"
  | "message-budget"
  | "byte-budget"
  | "broker-closed"
  /**
   * The socket itself failed, so no read happened at all.
   *
   * SEPARATE FROM `frame-refused`, AND WIRING THE PROVIDER IS WHAT SHOWED WHY. Both were `refused`
   * until a read against an address with no broker on it came back as an ordinary empty read whose
   * reason was "refused" - the same word a payload this reader could not parse produces. They are
   * different SCOPES: this one says the whole connection never existed and nothing the user asked
   * for was attempted, while the other says the connection worked and one frame in it did not. A
   * user who typed the wrong host needs the first; one whose broker sent something unreadable needs
   * the second, and a single word made the two indistinguishable.
   */
  | "dial-failed"
  /** A frame this reader could not parse, on a connection that otherwise worked. */
  | "frame-refused"
  /**
   * The broker answered the CONNECT with a refusal, so there was a server and it said no.
   *
   * A THIRD SCOPE, AND IT USED TO LOOK LIKE THE SECOND. A broker that refuses a connection closes
   * the socket afterwards, so this arrived as `broker-closed`: the same value a broker that accepted
   * the read and then went away produces. A reader whose credentials are wrong and a reader whose
   * broker restarted mid-read do different things about it.
   */
  | "connect-refused"
  /**
   * The broker accepted the connection and refused the SUBSCRIPTION, so nothing could be read.
   *
   * THE ONE THAT WAS INVISIBLE. Nothing here read SUBACK at all: a broker that refused every filter
   * produced an outcome identical to a broker with nothing to say, which is "0 rows, ended on the
   * time budget". That is not hypothetical, it is the default. The shipped MQTT guide measured a
   * stock EMQX 5.8.9 refusing `#`, `+/#` and `$SYS/#` out of the box with SUBACK 135, and `#` is
   * exactly the filter a Sparkplug read uses when no group is named. So on a stock EMQX this reader
   * reported a quiet plant where the truth was a refused subscription, and the fix for the two is
   * different: one is "your plant is quiet", the other is "narrow your filter or ask for access".
   */
  | "subscription-refused"
  /**
   * The broker said in its CONNACK that it does not accept wildcard subscriptions.
   *
   * KNOWN BEFORE THE SUBACK, WHICH IS WHY IT IS ITS OWN REASON. MQTT 5.0 3.2.2.3.11 lets a broker
   * declare `Wildcard Subscription Available` as 0 at connect time, and a Sparkplug read has no
   * wildcard-free form to fall back on: every filter this provider sends ends in `#`, because the
   * namespace puts the message type at a fixed level and a read has to cross it. So this is not
   * "narrow your filter", which is what a refused SUBACK usually means; there is no narrower filter.
   * Reported at CONNACK rather than waiting for the SUBACK to say the same thing later.
   */
  | "wildcards-unavailable";

/** One message, in the order it arrived. A topic can appear many times. */
export interface ReceivedMessage {
  readonly topic: string;
  /** The raw payload, kept undecoded. Absent when the byte cap was already reached. */
  readonly payload?: Uint8Array;
  readonly payloadBytes: number;
  /** When this reader received it. The only time that means the same thing on every broker. */
  readonly receivedAt: number;
}

export interface SessionOptions {
  readonly host: string;
  readonly port: number;
  readonly filters: readonly string[];
  readonly windowMs: number;
  /**
   * How often the keep-alive PINGREQ goes out, defaulting to half the keep-alive the CONNECT
   * declares. It is an option and not only a constant because a timer nothing can shorten is a
   * line nothing can reach: at the 30 s default no unit run is alive long enough to see the ping,
   * and the house holds 100 percent of src. Nothing in the product passes it.
   */
  readonly pingIntervalMs?: number;
  readonly maxMessages: number;
  readonly maxBytes: number;
  /**
   * The SSL / TLS panel as `tls.connect` takes it, or null/absent for a plain socket.
   *
   * IT IS THE MATERIAL AND NOT A FLAG, which is the whole fix: a boolean can only say "use TLS"
   * and the panel's CA, client certificate, key and identity have nowhere to go, so a dial would
   * verify against the system store and against the address dialled. `nodeTlsConnectOptions`
   * carries all of it, including `servername` and `checkServerIdentity`.
   */
  readonly tls?: NodeTlsMaterial | null;
  readonly user?: string;
  readonly password?: string;
  /** The test seam. Given, no socket is opened and no address is resolved. */
  readonly openTransport?: TransportFactory;
}

/** What the session needs of a socket, which is less than a socket. */
export interface Transport {
  write(bytes: Uint8Array): void;
  on(event: "data", handler: (chunk: Buffer) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  on(event: "close", handler: () => void): void;
  once(event: string, handler: () => void): void;
  destroy(): void;
}

export type TransportFactory = (options: SessionOptions) => {
  readonly transport: Transport;
  readonly readyEvent: string;
};

export interface ReadOutcome {
  readonly messages: readonly ReceivedMessage[];
  readonly endReason: EndReason;
  readonly bytesSeen: number;
  /** True when the byte cap stopped payloads being kept, so the sequence is thinner than the read. */
  readonly payloadsDropped: number;
  /**
   * The broker's own reason code for a refusal, when it gave one.
   *
   * CARRIED AS A NUMBER AND NOT A SENTENCE, because the number is the broker's word and the sentence
   * would be this module's. MQTT 5.0 3.2.2.2 and 3.9.3 list them; 0x87 is "not authorized", which is
   * the one a refused wildcard gives.
   */
  readonly refusalCode?: number;
  /**
   * The runtime's own code for the error that ended the dial, when there was one.
   *
   * CARRIED AND NOT DISCARDED, which is the fix: the handler used to be `() => stop("dial-failed")`,
   * so a TLS verification failure and an address with nothing on it reached the caller as the same
   * fact and earned the same sentence - *"check the address, the port"* - for a connection whose
   * address and port were both right. The code is the runtime's word (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`,
   * measured here with a CA that signed nothing), and the sentence is the provider's.
   */
  readonly transportErrorCode?: string;
  readonly elapsedMs: number;
  /**
   * True when the broker answered with a CONNACK the session accepted, which is the only evidence
   * that anything on the far side speaks MQTT.
   *
   * MEASURED BECAUSE THE READ COULD NOT TELL TWO SILENCES APART: a port that accepts TCP and then
   * says nothing produced the same outcome as an idle plant - `time-budget`, zero messages - and
   * the panel called it a successful connection after the whole window had passed.
   */
  readonly handshook: boolean;
}

/** A client identifier that cannot collide with an edge node's, which would steal its session. */
export function newClientId(): string {
  const random = new Uint8Array(CLIENT_ID_RANDOM_BYTES);
  crypto.getRandomValues(random);
  return CLIENT_ID_PREFIX + Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What a parser instance does: fed bytes, it emits `packet` and `error`. */
interface ParserLike {
  on(event: "packet", handler: (packet: Record<string, unknown>) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
  parse(chunk: Buffer): void;
}

/**
 * Load the packet READER and nothing else.
 *
 * THE IMPORT PATH IS THE GUARANTEE. The package root re-exports `generate` and `writeToStream`, so
 * importing it would put a packet writer in the bundle one call away from a PUBLISH. The subpath is
 * `module.exports = Parser` and reaches no writer. `tests/unit/db/sparkplug/encoder.test.ts` holds
 * that from both sides: undefined on the subpath, functions at the root.
 */
async function newParser(): Promise<ParserLike> {
  const loaded = await import("mqtt-packet/parser.js");
  const lifted = loaded as unknown as {
    parser?: (options: { protocolVersion: number }) => ParserLike;
    default?: { parser?: (options: { protocolVersion: number }) => ParserLike };
  };
  const factory = lifted.parser ?? lifted.default?.parser;
  if (typeof factory !== "function") throw new QueryError("The Sparkplug decoder did not load.");
  return factory({ protocolVersion: MQTT_PROTOCOL_LEVEL });
}

/** Open a socket, with the shared egress rule and no address check of this module's own. */
function openSocket(options: SessionOptions): { transport: Transport; readyEvent: string } {
  const lookup = socketEgress(options.host, { refusesLinkLocal: true });
  const common = { host: options.host, port: options.port, ...(lookup === undefined ? {} : { lookup }) };
  const tls = options.tls ?? null;
  const socket: Socket =
    tls === null ? netConnect(common) : (tlsConnect({ ...common, ...nodeTlsConnectOptions(tls) }) as unknown as Socket);
  // `secureConnect` and not `connect`: on a TLS socket `connect` fires before the handshake, so a
  // CONNECT written on it would go out before the peer is verified.
  return { transport: socket as unknown as Transport, readyEvent: tls === null ? "connect" : "secureConnect" };
}

/**
 * Read once.
 *
 * The three budgets are checked in the order they can be reached, and the one that ended the read
 * is reported as a value rather than inferred from a count. A read that ended on the message
 * budget and one that ended on time are different facts for a user: the first says the broker is
 * busier than one read can cover, the second says it is quiet.
 */
export async function readOnce(options: SessionOptions): Promise<ReadOutcome> {
  if (options.filters.length === 0) throw new QueryError("A Sparkplug read needs at least one topic filter.");

  const parser = await newParser();
  const { transport, readyEvent } = (options.openTransport ?? openSocket)(options);

  const messages: ReceivedMessage[] = [];
  const started = Date.now();
  let bytesSeen = 0;
  let payloadsDropped = 0;
  let handshook = false;
  let ended: EndReason | undefined;
  let transportErrorCode: string | undefined;
  let refusalCode: number | undefined;
  let finish: (() => void) | undefined;

  const stop = (reason: EndReason) => {
    if (ended !== undefined) return;
    ended = reason;
    finish?.();
  };

  parser.on("error", () => {
    // A frame this reader cannot parse ends the read rather than being skipped: a parser that has
    // lost its place cannot tell a caller which messages it missed, and a sequence with a silent
    // hole in it is worse than a short one that says it is short.
    stop("frame-refused");
  });

  parser.on("packet", (packet) => {
    if (ended !== undefined) return;
    // THE ACKNOWLEDGEMENTS ARE READ BEFORE THE PUBLISHES ARE FILTERED, and that order is the fix:
    // everything that was not a publish used to be dropped here, which is how a refused subscription
    // became indistinguishable from a quiet broker.
    if (packet.cmd === "connack") {
      const code = Number(packet.reasonCode ?? packet.returnCode ?? 0);
      if (code !== 0) {
        refusalCode = code;
        stop("connect-refused");
        return;
      }
      // THE ONE CONNACK PROPERTY THAT DECIDES THIS READ. Of the four a broker may narrow with,
      // three cannot touch a Sparkplug read and that is measured rather than assumed: `maximumQoS`
      // cannot bite because every subscription here is QoS 0, which is the floor; a granted QoS
      // below the requested one is impossible for the same reason; and `retainAvailable` is about
      // retained messages, while a Sparkplug birth is published at QoS 0 and NOT retained, its
      // stored copy living in the `$sparkplug` tree instead. Wildcards are the exception: every
      // filter this provider sends has one, so a broker without them refuses the whole read.
      const properties = packet.properties as Record<string, unknown> | undefined;
      // Set AFTER the refusal check above, so a CONNACK that refuses is not read as a handshake.
      handshook = true;
      if (properties?.wildcardSubscriptionAvailable === false) stop("wildcards-unavailable");
      return;
    }
    if (packet.cmd === "suback") {
      // `granted` carries one reason code per filter, in the order they were sent (3.9.3). A code of
      // 0x80 or more is a refusal; below it the number is the QoS the broker granted.
      const codes = Array.isArray(packet.granted) ? packet.granted.map((one) => Number(one)) : [];
      const refused = codes.filter((code) => code >= 0x80);
      // ALL of them, not any: a Sparkplug read sends two or three filters and the stored-certificate
      // one is commonly refused on a broker that has no `$sparkplug` tree at all. One refusal means
      // a thinner read, and the read still happens; every filter refused means there is no read.
      if (codes.length > 0 && refused.length === codes.length) {
        refusalCode = refused[0];
        stop("subscription-refused");
      }
      return;
    }
    if (packet.cmd !== "publish") return;

    const topic = typeof packet.topic === "string" ? packet.topic : "";
    const body = packet.payload;
    const bytes = body instanceof Uint8Array ? body.length : 0;

    // THE PAYLOAD CAP IS APPLIED WHILE THE SEQUENCE GROWS, not at the end. A cap that only looked
    // at the total once the read finished would never run: by then the bytes are already held.
    const keep = bytesSeen + bytes <= options.maxBytes;
    if (!keep) payloadsDropped++;

    messages.push({
      topic,
      ...(keep && body instanceof Uint8Array ? { payload: Uint8Array.from(body) } : {}),
      payloadBytes: bytes,
      receivedAt: Date.now(),
    });

    if (messages.length >= options.maxMessages) stop("message-budget");
  });

  transport.on("data", (chunk) => {
    if (ended !== undefined) return;
    // Counted BEFORE the parser sees it, because the byte budget is about what crossed the socket
    // and not about what parsed cleanly.
    bytesSeen += chunk.length;
    if (bytesSeen > options.maxBytes * 2) {
      // The hard stop: twice the payload cap of raw bytes means the broker is sending far more than
      // this read can account for, and the cap on kept payloads alone would let the socket run on.
      stop("byte-budget");
      return;
    }
    // The parser is fed the chunk AS IT ARRIVED. A broker writes on its own boundaries, so a
    // length prefix can be split across two chunks and two packets can share one. Reassembly is
    // the parser's job and feeding it faithfully is this module's.
    parser.parse(chunk);
  });

  transport.on("error", (error: Error) => {
    const code = (error as Error & { readonly code?: unknown }).code;
    if (typeof code === "string") transportErrorCode = code;
    stop("dial-failed");
  });
  transport.on("close", () => stop("broker-closed"));

  const timer = setTimeout(() => stop("time-budget"), options.windowMs);
  const pinger = setInterval(() => {
    if (ended === undefined) transport.write(encodePingReq());
  }, options.pingIntervalMs ?? PING_INTERVAL_MS);

  await new Promise<void>((resolve) => {
    finish = resolve;
    transport.once(readyEvent, () => {
      transport.write(
        encodeConnect({
          clientId: newClientId(),
          keepAliveSeconds: KEEP_ALIVE_SECONDS,
          ...(options.user === undefined ? {} : { user: options.user }),
          ...(options.password === undefined ? {} : { password: options.password }),
        }),
      );
      transport.write(encodeSubscribe(1, options.filters));
    });
  });

  clearTimeout(timer);
  clearInterval(pinger);

  // A read leaves nothing behind: the subscription is withdrawn and the session closed cleanly.
  // Both writes are attempted even when the read ended badly, and a failure to send them does not
  // change what was read: a write on a socket the broker already closed does not throw (measured on
  // Node 26.12.1, Bun 1.4.2 and Bun 1.4.4, over plain TCP and TLS), it is dropped.
  transport.write(encodeUnsubscribe(2, options.filters));
  transport.write(encodeDisconnect());
  transport.destroy();

  return {
    messages,
    endReason: ended ?? "time-budget",
    ...(refusalCode === undefined ? {} : { refusalCode }),
    ...(transportErrorCode === undefined ? {} : { transportErrorCode }),
    bytesSeen,
    payloadsDropped,
    handshook,
    elapsedMs: Date.now() - started,
  };
}
