/**
 * The Graph tab's view (graph view spec, task G3)
 *
 * Driven through the view's injectable factory: the real Cytoscape and fcose,
 * loaded the way production loads them, made headless because happy-dom has no
 * canvas. `png()` is the one call a headless instance cannot make, so the factory
 * records its options and returns a stand-in blob. No module is mocked.
 */
import "../../setup-dom";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import React from "react";
import { GraphView } from "@/components/results-graph/GraphView";
import { type Core, type CytoscapeFactory, loadCytoscape } from "@/components/results-graph/cytoscape-host";
import { ChunkBoundary } from "@/components/LazyView";
import { chartTheme } from "@/lib/charts/palette";
import { DEFAULT_MASKING_CONFIG, type MaskingConfig, maskingInForce } from "@/lib/data-masking";
import type { GraphNodeJson, GraphRelationshipJson } from "@/lib/db/graph/values";
import type { QueryResult } from "@/lib/types";

function node(id: string, labels: string[], properties: Record<string, unknown> = {}): GraphNodeJson {
  return { "~graph": "node", elementId: id, labels, properties };
}

function rel(id: string, start: string, end: string, type: string, properties: Record<string, unknown> = {}) {
  return {
    "~graph": "relationship",
    elementId: id,
    type,
    startNodeElementId: start,
    endNodeElementId: end,
    properties,
  } satisfies GraphRelationshipJson;
}

function resultOf(rows: Record<string, unknown>[]): QueryResult {
  const fields = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { rows, fields, rowCount: rows.length, executionTime: 1 };
}

const alice = node("4:a", ["Person"], { name: "Alice", email: "alice@example.com", age: 41 });
const bob = node("4:b", ["Person"], { name: "Bob" });
const heat = node("4:c", ["Movie"], {});
const knows = rel("5:ab", "4:a", "4:b", "KNOWS", { since: 2020 });
const actedIn = rel("5:bc", "4:b", "4:c", "ACTED_IN");
const people = resultOf([{ a: alice, r: knows, b: bob, s: actedIn, m: heat }]);

const MASKING_OFF: MaskingConfig = { ...DEFAULT_MASKING_CONFIG, enabled: false };

interface Harness {
  instances: Core[];
  pngCalls: unknown[];
  saved: { blob: Blob; fileName: string }[];
  factory: CytoscapeFactory;
}

function harness(): Harness {
  const instances: Core[] = [];
  const pngCalls: unknown[] = [];
  const saved: { blob: Blob; fileName: string }[] = [];
  const factory: CytoscapeFactory = async () => {
    const create = await loadCytoscape();
    return (options) => {
      const cy = create({ ...options, container: undefined, headless: true, styleEnabled: true });
      cy.png = ((pngOptions: unknown) => {
        pngCalls.push(pngOptions);
        return new Blob(["png"], { type: "image/png" });
      }) as Core["png"];
      instances.push(cy);
      return cy;
    };
  };
  return { instances, pngCalls, saved, factory };
}

let h: Harness;

