import { describe, expect, test } from "bun:test";
import {
  getHeaderFitColumnSize,
  RESULT_COLUMN_MAX_SIZE,
  RESULT_COLUMN_MIN_SIZE,
} from "@/components/results-grid/column-sizing";

describe("getHeaderFitColumnSize", () => {
  test("keeps short field names at the existing minimum width", () => {
    expect(getHeaderFitColumnSize("")).toBe(RESULT_COLUMN_MIN_SIZE);
    expect(getHeaderFitColumnSize("a")).toBe(RESULT_COLUMN_MIN_SIZE);
  });

  test("uses the header label length for ordinary field names", () => {
    expect(getHeaderFitColumnSize("name")).toBe(98);
    expect(getHeaderFitColumnSize("customer_registration_number")).toBe(271);
  });

  test("includes the declared type and header controls", () => {
    expect(getHeaderFitColumnSize("emp_no", "INTEGER")).toBe(159);
    expect(getHeaderFitColumnSize("birth_date", "DATE")).toBe(169);
    expect(getHeaderFitColumnSize("birth_date", "DATE", true)).toBe(185);
  });

  test("caps extremely long field names at the existing maximum width", () => {
    expect(getHeaderFitColumnSize("x".repeat(200))).toBe(RESULT_COLUMN_MAX_SIZE);
  });
});
