/**
 * Every named constant of the RabbitMQ provider, the injected clock and the deadline-signal factory, in one module
 * that imports nothing at run time: `generators.ts`, which the browser loads, reads the click's row count here, and
 * the seam-guard test holds this module to type-only imports from outside the provider directory.
 *
 * A value above a cap is refused or stopped at with a sentence naming the cap, never silently clamped, except the
 * negotiated values of the AMQP handshake (frame size, heartbeat), which the protocol itself takes as a minimum of two.
 * docs/providers/rabbitmq.md prints this table with the reason for each value.
 */
import type { BoundedLimiterOptions } from "@/lib/db/utils/bounded-limiter";
import type { DatabaseType } from "@/lib/types";

/** The provider's type id, the one every error of this provider is tagged with. */
export const RABBITMQ_TYPE: DatabaseType = "rabbitmq";

// --- Version and ports -------------------------------------------------------------------------------------------

/** The oldest RabbitMQ release the provider reads, compared by its three numbers. */
export const RABBITMQ_MIN_VERSION = "4.2.0";
/** The management API's plain port; 15671 with TLS. */
export const RABBITMQ_DEFAULT_MANAGEMENT_PORT = 15672;

// --- Stream reads --------------------------------------------------------------------------------------------------

/** The longest one stream read may take, from its first act to its last row: the query timeout shortens it. */
export const RABBITMQ_READ_DEADLINE_MS = 30_000;
/** Rows a read returns when its request names no limit, and the click's limit. */
export const RABBITMQ_READ_DEFAULT_ROWS = 50;
/** The most rows one read request may ask for. */
export const RABBITMQ_READ_MAX_ROWS = 500;
/** Unacknowledged deliveries the broker may send ahead: `min(limit, this)`. */
export const RABBITMQ_PREFETCH_MAX = 10;
/** A read stops when no byte but a heartbeat's arrived for this long after the consume started. */
export const RABBITMQ_IDLE_MS = 1_000;
/** Retained header bytes plus kept body bytes one result may hold. */
export const RABBITMQ_RESULT_BUDGET_BYTES = 8_388_608;
/** Characters one result cell may hold. */
export const RABBITMQ_CELL_CHARS = 65_536;
/** Body bytes kept per message; the rest is stepped over without a copy. */
export const RABBITMQ_BODY_PREFIX_BYTES = 262_144;
/** The largest declared body size accepted, RabbitMQ's own message ceiling. */
export const RABBITMQ_BODY_CEILING_BYTES = 536_870_912;
/** Inbound bytes one read may transfer after the consume started, skipped bytes included. */
export const RABBITMQ_READ_WIRE_BYTES = 67_108_864;
/** The largest content-header frame accepted; it is streamed, never held whole. */
export const RABBITMQ_HEADER_FRAME_MAX_BYTES = 536_870_912;
/** A header value longer than this is shown as its byte count. */
export const RABBITMQ_HEADER_VALUE_RETAINED_BYTES = 262_144;
/** Header bytes kept per message; values past this are shown as their byte counts. */
export const RABBITMQ_HEADER_TABLE_RETAINED_BYTES = 1_048_576;
/** How deep a header table or array is walked; a deeper subtree is shown as its byte count. */
export const RABBITMQ_HEADER_DEPTH = 8;
/** The largest frame size Studio accepts in the handshake: a proposal of 0 means this. */
export const RABBITMQ_FRAME_MAX_CEILING = 131_072;
/** RabbitMQ's smallest frame size; a smaller proposal is refused. */
export const RABBITMQ_FRAME_MIN_BYTES = 8_192;
/** The longest heartbeat interval Studio agrees to, never above the broker's proposal. */
export const RABBITMQ_HEARTBEAT_CEILING_S = 60;
/** How long a normal end waits for the broker's close-ok. */
export const RABBITMQ_CLOSE_OK_WAIT_MS = 1_000;
/** How far back the "last" hint steps from the first offset shown. */
export const RABBITMQ_LAST_HINT_BACKSTEP = 50;
/** How many descriptors the AMQP 1.0 section skipper follows; a deeper chain means base64. */
export const RABBITMQ_AMQP1_DESCRIPTOR_DEPTH = 4;
/** How deep a payload may nest to be shown as JSON; a deeper one is shown as base64. */
export const RABBITMQ_PAYLOAD_JSON_DEPTH = 64;

// --- Management API --------------------------------------------------------------------------------------------------

