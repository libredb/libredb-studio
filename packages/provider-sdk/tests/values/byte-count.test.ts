import { describe, expect, test } from "bun:test";
import { formatBytes } from "@libredb/provider-sdk/values";

describe("formatBytes", () => {
  test('0 bytes returns "0 B"', () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  test('1024 bytes returns "1 KB"', () => {
    expect(formatBytes(1024)).toBe("1 KB");
  });

  test('1536 bytes returns "1.5 KB"', () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  test('1048576 bytes returns "1 MB"', () => {
    expect(formatBytes(1048576)).toBe("1 MB");
  });

  test('1073741824 bytes returns "1 GB"', () => {
    expect(formatBytes(1073741824)).toBe("1 GB");
  });

  test('1099511627776 bytes returns "1 TB"', () => {
    expect(formatBytes(1099511627776)).toBe("1 TB");
  });

  test('a petabyte renders as "1 PB" rather than a number with no unit', () => {
    expect(formatBytes(1024 ** 5)).toBe("1 PB");
  });

  test("1.5 PB keeps its fraction and its unit", () => {
    expect(formatBytes(1.5 * 1024 ** 5)).toBe("1.5 PB");
  });

  test('an exabyte renders as "1 EB", the last rung on the ladder', () => {
    expect(formatBytes(1024 ** 6)).toBe("1 EB");
  });

  test("above the ladder the index clamps to EB instead of indexing past the array", () => {
    expect(formatBytes(1024 ** 7)).toBe("1024 EB");
  });

  test("the clamp holds for the largest representable double", () => {
    const formatted = formatBytes(Number.MAX_VALUE);
    expect(formatted.endsWith(" EB")).toBe(true);
    expect(formatted).not.toContain("undefined");
    expect(formatted).not.toContain("NaN");
  });

  test('a negative byte count is not a magnitude and returns "N/A"', () => {
    expect(formatBytes(-1)).toBe("N/A");
    expect(formatBytes(-1536)).toBe("N/A");
  });

  test('NaN returns "N/A"', () => {
    expect(formatBytes(NaN)).toBe("N/A");
  });

  test('both infinities return "N/A"', () => {
    expect(formatBytes(Infinity)).toBe("N/A");
    expect(formatBytes(-Infinity)).toBe("N/A");
  });

  test("negative zero is still a zero measurement, not a refusal", () => {
    expect(formatBytes(-0)).toBe("0 B");
  });
});
