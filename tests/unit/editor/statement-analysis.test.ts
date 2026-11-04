import { describe, expect, test } from "bun:test";
import type { TypedConfirmationAsk } from "@/lib/db/types";
import { runsAsScript, typedConfirmationExpected } from "@/lib/editor/statement-analysis";

describe("runsAsScript", () => {
  test("a text of more than one statement runs as a script", () => {
    expect(runsAsScript("SELECT 1; SELECT 2", "postgres", "sql")).toBe(true);
  });

  test("one statement written with a separator line runs as a script, which strips the line", () => {
    expect(runsAsScript("SELECT 1\nGO", "mssql", "sql")).toBe(true);
  });

  test("one statement runs on the single-statement route", () => {
    expect(runsAsScript("SELECT 1", "postgres", "sql")).toBe(false);
    expect(runsAsScript("SELECT 1;", "postgres", "sql")).toBe(false);
  });

  test("a type whose vocabulary bounds its console text never runs as a script, whatever language is passed", () => {
    // The web passes "sql" while the provider's metadata is still loading, and the bound is static.
    expect(runsAsScript("SELECT 1; SELECT 2", "kubernetes", "sql")).toBe(false);
  });

  test("a text in a query language other than SQL never runs as a script", () => {
    expect(runsAsScript("SELECT 1; SELECT 2", "mongodb", "json")).toBe(false);
    expect(runsAsScript("SELECT 1; SELECT 2", "postgres", "json")).toBe(false);
  });
});

describe("typedConfirmationExpected", () => {
  const NAME_ASK: TypedConfirmationAsk = { type: "connection-name", targets: ["every key"] };

  test("a text ask expects its own text, whatever the connection is called", () => {
    expect(typedConfirmationExpected({ type: "text", text: "/App/" }, "orders-etcd")).toBe("/App/");
    expect(typedConfirmationExpected({ type: "text", text: "/App/" }, undefined)).toBe("/App/");
  });

  test("a name ask expects the connection's name, exactly as it is written", () => {
    expect(typedConfirmationExpected(NAME_ASK, "orders-etcd")).toBe("orders-etcd");
    expect(typedConfirmationExpected(NAME_ASK, " Orders ")).toBe(" Orders ");
  });

  test("a name ask with an empty name or no name expects nothing, so no field can confirm it", () => {
    expect(typedConfirmationExpected(NAME_ASK, "")).toBeUndefined();
    expect(typedConfirmationExpected(NAME_ASK, undefined)).toBeUndefined();
  });
});
