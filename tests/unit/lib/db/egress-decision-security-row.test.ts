/**
 * docs/SECURITY.md control 0.6 names the egress decision (FND-2 slice 2a): DB_HTTP_BLOCK_PRIVATE_HOSTS is read once
 * per process by one core module, an invalid value stops a standalone boot by name, and where no boot runs the
 * provider factory takes the decision first. scripts/security-check.mjs, run by tests/unit/security-check.test.ts,
 * proves every file the row links exists and every test it links runs.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const SECURITY = readFileSync(path.join(ROOT, "docs/SECURITY.md"), "utf8");
const ROW = SECURITY.split("\n").find((line) => line.startsWith("| 0.6 |")) ?? "";
const [, control, , enforcedIn, verifiedBy] = ROW.split(" | ");
const LIMITS = SECURITY.slice(SECURITY.indexOf("## Known limits"));
const GUARD_BULLET = LIMITS.slice(
  LIMITS.indexOf("- **The HTTP destination guard is opt-in and address-based.**"),
  LIMITS.indexOf("- **A PostgreSQL-wire cancel"),
);

describe("control 0.6 names the egress decision", () => {
  test.each([
    "src/lib/db/egress-decision.ts",
    "src/lib/config/egress-preflight.ts",
    "src/instrumentation.ts",
    "src/lib/db/factory.ts",
    "src/lib/db/providers/network/snmp/client.ts",
  ])("enforced in %s", (file) => {
    expect(enforcedIn).toContain(`[\`${file}\`](../${file})`);
  });

  test.each([
    "tests/unit/lib/db/egress-decision.test.ts",
    "tests/unit/db/snmp/client.test.ts",
    "tests/integration/db/snmp-provider.test.ts",
    "tests/unit/lib/config/egress-preflight.test.ts",
    "tests/unit/instrumentation.test.ts",
    "tests/isolated/factory.test.ts",
    "tests/unit/lib/db/egress-decision-security-row.test.ts",
  ])("verified by %s", (file) => {
    expect(verifiedBy).toContain(`[\`${file}\`](../${file})`);
  });

  test("the control says the setting is read once and an invalid value stops the boot by name", () => {
    expect(control).toContain("`DB_HTTP_BLOCK_PRIVATE_HOSTS` is read once per process by one core module");
    expect(control).toContain("SNMP's name lookup included");
    expect(control).toContain("a standalone server refuses to boot on a value other than");
    expect(control).toContain("the provider factory takes the decision before any cache, tunnel or provider");
    expect(control).toContain("(trimmed, any case)");
    expect(control).toContain("logs the decision once, at info level,");
  });

  test("Known limits says the decision is logged once, at info level, and a change waits for a restart", () => {
    expect(GUARD_BULLET).toContain(
      "Studio reads the variable once per process, logs which way it decided and whether that is the default in one info line, which a `LOG_LEVEL` of `warn` or `error` hides,",
    );
    expect(GUARD_BULLET).toContain("A change to the variable takes effect when the process restarts.");
  });

  test("Known limits names SNMP's agent lookup as covered, as row 0.6 does", () => {
    expect(GUARD_BULLET).toContain("SNMP's agent lookup is covered too");
  });
});
