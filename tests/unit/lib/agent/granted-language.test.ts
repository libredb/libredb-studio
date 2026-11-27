import { describe, expect, test } from "bun:test";
import { grantedAgentLanguage } from "@/lib/agent/granted-language";
import { craftedCatalog, withCatalog } from "../../../helpers/package-catalog";

describe("grantedAgentLanguage", () => {
  test("a legacy engine is read in the statement language its engine record grants", () => {
    expect(grantedAgentLanguage("postgres")).toBe("sql");
    expect(grantedAgentLanguage("kubernetes")).toBe("kubectl");
  });

  test("an engine whose record grants no statement language has none", () => {
    expect(grantedAgentLanguage("bigquery")).toBeNull();
  });

  test("the installed record is what is read, not Studio's tables", async () => {
    const language = await withCatalog(craftedCatalog({ kubernetes: { statementLanguage: "sql" } }), () =>
      grantedAgentLanguage("kubernetes"),
    );

    expect(language).toBe("sql");
  });

  test("a granted language agent mode holds no pack for is refused by name, naming the engine and the language", async () => {
    const read = withCatalog(craftedCatalog({ postgres: { statementLanguage: "acmeql" } }), () =>
      grantedAgentLanguage("postgres"),
    );

    await expect(read).rejects.toThrow(
      'postgres is granted the statement language "acmeql", for which agent mode holds no pack',
    );
  });
});
