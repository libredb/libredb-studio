/**
 * The bundled modules, and the discipline the list keeps about its own claims.
 *
 * The rule these tests enforce is not "ship many modules". It is that every shipped module names
 * the document that publishes it, and that every withheld one says why and what it costs. A list
 * that quietly omits something reads as an oversight; a list that states a licence it has not
 * checked is worse than a short list.
 */
import { describe, expect, test } from "bun:test";
import {
  allNotices,
  BUNDLED,
  explainUnknown,
  isBundled,
  noticeFor,
  WITHHELD,
} from "@/lib/db/providers/network/snmp/mib";

describe("every shipped module names its document and its terms", () => {
  test("each one carries an RFC number", () => {
    for (const entry of BUNDLED) {
      expect(Number.isInteger(entry.rfc)).toBe(true);
      expect(entry.rfc).toBeGreaterThan(0);
    }
  });
  test("each one carries the same terms, which is the point of the rule", () => {
    for (const entry of BUNDLED) expect(entry.terms).toBe("IETF Trust");
  });
  test("no module is listed twice", () => {
    expect(new Set(BUNDLED.map((m) => m.name)).size).toBe(BUNDLED.length);
  });
  test("no vendor module is in the set", () => {
    const vendors = ["CISCO", "JUNIPER", "HP-", "APC", "DELL", "NETAPP", "MIKROTIK"];
    for (const entry of BUNDLED) {
      for (const vendor of vendors) expect(entry.name.toUpperCase()).not.toContain(vendor);
    }
  });
  test("the notice is built from the record, not written by hand", () => {
    for (const entry of BUNDLED) {
      expect(noticeFor(entry)).toBe(`${entry.name}: published in RFC ${entry.rfc}, IETF Trust.`);
    }
    expect(allNotices()).toHaveLength(BUNDLED.length);
  });
});

describe("every withheld module says why and what it costs", () => {
  test("none is withheld silently", () => {
    expect(WITHHELD.length).toBeGreaterThan(0);
    for (const entry of WITHHELD) {
      expect(entry.reason.length).toBeGreaterThan(30);
      expect(entry.cost.length).toBeGreaterThan(20);
    }
  });
  test("no reason is a promise instead of a reason", () => {
    for (const entry of WITHHELD) {
      expect(entry.reason.toLowerCase()).not.toContain("maybe");
      expect(entry.reason.toLowerCase()).not.toContain("later version");
    }
  });
  test("nothing is both shipped and withheld", () => {
    for (const entry of WITHHELD) expect(isBundled(entry.name)).toBe(false);
  });
  test("a module withheld for its imports names the modules that caused it", () => {
    const entity = WITHHELD.find((m) => m.name === "ENTITY-MIB");
    expect(entity?.reason).toContain("import closure");
  });
});

describe("an unresolvable name is explained by which kind of absence it is", () => {
  test("a name from a withheld module says so, and says why that module is absent", () => {
    const text = explainUnknown("IANAifType-MIB::ifType");
    expect(text).toContain("does not carry");
    expect(text).toContain("IANA");
  });
  test("a name from nowhere lists what is carried and offers the numeric route", () => {
    const text = explainUnknown("madeUpThing");
    expect(text).toContain("IF-MIB");
    expect(text).toContain("numeric object identifier");
  });
  test("each withheld module is named as ITSELF, not as whichever one is first", () => {
    // Without this, hardcoding one module's name in the explanation passed, because
    // the only withheld case asserted a word ("IANA") that the hardcoded answer also contains.
    expect(explainUnknown("ENTITY-MIB::entPhysicalDescr")).toContain("ENTITY-MIB");
    expect(explainUnknown("ENTITY-MIB::entPhysicalDescr")).not.toContain("IANAifType-MIB");
    expect(explainUnknown("IANA-ENTITY-MIB::x")).toContain("IANA-ENTITY-MIB");
  });
  test("the two explanations are different, because the two absences are", () => {
    expect(explainUnknown("ENTITY-MIB::entPhysicalDescr")).not.toBe(explainUnknown("madeUpThing"));
  });
});

describe("isBundled answers about this build and not about SNMP in general", () => {
  test("a shipped module", () => {
    expect(isBundled("IF-MIB")).toBe(true);
  });
  test("a real module this build does not carry", () => {
    expect(isBundled("ENTITY-MIB")).toBe(false);
  });
  test("a module that does not exist", () => {
    expect(isBundled("NOT-A-MIB")).toBe(false);
  });
});
