import { describe, test, expect } from "bun:test";
import ts from "typescript";
import {
  toPascalCase,
  toIdentifier,
  toCamelCase,
  toSnakeCase,
  mapSqlTypeToTS,
  mapSqlTypeToZod,
  mapSqlTypeToPrisma,
  mapSqlTypeToGo,
  mapSqlTypeToPython,
  mapSqlTypeToJava,
  generateCode,
} from "@/components/CodeGenerator";
import type { DetailedObject } from "@/lib/db/detailed-object";

// ============================================================================
// Naming helpers
// ============================================================================

describe("toPascalCase", () => {
  // Case only: it also names Go fields, so it must not singularize (#1138).
  test("simple name", () => expect(toPascalCase("email")).toBe("Email"));
  test("underscore name", () => expect(toPascalCase("order_items")).toBe("OrderItems"));
  test("hyphenated name", () => expect(toPascalCase("user-roles")).toBe("UserRoles"));
  test("a trailing s is kept", () => expect(toPascalCase("status")).toBe("Status"));
  test("already pascal", () => expect(toPascalCase("User")).toBe("User"));
  test("single char", () => expect(toPascalCase("a")).toBe("A"));
  test("non-plural name", () => expect(toPascalCase("data")).toBe("Data"));
});

describe("toCamelCase", () => {
  test("a trailing s is kept", () => expect(toCamelCase("status")).toBe("status"));
  // This case expected `user` before #1138. That was the defect itself: `toCamelCase()` names
  // fields, so a column `users` must stay `users`. Only a TYPE name is singularized.
  test("plural name", () => expect(toCamelCase("users")).toBe("users"));
  test("underscore name", () => expect(toCamelCase("order_items")).toBe("orderItems"));
  test("already camel", () => expect(toCamelCase("email")).toBe("email"));
});

describe("toSnakeCase", () => {
  test("camelCase to snake", () => expect(toSnakeCase("createdAt")).toBe("created_at"));
  test("already snake", () => expect(toSnakeCase("user_id")).toBe("user_id"));
  test("PascalCase to snake", () => expect(toSnakeCase("UserId")).toBe("user_id"));
  test("lowercase stays", () => expect(toSnakeCase("email")).toBe("email"));
});

// ============================================================================
// Type mappers — TypeScript
// ============================================================================

describe("mapSqlTypeToTS", () => {
  test("INTEGER → number", () => expect(mapSqlTypeToTS("INTEGER")).toBe("number"));
  test("SERIAL → number", () => expect(mapSqlTypeToTS("SERIAL")).toBe("number"));
  test("FLOAT → number", () => expect(mapSqlTypeToTS("FLOAT")).toBe("number"));
  test("DOUBLE PRECISION → number", () => expect(mapSqlTypeToTS("DOUBLE PRECISION")).toBe("number"));
  test("NUMERIC(10,2) → number", () => expect(mapSqlTypeToTS("NUMERIC(10,2)")).toBe("number"));
  test("REAL → number", () => expect(mapSqlTypeToTS("REAL")).toBe("number"));
  test("BOOLEAN → boolean", () => expect(mapSqlTypeToTS("BOOLEAN")).toBe("boolean"));
  test("DATE → Date", () => expect(mapSqlTypeToTS("DATE")).toBe("Date"));
  test("TIMESTAMP → Date", () => expect(mapSqlTypeToTS("TIMESTAMP")).toBe("Date"));
  test("TIME → Date", () => expect(mapSqlTypeToTS("TIME")).toBe("Date"));
  test("JSONB → Record", () => expect(mapSqlTypeToTS("JSONB")).toBe("Record<string, unknown>"));
  test("UUID → string", () => expect(mapSqlTypeToTS("UUID")).toBe("string"));
  test("ARRAY → the element array", () => expect(mapSqlTypeToTS("text[]")).toBe("string[]"));
  // PostgreSQL's `format_type` bracket spelling: an array of the element before it
  test("array keyword detected", () => expect(mapSqlTypeToTS("_text ARRAY")).toBe("unknown[]"));
  test("VARCHAR → string", () => expect(mapSqlTypeToTS("VARCHAR(255)")).toBe("string"));
  test("TEXT → string", () => expect(mapSqlTypeToTS("TEXT")).toBe("string"));
});

// ============================================================================
// Type mappers — Zod
// ============================================================================

describe("mapSqlTypeToZod", () => {
  test("INTEGER → z.number()", () => expect(mapSqlTypeToZod("INTEGER")).toBe("z.number()"));
  test("BOOLEAN → z.boolean()", () => expect(mapSqlTypeToZod("BOOLEAN")).toBe("z.boolean()"));
  test("TIMESTAMP → z.date()", () => expect(mapSqlTypeToZod("TIMESTAMP")).toBe("z.date()"));
  test("JSON → z.record", () => expect(mapSqlTypeToZod("JSON")).toBe("z.record(z.unknown())"));
  test("UUID → z.string().uuid()", () => expect(mapSqlTypeToZod("UUID")).toBe("z.string().uuid()"));
  test("TEXT → z.string()", () => expect(mapSqlTypeToZod("TEXT")).toBe("z.string()"));
});

// ============================================================================
// Type mappers — Prisma
// ============================================================================

