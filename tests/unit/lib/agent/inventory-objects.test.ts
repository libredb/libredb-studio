import { describe, expect, test } from "bun:test";
import { addressableObjects } from "@/lib/agent/inventory-objects";
import type { AgentInventory, AgentInventoryKind, AgentInventoryObject } from "@/lib/agent/types";

/**
 * The one decision every agent consumer of the inventory makes, pinned by the objects it
 * must NOT admit (#789).
 *
 * Each test below names the entry the filter is there to keep out, because that is what a
 * mutation has to be able to kill: a filter deleted from a consumer leaves a green suite
 * unless a test asserts, by name, an object that reached something it must not reach.
 */

const object = (name: string, kind?: string): AgentInventoryObject => ({
  name,
  columns: [],
  indexes: [],
  ...(kind === undefined ? {} : { kind }),
});

const kind = (
  id: string,
  role: AgentInventoryKind["role"],
  extra: Partial<AgentInventoryKind> = {},
): AgentInventoryKind => ({
  id,
  role,
  label: id,
  labelPlural: `${id}s`,
  ...extra,
});

describe("addressableObjects", () => {
  test("a routine is refused while the relation beside it is kept", () => {
    const inventory: AgentInventory = {
      objects: [object("public.orders", "table"), object("public.sales_report(integer)", "function")],
      kinds: [kind("table", "relation"), kind("function", "routine")],
    };

    expect(addressableObjects(inventory).map((entry) => entry.name)).toEqual(["public.orders"]);
  });

  test("the gate is the DECLARED role and never the kind id, so a kind this repo never heard of is kept", () => {
    // Two relation kinds no consumer names anywhere, against an engine that declares the
    // id `table` for something whose role is not a relation. An allowlist of kind ids would
    // answer the opposite on all three, which is what makes this the role test and not one.
    const inventory: AgentInventory = {
      objects: [object("metrics", "hypertable"), object("wikipedia", "datasource"), object("orders_id_seq", "table")],
      kinds: [kind("hypertable", "relation"), kind("datasource", "relation"), kind("table", "config")],
    };

    expect(addressableObjects(inventory).map((entry) => entry.name)).toEqual(["metrics", "wikipedia"]);
  });

  test("a Redis key pattern is refused though its role is relation, because nothing derived can be named", () => {
    const inventory: AgentInventory = {
      objects: [object("user:*", "key-pattern")],
      kinds: [kind("key-pattern", "relation", { derivedGroupings: true, sampledFrom: "a bounded SCAN walk" })],
    };

    expect(addressableObjects(inventory)).toEqual([]);
  });

  test("an entry with no kind is kept, because the flat reading declares none and nothing said it is not a table", () => {
    const inventory: AgentInventory = {
      objects: [object("film"), object("public.sales_report(integer)", "function")],
      kinds: [kind("function", "routine")],
    };

    expect(addressableObjects(inventory).map((entry) => entry.name)).toEqual(["film"]);
  });

  test("an object carrying a kind the inventory declares nothing about is refused", () => {
    const inventory: AgentInventory = { objects: [object("orders", "table")], kinds: [kind("view", "relation")] };

    expect(addressableObjects(inventory)).toEqual([]);
  });

  test("an inventory recorded before kinds existed keeps every entry it holds", () => {
    const inventory: AgentInventory = { objects: [object("film"), object("actor")] };

    expect(addressableObjects(inventory).map((entry) => entry.name)).toEqual(["film", "actor"]);
  });
});
