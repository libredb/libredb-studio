export const RESULT_COLUMN_MIN_SIZE = 80;
export const RESULT_COLUMN_MAX_SIZE = 500;
/**
 * How wide a user may drag or double-click a column. Far past the initial cap: the initial
 * width is chosen for the reader of the whole grid, this one for the reader of one long value.
 */
export const RESULT_COLUMN_RESIZE_MAX_SIZE = 2000;

const HEADER_FIELD_CHARACTER_WIDTH = 7.2;
const HEADER_TYPE_CHARACTER_WIDTH = 6;
const HEADER_HORIZONTAL_PADDING = 32;
const HEADER_LABEL_GAP = 4;
// The sort control is a button of its own: a 12px arrow inside 2px of padding on each side.
const HEADER_SORT_BUTTON_WIDTH = 16;
const HEADER_MARKER_GAP = 4;
const HEADER_MARKER_WIDTH = 12;
const HEADER_FILTER_GAP = 4;
const HEADER_FILTER_BUTTON_WIDTH = 16;
const HEADER_BORDER_WIDTH = 1;

// A cell is the same 12px monospace as the header's field name, with the same padding.
const CELL_CHARACTER_WIDTH = HEADER_FIELD_CHARACTER_WIDTH;
const CELL_HORIZONTAL_PADDING = HEADER_HORIZONTAL_PADDING;
const CELL_BORDER_WIDTH = HEADER_BORDER_WIDTH;

function clampColumnSize(width: number, maxSize: number): number {
  return Math.min(maxSize, Math.max(RESULT_COLUMN_MIN_SIZE, Math.ceil(width)));
}

function headerWidth(field: string, declaredType: string | undefined, hasMarker: boolean): number {
  const fieldWidth = field.length * HEADER_FIELD_CHARACTER_WIDTH;
  const typeWidth = declaredType ? declaredType.length * HEADER_TYPE_CHARACTER_WIDTH : 0;
  const labelWidth = fieldWidth + (declaredType ? HEADER_LABEL_GAP + typeWidth : 0);
  const markerWidth = hasMarker ? HEADER_MARKER_GAP + HEADER_MARKER_WIDTH : 0;
  const controlsWidth = HEADER_LABEL_GAP + HEADER_SORT_BUTTON_WIDTH + HEADER_FILTER_GAP + HEADER_FILTER_BUTTON_WIDTH;
  return labelWidth + markerWidth + controlsWidth + HEADER_HORIZONTAL_PADDING + HEADER_BORDER_WIDTH;
}

/**
 * Returns the width a desktop result field needs for its header alone.
 *
 * Result headers use a 12px monospace field name, a 10px type label, 32px of
 * horizontal padding and fixed sort/filter controls. Keeping this calculation
 * pure makes the TanStack numeric size available during render without
 * measuring cell values or depending on a browser layout pass.
 */
export function getHeaderFitColumnSize(field: string, declaredType?: string, hasMarker = false): number {
  return clampColumnSize(headerWidth(field, declaredType, hasMarker), RESULT_COLUMN_MAX_SIZE);
}

/**
 * Returns the width that shows the header and the widest of `values` whole, capped at `maxSize`.
 *
 * `values` are the texts the cells display, so the caller decides which rows are sampled and
 * what a masked cell reads as. Measured arithmetically for the reason the header is: the cell
 * font is monospace, so a character count is the width, with no layout pass per value.
 */
export function getContentFitColumnSize(
  field: string,
  declaredType: string | undefined,
  hasMarker: boolean,
  values: readonly string[],
  maxSize = RESULT_COLUMN_MAX_SIZE,
): number {
  let longest = 0;
  for (const value of values) longest = Math.max(longest, value.length);
  const valueWidth = longest * CELL_CHARACTER_WIDTH + CELL_HORIZONTAL_PADDING + CELL_BORDER_WIDTH;
  return clampColumnSize(Math.max(headerWidth(field, declaredType, hasMarker), valueWidth), maxSize);
}
