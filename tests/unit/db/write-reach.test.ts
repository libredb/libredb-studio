import { describe, expect, test } from "bun:test";
import type { WritePath, WritePathReach } from "@/lib/db/types";
import { declareWriteReach, noWritePath, summarizeWriteReach, WRITE_PATHS } from "@/lib/db/write-reach";

/**
 * The summary of a provider's per-path write declaration, and the two helpers a provider declares it with.
 *
 * The summary is the whole meaning of the three values: absent means open, any open path is open, any gated path
 * is guarded, and only a declaration whose every path is absent is none.
 */
const PROOF = Object.freeze({ module: "src/lib/db/write-reach.ts", symbol: "summarizeWriteReach" });

const absent: WritePathReach = { reach: "absent" };
const gated: WritePathReach = { reach: "gated", gate: PROOF };
const open: WritePathReach = { reach: "open" };

function paths(overrides: Partial<Record<WritePath, WritePathReach>>): Record<WritePath, WritePathReach> {
  return { editor: absent, objectEdit: absent, maintenance: absent, transaction: absent, ...overrides };
}

describe("summarizeWriteReach", () => {
  test("an absent declaration is open", () => {
    expect(summarizeWriteReach(undefined)).toBe("open");
  });

  test("every path absent is none", () => {
    expect(summarizeWriteReach(paths({}))).toBe("none");
  });

  test.each([...WRITE_PATHS])("one gated path, %s, makes the engine guarded", (path) => {
    expect(summarizeWriteReach(paths({ [path]: gated }))).toBe("guarded");
  });

  test.each([...WRITE_PATHS])("one open path, %s, makes the engine open even beside a gated one", (path) => {
    const other = WRITE_PATHS.find((candidate) => candidate !== path) as WritePath;
    expect(summarizeWriteReach(paths({ [path]: open, [other]: gated }))).toBe("open");
  });
});

describe("the declaration helpers", () => {
  test("the four write paths, in the order every declaration lists them", () => {
    expect(WRITE_PATHS).toEqual(["editor", "objectEdit", "maintenance", "transaction"]);
    expect(Object.isFrozen(WRITE_PATHS)).toBe(true);
  });

  test("declareWriteReach freezes the record and every path in it", () => {
    const declared = declareWriteReach(paths({ maintenance: gated }));
    expect(Object.isFrozen(declared)).toBe(true);
    for (const path of WRITE_PATHS) expect(Object.isFrozen(declared[path])).toBe(true);
    expect(Object.isFrozen((declared.maintenance as { gate: object }).gate)).toBe(true);
  });

  test("declareWriteReach freezes an absent path's proof as well", () => {
    const declared = declareWriteReach(paths({ editor: { reach: "absent", proof: { ...PROOF } } }));
    expect(Object.isFrozen((declared.editor as { proof: object }).proof)).toBe(true);
  });

  test("noWritePath declares the editor absent with its proof and the other three absent with none", () => {
    const declared = noWritePath({ ...PROOF });
    expect(declared).toEqual({
      editor: { reach: "absent", proof: PROOF },
      objectEdit: { reach: "absent" },
      maintenance: { reach: "absent" },
      transaction: { reach: "absent" },
    });
    expect(Object.isFrozen(declared.editor)).toBe(true);
    expect(summarizeWriteReach(declared)).toBe("none");
  });
});
