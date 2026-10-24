import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CONNECTION_STRING } from "@/lib/db/connection-string";
import { SEED_ONLY_FIELDS } from "@/lib/db/connection-fields";
import type { DatabaseType } from "@/lib/types";

/**
 * The provider triad's connection string leg: every provider document carries one `Connection string` subsection, at
 * whatever level the document's own scheme gives it, and that subsection says what the engine's `CONNECTION_STRING`
 * row declares. The scheme it shows (or that it shows none), each query parameter its `readTls` reads (or that it has
 * no `readTls`), each field its `validateSeed` refuses (or that it runs no seed load check), and each field its
 * `SEED_ONLY_FIELDS` entry refuses on every other engine.
 */

const ROOT = path.resolve(import.meta.dir, "../../../..");
const PROVIDER_DOCS = path.join(ROOT, "docs/providers");

const ENGINES = Object.keys(CONNECTION_STRING) as DatabaseType[];

const HEADING = /^#{2,4} Connection string$/;

/**
 * The query parameters each `readTls` reads, lower-cased as the reader looks them up (the lookup ignores case, so the
 * document may write a driver's own spelling, such as `useSSL` or `TrustServerCertificate`).
 */
const TLS_PARAMS: Readonly<Partial<Record<DatabaseType, readonly string[]>>> = {
  db2: ["security", "ssl"],
  mssql: ["encrypt", "trustservercertificate"],
  mysql: ["ssl-mode", "sslmode", "ssl", "usessl"],
  postgres: ["sslmode", "ssl"],
};

/** The fields snowflake's `validateSeed` refuses, one per check its provider makes before any socket. */
const SNOWFLAKE_SEED_FIELDS = ["host", "user", "authMethod", "privateKey", "password", "role"] as const;

/** The headings outside fenced code, each with its level and line index. */
function headingsOf(lines: readonly string[]): { readonly level: number; readonly index: number }[] {
  const headings: { level: number; index: number }[] = [];
  let fenced = false;
  lines.forEach((line, index) => {
    if (line.startsWith("```")) fenced = !fenced;
    const match = fenced ? null : /^(#{1,6}) /.exec(line);
    if (match !== null) headings.push({ level: match[1].length, index });
  });
  return headings;
}

/** Every `Connection string` subsection of a document, each up to the next heading of the same or a higher level. */
function connectionStringSections(text: string): string[] {
  const lines = text.split("\n");
  const headings = headingsOf(lines);
  return headings
    .filter(({ index }) => HEADING.test(lines[index]))
    .map((heading) => {
      const next = headings.find(({ index, level }) => index > heading.index && level <= heading.level);
      return lines.slice(heading.index, next?.index ?? lines.length).join("\n");
    });
}

/** The words a section writes in backticks, lower-cased. */
function codeSpans(section: string): Set<string> {
  return new Set([...section.matchAll(/`([^`\n]+)`/g)].map((match) => match[1].toLowerCase()));
}

const sectionOf = (type: DatabaseType): string => {
  const sections = connectionStringSections(readFileSync(path.join(PROVIDER_DOCS, `${type}.md`), "utf8"));
  expect(sections).toHaveLength(1);
  return sections[0];
};

describe("each provider document's Connection string subsection", () => {
  test("covers every engine the registry has a row for", () => {
    expect(ENGINES).toHaveLength(43);
  });

  for (const type of ENGINES) {
    describe(type, () => {
      const spec = CONNECTION_STRING[type];

      test("names the scheme it shows, or says it shows none", () => {
        const section = sectionOf(type);
        if (spec.scheme === null) expect(section).toContain("no connection string scheme");
        else expect(section).toContain(`\`${spec.scheme}://\``);
      });

      test("names each query parameter its readTls reads, or says it has none", () => {
        const section = sectionOf(type);
        const params = TLS_PARAMS[type];
        if (spec.readTls === null) {
          expect(params).toBeUndefined();
          expect(section).toContain("no `readTls`");
          return;
        }
        expect(params).toBeDefined();
        const spans = codeSpans(section);
        for (const param of params ?? []) expect(spans.has(param)).toBe(true);
      });

      test("names each field its validateSeed refuses, or says it runs no seed load check", () => {
        const section = sectionOf(type);
        if (spec.validateSeed === null) {
          expect(type).not.toBe("snowflake");
          expect(section).toContain("no seed load check");
          return;
        }
        expect(type).toBe("snowflake");
        const spans = codeSpans(section);
        for (const field of SNOWFLAKE_SEED_FIELDS) expect(spans.has(field.toLowerCase())).toBe(true);
      });

      test("names each field only this engine's provider reads", () => {
        const seedOnly = SEED_ONLY_FIELDS[type];
        if (seedOnly === null) return;
        const spans = codeSpans(sectionOf(type));
        for (const field of seedOnly.fields) expect(spans.has(field.toLowerCase())).toBe(true);
      });
    });
  }

  test("only opcua and elasticsearch declare seed-only fields, so the subsections above name them", () => {
    expect(ENGINES.filter((type) => SEED_ONLY_FIELDS[type] !== null).sort()).toEqual(["elasticsearch", "opcua"]);
  });
});
