import "../setup-dom";

import { describe, test, expect, beforeEach } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import React from "react";
import ReactDOMServer from "react-dom/server";

import { useConnectionGroups } from "@/hooks/use-connection-groups";
import { storage } from "@/lib/storage";

const group = (id: string, connectionIds: string[], collapsed = false) => ({
  id,
  name: `Group ${id}`,
  collapsed,
  connectionIds,
});

describe("useConnectionGroups", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("starts with no groups before storage is ready, and does not read storage", () => {
    storage.setConnectionGroups([group("g1", ["c1"])]);
    const { result } = renderHook(() => useConnectionGroups(false));
    expect(result.current.groups).toEqual([]);
  });

  test("loads the stored groups once storage becomes ready", () => {
    storage.setConnectionGroups([group("g1", ["c1"])]);
    const { result, rerender } = renderHook(({ ready }) => useConnectionGroups(ready), {
      initialProps: { ready: false },
    });
    rerender({ ready: true });
    expect(result.current.groups).toEqual([group("g1", ["c1"])]);
  });

  test("createGroup appends a trimmed, uncollapsed, empty group and returns its id", async () => {
    storage.setConnectionGroups([group("g1", [])]);
    const { result } = renderHook(() => useConnectionGroups(true));

    let id = null as string | null;
    act(() => {
      id = result.current.createGroup("  Production  ");
    });

    await waitFor(() => expect(result.current.groups).toHaveLength(2));
    expect(id).toBe(result.current.groups[1].id);
    expect(result.current.groups[1]).toEqual({ id: id!, name: "Production", collapsed: false, connectionIds: [] });
    expect(storage.getConnectionGroups()).toEqual(result.current.groups);
  });

  test("createGroup ignores a blank name and returns null", () => {
    const { result } = renderHook(() => useConnectionGroups(true));
    let id = "unset" as string | null;
    act(() => {
      id = result.current.createGroup("   ");
    });
    expect(id).toBeNull();
    expect(storage.getConnectionGroups()).toEqual([]);
  });

  test("renameGroup trims the name and leaves the rest of the group alone", async () => {
    storage.setConnectionGroups([group("g1", ["c1"], true), group("g2", [])]);
    const { result } = renderHook(() => useConnectionGroups(true));

    act(() => result.current.renameGroup("g1", "  Staging "));

    await waitFor(() => expect(result.current.groups[0].name).toBe("Staging"));
    expect(result.current.groups[0]).toEqual({ id: "g1", name: "Staging", collapsed: true, connectionIds: ["c1"] });
    expect(result.current.groups[1]).toEqual(group("g2", []));
  });

  test("renameGroup ignores a blank name", () => {
    storage.setConnectionGroups([group("g1", [])]);
    const { result } = renderHook(() => useConnectionGroups(true));
    act(() => result.current.renameGroup("g1", " "));
    expect(storage.getConnectionGroups()[0].name).toBe("Group g1");
  });

  test("deleteGroup removes the group; its members are in none, so they fall back to Ungrouped", async () => {
    storage.setConnectionGroups([group("g1", ["c1"]), group("g2", ["c2"])]);
    const { result } = renderHook(() => useConnectionGroups(true));

    act(() => result.current.deleteGroup("g1"));

    await waitFor(() => expect(result.current.groups).toEqual([group("g2", ["c2"])]));
  });

  test("toggleCollapsed flips only that group's flag", async () => {
    storage.setConnectionGroups([group("g1", []), group("g2", [], true)]);
    const { result } = renderHook(() => useConnectionGroups(true));

    act(() => result.current.toggleCollapsed("g1"));
    act(() => result.current.toggleCollapsed("g2"));

    await waitFor(() => expect(result.current.groups.map((g) => g.collapsed)).toEqual([true, false]));
  });

  test("moveConnection puts a connection in the target group and takes it out of its previous one", async () => {
    storage.setConnectionGroups([group("g1", ["c1", "c2"]), group("g2", ["c3"])]);
    const { result } = renderHook(() => useConnectionGroups(true));

    act(() => result.current.moveConnection("c1", "g2"));

    await waitFor(() => expect(result.current.groups[1].connectionIds).toEqual(["c3", "c1"]));
    expect(result.current.groups[0].connectionIds).toEqual(["c2"]);
  });

  test("moveConnection to null removes the connection from every group", async () => {
    storage.setConnectionGroups([group("g1", ["c1"]), group("g2", ["c2"])]);
    const { result } = renderHook(() => useConnectionGroups(true));

    act(() => result.current.moveConnection("c1", null));

    await waitFor(() => expect(result.current.groups[0].connectionIds).toEqual([]));
    expect(result.current.groups[1].connectionIds).toEqual(["c2"]);
  });

  test("moveConnection to a group that does not exist changes nothing", () => {
    storage.setConnectionGroups([group("g1", ["c1"])]);
    const { result } = renderHook(() => useConnectionGroups(true));
    act(() => result.current.moveConnection("c1", "missing"));
    expect(storage.getConnectionGroups()).toEqual([group("g1", ["c1"])]);
  });

  test("ignores libredb-storage-change events for other collections", () => {
    const { result } = renderHook(() => useConnectionGroups(true));
    act(() => {
      window.dispatchEvent(
        new CustomEvent("libredb-storage-change", { detail: { collection: "connections", data: [] } }),
      );
    });
    expect(result.current.groups).toEqual([]);
  });

  test("picks up a connection_groups change dispatched by another consumer of the facade", async () => {
    const { result } = renderHook(() => useConnectionGroups(true));
    act(() => {
      storage.setConnectionGroups([group("remote", [])]);
    });
    await waitFor(() => expect(result.current.groups).toEqual([group("remote", [])]));
  });

  test("reports no groups during server rendering, even with groups already stored", () => {
    storage.setConnectionGroups([group("should-not-appear", [])]);
    function Probe() {
      const { groups } = useConnectionGroups(true);
      return React.createElement("span", null, JSON.stringify(groups));
    }
    expect(ReactDOMServer.renderToString(React.createElement(Probe))).toContain("[]");
  });
});
