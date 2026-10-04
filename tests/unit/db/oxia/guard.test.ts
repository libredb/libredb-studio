/**
 * The confirmation gate's view of an Oxia command (SB2-4.1): nothing asks, because v1 only reads; what the parser
 * refuses with the browser's context, the gate refuses with the same sentence; a read is named by its verb.
 */
import { describe, expect, test } from "bun:test";
import { parseOxiaCommand } from "@/lib/db/providers/keyvalue/oxia/commands";
import { OXIA_DESTRUCTIVE_OPERATIONS, oxiaRefusal, readOxiaOperations } from "@/lib/db/providers/keyvalue/oxia/guard";

describe("OXIA_DESTRUCTIVE_OPERATIONS", () => {
  test("is empty: no Oxia command asks for a confirmation in v1", () => {
    expect(OXIA_DESTRUCTIVE_OPERATIONS.size).toBe(0);
  });
});

describe("readOxiaOperations", () => {
  test.each([
    ["get /a", "get"],
    ["oxia client list --prefix /a/", "list"],
    ["ls", "list"],
    ["scan a b", "range-scan"],
    ["range-scan --prefix /a/ --limit 50", "range-scan"],
    // A key spelled like an SQL keyword is a key (decidesAlone).
    ["get /delete/from", "get"],
  ])("%s is the read %s", (text, verb) => {
    expect(readOxiaOperations(text)).toEqual([verb]);
  });

  test.each(["put k v", "delete k", "notifications", "get $HOME", "", "list --internal-keys"])(
    "%j names no operation it could run",
    (text) => {
      expect(readOxiaOperations(text)).toBeUndefined();
    },
  );
});

describe("oxiaRefusal: what the browser refuses before anything is sent", () => {
  test.each([
    "put k v",
    "oxia client delete-range a b",
    "sequence-updates k",
    "get __oxia/assignments",
    "list --internal-keys",
    "get --auth-token t /a",
    "get --request-timeout 1s /a",
    "get -h",
    "get a; get b",
    "get a\nget b",
    "list --limit 501",
    "list --index i",
    "unknown",
    `get ${"a".repeat(65_533)}`,
  ])("%j is refused with the parser's own sentence", (text) => {
    const parsed = parseOxiaCommand(text, {});
    expect(parsed.ok).toBe(false);
    expect(oxiaRefusal(text)).toBe(parsed.ok ? "unreachable" : parsed.refusal.message);
  });

  test("a read is sent", () => {
    expect(oxiaRefusal("get /a")).toBeUndefined();
    expect(oxiaRefusal("oxia client list -s /xyz/ -e /xyz//")).toBeUndefined();
  });

  test("-a and -n with any value are the provider's to refuse, not the browser's (SB2-12 D7)", () => {
    expect(oxiaRefusal("-a elsewhere:1 -n other get /a")).toBeUndefined();
    expect(readOxiaOperations("-a elsewhere:1 -n other get /a")).toEqual(["get"]);
  });

  test("a write is refused in the browser without naming the read-only mode, which it cannot know", () => {
    expect(oxiaRefusal("put k v")).toBe(
      "put writes, and Studio's Oxia support reads only in this version: write with the oxia CLI.",
    );
  });
});
