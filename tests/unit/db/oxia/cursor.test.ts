/**
 * The Keys panel cursor (SB1-7.9): the last key a page emitted and the order it was cut under, written
 * `k:<base64url>:<h|n>`, decoded strictly, and resumed inclusive.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeOxiaCursor,
  encodeOxiaCursor,
  OXIA_CURSOR_FOREIGN_REFUSAL,
  OXIA_CURSOR_ORDER_REFUSAL,
} from "@/lib/db/providers/keyvalue/oxia/cursor";
import { type KeyOrder, keyComparator } from "@/lib/db/providers/keyvalue/oxia/order";
import { j4Keyset, sortedKeys } from "../../../helpers/oxia-keyset";

interface CursorVectors {
  readonly encoders: readonly { readonly key: string }[];
  readonly serverOrder: Readonly<Record<string, readonly string[]>>;
}

const VECTORS: CursorVectors = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../fixtures/oxia/order-vectors.json"), "utf8"),
);

describe("the Oxia cursor (SB1-7.9)", () => {
  test("the format", () => {
    expect(encodeOxiaCursor({ lastKey: "a", order: "hierarchical" })).toBe("k:YQ:h");
    expect(encodeOxiaCursor({ lastKey: "", order: "natural" })).toBe("k::n");
    expect(encodeOxiaCursor({ lastKey: "", order: "hierarchical" })).toBe("k::h");
    expect(encodeOxiaCursor({ lastKey: "/?>", order: "natural" })).toBe("k:Lz8-:n");
    expect(encodeOxiaCursor({ lastKey: "\u00ff\u00ff", order: "natural" })).toBe("k:w7_Dvw:n");
  });

  test("round trips over every vector key", () => {
    const keys = [
      ...VECTORS.encoders.map((row) => row.key),
      ...Object.values(VECTORS.serverOrder).flat(),
      ...j4Keyset(),
    ];
    expect(keys.length).toBeGreaterThan(3_400);
    for (const order of ["hierarchical", "natural"] as const) {
      for (const lastKey of keys) {
        const cursor = { lastKey, order };
        expect(decodeOxiaCursor(encodeOxiaCursor(cursor))).toEqual(cursor);
      }
    }
  });

  test("a key that begins with U+FEFF keeps it", () => {
    for (const lastKey of ["﻿", "﻿a", "﻿﻿/x"]) {
      const cursor = { lastKey, order: "natural" as const };
      expect(decodeOxiaCursor(encodeOxiaCursor(cursor))).toEqual(cursor);
    }
  });

  test("0 starts the walk", () => {
    expect(decodeOxiaCursor("0")).toBe("start");
  });

  test("strict decoding", () => {
    const refused = [
      "",
      "1",
      "k:YQ",
      "k:YQ:x",
      "k:YQ==:h",
      "k:YR:h",
      "k:Y:h",
      "k:YQ:h:x",
      "K:YQ:h",
      "k:/w:h",
      "k:_w:h",
      "k:7aCA:h",
      encodeOxiaCursor({ lastKey: "a".repeat(65_537), order: "hierarchical" }),
    ];
    for (const text of refused) {
      expect({ text: text.slice(0, 20), cursor: decodeOxiaCursor(text) }).toEqual({
        text: text.slice(0, 20),
        cursor: undefined,
      });
    }
    const longest = { lastKey: "a".repeat(65_536), order: "natural" as const };
    expect(decodeOxiaCursor(encodeOxiaCursor(longest))).toEqual(longest);
  });

  test("the two refusals are SB1-7.9's sentences", () => {
    expect(OXIA_CURSOR_ORDER_REFUSAL).toBe(
      "This cursor was cut under the other key order than this namespace is now detected to have: start the walk again.",
    );
    expect(OXIA_CURSOR_FOREIGN_REFUSAL).toBe("This cursor was not written by the Oxia provider: start the walk again.");
  });

  test("an inclusive resume needs no successor", () => {
    const order: KeyOrder = "hierarchical";
    const cmp = keyComparator(order);
    const truth = sortedKeys(j4Keyset(), order);
    const lasts = truth.filter((key) => key.endsWith("//"));
    expect(lasts.length).toBeGreaterThan(0);
    let naiveMisses = 0;
    for (const last of lasts) {
      const after = truth.slice(truth.indexOf(last) + 1);
      const inclusive = truth.filter((key) => cmp(key, last) >= 0 && key !== last);
      expect({ last, keys: inclusive }).toEqual({ last, keys: after });
      const naive = truth.filter((key) => cmp(key, `${last}\u0000`) >= 0);
      expect(naive.length).toBeLessThan(after.length);
      if (after.some((key) => !naive.includes(key))) naiveMisses++;
    }
    expect(naiveMisses).toBe(lasts.length);
  });
});