/** Rows per listing page, the broker's own `page_size` maximum. */
export const RABBITMQ_LISTING_PAGE_SIZE = 500;
/** How deep a management answer may nest. */
export const RABBITMQ_MGMT_DEPTH = 64;
/** The longest one management GET may take outside a read, applied as `min(queryTimeout, this)`. */
export const RABBITMQ_MGMT_REQUEST_DEADLINE_MS = 15_000;
/** Bindings rows kept per bindings part; the rest are counted. */
export const RABBITMQ_BINDINGS_MAX_ROWS = 1_000;
/** Bytes of bindings rows kept per bindings part. */
export const RABBITMQ_BINDINGS_KEPT_BYTES = 1_048_576;
/** The byte cap of the small answers: whoami, overview, the type check, alarms, extensions, tracking. */
export const RABBITMQ_SMALL_ANSWER_BYTES = 65_536;
/** The byte cap of listings, details and policies. */
export const RABBITMQ_ANSWER_BYTES = 1_048_576;
/** The byte cap of the three bindings routes. */
export const RABBITMQ_BINDINGS_ANSWER_BYTES = 16_777_216;
/** The longest vhost, queue, stream or exchange name, in UTF-8 bytes. */
export const RABBITMQ_NAME_MAX_BYTES = 255;
/** Characters of a name shown in a sentence before it is cut with "...". */
export const RABBITMQ_NAME_PROSE_CHARS = 64;

// --- Test Connection -----------------------------------------------------------------------------------------------

/**
 * Virtual hosts whose queue page Test Connection reads for readable queues: six pages at the slowest page measured
 * on a 30,000-queue virtual host (797 ms) fit in half the check deadline.
 */
export const RABBITMQ_TEST_CHECK_MAX_VHOSTS = 6;
/** Classic or quorum queues Test Connection checks for read access. */
export const RABBITMQ_TEST_CHECK_MAX_QUEUES = 50;
/** The longest the readable-queue check of Test Connection may take. */
export const RABBITMQ_TEST_CHECK_DEADLINE_MS = 10_000;
/** Queue names one readable-queue caution names before "and N more". */
export const RABBITMQ_CAUTION_NAMED_QUEUES = 5;
/** Virtual hosts that get their own readable-queue caution before the summary sentence. */
export const RABBITMQ_CAUTION_MAX_VHOSTS = 3;

// --- Limiters ------------------------------------------------------------------------------------------------------

export const RABBITMQ_READ_LIMITER_KEY = "rabbitmq-read";
export const RABBITMQ_MANAGEMENT_LIMITER_KEY = "rabbitmq-management";
export const RABBITMQ_BINDINGS_LIMITER_KEY = "rabbitmq-bindings";

/** One stream read per provider instance, four per process, sixteen waiting. */
export const RABBITMQ_READ_LIMITS: BoundedLimiterOptions = Object.freeze({
  perProvider: 1,
  perEngine: 4,
  queueDepth: 16,
});
/** Four management GETs per provider instance, sixteen per process, sixty-four waiting. */
export const RABBITMQ_MANAGEMENT_LIMITS: BoundedLimiterOptions = Object.freeze({
  perProvider: 4,
  perEngine: 16,
  queueDepth: 64,
});
/** One bindings GET per provider instance and two per process, so at most two 16 MiB bodies are in transfer. */
export const RABBITMQ_BINDINGS_LIMITS: BoundedLimiterOptions = Object.freeze({
  perProvider: 1,
  perEngine: 2,
  queueDepth: 16,
});

// --- Seams ---------------------------------------------------------------------------------------------------------

/** The injected clock: every timer of the read path and the heartbeats goes through it. */
export interface RabbitMQClock {
  now(): number;
  /** Starts a one-shot timer; the answer cancels it and is safe to call twice. */
  setTimer(callback: () => void, ms: number): () => void;
}

/** The process clock. */
export const SYSTEM_CLOCK: RabbitMQClock = Object.freeze({
  now: () => Date.now(),
  setTimer: (callback: () => void, ms: number): (() => void) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
});

/** A signal that aborts after `ms` with a reason that is not a QueryCancelledError. */
export type DeadlineSignalFactory = (ms: number) => AbortSignal;

/**
 * `AbortSignal.timeout`, whose reason is a `TimeoutError` DOMException: the shared node transport reads that reason
 * as a deadline (kind "timeout") rather than a cancel (kind "aborted").
 */
export const systemDeadlineSignal: DeadlineSignalFactory = (ms) => AbortSignal.timeout(ms);
