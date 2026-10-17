/**
 * The reference implementation's own bytes, read by this provider.
 *
 * `docs/providers/sparkplug.md` names Eclipse Tahu `sparkplug-payload` 1.0.3 as the reference
 * encoder, and `values.ts` carries three facts measured against it on 2026-10-13. This file
 * freezes the evidence: `tests/fixtures/sparkplug/tahu-datatypes.json` is ONE PAYLOAD THAT TAHU
 * ENCODED, recorded as hex, and the test reads it through the production path - the real
 * decoder, the real fold, the real row builder.
 *
 * WHY THE BYTES ARE RECORDED RATHER THAN GENERATED. Generating them would make Tahu a
 * dependency of this suite, and the point is the opposite: nothing here imports Tahu, so the
 * test cannot drift with it. Re-recording is a deliberate act, and the file says which package,
 * which integrity hash and which runtime produced it.
 *
 * WHAT WOULD MAKE THIS FAIL, and it is worth saying because the three facts are the kind that
 * produce a WRONG NUMBER rather than an error: Tahu writes the narrow signed types as 32-bit
 * two's complement (Int8 -1 arrives as `int_value` 4294967295), and it puts UInt32 in
 * `long_value` rather than `int_value`. A decoder that read the value off the field that
 * happens to be set, or that read `int_value` as the number, would answer 4294967295 for -1 and
 * would be believed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { foldMessages } from "@/lib/db/providers/industrial/sparkplug/fold";
import { buildRows } from "@/lib/db/providers/industrial/sparkplug/results";

const FIXTURE = JSON.parse(
  readFileSync(path.join(import.meta.dir, "../../../fixtures/sparkplug/tahu-datatypes.json"), "utf8"),
) as {
  readonly producedBy: string;
  readonly integrity: string;
  readonly topic: string;
  readonly payloadHex: string;
  readonly expected: Readonly<Record<string, string>>;
};

const query = { seconds: 3, limit: 1000, includeBirths: true };

describe("a payload Eclipse Tahu encoded", () => {
  test("the fixture says which encoder produced it, and it is not empty", () => {
    // A recording with no bytes would make the table below pass on nothing, which is the one
    // failure a frozen-evidence test cannot see from the inside.
    expect(FIXTURE.producedBy).toContain("sparkplug-payload 1.0.3");
    expect(FIXTURE.integrity).toStartWith("sha512-");
    expect(FIXTURE.payloadHex.length).toBeGreaterThan(200);
  });

  test("every datatype it carries is read as the number the reference meant", () => {
    const { state } = foldMessages([
      {
        topic: FIXTURE.topic,
        payload: Uint8Array.from(Buffer.from(FIXTURE.payloadHex, "hex")),
        payloadBytes: FIXTURE.payloadHex.length / 2,
        receivedAt: 1,
      },
    ]);
    const rows = buildRows(state, query);
    const read = Object.fromEntries(rows.map((row) => [String(row.metric), String(row.value)]));
    expect(read).toEqual({ ...FIXTURE.expected });
  });

  test("the two readings that would be wrong by four billion are named, not left to the table", () => {
    // The table above would still pass if someone widened it; these two are the measured facts
    // themselves, and they are the reason `values.ts` exists at all.
    const { state } = foldMessages([
      {
        topic: FIXTURE.topic,
        payload: Uint8Array.from(Buffer.from(FIXTURE.payloadHex, "hex")),
        payloadBytes: FIXTURE.payloadHex.length / 2,
        receivedAt: 1,
      },
    ]);
    const rows = buildRows(state, query);
    const valueOf = (metric: string) => rows.find((row) => row.metric === metric)?.value;
    // Int8 -1 travels as int_value 4294967295, and Int16 -32768 as 4294934528.
    expect(valueOf("Int8Min")).toBe("-1");
    expect(valueOf("Int16Min")).toBe("-32768");
    // UInt32 travels in long_value, so the field that is set does not identify the type.
    expect(valueOf("UInt32Max")).toBe("4294967295");
    expect(rows.find((row) => row.metric === "UInt32Max")?.datatype).toBe("UInt32");
    // And a 64-bit value never becomes a JavaScript number on the way.
    expect(valueOf("UInt64Max")).toBe("18446744073709551615");
    expect(valueOf("Int64Neg")).toBe("-5");
  });
});
