/**
 * Every number this provider decides, in one place, each one with the measurement that set it and
 * the date that measurement was taken.
 *
 * A constant whose reason lives in a design document outlives the document. The reason belongs
 * beside the number, so that someone widening a cap a year from now reads what it was protecting
 * before they move it.
 *
 * WHERE THE MEASUREMENTS CAME FROM. All taken on 2026-10-13 by this session, under Bun 1.4.2 and
 * Node 24.14.0 on one machine, against:
 *
 * - Eclipse Mosquitto 2.1.2 with its bundled Sparkplug Aware plugin, image pinned by digest
 *   `sha256:38c0da4f2ef84284d47b3b3eeea1cb3bdeabe81ee10caf0cd5c5ff61ee3ea408`, loopback only.
 * - HiveMQ CE 2026.5 with the HiveMQ Sparkplug Aware Extension 4.33.12, image digest
 *   `sha256:bac6d4d1d815bffe4bc9a7fca8d06ea12b32d34f84ef2f1851ff4548560ee67b`.
 * - Eclipse Mosquitto 1.5.11, digest `sha256:a969883d583a7cc3dbb0886d9a2d7ad4f776d792b01df9f0bef86a68dca9d08d`,
 *   which speaks MQTT 3.1.1 only, because MQTT 5.0 arrived in Mosquitto 1.6.
 * - Eclipse Tahu `sparkplug-payload` 1.0.3 as the reference encoder, and protobufjs 7.6.6 over
 *   Tahu's `sparkplug_b.proto`, SHA-256
 *   `4432c5c483b7fb9732d0594c98a2e97dca5e517e39c5374a8b918d837f0b4a19`.
 *
 * Repository facts were read from `origin/main` at `90881379` with `git show`, not from a working
 * tree: the shared working copy was at an older commit and a colour measurement taken from it came
 * out wrong once already.
 *
 * TWO OF THESE NUMBERS ARE DEFAULTS AND NOT ANSWERS, and they say so where they sit. The deepest
 * real template nesting and the largest real metric count per payload are still unmeasured, because
 * both need a producer this session does not have.
 */

/** The broker port, which is MQTT's own default and not a Sparkplug one. */
export const SPARKPLUG_DEFAULT_PORT = 1883;

/**
 * The protocol name and level this provider declares, which are MQTT 5.0's.
 *
 * SHIPPED: the same two values the shipped MQTT transport declares, read from `origin/main`. The
 * level is 5 and not 4, and that is a limit rather than a preference: specification 1.5 and 10.1.3
 * allow a Sparkplug system on MQTT 3.1.1, and a broker that speaks only 3.1.1 refuses this
 * handshake. MEASURED on 13 October 2026 against Eclipse Mosquitto 1.5.11, which predates
 * Mosquitto's MQTT 5.0 support: the broker answered the older four-byte acknowledgement with
 * return code 1, unacceptable protocol version, and closed the socket.
 */
export const MQTT_PROTOCOL_NAME = "MQTT";
export const MQTT_PROTOCOL_LEVEL = 5;

/**
 * The keep alive this provider asks for, in seconds, and the interval it pings at.
 *
 * SHIPPED: both equal to the shipped MQTT transport's, read from `origin/main`. The ping interval
 * is half the keep alive so that one lost ping does not end the session.
 */
export const KEEP_ALIVE_SECONDS = 60;
export const PING_INTERVAL_MS = (KEEP_ALIVE_SECONDS * 1000) / 2;

/**
 * The client identifier prefix, and how many random bytes follow it.
 *
 * SHIPPED: the same prefix the MQTT transport uses. It matters for a Sparkplug read specifically:
 * a client identifier that collided with an edge node's would TAKE OVER that node's session, and
 * taking a session from a running edge node is the loudest thing a read-only reader could do.
 */
export const CLIENT_ID_PREFIX = "libredb-";
export const CLIENT_ID_RANDOM_BYTES = 8;

/** The only namespace this provider reads (specification 4.1.1). */
export const SPARKPLUG_NAMESPACE = "spBv1.0";

/** The root an aware server stores birth certificates under (10.1.3, 10.1.4). */
export const STORED_BIRTH_ROOT = "$sparkplug/certificates";

/**
 * How deep the payload walk may go, counted in PROTOBUF MESSAGES rather than Sparkplug levels.
 *
 * One Sparkplug template level costs two protobuf messages, a `Metric` holding a `Template`, so
 * this number halves into levels: 32 messages is 16 levels.
 *
 * MEASURED, and this is the ceiling the value may not cross: protobufjs 7.6.6 accepts 49 Sparkplug
 * template levels and refuses the 50th, identically under Bun and Node. Its own documented limit is
 * 100, but that limit counts messages, which is why the two numbers look like they disagree. A cap
 * above 49 levels would let this reader accept payloads the reference reader cannot, and the
 * differential test would have nothing to compare against.
 *
 * STILL A DEFAULT. The deepest nesting a real producer emits (an Ignition user-defined type inside
 * another) is unmeasured, because that product is not available to this session. 16 levels is the
 * prototype's figure, not an answer.
 */
export const MAX_MESSAGE_DEPTH = 32;

/** The same number in Sparkplug levels, so no caller has to halve it by hand. */
export const MAX_TEMPLATE_LEVELS = MAX_MESSAGE_DEPTH / 2;

/** The measured ceiling `MAX_TEMPLATE_LEVELS` has to stay under. A test holds the relationship. */
export const MEASURED_PROTOBUFJS_LEVEL_CEILING = 49;

