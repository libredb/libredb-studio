/**
 * The provider triad's migration DDL leg (spec 7): every type id's provider document carries one `Migration DDL`
 * heading, and the subsection under it names the module's export and links the module, quotes every refusal reason
 * the module can print, and names each shared building block the module uses as one of its fields. A refused row's
 * reason is the part of `refusal` after "Cannot generate table DDL. ", read from `refusal` itself so the check does
 * not trust `reasons` to hold it. A written module's `reasons` is held to its golden text: every refusal line the
 * fixture makes it print ends in one of them, so a refusal the docs must quote cannot be left out of `reasons`.
 *
 * The subsection may wrap its prose, so text is compared with every whitespace run collapsed to one space. It cites
 * no line number: a line moves with every edit above it, and the anchor is the export name.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATION_DDL } from "@/lib/db/migration-ddl";
import * as shared from "@/lib/db/migration-ddl/shared";
import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";
import type { DatabaseType } from "@/lib/types";
import { renderGolden } from "./fixtures";
import { type EngineModule, engineModules, ROOT } from "./modules";

const HEADING = /^(#{2,4}) (?:[0-9.]+ )?Migration DDL$/;
const REFUSAL_PREFIX = "Cannot generate table DDL. ";
const MODULES = engineModules();

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

const collapse = (text: string): string => text.replace(/\s+/g, " ");

/** The `shared.ts` export names whose value is the very object or function one of the spec's fields holds. */
function sharedFields(spec: MigrationDdlSpec): string[] {
  const values: unknown[] = Object.values(spec);
  if (spec.tableDdl === "written" && spec.createTable.kind === "written") {
    values.push(spec.createTable.primaryKey, spec.createTable.foreignKey);
  }
  return Object.entries(shared)
    .filter(([, value]) => values.includes(value))
    .map(([name]) => name);
}

/** What one document gets wrong about its module, each as a sentence naming the type id; [] when nothing. */
function sectionViolations(module: EngineModule, spec: MigrationDdlSpec, text: string): string[] {
  const lines = text.split("\n");
  const headings = headingsOf(lines);
  const own = headings.filter(({ index }) => HEADING.test(lines[index]));
  if (own.length !== 1) return [`${module.id}: ${own.length} "Migration DDL" headings, not one`];
  const [heading] = own;
  const next = headings.find(({ index, level }) => index > heading.index && level <= heading.level);
  const section = collapse(lines.slice(heading.index, next?.index ?? lines.length).join("\n"));
  const violations: string[] = [];
  if (!section.includes(`\`${module.exportName}\``))
    violations.push(`${module.id}: does not name ${module.exportName}`);
  if (!section.includes(`](../../${module.path})`)) violations.push(`${module.id}: does not link ${module.path}`);
  const quoted =
    spec.tableDdl === "refused"
      ? [spec.refusal.slice(spec.refusal.indexOf(REFUSAL_PREFIX) + REFUSAL_PREFIX.length), ...spec.reasons]
      : spec.reasons;
  for (const reason of quoted) {
    if (!section.includes(collapse(reason))) violations.push(`${module.id}: does not quote "${reason}"`);
  }
  for (const name of sharedFields(spec)) {
    if (!section.includes(`\`${name}\``)) violations.push(`${module.id}: does not name ${name}`);
  }
  if (/\.ts:\d/.test(section)) violations.push(`${module.id}: cites a line number`);
  return violations;
}

function docOf(id: string): string {
  return readFileSync(join(ROOT, "docs/providers", `${id}.md`), "utf8");
}

describe("every provider document names its migration DDL", () => {
  test("the registry's engine modules are the whole type-id set", () => {
    expect(MODULES.map(({ id }) => id).sort()).toEqual(Object.keys(MIGRATION_DDL).sort());
  });

  test.each(MODULES.map((module) => [module.id, module] as const))(
    "docs/providers/%s.md matches its module",
    (id, module) => {
      expect(sectionViolations(module, MIGRATION_DDL[id as DatabaseType], docOf(id))).toEqual([]);
    },
  );
});

/** Each `-- <engine>: Cannot ...` line of a key's golden text; the header lines name no refusal. */
function refusalLines(key: string): string[] {
  return renderGolden(key)
    .split("\n")
    .filter((line) => line.startsWith("-- ") && line.includes(": Cannot "));
}

