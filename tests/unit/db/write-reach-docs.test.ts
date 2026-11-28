import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { WRITE_PATHS } from "@/lib/db/write-reach";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";
import { legacyRegisterTable } from "../../helpers/legacy-register";

const writeReach = legacyRegisterTable("writeReach");

/**
 * `docs/DATABASE_PROVIDERS.md` carries one table under `## Write reach`, one row per shipped type-id,
 * `| <engine> | \`<type-id>\` | <value> | <paths> |`, and the row agrees with the write reach of the engine's legacy row
 * in the grant register: the same value, and every gate and proof symbol the provider declares named where the reach
 * is not open.
 */
const PROVIDERS_DOC = join(import.meta.dir, "..", "..", "..", "docs", "DATABASE_PROVIDERS.md");
const TABLE_ROW = /^\| [^|]+ \| `([a-z0-9]+)` \| (none|guarded|open) \| (.+) \|$/;

function writeReachSection(): string[] {
  const lines = readFileSync(PROVIDERS_DOC, "utf8").split("\n");
  const start = lines.indexOf("## Write reach");
  expect(start).toBeGreaterThan(-1);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

function tableRows(): RegExpExecArray[] {
  return writeReachSection()
    .map((line) => TABLE_ROW.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
}

describe("the Write reach table in docs/DATABASE_PROVIDERS.md", () => {
  test("follows the Supported Databases section", () => {
    const headings = readFileSync(PROVIDERS_DOC, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("## "));
    expect(headings.indexOf("## Write reach")).toBe(headings.indexOf("## Supported Databases") + 1);
  });

  test("has one row per shipped type-id, and no other", () => {
    const ids = tableRows().map((row) => row[1]);
    expect(ids.toSorted()).toEqual([...SHIPPED_DATABASE_TYPES].toSorted());
  });

  test.each([...SHIPPED_DATABASE_TYPES])("%s: its value is the legacy row's", (type) => {
    const row = tableRows().find((match) => match[1] === type);
    expect(row?.[2]).toBe(writeReach[type]);
  });

  test.each(SHIPPED_DATABASE_TYPES.filter((type) => writeReach[type] !== "open"))(
    "%s: names every gate and proof its provider declares",
    async (type) => {
      const declared = (await createDatabaseProvider(CENSUS_CONNECTION[type])).getCapabilities().writeReach;
      const paths = tableRows().find((match) => match[1] === type)?.[3] ?? "";
      for (const path of WRITE_PATHS) {
        const reach = declared?.[path];
        const named = reach?.reach === "gated" ? reach.gate : reach?.reach === "absent" ? reach.proof : undefined;
        if (named !== undefined) expect(paths).toContain(`\`${named.symbol}\``);
      }
    },
  );
});

describe("docs/SECURITY.md row 3.8", () => {
  const security = readFileSync(join(import.meta.dir, "..", "..", "..", "docs", "SECURITY.md"), "utf8");
  const row = security.split("\n").find((line) => line.startsWith("| 3.8 |")) ?? "";

  test("states its rule by the grant and points at the Write reach table rather than naming engines", () => {
    expect(row).toContain("on every engine whose granted `policy.writeReach` is `open`");
    expect(row).toContain("](./DATABASE_PROVIDERS.md#write-reach)");
  });

  test("keeps its precondition: the mode is a boundary only on a managed seed whose secret stays on the server", () => {
    expect(security).toContain(
      "**3.8.** Partial for one precondition: the mode is a boundary only on a managed seed, which `resolveConnection` and `resolveServedConnection` re-resolve from the operator's file whatever a caller sends",
    );
  });
});

describe("the engine tables of the READMEs and the Docker Hub listing", () => {
  // Druid, Elasticsearch and OpenSearch refuse a write only in their own grammar, and the editor sends the
  // statement it holds, so no listing may call their IDE read-only while their write reach is open.
  const ROOT = join(import.meta.dir, "..", "..", "..");
  const LISTINGS = readdirSync(ROOT)
    .filter((name) => /^README(_[a-z-]+)?\.md$/i.test(name) || name === "DOCKERHUB.md")
    .sort();
  const LABELS = { druid: "Apache Druid", elasticsearch: "Elasticsearch", opensearch: "OpenSearch" } as const;
  // "Read-only" as each translation writes it.
  const READ_ONLY = [
    "read-only",
    "solo lectura",
    "somente leitura",
    "読み取り専用",
    "읽기 전용",
    "только для чтения",
    "只读",
  ];

  test("covers the English README, at least one translation and the listing", () => {
    expect(LISTINGS).toContain("README.md");
    expect(LISTINGS).toContain("DOCKERHUB.md");
    expect(LISTINGS.length).toBeGreaterThan(2);
  });

  test.each(LISTINGS)("%s: no Druid, Elasticsearch or OpenSearch row says read-only", (name) => {
    const lines = readFileSync(join(ROOT, name), "utf8").split("\n");
    for (const [type, label] of Object.entries(LABELS)) {
      expect(writeReach[type as keyof typeof LABELS]).toBe("open");
      // The first row of that engine is its row in the engine table; padded cells are allowed.
      const row = lines.find((line) => new RegExp(`^\\| \\*\\*${label}\\*\\* *\\|`).test(line));
      expect(row).toBeDefined();
      for (const term of READ_ONLY) expect(row?.toLowerCase()).not.toContain(term);
    }
  });
});
