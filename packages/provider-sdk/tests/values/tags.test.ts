/**
 * The value codec's tags are stated once, as `$defs/valueTag` in the manifest schema (docs/providers/CONTRACT.md,
 * clause V-1), and the codec writes and reads exactly those tags.
 *
 * `SAMPLES` holds one wire value per tag as a `Record<ValueTag, WireValue>`, so typecheck demands a sample for every tag
 * the schema names; the codec decodes each and writes it back unchanged. One value of every kind the codec tags is
 * encoded and its wire form walked, so a tag the codec writes that the schema does not name fails here by name.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { decodeValue, encodeValue, type ValueTag, ValueCodecError, type WireValue } from "@libredb/provider-sdk/values";

const SCHEMA = JSON.parse(
  readFileSync(path.join(import.meta.dir, "../../src/manifest/manifest.schema.json"), "utf8"),
) as { $defs: Record<string, { enum?: unknown[] }> };

/** The schema's value tags, sorted. */
const SCHEMA_TAGS = [...(SCHEMA.$defs.valueTag?.enum ?? [])].map(String).sort();

const SAMPLES: Record<ValueTag, WireValue> = {
  i64: { $: "i64", v: "-9223372036854775808" },
  bytes: { $: "bytes", v: "AAEC/w==" },
  ts: { $: "ts", v: "2026-11-23T10:15:30.123Z" },
  nf: { $: "nf", v: "-Infinity" },
  obj: { $: "obj", v: { $: "column", v: 1 } },
};

/** One value of every kind the codec writes as a tagged value, nested in plain JSON. */
const EVERY_TAGGED_KIND: unknown = {
  wide: BigInt(2) ** BigInt(63),
  bytes: new Uint8Array([1, 2, 3]),
  buffer: Buffer.from("text"),
  at: new Date(0),
  words: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
  row: { $: "a", v: { $: "nested", v: BigInt(1) } },
  plain: [null, true, 1, "s", { a: [] }],
};

/** Every tag a wire value holds, at any depth. */
function tagsOf(wire: WireValue, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(wire)) {
    for (const item of wire) tagsOf(item, found);
    return found;
  }
  if (wire === null || typeof wire !== "object") return found;
  const keys = Object.keys(wire);
  if (keys.length === 2 && keys.includes("$") && keys.includes("v")) {
    found.add(String(wire.$));
    // An obj payload is the escaped data object itself, whose two values are wire values; every other payload is text.
    const payload = wire.v as WireValue;
    if (wire.$ === "obj" && payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      for (const key of Object.keys(payload)) tagsOf(payload[key] as WireValue, found);
    }
    return found;
  }
  for (const key of keys) tagsOf(wire[key] as WireValue, found);
  return found;
}

describe("the value tags", () => {
  test("the codec writes and reads exactly the schema's value tags", () => {
    expect(SCHEMA_TAGS.length).toBeGreaterThan(0);
    expect(Object.keys(SAMPLES).sort()).toEqual(SCHEMA_TAGS);
    for (const tag of SCHEMA_TAGS) {
      const sample = SAMPLES[tag as ValueTag];
      expect({ tag, wire: encodeValue(decodeValue(sample)) }).toEqual({ tag, wire: sample });
    }
    expect([...tagsOf(encodeValue(EVERY_TAGGED_KIND))].sort()).toEqual(SCHEMA_TAGS);
  });

  test("a tag the schema does not name is refused on decode", () => {
    for (const tag of ["dec", "date", "time", "dur", "I64", ""]) {
      expect(SCHEMA_TAGS).not.toContain(tag);
      let thrown: unknown;
      try {
        decodeValue({ $: tag, v: "1" });
      } catch (error) {
        thrown = error;
      }
      expect({ tag, refused: thrown instanceof ValueCodecError }).toEqual({ tag, refused: true });
    }
  });
});
