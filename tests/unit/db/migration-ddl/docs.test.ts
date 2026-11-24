/**
 * The provider triad's migration DDL leg (spec 7): every type id's provider document carries one `Migration DDL`
 * heading, and the subsection under it names the `migrationDdl` segment and links the engine's declaration, where its
 * migration DDL is declared (docs/providers/CONTRACT.md, clause M-80); links the module of the engine's own migration
 * DDL functions and names each export Studio's migration DDL function table binds from it, where the engine holds one;
 * quotes every refusal reason the row can print; names each shared building block the table binds for it; and names
 * each statement of its transaction wrapper. A refused row's reason is the part of `refusal` after "Cannot generate
 * table DDL. ", read from `refusal` itself so the check does not trust `reasons` to hold it. A written row's `reasons`
 * is held to its golden text: every refusal line the fixture makes it print ends in one of them, so a refusal the docs
 * must quote cannot be left out of `reasons`.
 *
 * The subsection may wrap its prose, so text is compared with every whitespace run collapsed to one space. It cites
 * no line number: a line moves with every edit above it, and the anchors are the segment, the module and its exports.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
const IDS = Object.keys(MIGRATION_DDL) as DatabaseType[];

/** The module of `id`'s own migration DDL functions, or undefined where every function bound for it is shared. */
const moduleOf = (id: string): EngineModule | undefined => MODULES.find((module) => module.id === id);

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

/** The `shared.ts` export names whose value is the very function one of the row's slots holds. */
function sharedFields(spec: MigrationDdlSpec): string[] {
  const values: unknown[] = Object.values(spec);
  if (spec.tableDdl === "written") values.push(...Object.values(spec.createTable));
  return Object.entries(shared)
    .filter(([, value]) => values.includes(value))
    .map(([name]) => name);
}

/** The declaration of `id`, as its provider document links it. */
const declarationOf = (id: string): string => `src/lib/db/engine-declarations/${id}.json`;

/** What one document gets wrong about its engine's migration DDL, each as a sentence naming the type id; [] when nothing. */
function sectionViolations(
  id: string,
  spec: MigrationDdlSpec,
  text: string,
  module: EngineModule | undefined = moduleOf(id),
): string[] {
  const lines = text.split("\n");
  const headings = headingsOf(lines);
  const own = headings.filter(({ index }) => HEADING.test(lines[index]));
  if (own.length !== 1) return [`${id}: ${own.length} "Migration DDL" headings, not one`];
  const [heading] = own;
  const next = headings.find(({ index, level }) => index > heading.index && level <= heading.level);
  const section = collapse(lines.slice(heading.index, next?.index ?? lines.length).join("\n"));
  const violations: string[] = [];
  if (!section.includes("`migrationDdl`")) violations.push(`${id}: does not name migrationDdl`);
  if (!section.includes(`](../../${declarationOf(id)})`)) violations.push(`${id}: does not link ${declarationOf(id)}`);
  if (module !== undefined) {
    if (!section.includes(`](../../${module.path})`)) violations.push(`${id}: does not link ${module.path}`);
    for (const name of module.exportNames) {
      if (!section.includes(`\`${name}\``)) violations.push(`${id}: does not name ${name}`);
    }
  }
  const quoted =
    spec.tableDdl === "refused"
      ? [spec.refusal.slice(spec.refusal.indexOf(REFUSAL_PREFIX) + REFUSAL_PREFIX.length), ...spec.reasons]
      : spec.reasons;
  for (const reason of quoted) {
    if (!section.includes(collapse(reason))) violations.push(`${id}: does not quote "${reason}"`);
  }
  for (const name of sharedFields(spec)) {
    if (!section.includes(`\`${name}\``)) violations.push(`${id}: does not name ${name}`);
  }
  const wrapper = spec.transactionWrapper;
  for (const statement of wrapper === null ? [] : [wrapper.begin, wrapper.commit]) {
    if (!section.includes(`\`${statement}\``)) violations.push(`${id}: does not name ${statement}`);
  }
  return violations;
}