beforeEach(() => {
  h = harness();
  document.documentElement.classList.add("dark");
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

function view(overrides: Partial<React.ComponentProps<typeof GraphView>> = {}) {
  return (
    <GraphView
      result={people}
      maskingEnabled={undefined}
      userRole="admin"
      maskingConfig={MASKING_OFF}
      loadCytoscape={h.factory}
      save={(blob, fileName) => h.saved.push({ blob, fileName })}
      {...overrides}
    />
  );
}

async function mount(overrides: Partial<React.ComponentProps<typeof GraphView>> = {}) {
  const utils = render(view(overrides));
  await waitFor(() => expect(h.instances).toHaveLength(1));
  await waitFor(() =>
    expect(utils.getByRole("button", { name: "Fit the graph" }).hasAttribute("disabled")).toBe(false),
  );
  return { ...utils, cy: h.instances[0] };
}

function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255})`;
}

describe("GraphView: what is drawn", () => {
  test("draws every node and relationship the result holds, with captions, after one layout", async () => {
    const { cy } = await mount();
    expect(cy.nodes().map((element) => element.id())).toEqual(["n:4:a", "n:4:b", "n:4:c"]);
    expect(cy.edges().map((element) => element.id())).toEqual(["r:5:ab", "r:5:bc"]);
    expect(cy.$id("n:4:a").data("caption")).toBe("Alice");
    expect(cy.$id("r:5:ab").data("caption")).toBe("KNOWS");
    const positions = cy.nodes().map((element) => `${element.position().x},${element.position().y}`);
    expect(new Set(positions).size).toBe(3);
  });

  test("names the canvas for assistive technology and makes it focusable", async () => {
    const { getByRole } = await mount();
    const canvas = getByRole("application", { name: "Graph of 3 nodes and 2 relationships" });
    expect(canvas.getAttribute("tabindex")).toBe("0");
  });

  test("lists labels with colour and count, and relationship types with count", async () => {
    const { getByRole } = await mount();
    const legend = within(getByRole("region", { name: "Legend" }));
    expect(legend.getByText("Person").closest("li")?.textContent).toContain("2");
    expect(legend.getByText("Movie").closest("li")?.textContent).toContain("1");
    expect(legend.getByText("KNOWS").closest("li")?.textContent).toContain("1");
    expect(legend.getByText("ACTED_IN")).not.toBeNull();
    const swatch = legend.getByText("Movie").closest("li")?.querySelector("[data-swatch]") as HTMLElement;
    expect(swatch.getAttribute("style")).toContain(chartTheme("dark").series[1]);
  });

  test("colours a node by its first label from the theme's palette, and follows a theme change", async () => {
    const { cy } = await mount();
    expect(cy.$id("n:4:c").style("background-color")).toBe(rgb(chartTheme("dark").series[1]));
    act(() => document.documentElement.classList.remove("dark"));
    await waitFor(() => expect(cy.$id("n:4:c").style("background-color")).toBe(rgb(chartTheme("light").series[1])));
    expect(h.instances).toHaveLength(1);
  });

  test("states the cap and the relationships it could not draw", async () => {
    const many = Array.from({ length: 302 }, (_, index) => ({ n: node(`${index}`, ["N"]) }));
    const rows = [...many, { n: node("0", ["N"]), r: rel("x", "0", "301", "LINKS") }];
    const { getByText } = await mount({ result: { ...resultOf(many), rows, fields: ["n", "r"] } });
    expect(
      getByText("Showing 300 of 302 nodes. The graph draws at most 300 nodes; the Results tab holds every row."),
    ).not.toBeNull();
    expect(getByText("1 relationship is not drawn because an endpoint is not among the drawn nodes.")).not.toBeNull();
  });

  test("says nothing about a cap when every node is drawn", async () => {
    const { queryByText } = await mount();
    expect(queryByText(/Showing \d+ of/)).toBeNull();
    expect(queryByText(/not drawn/)).toBeNull();
  });
});

describe("GraphView: selection and the inspector", () => {
  test("a tapped node opens the inspector with its labels, elementId and every property", async () => {
    const { cy, getByRole } = await mount();
    act(() => {
      cy.$id("n:4:a").emit("tap");
    });
    const inspector = within(getByRole("region", { name: "Inspector" }));
    expect(inspector.getByText("Node")).not.toBeNull();
    expect(inspector.getByText("Person")).not.toBeNull();
    expect(inspector.getByText("4:a")).not.toBeNull();
    expect(inspector.getByText("alice@example.com")).not.toBeNull();
    expect(inspector.getByText("41")).not.toBeNull();
  });

  test("a tapped relationship shows its type, its endpoints and its properties", async () => {
    const { cy, getByRole } = await mount();
    act(() => {
      cy.$id("r:5:ab").emit("tap");
    });
    const inspector = within(getByRole("region", { name: "Inspector" }));
    expect(inspector.getByText("Relationship")).not.toBeNull();
    expect(inspector.getByText("KNOWS")).not.toBeNull();
    expect(inspector.getByText("5:ab")).not.toBeNull();
    expect(inspector.getByText("Alice → Bob")).not.toBeNull();
    expect(inspector.getByText("2020")).not.toBeNull();
  });

  test("a node with no property says so", async () => {
    const { cy, getByText } = await mount();
    act(() => {
      cy.$id("n:4:c").emit("tap");
    });
    expect(getByText("No properties")).not.toBeNull();
  });

  test("a tap on the background, Escape and the close button each clear the selection", async () => {
    const { cy, getByRole, queryByRole } = await mount();
    const select = () =>
      act(() => {
        cy.$id("n:4:a").select();
        cy.$id("n:4:a").emit("tap");
      });

    select();
    act(() => {
      cy.emit("tap");
    });
    expect(queryByRole("region", { name: "Inspector" })).toBeNull();

    select();
    fireEvent.keyDown(getByRole("application"), { key: "Escape" });
    expect(queryByRole("region", { name: "Inspector" })).toBeNull();
    expect(cy.$(":selected")).toHaveLength(0);

    select();
    fireEvent.click(getByRole("button", { name: "Close the inspector" }));
    expect(queryByRole("region", { name: "Inspector" })).toBeNull();
    expect(cy.$(":selected")).toHaveLength(0);
  });

  test("a new result draws a new canvas and drops the old selection", async () => {
    const { cy, rerender, queryByRole } = await mount();
    act(() => {
      cy.$id("n:4:a").emit("tap");
    });
    rerender(view({ result: resultOf([{ n: alice }]) }));
    await waitFor(() => expect(h.instances).toHaveLength(2));
    expect(cy.destroyed()).toBe(true);
    expect(queryByRole("region", { name: "Inspector" })).toBeNull();
    expect(h.instances[1].nodes()).toHaveLength(1);
  });
});

describe("GraphView: masking, exactly the grid's rule", () => {
  test("a node with an email property never shows the raw value when masking is on", async () => {
    const { cy, container, getByRole } = await mount({ maskingConfig: DEFAULT_MASKING_CONFIG, maskingEnabled: true });
    act(() => {
      cy.$id("n:4:a").emit("tap");
    });
    fireEvent.click(getByRole("button", { name: "Export JSON" }));
    const exported = await h.saved[0].blob.text();
    const drawn = JSON.stringify(cy.elements().map((element) => element.data()));
    for (const surface of [container.textContent ?? "", exported, drawn]) {
      expect(surface).not.toContain("alice@example.com");
    }
    expect(container.textContent).toContain("a****@e");
  });

  test("the caption is the masked value when the caption property is flagged", async () => {
    const result = resultOf([{ n: node("9", ["User"], { email: "carol@example.com" }) }]);
    const { cy } = await mount({ result, maskingConfig: DEFAULT_MASKING_CONFIG, maskingEnabled: true });
    expect(cy.$id("n:9").data("caption")).not.toContain("carol@example.com");
    expect(cy.$id("n:9").data("caption")).toContain("*");
  });

  test("a node under a column the grid masks by name never shows a raw property anywhere", async () => {
    const owner = node("7", ["Account"], { name: "Dana", city: "Izmir" });
    const result = resultOf([{ email: owner }]);
    const { cy, container, getByRole } = await mount({
      result,
      maskingConfig: DEFAULT_MASKING_CONFIG,
      maskingEnabled: true,
    });
    act(() => {
      cy.$id("n:7").emit("tap");
    });
    fireEvent.click(getByRole("button", { name: "Export JSON" }));
    const exported = await h.saved[0].blob.text();
    const drawn = JSON.stringify(cy.elements().map((element) => element.data()));
    for (const surface of [container.textContent ?? "", exported, drawn]) {
      expect(surface).not.toContain("Dana");
      expect(surface).not.toContain("Izmir");
    }
    // Labels and the elementId are not cell values the grid hides; they stay.
    expect(within(getByRole("region", { name: "Inspector" })).getAllByText("Account")).not.toHaveLength(0);
    expect(JSON.parse(exported).nodes[0].elementId).toBe("7");
  });

  test("masks exactly when the grid's maskingInForce does, over every role and switch state", async () => {
    const raw = "carol@example.com";
    const result = resultOf([{ n: node("9", ["User"], { email: raw }) }]);
    const outcomes = new Set<boolean>();
    for (const userRole of ["admin", "user", undefined]) {
      for (const canToggle of [true, false]) {
        for (const enabled of [true, false]) {
          for (const maskingEnabled of [true, false, undefined]) {
            const maskingConfig: MaskingConfig = {
              ...DEFAULT_MASKING_CONFIG,
              enabled,
              roleSettings: { ...DEFAULT_MASKING_CONFIG.roleSettings, user: { canToggle, canReveal: false } },
            };
            const expected = maskingInForce(userRole, maskingConfig, maskingEnabled);
            outcomes.add(expected);
            h = harness();
            const { cy, unmount } = await mount({ result, userRole, maskingConfig, maskingEnabled });
            expect({
              userRole,
              canToggle,
              enabled,
              maskingEnabled,
              masked: cy.$id("n:9").data("caption") !== raw,
            }).toEqual({ userRole, canToggle, enabled, maskingEnabled, masked: expected });
            unmount();
          }
        }
      }
    }
    expect(outcomes).toEqual(new Set([true, false]));
  });

  test("the shell's switch turns it off, as it does for the grid", async () => {
    const { cy, getByText } = await mount({ maskingConfig: DEFAULT_MASKING_CONFIG, maskingEnabled: false });
    act(() => {
      cy.$id("n:4:a").emit("tap");
    });
    expect(getByText("alice@example.com")).not.toBeNull();
  });
});

describe("GraphView: toolbar and keyboard", () => {
  test("every toolbar button has an accessible name and acts on the canvas", async () => {
    const { cy, getByRole } = await mount();
    const zoom = cy.zoom();
    fireEvent.click(getByRole("button", { name: "Zoom in" }));
    expect(cy.zoom()).toBeGreaterThan(zoom);
    fireEvent.click(getByRole("button", { name: "Zoom out" }));
    expect(cy.zoom()).toBeCloseTo(zoom);

    const fit = spyOn(cy, "fit");
    fireEvent.click(getByRole("button", { name: "Fit the graph" }));
    expect(fit).toHaveBeenCalledTimes(1);

    const layout = spyOn(cy, "layout");
    fireEvent.click(getByRole("button", { name: "Re-layout" }));
    expect(layout).toHaveBeenCalledWith({ name: "fcose", randomize: true, animate: false });
  });

  test("keys zoom, fit, pan and clear, and every other key is left alone", async () => {
    const { cy, getByRole } = await mount();
    const canvas = getByRole("application");
    const zoom = cy.zoom();
    expect(fireEvent.keyDown(canvas, { key: "+" })).toBe(false);
    expect(cy.zoom()).toBeGreaterThan(zoom);
    fireEvent.keyDown(canvas, { key: "-" });
    expect(cy.zoom()).toBeCloseTo(zoom);
    fireEvent.keyDown(canvas, { key: "=" });
    expect(cy.zoom()).toBeGreaterThan(zoom);

    const fit = spyOn(cy, "fit");
    fireEvent.keyDown(canvas, { key: "0" });
    expect(fit).toHaveBeenCalledTimes(1);

    const pan = { ...cy.pan() };
    fireEvent.keyDown(canvas, { key: "ArrowLeft" });
    fireEvent.keyDown(canvas, { key: "ArrowUp" });
    expect(cy.pan().x).toBeCloseTo(pan.x + 40);
    expect(cy.pan().y).toBeCloseTo(pan.y + 40);
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.keyDown(canvas, { key: "ArrowDown" });
    expect(cy.pan().x).toBeCloseTo(pan.x);
    expect(cy.pan().y).toBeCloseTo(pan.y);

    expect(fireEvent.keyDown(canvas, { key: "a" })).toBe(true);
    expect(fireEvent.keyDown(canvas, { key: "Tab" })).toBe(true);
  });

  test("the toolbar waits for the canvas", async () => {
    let release: (create: Awaited<ReturnType<CytoscapeFactory>>) => void = () => {};
    const pending: CytoscapeFactory = () => new Promise((resolve) => (release = resolve));
    const { getByRole } = render(view({ loadCytoscape: pending }));
    for (const name of ["Fit the graph", "Zoom in", "Zoom out", "Re-layout", "Export PNG", "Export JSON"]) {
      expect(getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    }
    expect(getByRole("status", { name: "Drawing the graph" })).not.toBeNull();
    await act(async () => release(await h.factory()));
    await waitFor(() => expect(getByRole("button", { name: "Zoom in" }).hasAttribute("disabled")).toBe(false));
  });
});

describe("GraphView: exports", () => {
  test("PNG is the whole graph from Cytoscape's own png(), on the theme's export ground", async () => {
    const { getByRole } = await mount();
    fireEvent.click(getByRole("button", { name: "Export PNG" }));
    expect(h.pngCalls).toEqual([{ output: "blob", full: true, scale: 2, bg: chartTheme("dark").exportBackground }]);
    expect(h.saved[0].fileName).toMatch(/^graph_\d+\.png$/);
    expect(await h.saved[0].blob.text()).toBe("png");
  });

  test("JSON is the drawn nodes and relationships in their tagged forms", async () => {
    const { getByRole } = await mount();
    fireEvent.click(getByRole("button", { name: "Export JSON" }));
    expect(h.saved[0].fileName).toMatch(/^graph_\d+\.json$/);
    expect(h.saved[0].blob.type).toStartWith("application/json");
    expect(JSON.parse(await h.saved[0].blob.text())).toEqual({
      nodes: [alice, bob, heat],
      relationships: [knows, actedIn],
    });
  });
});

describe("GraphView: lifecycle", () => {
  test("unmounting destroys the canvas", async () => {
    const { cy, unmount } = await mount();
    unmount();
    expect(cy.destroyed()).toBe(true);
  });

  test("a view gone before the library arrives builds nothing", async () => {
    let release: (create: Awaited<ReturnType<CytoscapeFactory>>) => void = () => {};
    const pending: CytoscapeFactory = () => new Promise((resolve) => (release = resolve));
    const { unmount } = render(view({ loadCytoscape: pending }));
    unmount();
    await act(async () => release(await h.factory()));
    expect(h.instances).toHaveLength(0);
  });

  test("a library that fails to load reaches the panel's chunk boundary", async () => {
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing: CytoscapeFactory = () => Promise.reject(new Error("chunk failed"));
      const { findByTestId } = render(
        <ChunkBoundary label="The graph">{view({ loadCytoscape: failing })}</ChunkBoundary>,
      );
      expect((await findByTestId("chunk-error")).textContent).toContain("The graph could not be loaded.");
    } finally {
      quiet.mockRestore();
    }
  });

  test("a failure that lands after the view is gone is dropped", async () => {
    let fail: (error: Error) => void = () => {};
    const pending: CytoscapeFactory = () => new Promise((_, reject) => (fail = reject));
    const { unmount } = render(view({ loadCytoscape: pending }));
    unmount();
    await act(async () => fail(new Error("late")));
    expect(h.instances).toHaveLength(0);
  });
});