describe("mapSqlTypeToPrisma", () => {
  test("SERIAL → Int", () => expect(mapSqlTypeToPrisma("SERIAL")).toBe("Int"));
  test("integer → Int", () => expect(mapSqlTypeToPrisma("integer")).toBe("Int"));
  test("int4 → Int", () => expect(mapSqlTypeToPrisma("int4")).toBe("Int"));
  test("BIGINT → BigInt", () => expect(mapSqlTypeToPrisma("BIGINT")).toBe("BigInt"));
  test("int8 → BigInt", () => expect(mapSqlTypeToPrisma("int8")).toBe("BigInt"));
  test("FLOAT → Float", () => expect(mapSqlTypeToPrisma("FLOAT")).toBe("Float"));
  test("DECIMAL → Float", () => expect(mapSqlTypeToPrisma("DECIMAL")).toBe("Float"));
  test("BOOLEAN → Boolean", () => expect(mapSqlTypeToPrisma("BOOLEAN")).toBe("Boolean"));
  test("TIMESTAMP → DateTime", () => expect(mapSqlTypeToPrisma("TIMESTAMP")).toBe("DateTime"));
  test("DATETIME → DateTime", () => expect(mapSqlTypeToPrisma("DATETIME")).toBe("DateTime"));
  test("DATE → DateTime", () => expect(mapSqlTypeToPrisma("DATE")).toBe("DateTime"));
  test("JSON → Json", () => expect(mapSqlTypeToPrisma("JSON")).toBe("Json"));
  test("TEXT → String", () => expect(mapSqlTypeToPrisma("TEXT")).toBe("String"));
});

// ============================================================================
// Type mappers — Go
// ============================================================================

describe("mapSqlTypeToGo", () => {
  test("SERIAL → int", () => expect(mapSqlTypeToGo("SERIAL")).toBe("int"));
  test("integer → int", () => expect(mapSqlTypeToGo("integer")).toBe("int"));
  test("BIGINT → int64", () => expect(mapSqlTypeToGo("BIGINT")).toBe("int64"));
  test("FLOAT → float32", () => expect(mapSqlTypeToGo("FLOAT")).toBe("float32"));
  test("REAL → float32", () => expect(mapSqlTypeToGo("REAL")).toBe("float32"));
  test("DOUBLE → float64", () => expect(mapSqlTypeToGo("DOUBLE")).toBe("float64"));
  test("DECIMAL → float64", () => expect(mapSqlTypeToGo("DECIMAL")).toBe("float64"));
  test("BOOLEAN → bool", () => expect(mapSqlTypeToGo("BOOLEAN")).toBe("bool"));
  test("TIMESTAMP → time.Time", () => expect(mapSqlTypeToGo("TIMESTAMP")).toBe("time.Time"));
  test("TEXT → string", () => expect(mapSqlTypeToGo("TEXT")).toBe("string"));
});

// ============================================================================
// Type mappers — Python
// ============================================================================

describe("mapSqlTypeToPython", () => {
  test("INTEGER → int", () => expect(mapSqlTypeToPython("INTEGER")).toBe("int"));
  test("SERIAL → int", () => expect(mapSqlTypeToPython("SERIAL")).toBe("int"));
  test("FLOAT → float", () => expect(mapSqlTypeToPython("FLOAT")).toBe("float"));
  test("NUMERIC → float", () => expect(mapSqlTypeToPython("NUMERIC")).toBe("float"));
  test("BOOLEAN → bool", () => expect(mapSqlTypeToPython("BOOLEAN")).toBe("bool"));
  test("TIMESTAMP → datetime", () => expect(mapSqlTypeToPython("TIMESTAMP")).toBe("datetime"));
  test("JSON → dict", () => expect(mapSqlTypeToPython("JSON")).toBe("dict"));
  test("TEXT → str", () => expect(mapSqlTypeToPython("TEXT")).toBe("str"));
});

// ============================================================================
// Type mappers — Java
// ============================================================================

describe("mapSqlTypeToJava", () => {
  test("SERIAL → Integer", () => expect(mapSqlTypeToJava("SERIAL")).toBe("Integer"));
  test("integer → Integer", () => expect(mapSqlTypeToJava("integer")).toBe("Integer"));
  test("BIGINT → Long", () => expect(mapSqlTypeToJava("BIGINT")).toBe("Long"));
  test("FLOAT → Float", () => expect(mapSqlTypeToJava("FLOAT")).toBe("Float"));
  test("DOUBLE → Double", () => expect(mapSqlTypeToJava("DOUBLE")).toBe("Double"));
  test("DECIMAL → Double", () => expect(mapSqlTypeToJava("DECIMAL")).toBe("Double"));
  test("BOOLEAN → Boolean", () => expect(mapSqlTypeToJava("BOOLEAN")).toBe("Boolean"));
  test("TIMESTAMP → LocalDateTime", () => expect(mapSqlTypeToJava("TIMESTAMP")).toBe("LocalDateTime"));
  test("TEXT → String", () => expect(mapSqlTypeToJava("TEXT")).toBe("String"));
});

// ============================================================================
// The single classification (#1446): containers before ints, 64-bit integers,
// and `number` as a numeric
// ============================================================================