function docOf(id: string): string {
  return readFileSync(join(ROOT, "docs/providers", `${id}.md`), "utf8");
}

/** A module path or an export of a migration DDL function module, as a provider document may cite one. */
const CITED_MODULE = /\]\(\.\.\/\.\.\/(src\/lib\/db\/providers\/[^)]*migration-ddl\.ts)\)/g;
const CITED_EXPORT =
  /`([A-Z][A-Z0-9]*_(?:MIGRATION_DDL|CREATE_TABLE_PRIMARY_KEY|CREATE_TABLE_FOREIGN_KEY|CREATE_TABLE_REFUSAL|COLUMN_DEF|CREATE_INDEX|DROP_INDEX|ADD_FOREIGN_KEY|DROP_FOREIGN_KEY|ADD_COLUMN|DROP_COLUMN|MODIFY_COLUMN|DROP_TABLE))`/g;

/** The module paths and exports `text` cites that no migration DDL function module the registry imports holds. */
function staleCitations(file: string, text: string): string[] {
  const exported = new Set(MODULES.flatMap((module) => module.exportNames));
  const paths = new Set(MODULES.map((module) => module.path));
  return [
    ...[...text.matchAll(CITED_MODULE)]
      .map((match) => match[1])
      .filter((path) => !paths.has(path) || !existsSync(join(ROOT, path)))
      .map((path) => `${file} cites ${path}`),
    ...[...text.matchAll(CITED_EXPORT)]
      .map((match) => match[1])
      .filter((name) => !exported.has(name))
      .map((name) => `${file} cites ${name}`),
  ];
}

describe("every provider document names its migration DDL", () => {
  test("the registry's function modules belong to shipped engines that write table DDL, one module each", () => {
    const ids = MODULES.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => MIGRATION_DDL[id as DatabaseType]?.tableDdl !== "written")).toEqual([]);
  });

  test.each(IDS.map((id) => [id] as const))("docs/providers/%s.md matches its migration DDL", (id) => {
    expect(sectionViolations(id, MIGRATION_DDL[id], docOf(id))).toEqual([]);
  });

  test("every migration DDL module and export a doc cites exists, so no doc cites one the declarations replaced", () => {
    const docs = readdirSync(join(ROOT, "docs/providers")).filter((name) => name.endsWith(".md"));
    expect(docs.flatMap((name) => staleCitations(name, docOf(name.slice(0, -3))))).toEqual([]);
    // Vacuity: a document citing a deleted module or a replaced row export is named.
    expect(
      staleCitations(
        "redis.md",
        "[x](../../src/lib/db/providers/keyvalue/redis-migration-ddl.ts) `REDIS_MIGRATION_DDL` `MYSQL_DROP_INDEX`",
      ),
    ).toEqual([
      "redis.md cites src/lib/db/providers/keyvalue/redis-migration-ddl.ts",
      "redis.md cites REDIS_MIGRATION_DDL",
    ]);
  });
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
  const written = IDS.filter((id) => MIGRATION_DDL[id].tableDdl === "written");

  test.each(written.map((id) => [id] as const))("%s", (id) => {
    expect(unlistedRefusals(id, MIGRATION_DDL[id].reasons)).toEqual([]);
  });

  test("a printed refusal missing from reasons is named, and a module that refuses nothing prints none", () => {
    expect(refusalLines("postgres")).toEqual([]);
    expect(unlistedRefusals("clickhouse", [])).toContain(
      "-- ClickHouse: Cannot add a foreign key. The engine has no foreign-key constraint.",
    );
  });
});

