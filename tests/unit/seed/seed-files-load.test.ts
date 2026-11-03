/**
 * Every seed file this repository ships, the fixtures under tests/fixtures/seed-connections and each whole seed file
 * docs/SEED_CONNECTIONS.md shows, loads or is refused exactly as it was before a seed could carry an agent credential.
 * The agent fields are new keys, and no file that sets neither may change outcome: a refine that read them wrongly
 * would refuse a file nobody edited, and with it every connection that file holds.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { SeedConfigSchema } from "@/lib/seed/types";

const ROOT = path.resolve(import.meta.dir, "../../..");
const FIXTURES = path.join(ROOT, "tests/fixtures/seed-connections");

/** The fixtures that are refused on purpose, each by what it tests. A fixture that is not YAML or JSON is not here. */
const REFUSED_ON_PURPOSE: Readonly<Record<string, string>> = {
  "invalid-config.yaml": "a file that breaks the schema's basic rules",
  "kafka-mechanism-reference.yaml": "a SASL mechanism written as a reference",
  "readonly-defaults.yaml": "readOnly in defaults",
  "readonly-reference.yaml": "readOnly written as a reference",
};

/** The fixtures whose text does not parse, on purpose: they test the loader's syntax error, never the schema. */
const NOT_PARSED = new Set(["malformed-alias-config.yaml", "malformed-config.json", "malformed-secret-config.yaml"]);

const fixtures = readdirSync(FIXTURES)
  .filter((name) => !NOT_PARSED.has(name))
  .sort();

/** The YAML blocks of the seed document that are a whole seed file, with a version and a connection list. */
const documentFiles = [
  ...readFileSync(path.join(ROOT, "docs/SEED_CONNECTIONS.md"), "utf8").matchAll(/```yaml\n([\s\S]*?)```/g),
]
  .map((match) => match[1])
  .filter((block) => /^version:/m.test(block) && /^connections:/m.test(block));

describe("the seed files this repository ships", () => {
  it.each(fixtures)("%s loads, or is refused only for the reason it was written for", (name) => {
    const result = SeedConfigSchema.safeParse(parseYaml(readFileSync(path.join(FIXTURES, name), "utf8")));
    expect([name, result.success]).toEqual([name, REFUSED_ON_PURPOSE[name] === undefined]);
  });

  it("finds whole seed files in docs/SEED_CONNECTIONS.md to check", () => {
    expect(documentFiles.length).toBeGreaterThan(5);
  });

  it.each(documentFiles.map((block, index) => [index, block] as const))(
    "the seed document's file %d loads",
    (_index, block) => {
      const result = SeedConfigSchema.safeParse(parseYaml(block));
      expect(result.error?.issues ?? []).toEqual([]);
    },
  );
});