/*
  Every mapper below used to test substrings in its own order, so `Array(Int32)`
  matched `int` first and was typed a single number, `Map(String, Int32)` the same,
  and a type spelled `number` matched nothing and fell to the string default. The
  classification is decided once here and every mapper maps the class.
*/
describe("mapSqlTypeToTS classifies the declared type once (#1446)", () => {
  test("Array(Int32) is a list of numbers, not one number", () =>
    expect(mapSqlTypeToTS("Array(Int32)")).toBe("number[]"));
  test("Array(Int64) is a list of bigints", () => expect(mapSqlTypeToTS("Array(Int64)")).toBe("bigint[]"));
  test("Map(String, Int32) is a record of numbers", () =>
    expect(mapSqlTypeToTS("Map(String, Int32)")).toBe("Record<string, number>"));
  test("Map(String, Int64) is a record of bigints", () =>
    expect(mapSqlTypeToTS("Map(String, Int64)")).toBe("Record<string, bigint>"));
  test("a bare ARRAY stays unknown[]", () => expect(mapSqlTypeToTS("_text ARRAY")).toBe("unknown[]"));
  test("a bracket spelling is an array of its element", () => expect(mapSqlTypeToTS("text[]")).toBe("string[]"));
  test("ClickHouse Int64 is bigint, not number", () => expect(mapSqlTypeToTS("Int64")).toBe("bigint"));
  test("ClickHouse UInt64 is bigint, not number", () => expect(mapSqlTypeToTS("UInt64")).toBe("bigint"));
  test("BIGINT is bigint", () => expect(mapSqlTypeToTS("BIGINT")).toBe("bigint"));
  test("LibreDB number is a number", () => expect(mapSqlTypeToTS("number")).toBe("number"));
  test("Oracle NUMBER is a number", () => expect(mapSqlTypeToTS("NUMBER(10,2)")).toBe("number"));
  test("a Unicode-letter field type stays reachable", () => expect(mapSqlTypeToTS("metin")).toBe("string"));
  test("a bare map is a record of unknown", () => expect(mapSqlTypeToTS("map")).toBe("Record<string, unknown>"));
  test("a tuple names several elements, so it stays a bare array", () =>
    expect(mapSqlTypeToTS("Tuple(String, Int32)")).toBe("unknown[]"));
  test("a Nullable wrapper is unwrapped, not typed", () =>
    expect(mapSqlTypeToTS("Nullable(Array(String))")).toBe("string[]"));
});

describe("mapSqlTypeToZod classifies the declared type once (#1446)", () => {
  test("Array(Int32) is an array of numbers", () =>
    expect(mapSqlTypeToZod("Array(Int32)")).toBe("z.array(z.number())"));
  test("a bare array is an array of unknown", () =>
    expect(mapSqlTypeToZod("_text ARRAY")).toBe("z.array(z.unknown())"));
  test("Map(String, Int32) is a record of numbers", () =>
    expect(mapSqlTypeToZod("Map(String, Int32)")).toBe("z.record(z.number())"));
  test("a bare map is a record of unknown", () => expect(mapSqlTypeToZod("map")).toBe("z.record(z.unknown())"));
  test("ClickHouse Int64 is a bigint", () => expect(mapSqlTypeToZod("Int64")).toBe("z.bigint()"));
  test("LibreDB number is a number", () => expect(mapSqlTypeToZod("number")).toBe("z.number()"));
  test("Oracle NUMBER is a number", () => expect(mapSqlTypeToZod("NUMBER(10,2)")).toBe("z.number()"));
  test("FLOAT is a number", () => expect(mapSqlTypeToZod("FLOAT")).toBe("z.number()"));
});

describe("mapSqlTypeToGo classifies the declared type once (#1446)", () => {
  test("Array(Int32) is a slice of int", () => expect(mapSqlTypeToGo("Array(Int32)")).toBe("[]int"));
  test("Array(String) is a slice of string", () => expect(mapSqlTypeToGo("Array(String)")).toBe("[]string"));
  test("Map(String, Int32) is a map of int by string", () =>
    expect(mapSqlTypeToGo("Map(String, Int32)")).toBe("map[string]int"));
  test("a bare array is a slice of interface", () => expect(mapSqlTypeToGo("_text ARRAY")).toBe("[]interface{}"));
  test("ClickHouse Int64 is int64", () => expect(mapSqlTypeToGo("Int64")).toBe("int64"));
  test("ClickHouse UInt64 is int64", () => expect(mapSqlTypeToGo("UInt64")).toBe("int64"));
  test("LibreDB number is float64", () => expect(mapSqlTypeToGo("number")).toBe("float64"));
  test("Oracle NUMBER is float64", () => expect(mapSqlTypeToGo("NUMBER(10,2)")).toBe("float64"));
  test("a bare map is a map of unknown by string", () => expect(mapSqlTypeToGo("map")).toBe("map[string]interface{}"));
  test("JSON is a string", () => expect(mapSqlTypeToGo("JSON")).toBe("string"));
  test("UUID is a string", () => expect(mapSqlTypeToGo("UUID")).toBe("string"));
});

describe("mapSqlTypeToPython classifies the declared type once (#1446)", () => {
  test("Array(Int32) is a list of int", () => expect(mapSqlTypeToPython("Array(Int32)")).toBe("list[int]"));
  test("Map(String, Int32) is a dict of int by str", () =>
    expect(mapSqlTypeToPython("Map(String, Int32)")).toBe("dict[str, int]"));
  test("a bare array is list", () => expect(mapSqlTypeToPython("_text ARRAY")).toBe("list"));
  test("ClickHouse Int64 is int", () => expect(mapSqlTypeToPython("Int64")).toBe("int"));
  test("ClickHouse UInt64 is int", () => expect(mapSqlTypeToPython("UInt64")).toBe("int"));
  test("LibreDB number is float", () => expect(mapSqlTypeToPython("number")).toBe("float"));
  test("Oracle NUMBER is float", () => expect(mapSqlTypeToPython("NUMBER(10,2)")).toBe("float"));
  test("a bare map is dict", () => expect(mapSqlTypeToPython("map")).toBe("dict"));
});

