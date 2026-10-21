import { describe, expect, test } from "bun:test";
import {
  getContentFitColumnSize,
  getHeaderFitColumnSize,
  RESULT_COLUMN_MAX_SIZE,
  RESULT_COLUMN_MIN_SIZE,
  RESULT_COLUMN_RESIZE_MAX_SIZE,
} from "@/components/results-grid/column-sizing";

describe("getHeaderFitColumnSize", () => {
  test("keeps short field names at the existing minimum width", () => {
    expect(getHeaderFitColumnSize("")).toBe(RESULT_COLUMN_MIN_SIZE);
    // One character and the header's controls come to 80.2px, just past the floor.
    expect(getHeaderFitColumnSize("a")).toBe(RESULT_COLUMN_MIN_SIZE + 1);
  });

  // The sort control is its own 16px button (a 12px arrow and its padding), the same size as the
  // filter button beside it; counting it as the bare 12px arrow cut every header short by 4px.
  test("uses the header label length for ordinary field names", () => {
    expect(getHeaderFitColumnSize("name")).toBe(102);
    expect(getHeaderFitColumnSize("customer_registration_number")).toBe(275);
  });

  test("includes the declared type and header controls", () => {
    expect(getHeaderFitColumnSize("emp_no", "INTEGER")).toBe(163);
    expect(getHeaderFitColumnSize("birth_date", "DATE")).toBe(173);
    expect(getHeaderFitColumnSize("birth_date", "DATE", true)).toBe(189);
  });

  test("caps extremely long field names at the existing maximum width", () => {
    expect(getHeaderFitColumnSize("x".repeat(200))).toBe(RESULT_COLUMN_MAX_SIZE);
  });
});

describe("getContentFitColumnSize", () => {
  test("is the header fit when every value is narrower than the header", () => {
    expect(getContentFitColumnSize("customer_registration_number", undefined, false, ["1", "22"])).toBe(
      getHeaderFitColumnSize("customer_registration_number"),
    );
    expect(getContentFitColumnSize("name", undefined, false, [])).toBe(getHeaderFitColumnSize("name"));
  });

  test("widens to the longest value, measured in the cell's 12px monospace with its padding", () => {
    // 20 characters at 7.2px, 32px of padding and the 1px border.
    expect(getContentFitColumnSize("id", undefined, false, ["short", "x".repeat(20)])).toBe(177);
  });

  test("keeps the header's type label and marker in the comparison", () => {
    expect(getContentFitColumnSize("birth_date", "DATE", true, ["1990-01-01"])).toBe(
      getHeaderFitColumnSize("birth_date", "DATE", true),
    );
  });

  test("caps an initial fit at the result maximum, so one long value cannot push every other column away", () => {
    expect(getContentFitColumnSize("doc", undefined, false, ["x".repeat(5000)])).toBe(RESULT_COLUMN_MAX_SIZE);
  });

  test("a fit the user asked for may go past that, up to the resize maximum", () => {
    expect(getContentFitColumnSize("doc", undefined, false, ["x".repeat(100)], RESULT_COLUMN_RESIZE_MAX_SIZE)).toBe(
      753,
    );
    expect(getContentFitColumnSize("doc", undefined, false, ["x".repeat(5000)], RESULT_COLUMN_RESIZE_MAX_SIZE)).toBe(
      RESULT_COLUMN_RESIZE_MAX_SIZE,
    );
  });

  test("a long header is capped at the same limit as a long value", () => {
    expect(getContentFitColumnSize("x".repeat(200), undefined, false, [])).toBe(RESULT_COLUMN_MAX_SIZE);
  });
});