/**
 * How many messages one payload walk may visit, which bounds breadth where the depth cap bounds
 * height.
 */
export const MAX_MESSAGES_PER_PAYLOAD = 100_000;

/**
 * How many metrics one payload may carry.
 *
 * MEASURED, and the measurement changed what this number is FOR. A realistic device with 4,322
 * metrics in four levels of folders encodes to 179,564 bytes, which is 2.1 percent of the
 * transport's 8 MiB inbound limit; 41.8 bytes per metric means that limit would hold roughly
 * 200,000 metrics. So the transport's byte limit is not the bound that bites: this cap is, and it
 * bites at about 2.12 MiB, a quarter of the way to the byte limit. A payload of 50,010 metrics was
 * refused here with `metric-cap` at that size.
 *
 * STILL A DEFAULT, for the same reason as the depth cap: the largest real metric count per payload
 * is unmeasured.
 */
export const MAX_METRICS_PER_PAYLOAD = 50_000;

/**
 * The largest `bytes` or `string` field the reader will materialise.
 *
 * It matches the shipped MQTT transport's inbound packet limit, so a field cannot be larger than
 * the packet that carried it. MEASURED on the reason this is checked BEFORE allocation: a 16-byte
 * payload declaring a 2,147,483,647-byte field is answered by protobufjs with `index out of range`,
 * and by this reader with the bound's own name, without allocating anything.
 */
export const MAX_FIELD_BYTES = 8 * 1024 * 1024;

/**
 * The console's default read window, in seconds, which is the shipped MQTT transport's own read
 * budget (`MQTT_READ_BUDGET_MS`, measured at 3,000 ms on `origin/main`).
 *
 * It is deliberately the transport's number and not a rounder one: a window longer than the
 * transport's budget would end on the budget and report a window it never had.
 */
export const DEFAULT_WINDOW_SECONDS = 3;

/**
 * The widest window a console read may ask for.
 *
 * Not measured, and the reason it is bounded at all is: a birth certificate is published at QoS 0
 * and not retained, so on a broker that does not store certificates a reader sees one only while
 * an edge node connects or answers somebody else's rebirth. A user who learns that will reach for
 * a longer window, and an unbounded one would hold a subscription open with no end in sight. How
 * often a window of 3, 10 or 60 seconds actually catches a certificate is still unmeasured.
 */
export const MAX_WINDOW_SECONDS = 300;

/** The most rows one console read returns, so a grid cannot be handed an unbounded result. */
export const MAX_ROWS = 10_000;

/**
 * The most messages ONE READ takes before it stops, which is the shipped MQTT transport's own
 * message budget (MEASURED on `origin/main`).
 *
 * It is a read-level bound and not the per-payload one above: `MAX_MESSAGES_PER_PAYLOAD` bounds the
 * nested messages inside a single protobuf payload, and this bounds how many MQTT publishes a read
 * accepts in all. Measured (ENV-A, load 9.36, three runs): with 200 edge nodes publishing through
 * eight publishers, all three runs ended on THIS budget in 648 to 749 ms, having used a quarter of
 * the time budget and 6 percent of the byte budget. So on a busy broker this is the bound a user
 * actually meets, which is why the panel names which budget ended the read.
 */
export const MAX_MESSAGES_PER_READ = 50_000;

/**
 * The most payload bytes ONE READ keeps, which is the shipped MQTT transport's own byte budget
 * (MEASURED on `origin/main`).
 *
 * The same measurement says this one rarely bites: the three runs above collected 1.84 MiB against
 * it. It is here for the read that meets a few very large payloads rather than many small ones.
 */
export const MAX_BYTES_PER_READ = 32 * 1024 * 1024;

/**
 * The hex dump bound for a `Bytes` or `File` metric shown in a cell.
 *
 * Bytes and File are shown as hex with their MetaData and never written to disk or opened, so the
 * only question is how much of one cell is readable, and 256 bytes is 768 characters of hex.
 */
export const MAX_HEX_BYTES_IN_CELL = 256;

/**
 * The `seq` wrap, from the specification rather than from a measurement: 5.4 and 6.4.5 put `seq`
 * in 0 to 255, so 256 is the modulus a gap check uses. 4.2.1 says a birth's own `seq` "MUST have a
 * value of 0" while those two allow the whole range, which is why a birth's seq is accepted
 * anywhere in it and the gap check applies only between successive data messages.
 */
export const SEQ_MODULUS = 256;

/**
 * The longest group, edge node or device id an agent read may name, in UTF-8 bytes.
 *
 * CHOSEN, no measurement behind it: the specification sets no length for an id (4.1.2), and real ids are short names.
 * Three ids at this length, the namespace and the longest message type still make a topic far inside MQTT's 65,535-byte
 * string, so a request the agent's reader admits is always one the encoder can write.
 */
export const SPARKPLUG_AGENT_MAX_ID_BYTES = 1_024;

/**
 * The least time budget an agent read is admitted with: the window plus a second for its answer to settle. Every agent
 * read listens for `DEFAULT_WINDOW_SECONDS`, and the window's clock starts before the dial, so the read ends on it
 * whatever the broker does; a budget shorter than this is refused rather than cut into a shorter window.
 */
export const SPARKPLUG_AGENT_MIN_STATEMENT_MS = DEFAULT_WINDOW_SECONDS * 1000 + 1_000;