describe("mapSqlTypeToJava classifies the declared type once (#1446)", () => {
  test("Array(Int32) is an Integer array", () => expect(mapSqlTypeToJava("Array(Int32)")).toBe("Integer[]"));
  test("Map(String, Int32) is a Map of Integer by String", () =>
    expect(mapSqlTypeToJava("Map(String, Int32)")).toBe("Map<String, Integer>"));
  test("a bare array is an Object array", () => expect(mapSqlTypeToJava("_text ARRAY")).toBe("Object[]"));
  test("ClickHouse Int64 is Long", () => expect(mapSqlTypeToJava("Int64")).toBe("Long"));
  test("ClickHouse UInt64 is Long", () => expect(mapSqlTypeToJava("UInt64")).toBe("Long"));
  test("LibreDB number is Double", () => expect(mapSqlTypeToJava("number")).toBe("Double"));
  test("Oracle NUMBER is Double", () => expect(mapSqlTypeToJava("NUMBER(10,2)")).toBe("Double"));
  test("a bare map is a Map of Object by String", () => expect(mapSqlTypeToJava("map")).toBe("Map<String, Object>"));
  test("JSON is a String", () => expect(mapSqlTypeToJava("JSON")).toBe("String"));
  test("UUID is a String", () => expect(mapSqlTypeToJava("UUID")).toBe("String"));
});

describe("mapSqlTypeToPrisma classifies the declared type once (#1446)", () => {
  // Prisma's scalar lists are a connector conditional (PostgreSQL and CockroachDB
  // alone), and the generator serves every engine, so a container is Json there.
  test("Array(Int32) is Json", () => expect(mapSqlTypeToPrisma("Array(Int32)")).toBe("Json"));
  test("Map(String, Int32) is Json", () => expect(mapSqlTypeToPrisma("Map(String, Int32)")).toBe("Json"));
  test("ClickHouse Int64 is BigInt", () => expect(mapSqlTypeToPrisma("Int64")).toBe("BigInt"));
  test("ClickHouse UInt64 is BigInt", () => expect(mapSqlTypeToPrisma("UInt64")).toBe("BigInt"));
  test("LibreDB number is Float", () => expect(mapSqlTypeToPrisma("number")).toBe("Float"));
  test("Oracle NUMBER is Float", () => expect(mapSqlTypeToPrisma("NUMBER(10,2)")).toBe("Float"));
  test("UUID is a String", () => expect(mapSqlTypeToPrisma("UUID")).toBe("String"));
});

// ============================================================================
// generateCode
// ============================================================================

const testSchema: DetailedObject = {
  name: "order_items",
  kind: "table",
  path: ["order_items"],
  indexes: [],
  columns: [
    { name: "id", type: "SERIAL", nullable: false, isPrimary: true },
    { name: "product_name", type: "VARCHAR(255)", nullable: false, isPrimary: false },
    { name: "price", type: "DECIMAL(10,2)", nullable: true, isPrimary: false },
    { name: "created_at", type: "TIMESTAMP", nullable: true, isPrimary: false },
    { name: "metadata", type: "JSONB", nullable: true, isPrimary: false },
  ],
};

