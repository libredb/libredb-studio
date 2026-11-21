import { describe, expect, test } from "bun:test";
import { showsReadOnlyMarker } from "@/components/read-only-marker";
import { SHIPPED_DATABASE_TYPES, WRITE_REACH } from "@/lib/db/compatibility";
import type { DatabaseType } from "@/lib/types";
import { OUTSIDE_THE_UNION, refusalOf, refusalThrownBy } from "../helpers/outside-the-union";

/**
 * Whether a connection carries the "Read-only" marker (#1089): its own `readOnly`, or its engine's `WRITE_REACH`
 * where that is `none`. The engine's row is read through the type-id check (FND-1), so a type outside the union is
 * refused by name instead of reading `undefined` or an `Object.prototype` member as "has a write path".
 */
describe("showsReadOnlyMarker", () => {
  test("a connection without readOnly carries it exactly where its engine has no write path", () => {
    const none = SHIPPED_DATABASE_TYPES.filter((type) => WRITE_REACH[type] === "none");
    // Vacuity, by name: both answers occur.
    expect(none.length).toBeGreaterThan(0);
    expect(none).not.toContain("postgres");
    for (const type of SHIPPED_DATABASE_TYPES) {
      expect({ type, shown: showsReadOnlyMarker({ type, readOnly: undefined }) }).toEqual({
        type,
        shown: none.includes(type),
      });
      expect({ type, shown: showsReadOnlyMarker({ type, readOnly: false }) }).toEqual({
        type,
        shown: none.includes(type),
      });
    }
  });

  test("a connection with readOnly: true carries it on every engine", () => {
    for (const type of SHIPPED_DATABASE_TYPES) {
      expect({ type, shown: showsReadOnlyMarker({ type, readOnly: true }) }).toEqual({ type, shown: true });
    }
  });

  test.each(OUTSIDE_THE_UNION)("refuses %s by name where it reads the engine's row", (_label, value) => {
    const type = value as DatabaseType;
    expect(refusalThrownBy(() => showsReadOnlyMarker({ type, readOnly: undefined }))).toEqual(refusalOf(value));
    expect(refusalThrownBy(() => showsReadOnlyMarker({ type, readOnly: false }))).toEqual(refusalOf(value));
  });

  test.each(OUTSIDE_THE_UNION)(
    "answers a readOnly: true record of %s from the record, reading no row",
    (_label, value) => {
      expect(showsReadOnlyMarker({ type: value as DatabaseType, readOnly: true })).toBe(true);
    },
  );
});
