/**
 * The word a run is told its inventory rows go by (#414).
 *
 * Small enough to look like plumbing, and it is not: every block a run reads said
 * "table" on every engine until a live drive on a seeded Redis found what that costs.
 * What is pinned here is the derivation itself — the noun comes from what the PROVIDER
 * declares, so an engine added later arrives with its own word rather than being
 * spelled "table" until somebody notices.
 */

import { describe, expect, test } from "bun:test";
import { TABLE_INVENTORY_NOUN, inventoryNoun } from "@/lib/agent/inventory-noun";
import type { ProviderLabels } from "@/lib/db/types";
import { KEY_PATTERN_LABELS, TABLE_LABELS } from "../../../fixtures/provider-labels";

describe("inventoryNoun", () => {
  test("takes the provider's own entity labels, lower-cased for prose", () => {
    expect(inventoryNoun(KEY_PATTERN_LABELS)).toEqual({ singular: "key pattern", plural: "key patterns" });
  });

  /*
    The base provider's labels produce exactly the default, which is what keeps every
    SQL engine's prompt identical to what it was: the two are one decision recorded in
    two places, and this fails the moment they drift.
  */
  test("what every SQL engine declares is the default this module carries", () => {
    expect(inventoryNoun(TABLE_LABELS)).toEqual(TABLE_INVENTORY_NOUN);
  });

  /*
    The plural is carried rather than inflected. "Key Prefixes" is not "key prefix"
    plus an s, and a provider is free to declare a noun this layer has no business
    guessing the plural of.
  */
  test("an irregular plural survives, because it is read and never derived", () => {
    const labels: ProviderLabels = { ...TABLE_LABELS, entityName: "Index", entityNamePlural: "Indices" };

    expect(inventoryNoun(labels)).toEqual({ singular: "index", plural: "indices" });
  });
});
