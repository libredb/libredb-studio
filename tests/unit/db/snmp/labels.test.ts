/**
 * The labels, and the one rule they all have to meet: a control that is not offered says why.
 *
 * The reasons are checked against what this provider actually does rather than against a
 * wording, so a label that promises something the code does not do fails here.
 */
import { describe, expect, test } from "bun:test";
import { SNMP_LABELS, SNMP_NO_COUNT } from "@/lib/db/providers/network/snmp/labels";
import { PDU_GET, PDU_GET_BULK, PDU_GET_NEXT } from "@/lib/db/providers/network/snmp/valve";

describe("every unavailable control carries its reason", () => {
  const unavailable = [
    "generateAction",
    "analyzeAction",
    "vacuumAction",
    "analyzeGlobalLabel",
    "vacuumGlobalLabel",
  ] as const;
  for (const field of unavailable) {
    test(`${field} says not available`, () => {
      expect(SNMP_LABELS[field]).toBe("Not available");
    });
  }
  test("each one has a title and a description beside it", () => {
    for (const pair of [
      ["analyzeGlobalTitle", "analyzeGlobalDesc"],
      ["vacuumGlobalTitle", "vacuumGlobalDesc"],
    ] as const) {
      for (const field of pair) {
        expect(SNMP_LABELS[field].length).toBeGreaterThan(20);
      }
    }
  });
  test("the reasons are about SNMP, not apologies", () => {
    expect(SNMP_LABELS.analyzeGlobalDesc).toContain("no catalog");
    // The claim this one makes is the seam's, so it is asserted as the seam states it rather
    // than by matching a fragment of the title, which an earlier version of this test did and
    // which passed on nothing but a coincidence of letters.
    expect(SNMP_LABELS.vacuumGlobalDesc).toContain("no code that can write");
  });
});

describe("the labels name what SNMP has, not what SQL has", () => {
  test("no SQL word appears in any label", () => {
    const sqlWords = ["table", "schema", "column", "database", "index", "query"];
    for (const [field, value] of Object.entries(SNMP_LABELS)) {
      if (typeof value !== "string") continue;
      for (const word of sqlWords) {
        expect(`${field}: ${value.toLowerCase()}`).not.toContain(` ${word} `);
      }
    }
  });
  test("a row is an instance, because an object in SNMP is the definition", () => {
    expect(SNMP_LABELS.rowName).toBe("Instance");
    expect(SNMP_LABELS.rowNamePlural).toBe("Instances");
  });
});

describe("the maintenance reason matches the three PDU types the valve allows", () => {
  test("it names all three and no fourth", () => {
    const text = SNMP_LABELS.vacuumGlobalDesc;
    for (const name of ["GetRequest", "GetNextRequest", "GetBulkRequest"]) expect(text).toContain(name);
    for (const name of ["SetRequest", "InformRequest", "Trap"]) expect(text).not.toContain(name);
  });
  test("and the valve really does allow exactly those three", () => {
    // The sentence above is only true while this is: three read PDU types and no more.
    expect([PDU_GET, PDU_GET_NEXT, PDU_GET_BULK]).toEqual([0xa0, 0xa1, 0xa5]);
  });
});

describe("the count sentence says why there is no number", () => {
  test("it names the reason a zero would be wrong", () => {
    expect(SNMP_NO_COUNT).toContain("looks exactly like");
  });
  test("it does not promise a count later", () => {
    expect(SNMP_NO_COUNT.toLowerCase()).not.toContain("soon");
    expect(SNMP_NO_COUNT.toLowerCase()).not.toContain("will be");
  });
});
