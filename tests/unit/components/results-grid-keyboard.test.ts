import { describe, expect, test } from "bun:test";
import { gridKeyCommand, gridKeyTarget, type GridKeyInput } from "@/components/results-grid/keyboard";

const key = (value: string, modifiers: Partial<Omit<GridKeyInput, "key">> = {}): GridKeyInput => ({
  key: value,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...modifiers,
});

describe("gridKeyCommand", () => {
  test("arrows move the active cell, and with Shift extend the range", () => {
    expect(gridKeyCommand(key("ArrowDown"))).toEqual({ kind: "move", step: "down", extend: false });
    expect(gridKeyCommand(key("ArrowLeft", { shiftKey: true }))).toEqual({ kind: "move", step: "left", extend: true });
  });

  test("Ctrl or Cmd with an arrow jumps to that edge of the grid", () => {
    expect(gridKeyCommand(key("ArrowRight", { ctrlKey: true }))).toEqual({
      kind: "move",
      step: "rightEdge",
      extend: false,
    });
    expect(gridKeyCommand(key("ArrowUp", { metaKey: true, shiftKey: true }))).toEqual({
      kind: "move",
      step: "topEdge",
      extend: true,
    });
  });

  test("Home and End go to the row's ends, and with Ctrl to the grid's corners", () => {
    expect(gridKeyCommand(key("Home"))).toEqual({ kind: "move", step: "leftEdge", extend: false });
    expect(gridKeyCommand(key("End", { shiftKey: true }))).toEqual({ kind: "move", step: "rightEdge", extend: true });
    expect(gridKeyCommand(key("Home", { ctrlKey: true }))).toEqual({ kind: "move", step: "first", extend: false });
    expect(gridKeyCommand(key("End", { ctrlKey: true }))).toEqual({ kind: "move", step: "last", extend: false });
  });

  test("Page Up and Page Down move by a page", () => {
    expect(gridKeyCommand(key("PageDown"))).toEqual({ kind: "move", step: "pageDown", extend: false });
    expect(gridKeyCommand(key("PageUp", { shiftKey: true }))).toEqual({ kind: "move", step: "pageUp", extend: true });
  });

  test("Ctrl+A selects everything, Shift+Space the rows and Ctrl+Space the columns of the selection", () => {
    expect(gridKeyCommand(key("a", { ctrlKey: true }))).toEqual({ kind: "selectAll" });
    expect(gridKeyCommand(key("A", { metaKey: true }))).toEqual({ kind: "selectAll" });
    expect(gridKeyCommand(key(" ", { shiftKey: true }))).toEqual({ kind: "selectRows" });
    expect(gridKeyCommand(key(" ", { ctrlKey: true }))).toEqual({ kind: "selectColumns" });
  });

  test("Enter and F2 edit the active cell, Escape clears the selection", () => {
    expect(gridKeyCommand(key("Enter"))).toEqual({ kind: "edit" });
    expect(gridKeyCommand(key("F2"))).toEqual({ kind: "edit" });
    expect(gridKeyCommand(key("Escape"))).toEqual({ kind: "clear" });
  });

  test("leaves every other key, and Alt chords, to the browser", () => {
    expect(gridKeyCommand(key("x"))).toBeNull();
    expect(gridKeyCommand(key("c", { ctrlKey: true }))).toBeNull();
    expect(gridKeyCommand(key("Tab"))).toBeNull();
    expect(gridKeyCommand(key(" "))).toBeNull();
    expect(gridKeyCommand(key("ArrowDown", { altKey: true }))).toBeNull();
    expect(gridKeyCommand(key("Enter", { shiftKey: true }))).toBeNull();
  });
});

describe("gridKeyTarget", () => {
  const size = { rows: 10, columns: 4, page: 3 };

  test("a step moves one cell and stops at the grid's edge", () => {
    expect(gridKeyTarget("down", { row: 2, column: 1 }, size)).toEqual({ row: 3, column: 1 });
    expect(gridKeyTarget("up", { row: 0, column: 1 }, size)).toEqual({ row: 0, column: 1 });
    expect(gridKeyTarget("right", { row: 2, column: 3 }, size)).toEqual({ row: 2, column: 3 });
    expect(gridKeyTarget("left", { row: 2, column: 1 }, size)).toEqual({ row: 2, column: 0 });
  });

  test("an edge keeps the other coordinate", () => {
    expect(gridKeyTarget("topEdge", { row: 5, column: 2 }, size)).toEqual({ row: 0, column: 2 });
    expect(gridKeyTarget("bottomEdge", { row: 5, column: 2 }, size)).toEqual({ row: 9, column: 2 });
    expect(gridKeyTarget("leftEdge", { row: 5, column: 2 }, size)).toEqual({ row: 5, column: 0 });
    expect(gridKeyTarget("rightEdge", { row: 5, column: 2 }, size)).toEqual({ row: 5, column: 3 });
  });

  test("first and last are the grid's corners", () => {
    expect(gridKeyTarget("first", { row: 5, column: 2 }, size)).toEqual({ row: 0, column: 0 });
    expect(gridKeyTarget("last", { row: 5, column: 2 }, size)).toEqual({ row: 9, column: 3 });
  });

  test("a page moves by the page size and stops at the edge", () => {
    expect(gridKeyTarget("pageDown", { row: 5, column: 2 }, size)).toEqual({ row: 8, column: 2 });
    expect(gridKeyTarget("pageDown", { row: 8, column: 2 }, size)).toEqual({ row: 9, column: 2 });
    expect(gridKeyTarget("pageUp", { row: 1, column: 2 }, size)).toEqual({ row: 0, column: 2 });
  });
});
