import { describe, test, expect } from "bun:test";
import { buildConnectionSections } from "@/lib/connection-groups";
import type { ConnectionGroup } from "@/lib/storage/types";
import { mockPostgresConnection, mockMySQLConnection, mockSQLiteConnection } from "../../fixtures/connections";

const pg = mockPostgresConnection;
const my = mockMySQLConnection;
const lite = mockSQLiteConnection;

const group = (id: string, connectionIds: string[], collapsed = false): ConnectionGroup => ({
  id,
  name: `Group ${id}`,
  collapsed,
  connectionIds,
});

const ids = (section: { connections: { id: string }[] }) => section.connections.map((c) => c.id);

describe("buildConnectionSections", () => {
  test("with no groups and no favorites there is one Connections section holding everything, in order", () => {
    const sections = buildConnectionSections([pg, my], [], new Set());
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ key: "connections", kind: "connections", label: "Connections" });
    expect(ids(sections[0])).toEqual([pg.id, my.id]);
  });

  test("with no connections at all the Connections section still exists, empty", () => {
    const sections = buildConnectionSections([], [], new Set());
    expect(sections).toHaveLength(1);
    expect(sections[0].kind).toBe("connections");
    expect(sections[0].connections).toEqual([]);
  });

  test("a starred row appears under Favorites and stays in its own section too", () => {
    const sections = buildConnectionSections([pg, my], [], new Set([my.id]));
    expect(sections.map((s) => s.kind)).toEqual(["favorites", "connections"]);
    expect(ids(sections[0])).toEqual([my.id]);
    expect(ids(sections[1])).toEqual([pg.id, my.id]);
  });

  test("with groups, each group renders in group order holding its members in the given connection order", () => {
    const groups = [group("b", [my.id]), group("a", [lite.id, pg.id])];
    const sections = buildConnectionSections([pg, my, lite], groups, new Set());
    expect(sections.map((s) => [s.kind, s.key])).toEqual([
      ["group", "b"],
      ["group", "a"],
    ]);
    expect(ids(sections[0])).toEqual([my.id]);
    expect(ids(sections[1])).toEqual([pg.id, lite.id]);
    expect(sections[0]).toMatchObject({ label: "Group b", groupId: "b", collapsed: false });
  });

  test("connections in no group fall under Ungrouped, after the groups", () => {
    const sections = buildConnectionSections([pg, my, lite], [group("a", [pg.id])], new Set());
    expect(sections.map((s) => s.kind)).toEqual(["group", "ungrouped"]);
    expect(sections[1]).toMatchObject({ key: "ungrouped", label: "Ungrouped" });
    expect(ids(sections[1])).toEqual([my.id, lite.id]);
  });

  test("Ungrouped is hidden while it would be empty", () => {
    const sections = buildConnectionSections([pg], [group("a", [pg.id])], new Set());
    expect(sections.map((s) => s.kind)).toEqual(["group"]);
  });

  test("an empty group still renders, so a new group can be seen before anything is moved into it", () => {
    const sections = buildConnectionSections([pg], [group("a", [])], new Set());
    expect(sections.map((s) => s.kind)).toEqual(["group", "ungrouped"]);
    expect(sections[0].connections).toEqual([]);
  });

  test("a stale id in a group, naming a connection that no longer exists, is ignored", () => {
    const sections = buildConnectionSections([pg], [group("a", ["gone", pg.id])], new Set());
    expect(ids(sections[0])).toEqual([pg.id]);
  });

  test("a connection named by two groups renders only in the first", () => {
    const sections = buildConnectionSections([pg], [group("a", [pg.id]), group("b", [pg.id])], new Set());
    expect(ids(sections[0])).toEqual([pg.id]);
    expect(sections[1].connections).toEqual([]);
  });

  test("a starred row inside a group appears under Favorites and in its group", () => {
    const sections = buildConnectionSections([pg, my], [group("a", [pg.id])], new Set([pg.id]));
    expect(sections.map((s) => s.kind)).toEqual(["favorites", "group", "ungrouped"]);
    expect(ids(sections[0])).toEqual([pg.id]);
    expect(ids(sections[1])).toEqual([pg.id]);
    expect(ids(sections[2])).toEqual([my.id]);
  });

  test("a group's collapsed flag is carried through; other sections are never collapsed", () => {
    const sections = buildConnectionSections([pg, my], [group("a", [pg.id], true)], new Set([my.id]));
    expect(sections.map((s) => s.collapsed)).toEqual([false, true, false]);
  });

  test("a starred id with no matching connection produces no Favorites section", () => {
    const sections = buildConnectionSections([pg], [], new Set(["gone"]));
    expect(sections.map((s) => s.kind)).toEqual(["connections"]);
  });
});