/** The refusal lines that end in none of `reasons`, each once. */
function unlistedRefusals(key: string, reasons: readonly string[]): string[] {
  return [...new Set(refusalLines(key))].filter((line) => !reasons.some((reason) => line.endsWith(reason)));
}

describe("a written module lists every refusal it prints", () => {
  const written = MODULES.filter(({ id }) => MIGRATION_DDL[id as DatabaseType].tableDdl === "written");

  test.each(written.map(({ id }) => [id] as const))("%s", (id) => {
    expect(unlistedRefusals(id, MIGRATION_DDL[id as DatabaseType].reasons)).toEqual([]);
  });

  test("a printed refusal missing from reasons is named, and a module that refuses nothing prints none", () => {
    expect(refusalLines("postgres")).toEqual([]);
    expect(unlistedRefusals("clickhouse", [])).toContain(
      "-- ClickHouse: Cannot add a foreign key. The engine has no foreign-key constraint.",
    );
  });
});

describe("the check fails a planted document by name", () => {
  const db2 = MODULES.find(({ id }) => id === "db2") as EngineModule;
  const redis = MODULES.find(({ id }) => id === "redis") as EngineModule;

  test("the shared building blocks a module uses are found by identity", () => {
    expect(sharedFields(MIGRATION_DDL.postgres)).toContain("BEGIN_COMMIT");
    expect(sharedFields(MIGRATION_DDL.postgres)).toContain("standardPrimaryKey");
    expect(sharedFields(MIGRATION_DDL.oracle)).not.toContain("standardDropIndex");
    expect(sharedFields(MIGRATION_DDL.redis)).toEqual([]);
  });

  test("a missing heading, a second heading and a heading in fenced code are named", () => {
    expect(sectionViolations(redis, MIGRATION_DDL.redis, "# Redis\n")).toEqual([
      'redis: 0 "Migration DDL" headings, not one',
    ]);
    expect(sectionViolations(redis, MIGRATION_DDL.redis, "```\n## Migration DDL\n```\n")).toEqual([
      'redis: 0 "Migration DDL" headings, not one',
    ]);
    expect(sectionViolations(redis, MIGRATION_DDL.redis, `${docOf("redis")}\n### 9.9 Migration DDL\n`)).toEqual([
      'redis: 2 "Migration DDL" headings, not one',
    ]);
  });

  test("a missing export, link, reason, building block and a cited line are named", () => {
    const section = "## Migration DDL\n\nSee `src/lib/db/providers/sql/db2/migration-ddl.ts:12`.\n";
    expect(sectionViolations(db2, MIGRATION_DDL.db2, section)).toEqual([
      "db2: does not name DB2_MIGRATION_DDL",
      `db2: does not link ${db2.path}`,
      `db2: does not quote "${MIGRATION_DDL.db2.reasons[0]}"`,
      "db2: does not name standardAddColumn",
      "db2: does not name standardAddForeignKey",
      "db2: does not name standardColumnDef",
      "db2: does not name standardCreateIndex",
      "db2: does not name standardCreateTableForeignKey",
      "db2: does not name standardDropColumn",
      "db2: does not name standardDropTable",
      "db2: does not name standardPrimaryKey",
      "db2: cites a line number",
    ]);
  });

  test("a refused row's reason is read from its refusal line, and the section ends at the next heading", () => {
    const reason = MIGRATION_DDL.redis.tableDdl === "refused" ? MIGRATION_DDL.redis.refusal : "";
    const section = `## Migration DDL\n\n\`REDIS_MIGRATION_DDL\` in [x](../../${redis.path}).\n\n## Next\n\n${reason}\n`;
    expect(sectionViolations(redis, MIGRATION_DDL.redis, section)).toEqual([
      `redis: does not quote "Keys are not tables and have no column definitions to change."`,
      `redis: does not quote "Keys are not tables and have no column definitions to change."`,
    ]);
  });

  test("a reason wrapped across lines matches with its whitespace collapsed", () => {
    const [reason] = MIGRATION_DDL.db2.reasons;
    const wrapped = reason.replace(" ", "\n  ");
    const section = sectionOf(docOf("db2")).replace(reason, wrapped);
    expect(section).toContain(wrapped);
    expect(sectionViolations(db2, MIGRATION_DDL.db2, section)).toEqual([]);
  });
});

/** The document from its `Migration DDL` heading on. */
function sectionOf(text: string): string {
  const lines = text.split("\n");
  return lines.slice(lines.findIndex((line) => HEADING.test(line))).join("\n");
}
