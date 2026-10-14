/**
 * The Apache Spark example of docs/SEED_CONNECTIONS.md is a file a reader can copy: the seed loader's schema accepts
 * it, and the connection it seeds builds the options its channel opens with, the token travelling over TLS.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYAML } from "yaml";
import { buildSparkConnectionOptions } from "@/lib/db/providers/sql/spark/connection-options";
import { SeedConfigSchema } from "@/lib/seed/types";
import type { DatabaseConnection } from "@/lib/types";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const SEEDS = readFileSync(path.join(ROOT, "docs/SEED_CONNECTIONS.md"), "utf8");
const HEADING = "### An Apache Spark connection";
// A named placeholder, never a realistic value: what the loader resolves the token reference to.
const TOKEN = "spark-test-token";

/** The body of the first ```yaml block under `heading`, before the next `### ` heading. */
function yamlBlockUnder(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`no section "${heading}"`);
  const next = text.indexOf("\n### ", start + 1);
  const section = next < 0 ? text.slice(start) : text.slice(start, next);
  const match = /```yaml\n([\s\S]*?)\n```/.exec(section);
  if (match === null) throw new Error(`the section "${heading}" holds no yaml block`);
  return match[1];
}

const BLOCK = yamlBlockUnder(SEEDS, HEADING);

describe("the Apache Spark example of docs/SEED_CONNECTIONS.md", () => {
  test("it loads as a seed file with one spark connection, its token written as a reference", () => {
    // The page's examples are the connections part of a file, written without the file's version line.
    const parsed = SeedConfigSchema.safeParse({ version: "1", ...(parseYAML(BLOCK) as object) });
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data?.connections).toHaveLength(1);
    expect(parsed.data?.connections[0]?.type).toBe("spark");
    expect(parsed.data?.connections[0]?.password).toMatch(/^\$\{SPARK_TOKEN\}$/);
  });

  test("the connection it seeds builds its channel options, with the token over TLS", () => {
    const [seeded] = (parseYAML(BLOCK) as { connections: Array<Record<string, unknown>> }).connections;
    // The loader resolves the token reference before any provider reads the connection.
    const connection = { ...seeded, password: TOKEN } as unknown as DatabaseConnection;
    const options = buildSparkConnectionOptions(connection, { queryTimeout: 60_000 });
    expect(options.token).toBe(TOKEN);
    expect(options.tls).toBeDefined();
    expect([options.catalog, options.namespace]).toStrictEqual(["spark_catalog", ["studio"]]);
  });
});
