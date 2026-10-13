/**
 * Constants of the Modbus TCP wire, and the two timers without which a read never ends.
 *
 * WHY THE TIMERS ARE HERE AND NOT IN THE UI. Measured on 13 October 2026 under Node 24 and Bun 1,
 * against a device made to vanish without sending FIN or RST (`iptables -A INPUT -p tcp --dport 502
 * -j DROP`, interface left in place): with `setTimeout(3000)` the read ended at 3005 ms under Node
 * and 3029 ms under Bun; with no timer at all nothing happened for 143995 ms and the socket still
 * read as ESTABLISHED. The request timer is therefore not a quality of implementation detail, it is
 * the only thing that ends a stalled read, so it is a constant of the provider rather than an
 * option a caller may omit.
 */

/** IANA `mbap`. */
export const MODBUS_DEFAULT_PORT = 502;
/**
 * IANA `mbap-s`. MODBUS/TCP Security, section 5 of MB-TCP-Security-v36.
 *
 * NOTHING READS THIS YET, AND IT IS KEPT ANYWAY. `client.ts` already dials TLS, but the provider
 * does not reach the socket yet, so no code is in a position to choose between 502 and 802. The
 * name was deleted once to turn `knip` green, and that is the wrong repair: it turns a missing
 * connection into a quiet absence, and the gap stops being visible to anyone reading this file.
 * The gate carries it as ONE expected unread export with an end condition - when `index.ts`
 * imports `./client`, this constant must have a reader and the allowance comes out.
 */
export const MBAPS_DEFAULT_PORT = 802;

/** MBAP header: transaction id, protocol id, length, unit id. TCP 3.1.3. */
export const MBAP_HEADER_BYTES = 7;
/**
 * A PDU is at most 253 bytes and a TCP ADU 260 (MB 4.1), so a valid MBAP Length field is 3 to 254:
 * one unit id plus one to 253 PDU bytes.
 */
export const MBAP_LENGTH_MIN = 3;
export const MBAP_LENGTH_MAX = 254;

/**
 * The most bytes ONE identification object can carry, derived rather than written down.
 *
 * The MBAP length counts the unit id and the PDU, so the PDU is at most `MBAP_LENGTH_MAX - 1`.
 * A 43/14 answer spends 1 byte on the function code and 6 on its own header (MEI type, read
 * code, conformity level, More Follows, Next Object Id, object count), and each object spends 2
 * more on its id and its length. What is left is this.
 *
 * Written as a literal it would be a number that stays still while the frame bound moves, and the
 * two would disagree without either one looking wrong.
 */
export const MAX_IDENTIFICATION_OBJECT_BYTES = MBAP_LENGTH_MAX - 1 - 1 - 6 - 2;
export const PROTOCOL_ID = 0;

/** The four read function codes MB-S1 allows, and nothing else. */
export const FC_READ_COILS = 0x01;
export const FC_READ_DISCRETE_INPUTS = 0x02;
export const FC_READ_HOLDING_REGISTERS = 0x03;
export const FC_READ_INPUT_REGISTERS = 0x04;
/** The fifth allowed request: Encapsulated Interface Transport with MEI type 14. MB 6.19, 6.21. */
export const FC_ENCAPSULATED_INTERFACE = 0x2b;
export const MEI_READ_DEVICE_IDENTIFICATION = 0x0e;

/** Quantity limits of MB 6.1 to 6.4. Bits and registers do not share one. */
export const MAX_BITS_PER_READ = 2000;
export const MAX_REGISTERS_PER_READ = 125;
/** The data model gives each table 65536 items (MB 4.3), so address plus quantity may not pass it. */
export const TABLE_SIZE = 65536;

/** Timers, in milliseconds. Above the 2137 ms an absent unit cost through mbusd at its defaults. */
export const DIAL_TIMEOUT_MS = 3000;
export const REQUEST_TIMEOUT_MS = 3000;

/** NumberMaxOfClientTransaction, which TCP 4.4.1.2 requires a client to publish. Ours is one. */
export const MAX_TRANSACTIONS_IN_FLIGHT = 1;

/** Unit ids. 0 is a broadcast that carries writes only and is never answered (SL 2.1). */
export const UNIT_ID_MIN = 1;
export const UNIT_ID_MAX = 255;
/** 248 to 255 are reserved on a serial line (SL 2.2), accepted here with a warning. */
export const UNIT_ID_SERIAL_RESERVED_FROM = 248;

/**
 * The sentences the product has to say out loud, kept here because `index.ts` imports this file and
 * a sentence nothing imports is a sentence that drifts.
 *
 * They were first written in a `provider-surface.ts` that declared the capabilities a second time.
 * Nothing read that file: the provider declares its own capabilities inline, so the duplicate was a
 * stand-in whose tests protected nothing, and the two had already diverged on `queryDialect`. The
 * file is gone and these two sentences are what was worth keeping.
 */
export const MODBUS_READ_ONLY_HINT =
  "Studio cannot write to a Modbus device: it builds four read requests and the identification request, and nothing else. The device enforces nothing of its own, so anything else that reaches its port can write to it. Protection is MODBUS/TCP Security or a network path you control.";

export const MODBUS_NO_REVOCATION_SENTENCE =
  "Over MODBUS/TCP Security, Studio checks the device's certificate chain and host name but does not check revocation. Measured on 13 October 2026: a stapled OCSP response saying revoked still completes the connection under Node, and under Bun it never reaches the application.";
