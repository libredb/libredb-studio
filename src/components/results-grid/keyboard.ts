/**
 * The keyboard of the desktop result grid, as the spreadsheet and database tools its users come
 * from (Excel, DataGrip, SQL Server Management Studio) have taught it.
 *
 * Kept apart from the component and free of React so the whole key map can be read and tested
 * in one place. Copy is not here: it rides the browser's own `copy` event, which also works
 * where `navigator.clipboard` does not (plain HTTP), so Ctrl+C is left to the browser.
 */

export interface GridKeyInput {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export type GridStep =
  | "up"
  | "down"
  | "left"
  | "right"
  | "topEdge"
  | "bottomEdge"
  | "leftEdge"
  | "rightEdge"
  | "first"
  | "last"
  | "pageUp"
  | "pageDown";

export type GridKeyCommand =
  | { kind: "move"; step: GridStep; extend: boolean }
  | { kind: "selectAll" }
  | { kind: "selectRows" }
  | { kind: "selectColumns" }
  | { kind: "edit" }
  | { kind: "clear" };

export interface GridPoint {
  row: number;
  column: number;
}

export interface GridSize {
  rows: number;
  columns: number;
  page: number;
}

const ARROW_STEPS: Record<string, { step: GridStep; edge: GridStep }> = {
  ArrowUp: { step: "up", edge: "topEdge" },
  ArrowDown: { step: "down", edge: "bottomEdge" },
  ArrowLeft: { step: "left", edge: "leftEdge" },
  ArrowRight: { step: "right", edge: "rightEdge" },
};

/** The grid command a key press asks for, or null for a key the grid leaves to the browser. */
export function gridKeyCommand(input: GridKeyInput): GridKeyCommand | null {
  if (input.altKey) return null;
  // Cmd on macOS plays the part Ctrl plays elsewhere.
  const command = input.ctrlKey || input.metaKey;
  const extend = input.shiftKey;

  const arrow = ARROW_STEPS[input.key];
  if (arrow !== undefined) return { kind: "move", step: command ? arrow.edge : arrow.step, extend };

  switch (input.key) {
    case "Home":
      return { kind: "move", step: command ? "first" : "leftEdge", extend };
    case "End":
      return { kind: "move", step: command ? "last" : "rightEdge", extend };
    case "PageUp":
      return { kind: "move", step: "pageUp", extend };
    case "PageDown":
      return { kind: "move", step: "pageDown", extend };
    case "a":
    case "A":
      return command ? { kind: "selectAll" } : null;
    case " ":
      if (command) return { kind: "selectColumns" };
      return extend ? { kind: "selectRows" } : null;
    case "Enter":
      return extend || command ? null : { kind: "edit" };
    case "F2":
      return { kind: "edit" };
    case "Escape":
      return { kind: "clear" };
    default:
      return null;
  }
}

/** Where a step from `from` lands, held inside a grid of `size`. */
export function gridKeyTarget(step: GridStep, from: GridPoint, size: GridSize): GridPoint {
  const lastRow = size.rows - 1;
  const lastColumn = size.columns - 1;
  const clampRow = (row: number) => Math.min(lastRow, Math.max(0, row));
  const clampColumn = (column: number) => Math.min(lastColumn, Math.max(0, column));

  switch (step) {
    case "up":
      return { row: clampRow(from.row - 1), column: from.column };
    case "down":
      return { row: clampRow(from.row + 1), column: from.column };
    case "left":
      return { row: from.row, column: clampColumn(from.column - 1) };
    case "right":
      return { row: from.row, column: clampColumn(from.column + 1) };
    case "topEdge":
      return { row: 0, column: from.column };
    case "bottomEdge":
      return { row: lastRow, column: from.column };
    case "leftEdge":
      return { row: from.row, column: 0 };
    case "rightEdge":
      return { row: from.row, column: lastColumn };
    case "first":
      return { row: 0, column: 0 };
    case "last":
      return { row: lastRow, column: lastColumn };
    case "pageUp":
      return { row: clampRow(from.row - size.page), column: from.column };
    case "pageDown":
      return { row: clampRow(from.row + size.page), column: from.column };
  }
}
