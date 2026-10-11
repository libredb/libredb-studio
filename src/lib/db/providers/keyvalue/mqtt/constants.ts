/**
 * Every number and fixed name of the MQTT provider (#1635), in one pure, browser-safe module.
 *
 * Every other module of the provider imports its numbers from here, and no module restates one. The module holds no
 * logic and imports nothing but a type, so the browser-safe modules can read it.
 */
import type { DatabaseType } from "@/lib/types";

/** The provider's type-id, the one every error of this provider is tagged with. */
export const MQTT_TYPE: DatabaseType = "mqtt";

/**
 * The plain TCP port, IANA-assigned for MQTT. 8883 is the IANA port for MQTT over TLS, and a reader who
 * chooses an SSL mode types it themselves: a default that changed under the SSL selector would move the port
 * a reader had set by hand.
 */
export const MQTT_DEFAULT_PORT = 1883;

/**
 * The protocol version in CONNECT. 5 is the only version this provider speaks: every field the panel draws
 * (a subscription's reason code, a message's remaining lifetime, the server's own limits) exists only in 5.0.
 * A 3.1.1 broker answers CONNACK with 0x01, and the connection sentence says which version was refused.
 */
export const MQTT_PROTOCOL_VERSION = 5;
/** The protocol name of 5.0 and 3.1.1 alike, four bytes on the wire. */
export const MQTT_PROTOCOL_NAME = "MQTT";

/**
 * The prefix of the client id, before the random suffix.
 *
 * FIXED, NOT A SETTING. A comment here once called it configurable and the manual repeated that, which would
 * send a reader whose broker enforces `clientid_prefixes` hunting for a connection field that does not exist.
 * Changing it means changing this line. A broker that refuses `libredb-` answers CONNACK 0x85, which
 * `connackSentence()` names.
 */
export const MQTT_CLIENT_ID_PREFIX = "libredb-";
/**
 * Bytes of randomness in the client id's suffix, rendered as hex. The suffix is mandatory and random rather
 * than a process id: MQTT ends the older session on a duplicate id (Session Taken Over, 0x8E), so a colliding
 * id disconnects whoever connected first, and process ids are small and repeat across container restarts.
 */
export const MQTT_CLIENT_ID_RANDOM_BYTES = 8;

/**
 * The largest packet this provider will take off the wire, applied by our own decoder before any allocation.
 *
 * IT IS NOT DECLARED TO THE BROKER. Declaring a Maximum Packet Size in CONNECT makes the loss invisible:
 * "Where a Packet is too large to send, the Server MUST discard it without sending it and then behave as if
 * it had completed sending that Application Message" [MQTT-3.1.2-25]. Enforcing it here instead means we see
 * the header, skip the body by byte count, and can say how many bytes were skipped.
 */
export const MQTT_MAX_INBOUND_BYTES = 8 * 1024 * 1024;

/**
 * The largest Remaining Length a Variable Byte Integer can express (section 1.5.5, Table 1-1). A declared
 * length above this is malformed; a server-sent Maximum Packet Size above it names a packet that cannot exist,
 * which is why a value of 268,435,456 is clamped rather than trusted.
 */
export const MQTT_MAX_REMAINING_LENGTH = 268_435_455;

/**
 * The largest MQTT UTF-8 string, in bytes: a two-byte length prefix and nothing longer (section 1.5.4).
 *
 * Every field a reader types into the connection dialog becomes one of these, and none of them was bounded
 * until an audit ran the provider under Node and watched the process exit: `encodeString` refused the long
 * one by throwing, inside a socket listener, where a throw is an uncaught exception. The fields are bounded
 * where they are read now, so the refusal is a config error with a sentence rather than a dead server.
 */
export const MQTT_MAX_STRING_BYTES = 65_535;

/** What separates one level of a topic from the next, and the separator the Keys panel's tree is built on. */
export const MQTT_TOPIC_SEPARATOR = "/";
/**
 * The filter that matches every topic except the ones under a `$` root ([MQTT-4.7.2-1]), which is why the
 * broker's own `$SYS` tree is never reached by it and has to be asked for by name.
 */
export const MQTT_WILDCARD_FILTER = "#";
/**
 * Filter prefixes refused before SUBSCRIBE is sent, case sensitively.
 *
 * `$share/` and `$queue/` take messages away from the devices that need them: a shared subscription hands each
 * message to exactly one member of the group, so a read-only tool silently eats commands meant for a device.
 * `$exclusive/` locks another client out of a topic. None of the three is detectable afterwards: every broker
 * we measured answers SUBACK Granted and then simply delivers less.
 *
 * The comparison is case sensitive because `$SHARE/...` in uppercase is an ordinary topic, not a shared
 * subscription, and refusing it would refuse real data.
 */
export const MQTT_REFUSED_FILTER_PREFIXES: readonly string[] = Object.freeze(["$share/", "$queue/", "$exclusive/"]);

/** Seconds between PINGREQs, and the Keep Alive declared in CONNECT. */
export const MQTT_KEEP_ALIVE_SECONDS = 60;
/**
 * Milliseconds between PINGREQs: half the declared Keep Alive, so one lost ping does not end the session.
 * A broker drops a client that has been silent for one and a half Keep Alive periods (section 3.1.2.10).
 */
export const MQTT_PING_INTERVAL_MS = (MQTT_KEEP_ALIVE_SECONDS * 1000) / 2;

/** Topics one page of the Keys panel holds when the caller names no count. */
export const MQTT_KEY_SCAN_DEFAULT_COUNT = 1_000;
/** Topics one page may hold. A caller asking for more is refused rather than silently given fewer. */
export const MQTT_KEY_SCAN_MAX_COUNT = 10_000;

/**
 * The budgets a read ends on. A read never ends on an inferred signal: silence is not a signal, and neither is
 * the first message that arrives without the retain flag. Measured across twelve cases, the quiet gap before a
 * lossless read (214 ms to 4,013 ms) and before a lossy one (5,954 ms to 19,894 ms) do not separate, and the
 * ordering is inverted.
 */
export const MQTT_READ_BUDGET_MS = 3_000;
/** Messages one read takes before it ends on its own budget. */
export const MQTT_READ_BUDGET_MESSAGES = 50_000;
/** Bytes one read takes before it ends on its own budget. */
export const MQTT_READ_BUDGET_BYTES = 32 * 1024 * 1024;

/** Seconds a CONNECT waits for its CONNACK before the connection is abandoned. */
export const MQTT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * The consent box's label as the dialog draws it, named in the refusal so the reader can find it.
 *
 * The box is the reader's informed consent to send a credential in the clear, which is a decision only they
 * can make. Oxia's refusal names its own box the same way, for the same reason.
 */
export const MQTT_CONSENT_CLAUSE =
  ' Or tick "Send the password without TLS", which this connection then does on every read.';

/**
 * What a dial that timed out with nothing coming back means, after the address and the clock.
 *
 * Here rather than inline because a plain string literal folded into a concatenation is reported as an
 * unexecuted line by the coverage tool, and the 100% gate then fails on prose. A module-level constant is
 * evaluated on import, which is also the truer description of it: fixed text, not a computed message.
 */
export const MQTT_NOTHING_CAME_BACK =
  "Nothing came back at all, not even a refusal, which is what a firewall that drops the connection and a wrong address both look like.";