describe("generateCode", () => {
  test("TypeScript interface", () => {
    const code = generateCode("typescript", testSchema);
    expect(code).toContain("export interface OrderItem");
    expect(code).toContain("id: number;");
    expect(code).toContain("productName: string;");
    expect(code).toContain("price: number | null;");
    expect(code).toContain("createdAt: Date | null;");
    expect(code).toContain("metadata: Record<string, unknown> | null;");
  });

  test("Zod schema", () => {
    const code = generateCode("zod", testSchema);
    expect(code).toContain("import { z } from 'zod'");
    expect(code).toContain("OrderItemSchema = z.object");
    expect(code).toContain("z.number()");
    expect(code).toContain("z.number().nullable()");
    expect(code).toContain("z.date().nullable()");
    expect(code).toContain("z.record(z.unknown()).nullable()");
    expect(code).toContain("z.infer<typeof OrderItemSchema>");
  });

  test("Prisma model", () => {
    const code = generateCode("prisma", testSchema);
    expect(code).toContain("model OrderItem");
    expect(code).toContain("@id");
    expect(code).toContain("@default(autoincrement())");
    expect(code).toContain('@@map("order_items")');
    expect(code).toContain("price  Float?");
    expect(code).toContain("created_at  DateTime?");
  });

  test("the Prisma map names the object's own SEGMENT and never the display label", () => {
    // `DatabaseObject.name` is a display label and is NOT required to equal the last path
    // segment (standing ruling 2). `@@map` is what Prisma addresses the table by, so it takes
    // the segment; the model name is for a person and stays derived from the label (#789).
    const labelled: DetailedObject = {
      name: "Order Items",
      kind: "table",
      path: ["app", "order_items"],
      indexes: [],
      columns: [{ name: "id", type: "integer", nullable: false, isPrimary: true }],
    };
    const code = generateCode("prisma", labelled);
    expect(code).toContain("model OrderItem {");
    expect(code).toContain('@@map("order_items")');
  });

  test("Go struct", () => {
    const code = generateCode("go", testSchema);
    expect(code).toContain("package models");
    expect(code).toContain('import "time"');
    expect(code).toContain("type OrderItem struct");
    expect(code).toContain('json:"id"');
    expect(code).toContain("*float64");
    expect(code).toContain("*time.Time");
  });

  test("Python dataclass", () => {
    const code = generateCode("python", testSchema);
    expect(code).toContain("from dataclasses import dataclass");
    expect(code).toContain("from typing import Optional");
    expect(code).toContain("from datetime import datetime");
    expect(code).toContain("@dataclass");
    expect(code).toContain("class OrderItem:");
    expect(code).toContain("id: int");
    expect(code).toContain("price: Optional[float]");
  });

  test("Java POJO", () => {
    const code = generateCode("java", testSchema);
    expect(code).toContain("import java.time.LocalDateTime;");
    expect(code).toContain("public class OrderItem");
    expect(code).toContain("private Integer id;");
    expect(code).toContain("private String productName;");
    expect(code).toContain("private Double price;");
    expect(code).toContain("private LocalDateTime createdAt;");
  });

  test("Go struct without time import when no date columns", () => {
    const schema: DetailedObject = {
      name: "tags",
      kind: "table",
      path: ["tags"],
      indexes: [],
      columns: [
        { name: "id", type: "INTEGER", nullable: false, isPrimary: true },
        { name: "name", type: "TEXT", nullable: false, isPrimary: false },
      ],
    };
    const code = generateCode("go", schema);
    expect(code).not.toContain('import "time"');
  });

  test("Python dataclass without optional/datetime when not needed", () => {
    const schema: DetailedObject = {
      name: "flags",
      kind: "table",
      path: ["flags"],
      indexes: [],
      columns: [
        { name: "id", type: "INTEGER", nullable: false, isPrimary: true },
        { name: "name", type: "TEXT", nullable: false, isPrimary: false },
      ],
    };
    const code = generateCode("python", schema);
    expect(code).not.toContain("from typing import Optional");
    expect(code).not.toContain("from datetime import datetime");
  });

  test("Java POJO without LocalDateTime import when not needed", () => {
    const schema: DetailedObject = {
      name: "tags",
      kind: "table",
      path: ["tags"],
      indexes: [],
      columns: [{ name: "id", type: "INTEGER", nullable: false, isPrimary: true }],
    };
    const code = generateCode("java", schema);
    expect(code).not.toContain("import java.time.LocalDateTime");
  });

  describe("a column name that ends in `s` keeps its `s` (#1138)", () => {
    // Only the TYPE name is singularized. A field is the name of a key in a real row, so a
    // Zod schema that requires `statu` rejects every row, because the row has `status`.
    const orders: DetailedObject = {
      name: "orders",
      kind: "table",
      path: ["orders"],
      indexes: [],
      columns: [
        { name: "id", type: "INTEGER", nullable: false, isPrimary: true },
        { name: "status", type: "TEXT", nullable: false, isPrimary: false },
        { name: "address", type: "TEXT", nullable: true, isPrimary: false },
      ],
    };

    test.each([
      ["typescript", ["  status: string;", "  address: string | null;"]],
      ["zod", ["  status: z.string(),", "  address: z.string().nullable(),"]],
      ["go", ["\tStatus string ", "\tAddress *string "]],
      ["java", ["    private String status;", "    private String address;"]],
    ] as const)("%s", (lang, fields) => {
      const code = generateCode(lang, orders);
      for (const field of fields) expect(code).toContain(field);
    });

    test.each([
      ["typescript", "export interface Order {"],
      ["zod", "export const OrderSchema = z.object({"],
      ["prisma", "model Order {"],
      ["go", "type Order struct {"],
      ["python", "class Order:"],
      ["java", "public class Order {"],
    ] as const)("the %s type name is still singular", (lang, declaration) => {
      expect(generateCode(lang, orders)).toContain(declaration);
    });
  });

  test("empty columns produces empty body", () => {
    const schema: DetailedObject = { name: "empty", kind: "table", path: ["empty"], indexes: [], columns: [] };
    const code = generateCode("typescript", schema);
    expect(code).toContain("export interface Empty");
    expect(code).toContain("{\n\n}");
  });

  /*
    Field names with `.` or `@` (#1446). `toCamelCase` and its siblings kept every
    non-`_`/`-` character, so a nested Elasticsearch field and a data stream's
    `@timestamp` produced `address.city: string | null;` and
    `private LocalDateTime @timestamp;`, which do not parse. TypeScript and Zod
    quote such a key; Go, Python, Java and Prisma sanitise the name and keep the
    original in the tag, alias or annotation the language has.
  */
  describe("field names that are not identifiers (#1446)", () => {
    const mappingSchema: DetailedObject = {
      name: "events",
      kind: "table",
      path: ["events"],
      indexes: [],
      columns: [
        { name: "@timestamp", type: "TIMESTAMP", nullable: true, isPrimary: false },
        { name: "address.city", type: "VARCHAR(255)", nullable: true, isPrimary: false },
        { name: "plain_field", type: "TEXT", nullable: false, isPrimary: false },
      ],
    };

    test("TypeScript quotes the key and keeps a plain name bare", () => {
      const code = generateCode("typescript", mappingSchema);
      expect(code).toContain('  "@timestamp": Date | null;');
      expect(code).toContain('  "address.city": string | null;');
      expect(code).toContain("  plainField: string;");
    });

    test("Zod quotes the key and keeps a plain name bare", () => {
      const code = generateCode("zod", mappingSchema);
      expect(code).toContain('  "@timestamp": z.date().nullable(),');
      expect(code).toContain('  "address.city": z.string().nullable(),');
      expect(code).toContain("  plainField: z.string(),");
    });

    test("Go sanitises the field name and keeps the original in the tag", () => {
      const code = generateCode("go", mappingSchema);
      expect(code).toContain('\tTimestamp *time.Time `json:"@timestamp" db:"@timestamp"`');
      expect(code).toContain('\tAddressCity *string `json:"address.city" db:"address.city"`');
      expect(code).toContain('\tPlainField string `json:"plain_field" db:"plain_field"`');
    });

    test("Python sanitises the field name and keeps the original as the alias", () => {
      const code = generateCode("python", mappingSchema);
      expect(code).toContain("from dataclasses import dataclass, field");
      expect(code).toContain('    timestamp: Optional[datetime] = field(metadata={"alias": "@timestamp"})');
      expect(code).toContain('    address_city: Optional[str] = field(metadata={"alias": "address.city"})');
      expect(code).toContain("    plain_field: str");
    });

    test("Java sanitises the field name and keeps the original in @JsonProperty", () => {
      const code = generateCode("java", mappingSchema);
      expect(code).toContain("import com.fasterxml.jackson.annotation.JsonProperty;");
      expect(code).toContain('    @JsonProperty("@timestamp")\n    private LocalDateTime timestamp;');
      expect(code).toContain('    @JsonProperty("address.city")\n    private String addressCity;');
      expect(code).toContain("    private String plainField;");
    });

    test("Prisma sanitises the field name and keeps the original in @map", () => {
      const code = generateCode("prisma", mappingSchema);
      expect(code).toContain('  timestamp  DateTime? @map("@timestamp")');
      expect(code).toContain('  address_city  String? @map("address.city")');
      expect(code).toContain("  plain_field  String");
    });

    test("a name with a quote character is escaped, not emitted raw", () => {
      const quoted: DetailedObject = {
        name: "odd",
        kind: "table",
        path: ["odd"],
        indexes: [],
        columns: [{ name: 'say "hi"', type: "TEXT", nullable: false, isPrimary: false }],
      };
      expect(generateCode("typescript", quoted)).toContain('  "say \\"hi\\"": string;');
      expect(generateCode("java", quoted)).toContain('    @JsonProperty("say \\"hi\\"")\n    private String sayHi;');
    });

    test("a name that is only punctuation does not collapse the output", () => {
      const punct: DetailedObject = {
        name: "punct",
        kind: "table",
        path: ["punct"],
        indexes: [],
        columns: [{ name: "@", type: "TEXT", nullable: false, isPrimary: false }],
      };
      expect(generateCode("typescript", punct)).toContain('  "@": string;');
      expect(generateCode("go", punct)).toContain("\tField string ");
      expect(generateCode("java", punct)).toContain("private String field;");
    });
  });

  describe("container columns reach every language (#1446)", () => {
    const clickhouse: DetailedObject = {
      name: "ch",
      kind: "table",
      path: ["ch"],
      indexes: [],
      columns: [
        { name: "big", type: "Int64", nullable: false, isPrimary: false },
        { name: "ubig", type: "UInt64", nullable: false, isPrimary: false },
        { name: "arr", type: "Array(Int32)", nullable: false, isPrimary: false },
        { name: "m", type: "Map(String, Int32)", nullable: false, isPrimary: false },
      ],
    };

    test("TypeScript", () => {
      const code = generateCode("typescript", clickhouse);
      expect(code).toContain("big: bigint;");
      expect(code).toContain("ubig: bigint;");
      expect(code).toContain("arr: number[];");
      expect(code).toContain("m: Record<string, number>;");
    });

    test("Zod", () => {
      const code = generateCode("zod", clickhouse);
      expect(code).toContain("big: z.bigint(),");
      expect(code).toContain("ubig: z.bigint(),");
      expect(code).toContain("arr: z.array(z.number()),");
      expect(code).toContain("m: z.record(z.number()),");
    });

    test("Go", () => {
      const code = generateCode("go", clickhouse);
      expect(code).toContain("Big int64");
      expect(code).toContain("Ubig int64");
      expect(code).toContain("Arr []int");
      expect(code).toContain("M map[string]int");
    });

    test("Python", () => {
      const code = generateCode("python", clickhouse);
      expect(code).toContain("big: int");
      expect(code).toContain("ubig: int");
      expect(code).toContain("arr: list[int]");
      expect(code).toContain("m: dict[str, int]");
    });

    test("Java", () => {
      const code = generateCode("java", clickhouse);
      expect(code).toContain("private Long big;");
      expect(code).toContain("private Long ubig;");
      expect(code).toContain("private Integer[] arr;");
      expect(code).toContain("private Map<String, Integer> m;");
      expect(code).toContain("import java.util.Map;");
    });

    test("Prisma", () => {
      const code = generateCode("prisma", clickhouse);
      expect(code).toContain("big  BigInt");
      expect(code).toContain("ubig  BigInt");
      expect(code).toContain("arr  Json");
      expect(code).toContain("m  Json");
    });
  });

  describe("generated TypeScript parses (#1446)", () => {
    const parseErrors = (code: string): number => {
      const source = ts.createSourceFile("generated.ts", code, ts.ScriptTarget.Latest, true);
      return (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length;
    };

    const mappingSchema: DetailedObject = {
      name: "events",
      kind: "table",
      path: ["events"],
      indexes: [],
      columns: [
        { name: "@timestamp", type: "TIMESTAMP", nullable: true, isPrimary: false },
        { name: "address.city", type: "VARCHAR(255)", nullable: true, isPrimary: false },
        { name: "arr", type: "Array(Int32)", nullable: false, isPrimary: false },
      ],
    };

    test("the interface with quoted keys parses", () =>
      expect(parseErrors(generateCode("typescript", mappingSchema))).toBe(0));
    test("the zod schema with quoted keys parses", () =>
      expect(parseErrors(generateCode("zod", mappingSchema))).toBe(0));
    test("the guard is not vacuous: an unquoted dotted key does not parse", () =>
      expect(parseErrors("export interface A { address.city: string; }")).toBeGreaterThan(0));
  });
});

// ============================================================================
// toIdentifier (#427)
// ============================================================================

describe("toIdentifier", () => {
  test("redis key-prefix grouping becomes a legal identifier", () => expect(toIdentifier("user:*")).toBe("User"));
  test("a second grouping keeps its singular-stripping behaviour", () =>
    expect(toIdentifier("session:*")).toBe("Session"));
  test("a bare key is unchanged", () => expect(toIdentifier("counter")).toBe("Counter"));
  test("punctuation runs become word boundaries", () => expect(toIdentifier("a-b:*")).toBe("AB"));
  test("a name with no alphanumerics falls back to Record", () => expect(toIdentifier(":*")).toBe("Record"));
  test("an empty name falls back to Record", () => expect(toIdentifier("")).toBe("Record"));
  test("an ordinary SQL table name is unaffected (regression)", () => expect(toIdentifier("users")).toBe("User"));
  test("an underscore table name is singularized", () => expect(toIdentifier("order_items")).toBe("OrderItem"));
  test("a hyphenated table name is singularized", () => expect(toIdentifier("user-roles")).toBe("UserRole"));
  test("a leading digit is prefixed rather than left illegal", () => expect(toIdentifier("2fa:*")).toBe("T2fa"));

  // Non-ASCII names were ALREADY legal identifiers in all six target languages,
  // and an ASCII-only strip destroyed them: "musteri" lost its diacritics and
  // two entirely non-Latin names collapsed onto the same fallback, so two tables
  // generated two files declaring one type (#427).
  test("a Turkish name keeps its letters", () => expect(toIdentifier("m\u00fc\u015fteri")).toBe("M\u00fc\u015fteri"));
  test("an already-capitalised Turkish name is unchanged", () =>
    expect(toIdentifier("\u00dcr\u00fcnler")).toBe("\u00dcr\u00fcnler"));
  test("a CJK name is unchanged rather than replaced by the fallback", () =>
    expect(toIdentifier("\u65e5\u672c\u8a9e")).toBe("\u65e5\u672c\u8a9e"));
  test("two distinct non-ASCII names do not collide", () =>
    expect(toIdentifier("\u65e5\u672c\u8a9e")).not.toBe(toIdentifier("\u00dcr\u00fcnler")));
  test("a non-ASCII prefix group is still stripped of its glob", () =>
    expect(toIdentifier("m\u00fc\u015fteri:*")).toBe("M\u00fc\u015fteri"));
});

describe("generateCode — non-identifier table names (#427)", () => {
  const redisSchema: DetailedObject = {
    name: "user:*",
    kind: "table",
    path: ["user:*"],
    indexes: [],
    columns: [
      { name: "key", type: "string", nullable: false, isPrimary: true },
      { name: "value", type: "string", nullable: true, isPrimary: false },
    ],
  };

  test("TypeScript emits a legal interface name", () => {
    const code = generateCode("typescript", redisSchema);
    expect(code).toContain("export interface User {");
    expect(code).not.toContain("User:*");
  });

  test("Zod emits a legal schema name", () => {
    const code = generateCode("zod", redisSchema);
    expect(code).toContain("export const UserSchema = z.object");
    expect(code).not.toContain("User:*");
  });

  test("Prisma emits a legal model name but maps the raw key pattern", () => {
    const code = generateCode("prisma", redisSchema);
    expect(code).toContain("model User {");
    expect(code).toContain('@@map("user:*")');
  });

  test("Go emits a legal struct name", () => {
    const code = generateCode("go", redisSchema);
    expect(code).toContain("type User struct");
    expect(code).not.toContain("User:*");
  });

  test("Python emits a legal class name", () => {
    const code = generateCode("python", redisSchema);
    expect(code).toContain("class User:");
    expect(code).not.toContain("User:*");
  });

  test("Java emits a legal class name", () => {
    const code = generateCode("java", redisSchema);
    expect(code).toContain("public class User {");
    expect(code).not.toContain("User:*");
  });

  // Every target language accepts Unicode letters in an identifier, so a
  // non-ASCII table name must survive intact in all six outputs (#427).
  const unicodeSchema: DetailedObject = {
    name: "m\u00fc\u015fteri",
    kind: "table",
    path: ["m\u00fc\u015fteri"],
    indexes: [],
    columns: [{ name: "id", type: "INT", nullable: false, isPrimary: true }],
  };

  const unicodeExpectations: [Parameters<typeof generateCode>[0], string][] = [
    ["typescript", "export interface M\u00fc\u015fteri {"],
    ["zod", "export const M\u00fc\u015fteriSchema = z.object"],
    ["prisma", "model M\u00fc\u015fteri {"],
    ["go", "type M\u00fc\u015fteri struct"],
    ["python", "class M\u00fc\u015fteri:"],
    ["java", "public class M\u00fc\u015fteri {"],
  ];

  for (const [lang, expected] of unicodeExpectations) {
    test(`${lang} keeps a non-ASCII table name intact`, () => {
      expect(generateCode(lang, unicodeSchema)).toContain(expected);
    });
  }
});

// ─── the review's three fixes (#1446) ─────────────────────────────────────────

/*
  1. The `time`, `datetime` and `LocalDateTime` imports are decided from the
     MAPPED type, not the raw declared one, so a container the classifier cannot
     see into (`list<timestamp>`, `map<text, timestamp>`, `Tuple(DateTime, Int32)`)
     no longer emits an import nothing uses - `go build` failed on exactly that.
*/
describe("imports follow the mapped type, not the declared string (#1446 review)", () => {
  const cassandraContainers: DetailedObject = {
    name: "ch",
    kind: "table",
    path: ["ch"],
    indexes: [],
    columns: [
      { name: "l", type: "list<timestamp>", nullable: false, isPrimary: false },
      { name: "m", type: "map<text, timestamp>", nullable: false, isPrimary: false },
      { name: "t", type: "Tuple(DateTime, Int32)", nullable: false, isPrimary: false },
    ],
  };

  test("Go emits no time import for containers it maps to interface{}", () => {
    const code = generateCode("go", cassandraContainers);
    expect(code).not.toContain('import "time"');
    expect(code).toContain("L []interface{}");
    expect(code).toContain("M map[string]interface{}");
    expect(code).toContain("T []interface{}");
  });

  test("Python emits no datetime import for them", () => {
    const code = generateCode("python", cassandraContainers);
    expect(code).not.toContain("from datetime import datetime");
    expect(code).toContain("l: list");
    expect(code).toContain("m: dict");
  });

  test("Java emits no LocalDateTime import for them", () => {
    const code = generateCode("java", cassandraContainers);
    expect(code).not.toContain("import java.time.LocalDateTime;");
    expect(code).toContain("private Object[] l;");
  });
});

/*
  2. Integer spellings match as whole tokens, so `point`, `interval` and
     `geo_point` (each carrying `int` as characters, none an integer type) are
     not integers in any language, and ClickHouse's CamelCase `Int8` - an 8-bit
     integer - is not PostgreSQL's `int8`, which is a 64-bit one.
*/
describe("integer spellings are whole tokens, not substrings (#1446 review)", () => {
  for (const type of ["point", "interval", "geo_point"]) {
    test(`${type} is not an integer in any language`, () => {
      expect(mapSqlTypeToTS(type)).toBe("string");
      expect(mapSqlTypeToZod(type)).toBe("z.string()");
      expect(mapSqlTypeToGo(type)).toBe("string");
      expect(mapSqlTypeToPython(type)).toBe("str");
      expect(mapSqlTypeToJava(type)).toBe("String");
      expect(mapSqlTypeToPrisma(type)).toBe("String");
    });
  }

  test("ClickHouse Int8 is an 8-bit integer, not PostgreSQL's int8", () => {
    expect(mapSqlTypeToTS("Int8")).toBe("number");
    expect(mapSqlTypeToZod("Int8")).toBe("z.number()");
    expect(mapSqlTypeToGo("Int8")).toBe("int");
    expect(mapSqlTypeToJava("Int8")).toBe("Integer");
    expect(mapSqlTypeToPrisma("Int8")).toBe("Int");
  });

  test("PostgreSQL's int8 stays the 64-bit one", () => {
    expect(mapSqlTypeToTS("int8")).toBe("bigint");
    expect(mapSqlTypeToGo("int8")).toBe("int64");
    expect(mapSqlTypeToJava("int8")).toBe("Long");
    expect(mapSqlTypeToPrisma("int8")).toBe("BigInt");
  });

  test("a modified integer keeps its family", () => {
    expect(mapSqlTypeToTS("int(11)")).toBe("number");
    expect(mapSqlTypeToTS("smallint")).toBe("number");
    expect(mapSqlTypeToTS("varint")).toBe("number");
    expect(mapSqlTypeToPython("varint")).toBe("int");
  });

  test("DuckDB's unsigned and huge integers keep their family", () => {
    for (const type of ["UTINYINT", "USMALLINT", "UINTEGER"]) {
      expect(mapSqlTypeToTS(type)).toBe("number");
      expect(mapSqlTypeToGo(type)).toBe("int");
    }
    for (const type of ["UBIGINT", "HUGEINT", "UHUGEINT"]) {
      expect(mapSqlTypeToTS(type)).toBe("bigint");
      expect(mapSqlTypeToGo(type)).toBe("int64");
      expect(mapSqlTypeToJava(type)).toBe("Long");
    }
  });
});

/*
  3. A trailing `[]` is PostgreSQL's array spelling (format_type), so the element
     is typed: `integer[]` is a list of numbers, not one number, and
     `timestamp with time zone[]` reaches Go as []time.Time.
*/
describe("a trailing [] is an array of its element (#1446 review)", () => {
  test("integer[] is a list of numbers", () => expect(mapSqlTypeToTS("integer[]")).toBe("number[]"));
  test("text[] is a list of strings", () => expect(mapSqlTypeToTS("text[]")).toBe("string[]"));
  test("timestamp with time zone[] is a list of Date", () =>
    expect(mapSqlTypeToTS("timestamp with time zone[]")).toBe("Date[]"));
  test("Go reads []time.Time for a zoned array", () =>
    expect(mapSqlTypeToGo("timestamp with time zone[]")).toBe("[]time.Time"));
  test("a two-dimensional array nests", () => expect(mapSqlTypeToTS("integer[][]")).toBe("number[][]"));
  test("Zod and Python type the element too", () => {
    expect(mapSqlTypeToZod("integer[]")).toBe("z.array(z.number())");
    expect(mapSqlTypeToPython("integer[]")).toBe("list[int]");
  });
  test("the _text ARRAY spelling still names no element", () =>
    expect(mapSqlTypeToTS("_text ARRAY")).toBe("unknown[]"));

  test("generateCode writes the element type and no unused import", () => {
    const schema: DetailedObject = {
      name: "pg",
      kind: "table",
      path: ["pg"],
      indexes: [],
      columns: [{ name: "tags", type: "text[]", nullable: false, isPrimary: false }],
    };
    const code = generateCode("go", schema);
    expect(code).toContain("Tags []string");
    expect(code).not.toContain('import "time"');
  });
});
