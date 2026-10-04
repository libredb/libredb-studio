/**
 * The Milvus provider's read-only decision: Load and Release are refused before any
 * request with etcd's sentences, unchanged, naming where the mode was set, and nothing is refused without a mode.
 */
import { describe, expect, test } from "bun:test";
import { readOnlySentence as etcdReadOnlySentence } from "@/lib/db/providers/keyvalue/etcd/write-policy";
import { readOnlySentence, refuseReadOnly } from "@/lib/db/providers/vector/milvus/write-policy";

describe("readOnlySentence", () => {
  test.each(["seed", "connection", "execution-profile"] as const)("words %s exactly as etcd does", (source) => {
    expect(readOnlySentence(source)).toBe(etcdReadOnlySentence(source));
  });
});

describe("refuseReadOnly", () => {
  test("refuses with the sentence of the place the mode was set", () => {
    expect(refuseReadOnly({ readOnly: "seed" })).toBe(
      "This connection is read-only (set in the operator's seed file).",
    );
    expect(refuseReadOnly({ readOnly: "connection" })).toBe(
      "This connection is read-only: turn off Read-only in its settings to write.",
    );
    expect(refuseReadOnly({ readOnly: "execution-profile" })).toBe(
      "This run opens the connection read-only (agent execution profile).",
    );
  });

  test("refuses nothing without a read-only mode", () => {
    expect(refuseReadOnly({})).toBeUndefined();
  });
});
