/**
 * Query event ids (docs/GOVERNANCE.md#row-semantics): Studio generates each `event_id` before the first insert attempt,
 * as a UUIDv7 (RFC 9562 section 5.7), so a retried batch keeps its ids and `ON CONFLICT DO NOTHING` makes the retry
 * idempotent, and an id created later sorts later, so the primary key's index grows at its end.
 *
 * The generator keeps its state per process, so each case freezes the clock later than every case before it.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { uuidv7 } from "@/lib/query-events/uuidv7";

/** Version 7 in the 13th hex digit, and the variant bits 10 in the top of the 17th. */
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The unix milliseconds an id carries in its first 48 bits. */
const millisecondsOf = (id: string): number => Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);

/** A wall clock an hour past the real one, later than any id the generator handed out before this file ran. */
const FROZEN_AT = Date.now() + 3_600_000;

let clock: ReturnType<typeof spyOn> | undefined;

/** Freezes `Date.now()` at what `read()` answers on each call. */
function freezeClock(read: () => number): void {
  clock = spyOn(Date, "now").mockImplementation(read);
}

afterEach(() => {
  clock?.mockRestore();
  clock = undefined;
});

describe("uuidv7", () => {
  test("ids are version 7 with variant bits 10 and sort by creation time", () => {
    const ids = Array.from({ length: 10_000 }, () => uuidv7());

    for (const id of ids) expect(id).toMatch(UUIDV7);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.toSorted()).toEqual(ids);
  });

  test("an id carries the millisecond it was created in", () => {
    freezeClock(() => FROZEN_AT);

    expect(millisecondsOf(uuidv7())).toBe(FROZEN_AT);
  });

  test("more ids in one millisecond than its counter holds still sort, because the timestamp moves on", () => {
    const frozenAt = FROZEN_AT + 3_600_000;
    freezeClock(() => frozenAt);

    const ids = Array.from({ length: 20_000 }, () => uuidv7());

    expect(millisecondsOf(ids[0])).toBe(frozenAt);
    expect(millisecondsOf(ids.at(-1) as string)).toBeGreaterThan(frozenAt);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.toSorted()).toEqual(ids);
  });

  test("a wall clock that steps back keeps ids in creation order", () => {
    let now = FROZEN_AT + 7_200_000;
    freezeClock(() => now);

    const before = uuidv7();
    now -= 60_000;
    const after = [uuidv7(), uuidv7()];

    expect([before, ...after].toSorted()).toEqual([before, ...after]);
    expect(millisecondsOf(after[0])).toBe(millisecondsOf(before));
  });

  test("ids from one millisecond differ in their random bits too", () => {
    const frozenAt = FROZEN_AT + 10_800_000;
    freezeClock(() => frozenAt);

    const [first, second] = [uuidv7(), uuidv7()];

    // Past the counter, the last 62 bits are fresh random bits for every id.
    expect(first.slice(19)).not.toBe(second.slice(19));
  });
});