describe("the check fails a planted document by name", () => {
  const db2 = moduleOf("db2") as EngineModule;

  test("the shared building blocks a row runs are found by identity", () => {
    expect(sharedFields(MIGRATION_DDL.postgres)).toContain("standardPrimaryKey");
    expect(sharedFields(MIGRATION_DDL.postgres)).toContain("standardModifyColumn");
    expect(sharedFields(MIGRATION_DDL.oracle)).not.toContain("standardDropIndex");
    expect(sharedFields(MIGRATION_DDL.redis)).toEqual([]);
    expect(moduleOf("postgres")).toBeUndefined();
    expect(db2.exportNames).toEqual(["DB2_DROP_FOREIGN_KEY", "DB2_DROP_INDEX", "DB2_MODIFY_COLUMN"]);
  });

  test("a missing heading, a second heading and a heading in fenced code are named", () => {
    expect(sectionViolations("redis", MIGRATION_DDL.redis, "# Redis\n")).toEqual([
      'redis: 0 "Migration DDL" headings, not one',
    ]);
    expect(sectionViolations("redis", MIGRATION_DDL.redis, "```\n## Migration DDL\n```\n")).toEqual([
      'redis: 0 "Migration DDL" headings, not one',
    ]);
    expect(sectionViolations("redis", MIGRATION_DDL.redis, `${docOf("redis")}\n### 9.9 Migration DDL\n`)).toEqual([
      'redis: 2 "Migration DDL" headings, not one',
    ]);
  });

  test("a missing segment, declaration link, module link, export, reason and building block are named", () => {
    const section = "## Migration DDL\n\nSee `src/lib/db/providers/sql/db2/migration-ddl.ts`.\n";
    expect(sectionViolations("db2", MIGRATION_DDL.db2, section)).toEqual([
      "db2: does not name migrationDdl",
      "db2: does not link src/lib/db/engine-declarations/db2.json",
      `db2: does not link ${db2.path}`,
      "db2: does not name DB2_DROP_FOREIGN_KEY",
      "db2: does not name DB2_DROP_INDEX",
      "db2: does not name DB2_MODIFY_COLUMN",
      `db2: does not quote "${MIGRATION_DDL.db2.reasons[0]}"`,
      "db2: does not name standardAddColumn",
      "db2: does not name standardAddForeignKey",
      "db2: does not name standardColumnDef",
      "db2: does not name standardCreateIndex",
      "db2: does not name standardCreateTableForeignKey",
      "db2: does not name standardDropColumn",
      "db2: does not name standardDropTable",
      "db2: does not name standardPrimaryKey",
    ]);
  });

  test("a wrapper statement the section does not name is named", () => {
    const section = sectionOf(docOf("mssql")).replaceAll("`BEGIN TRANSACTION;`", "BEGIN TRANSACTION;");
    expect(sectionViolations("mssql", MIGRATION_DDL.mssql, section)).toEqual([
      "mssql: does not name BEGIN TRANSACTION;",
    ]);
  });

  test("a refused row's reason is read from its refusal line, and the section ends at the next heading", () => {
    const reason = MIGRATION_DDL.redis.tableDdl === "refused" ? MIGRATION_DDL.redis.refusal : "";
    const section = `## Migration DDL\n\nThe \`migrationDdl\` of [x](../../${declarationOf("redis")}).\n\n## Next\n\n${reason}\n`;
    expect(sectionViolations("redis", MIGRATION_DDL.redis, section)).toEqual([
      `redis: does not quote "Keys are not tables and have no column definitions to change."`,
      `redis: does not quote "Keys are not tables and have no column definitions to change."`,
    ]);
  });

  test("a reason wrapped across lines matches with its whitespace collapsed", () => {
    const [reason] = MIGRATION_DDL.db2.reasons;
    const wrapped = reason.replace(" ", "\n  ");
    const section = sectionOf(docOf("db2")).replace(reason, wrapped);
    expect(section).toContain(wrapped);
    expect(sectionViolations("db2", MIGRATION_DDL.db2, section)).toEqual([]);
  });
});

/** The document from its `Migration DDL` heading on. */
function sectionOf(text: string): string {
  const lines = text.split("\n");
  return lines.slice(lines.findIndex((line) => HEADING.test(line))).join("\n");
}
