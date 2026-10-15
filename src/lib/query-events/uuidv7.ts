/**
 * Query event ids (docs/GOVERNANCE.md#row-semantics): UUIDv7 as RFC 9562 section 5.7 lays it out, a 48-bit Unix
 * millisecond timestamp, the version 7, a 12-bit counter in `rand_a`, the variant bits 10 and 62 random bits in
 * `rand_b`.
 *
 * Studio generates each `event_id` before the first insert attempt and keeps it across retries, so
 * `ON CONFLICT DO NOTHING` makes a retried batch idempotent, and an id created later sorts later, so the primary
 * key's index grows at its end.
 *
 * Within one millisecond the counter orders the ids (RFC 9562 section 6.2, method 1). It starts each millisecond at a
 * random value below 2048, so at least 2048 ids fit before it would roll over, and the id after 4095 moves the
 * timestamp one millisecond on instead. A wall clock that steps back keeps the last timestamp and counts on, so ids
 * keep their creation order across an NTP step. Uniqueness never rests on the counter: the 62 random bits are fresh
 * for every id.
 */
import { randomBytes, randomInt } from "node:crypto";

/** The largest value the 12-bit counter holds. */
const COUNTER_MAX = 0xfff;
/** A millisecond's first counter is below this, so half of the counter's range is always left to count in. */
const COUNTER_START_LIMIT = 0x800;
/** The version 7 in the top four bits of the 16 bits that carry the counter. */
const VERSION_BITS = 0x7000;

/** The timestamp of the last id handed out, in Unix milliseconds. */
let lastMs = -1;
/** The counter of the last id handed out. */
let counter = 0;

export function uuidv7(): string {
  const now = Date.now();
  if (now > lastMs) {
    lastMs = now;
    counter = randomInt(COUNTER_START_LIMIT);
  } else if (counter < COUNTER_MAX) {
    counter += 1;
  } else {
    lastMs += 1;
    counter = randomInt(COUNTER_START_LIMIT);
  }
  const random = randomBytes(8);
  // The variant bits 10 above the 62 random bits of rand_b.
  random[0] = 0x80 | (random[0] & 0x3f);
  const hex = `${lastMs.toString(16).padStart(12, "0")}${(VERSION_BITS | counter).toString(16)}${random.toString("hex")}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
