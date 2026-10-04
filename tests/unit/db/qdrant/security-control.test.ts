/**
 * docs/SECURITY.md control 0.6 names the shared REST transport and the Qdrant client that rides on it (vector-family
 * spec 3.7, QE2): the repair of PR 3h left node-transport.ts and its tests out of the row until a provider used the
 * transport, and the Qdrant REST client is that provider. scripts/security-check.mjs, run by
 * tests/unit/security-check.test.ts, proves every file the row links exists and every test it links runs.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const SECURITY = readFileSync(path.join(ROOT, "docs/SECURITY.md"), "utf8");
const ROW = SECURITY.split("\n").find((line) => line.startsWith("| 0.6 |")) ?? "";
const [, , status, enforcedIn, verifiedBy] = ROW.split(" | ");

describe("control 0.6 names the shared transport and its first consumer", () => {
  test("is an implemented control", () => {
    expect(status).toBe("Implemented");
  });

  test.each(["src/lib/db/http/node-transport.ts", "src/lib/db/providers/vector/qdrant/rest-client.ts"])(
    "enforced in %s",
    (file) => {
      expect(enforcedIn).toContain(`[\`${file}\`](../${file})`);
    },
  );

  test.each([
    "tests/unit/db/http/node-transport.test.ts",
    "tests/unit/db/http/node-transport-tls.test.ts",
    "tests/unit/db/http/node-transport-tls-material.test.ts",
    "tests/unit/db/http/node-transport-guard.test.ts",
    "tests/unit/db/http/node-transport-guard-lookup.test.ts",
    "tests/unit/db/http/node-transport-runtimes.test.ts",
    "tests/unit/db/qdrant/rest-client.test.ts",
    "tests/unit/db/qdrant/rest-client-wire.test.ts",
  ])("verified by %s", (file) => {
    expect(verifiedBy).toContain(`[\`${file}\`](../${file})`);
  });
});
