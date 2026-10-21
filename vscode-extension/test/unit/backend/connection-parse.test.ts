import assert from "node:assert/strict";
import { parseConnectionString } from "@/lib/connection-string-parser";
import { CONNECTION_FORM } from "@/lib/db/connection-form";
import { type BackendFactory, createHandlers } from "../../../src/backend/handlers";
import { TEST_PASSWORD } from "../../fakes/credentials";

const unused = async (): Promise<never> => {
  throw new Error("connection/parse touches no factory function");
};
const FACTORY = {
  getOrCreateProvider: unused,
  removeProvider: unused,
  clearProviderCache: unused,
  enabledProviderTypes: () => ["postgres", "mssql", "mysql", "mongodb"],
  testConnection: unused,
} as unknown as BackendFactory;
const RUNTIME = {
  versions: { ...process.versions, node: "24.21.0" },
  platform: "linux",
  arch: "x64",
  nodeFloor: ">=24.0.0",
};
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const answerOf = (text: string) => json(createHandlers(FACTORY, RUNTIME).parsePastedConnection({ text }));

describe("connection/parse", () => {
  const cases: [string, string, string][] = [
    [`postgresql://app:${TEST_PASSWORD}@db.example:6543/shop?sslmode=require`, "postgres", "PostgreSQL"],
    [`mysql://app:${TEST_PASSWORD}@db.example:3306/shop`, "mysql", "MySQL"],
    [`mssql://app:${TEST_PASSWORD}@db.example:1433/shop`, "mssql", "SQL Server"],
    [`Server=db.example,1433;Database=shop;User Id=app;Password=${TEST_PASSWORD};Encrypt=true`, "mssql", "SQL Server"],
    [`mongodb+srv://app:${TEST_PASSWORD}@cluster0.example.net/orders`, "mongodb", "MongoDB"],
    // Ambiguous: the parser marks it credentialsAmbiguous.
    ["mongodb://app:p@ss@db.example/orders", "mongodb", "MongoDB"],
  ];
  for (const [text, type, label] of cases) {
    it(`answers the parser's own reading of ${text}, with its type's label`, () => {
      const parsed = parseConnectionString(text);
      assert.equal(parsed?.type, type);
      assert.deepEqual(answerOf(text), json({ parsed, label }));
    });
  }

  it("marks the ambiguous MongoDB string as the parser does", () => {
    assert.equal(answerOf("mongodb://app:p@ss@db.example/orders").parsed.credentialsAmbiguous, true);
  });

  it("answers a refusal with the refused type's label", () => {
    const text = "databend://app:pa#ss@db.example:8000/shop";
    const parsed = parseConnectionString(text);
    // Precondition: a text the parser refuses.
    assert.ok(parsed !== null && typeof parsed.refusal === "string");
    assert.deepEqual(answerOf(text), json({ parsed, label: CONNECTION_FORM[parsed.type].label }));
  });

  it("answers no reading and no label for a text it cannot read", () => {
    assert.deepEqual(answerOf("hello"), { parsed: null, label: null });
  });
});
