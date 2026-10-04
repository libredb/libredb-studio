export const RESULT_COLUMN_MIN_SIZE = 80;
export const RESULT_COLUMN_MAX_SIZE = 500;

const HEADER_FIELD_CHARACTER_WIDTH = 7.2;
const HEADER_TYPE_CHARACTER_WIDTH = 6;
const HEADER_HORIZONTAL_PADDING = 32;
const HEADER_LABEL_GAP = 4;
const HEADER_SORT_ICON_WIDTH = 12;
const HEADER_MARKER_GAP = 4;
const HEADER_MARKER_WIDTH = 12;
const HEADER_FILTER_GAP = 4;
const HEADER_FILTER_BUTTON_WIDTH = 16;
const HEADER_BORDER_WIDTH = 1;

/**
 * Returns the initial and reset width for a desktop result field.
 *
 * Result headers use a 12px monospace field name, a 10px type label, 32px of
 * horizontal padding and fixed sort/filter controls. Keeping this calculation
 * pure makes the TanStack numeric size available during render without
 * measuring cell values or depending on a browser layout pass.
 */
export function getHeaderFitColumnSize(field: string, declaredType?: string, hasMarker = false): number {
  const fieldWidth = field.length * HEADER_FIELD_CHARACTER_WIDTH;
  const typeWidth = declaredType ? declaredType.length * HEADER_TYPE_CHARACTER_WIDTH : 0;
  const labelWidth = fieldWidth + (declaredType ? HEADER_LABEL_GAP + typeWidth : 0);
  const markerWidth = hasMarker ? HEADER_MARKER_GAP + HEADER_MARKER_WIDTH : 0;
  const controlsWidth = HEADER_LABEL_GAP + HEADER_SORT_ICON_WIDTH + HEADER_FILTER_GAP + HEADER_FILTER_BUTTON_WIDTH;
  const headerWidth = labelWidth + markerWidth + controlsWidth + HEADER_HORIZONTAL_PADDING + HEADER_BORDER_WIDTH;

  return Math.min(RESULT_COLUMN_MAX_SIZE, Math.max(RESULT_COLUMN_MIN_SIZE, Math.ceil(headerWidth)));
}
