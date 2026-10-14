import { describe, test, expect, afterEach } from "bun:test";
import { readSchemaName } from "@/lib/storage/schema-name";

const VARIABLE = "LIBREDB_TEST_SCHEMA_NAME";

describe("storage/schema-name readSchemaName", () => {
  afterEach(() => {
    delete process.env[VARIABLE];
  });

  test("returns the fallback, or undefined without one, when the variable is unset or empty", () => {
    expect(readSchemaName(VARIABLE)).toBeUndefined();
    expect(readSchemaName(VARIABLE, "bridge")).toBe("bridge");
    process.env[VARIABLE] = "";
    expect(readSchemaName(VARIABLE)).toBeUndefined();
    expect(readSchemaName(VARIABLE, "bridge")).toBe("bridge");
  });

  test("returns a lowercase identifier of up to 63 characters as it was set", () => {
    for (const name of ["studio", "_private", "s2_bridge", `a${"b".repeat(62)}`]) {
      process.env[VARIABLE] = name;
      expect(readSchemaName(VARIABLE, "bridge")).toBe(name);
    }
  });

  test("refuses anything that would need quoting, naming the variable and the value", () => {
    for (const name of [
      "Studio",
      "2studio",
      "my-schema",
      'stu"dio',
      "stu dio",
      "public.studio",
      `a${"b".repeat(63)}`,
    ]) {
      process.env[VARIABLE] = name;
      expect(() => readSchemaName(VARIABLE)).toThrow(
        `${VARIABLE} must be a lowercase PostgreSQL schema name matching ^[a-z_][a-z0-9_]{0,62}$, got "${name}"`,
      );
    }
  });
});
