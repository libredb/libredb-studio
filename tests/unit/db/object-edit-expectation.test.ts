import { describe, expect, test } from "bun:test";
import {
  EDIT_CENSUS_TYPES,
  EXPECTED_EDITABLE_KINDS,
  EXPECTED_EDIT_ABSTAINERS,
} from "../../helpers/object-edit-expectation";

describe("the Phase 3 census expectation", () => {
  test("the two populations partition the fleet exactly once", () => {
    const declaring = new Set(EXPECTED_EDITABLE_KINDS.map(([type]) => String(type)));
    const abstaining = new Set(EXPECTED_EDIT_ABSTAINERS.map(String));
    // No type-id may be in both, and every type-id must be in one. A fleet that grew an engine
    // with neither row fails HERE, before the census ever runs.
    expect([...declaring].filter((type) => abstaining.has(type))).toEqual([]);
    expect([...declaring, ...abstaining].sort()).toEqual([...EDIT_CENSUS_TYPES].map(String).sort());
  });

  test("the day-one set is four pairs on three engines", () => {
    expect(EXPECTED_EDITABLE_KINDS.length).toBe(4);
    expect(new Set(EXPECTED_EDITABLE_KINDS.map(([type]) => type)).size).toBe(3);
    expect(EXPECTED_EDIT_ABSTAINERS.length).toBe(15);
    expect(EDIT_CENSUS_TYPES.length).toBe(18);
  });

  test("no pair is written twice", () => {
    const keys = EXPECTED_EDITABLE_KINDS.map(([type, kind]) => `${type}/${kind}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
