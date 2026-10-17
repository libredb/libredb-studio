import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { MIB_NAMES } from "@/lib/db/providers/network/snmp/mib-names";

/**
 * The generated name index, held against the three ways a generated file goes wrong quietly.
 *
 * Nothing referred to this file before: 673 pairs, produced by net-snmp's own parser, and no case
 * would have noticed if half of them disappeared. A few names are resolved by read.test.ts, which
 * is a different claim - those cases pass while 600 names are missing, because they only ask about
 * the ones they name.
 *
 * The three ways, and the case for each:
 *   1. IT SHRINKS. A bad merge, a truncated write, a regeneration against fewer modules. The count
 *      is DECLARED here rather than read from the map, because a count taken from the thing it
 *      measures agrees with it whatever happened. Adding a module means changing this number, and
 *      that is the point of it.
 *   2. A KEY IS WRITTEN TWICE. The map literal takes the last one silently, so the file can carry
 *      two identifiers for a name and look fine. The source text is counted, not the map.
 *   3. SOMEONE TYPES ONE BY HAND. The header says every pair came out of `snmptranslate -Tz`; a
 *      case holds that command in the header, so the recipe cannot be deleted while the claim
 *      stays. The recipe was re-run on 15 October 2026 and reproduced all 673 pairs unchanged.
 */
const SOURCE = path.join(import.meta.dir, "../../../../src/lib/db/providers/network/snmp/mib-names.ts");
const TEXT = readFileSync(SOURCE, "utf8");

/** What the file is supposed to carry. See reason 1 above before changing it. */
const DECLARED = 673;

describe("the generated MIB name index", () => {
  test("it carries the number of names it declares", () => {
    expect(MIB_NAMES.size).toBe(DECLARED);
  });

  test("no name is written twice, which a map literal would hide", () => {
    const written = [...TEXT.matchAll(/\n\s*\["([A-Za-z0-9_-]+)",/g)].map((found) => found[1]);
    expect(written).toHaveLength(DECLARED);
    expect(new Set(written).size).toBe(written.length);
  });

  test("every name resolves to an identifier, and every arc is a whole number", () => {
    for (const [name, oid] of MIB_NAMES) {
      expect(oid.length, name).toBeGreaterThanOrEqual(2);
      for (const arc of oid) expect(Number.isInteger(arc) && arc >= 0, `${name}: ${oid.join(".")}`).toBe(true);
    }
  });

  test("the names the provider document teaches resolve where the agent keeps them", () => {
    // Measured against the live fixture on 15 October 2026, not copied from a specification.
    expect(MIB_NAMES.get("sysName")).toEqual([1, 3, 6, 1, 2, 1, 1, 5]);
    expect(MIB_NAMES.get("ifDescr")).toEqual([1, 3, 6, 1, 2, 1, 2, 2, 1, 2]);
    expect(MIB_NAMES.get("hrSystemUptime")).toEqual([1, 3, 6, 1, 2, 1, 25, 1, 1]);
    expect(MIB_NAMES.get("snmpEngineID")).toEqual([1, 3, 6, 1, 6, 3, 10, 2, 1, 1]);
  });

  test("the file still says how to make it again", () => {
    // A generated file whose recipe is gone is a file the repository owns without understanding.
    expect(TEXT).toContain('snmptranslate -Tz -m "$m"');
    expect(TEXT).toContain("SNMPv2-MIB IF-MIB IP-MIB TCP-MIB UDP-MIB SNMP-FRAMEWORK-MIB HOST-RESOURCES-MIB");
  });
});
