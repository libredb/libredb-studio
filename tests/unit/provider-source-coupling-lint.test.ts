/**
 * The provider source coupling lint (docs/TOOLCHAIN.md, "Provider source coupling lint").
 *
 * ESLint refuses, in a provider package's source (`packages/provider-*\/src/`, the kit
 * excepted), a read of `process.env`, a call of `process.cwd()`, any value reference to
 * `globalThis` or `global` and any use of `console`, with no exception list and no inline
 * disable. Each case plants a violation in a throwaway root that carries the repository's
 * own eslint.config.mjs, and asserts the rule reports it. The planted lines are copied from
 * today's providers where one exists, each with its origin named by file and enclosing
 * symbol, so the lint is proven against the coupling providers have, not an invented one.
 * The origins are not asserted to still hold the line: the provider moves remove them.
 *
 * ESLint runs once over every planted file in `beforeAll`, and each case reads its file's
 * report from that run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { workspacePackageDirectories } from "../../scripts/workspace-packages.mjs";
import { plantedRoot, REPOSITORY_ROOT, removePlantedRoot, runTool } from "../helpers/planted-package";

const COUPLING_RULES = new Set(["no-restricted-properties", "no-restricted-globals", "no-restricted-imports"]);

function manifest(directory: string): string {
  return `${JSON.stringify({ name: `@libredb/${directory}`, private: true, type: "module" }, null, 2)}\n`;
}

const P = "packages/provider-planted/src";

// From src/lib/db/providers/sql/postgres.ts, PostgresProvider.expireTransaction.
const POSTGRES_WARN = 'console.warn("[Postgres] Transaction timed out, auto-rolling back");';

const PLANTED: Record<string, string> = {
  "packages/provider-planted/package.json": manifest("provider-planted"),
  [`${P}/environment.ts`]: [
    "// From src/lib/db/providers/sql/oracle/index.ts, the OracleProvider constructor.",
    "export function oracleLibDir(): string | undefined {",
    "  const libDir = process.env.ORACLE_CLIENT_LIB_DIR;",
    "  return libDir;",
    "}",
    "// From src/lib/db/providers/platform/kubernetes/connection-options.ts, flag.",
    "export function flag(name: string): string | undefined {",
    "  const value = process.env[name]?.trim().toLowerCase();",
    "  return value;",
    "}",
    "// From src/lib/db/providers/sql/sqlite-worker.ts, workerEnvironment.",
    "export function workerEnvironment(): Record<string, string | undefined> {",
    "  const parent = process.env;",
    "  return { ...parent };",
    "}",
    "// From src/lib/db/providers/sql/bigquery/credential-policy.ts, bigQueryCredentialIo.",
    "export function bigQueryCredentialIo(): { env: Record<string, string | undefined> } {",
    "  return {",
    "    env: process.env,",
    "  };",
    "}",
    "// The destructured form, written for the test.",
    "export function destructured(): Record<string, string | undefined> {",
    "  const { env } = process;",
    "  return env;",
    "}",
    "",
  ].join("\n"),
  [`${P}/working-directory.ts`]: [
    "// No provider calls process.cwd() today, so these lines are written for the test.",
    "export function base(): string {",
    "  const base = process.cwd();",
    "  return base;",
    "}",
    "export function destructured(): string {",
    "  const { cwd } = process;",
    "  return cwd();",
    "}",
    "",
  ].join("\n"),
  [`${P}/global-state.ts`]: [
    "// From src/lib/db/providers/industrial/modbus/agent-pacing.ts, LANES_KEY, LanesHolder and processLanes.",
    'const LANES_KEY = Symbol.for("libredb-studio.modbus-agent-lanes");',
    "type Lane = { readonly next: number };",
    "type LanesHolder = { [LANES_KEY]?: Map<string, Lane> };",
    "export function processLanes(): Map<string, Lane> {",
    "  const holder = globalThis as LanesHolder;",
    "  holder[LANES_KEY] ??= new Map();",
    "  return holder[LANES_KEY];",
    "}",
    "// From src/lib/db/providers/sql/spark/heartbeat.ts, the SparkHeartbeat constructor.",
    "export class Heartbeat {",
    "  constructor(",
    '    private readonly timers: Pick<typeof globalThis, "setInterval" | "clearInterval"> = globalThis,',
    "  ) {}",
    "  stop(handle: ReturnType<typeof setInterval>): void {",
    "    this.timers.clearInterval(handle);",
    "  }",
    "}",
    "// Written for the test.",
    "export function plant(): void {",
    "  (global as unknown as { planted: number }).planted = 1;",
    "}",
    "",
  ].join("\n"),
  [`${P}/global-type.ts`]: 'export type Timers = Pick<typeof globalThis, "setInterval" | "clearInterval">;\n',
  [`${P}/console.ts`]: [
    "export function expireTransaction(): void {",
    `  ${POSTGRES_WARN}`,
    "}",
    "// From src/lib/db/providers/sql/mssql.ts, MSSQLProvider.connect.",
    "export function poolError(error: unknown): void {",
    '  console.error("[MSSQL] Pool error:", error);',
    "}",
    "// The destructured form, written for the test.",
    "export function destructured(): void {",
    "  const { warn } = console;",
    '  warn("planted");',
    "}",
    "",
  ].join("\n"),
  [`${P}/module-imports.ts`]: [
    'import { env } from "node:process";',
    'import { warn } from "node:console";',
    "export function report(): void {",
    "  warn(env.PLANTED);",
    "}",
    "",
  ].join("\n"),
  [`${P}/inline-disable.ts`]: [
    "export function expireTransaction(): void {",
    "  // eslint-disable-next-line no-restricted-globals",
    `  ${POSTGRES_WARN}`,
    "}",
    "",
  ].join("\n"),
  "packages/provider-sdk/package.json": manifest("provider-sdk"),
  "packages/provider-sdk/src/console.ts": `export function expireTransaction(): void {\n  ${POSTGRES_WARN}\n}\n`,
  "packages/provider-kit/package.json": manifest("provider-kit"),
  "packages/provider-kit/src/cli.ts":
    "export function main(): void {\n  console.log(process.env.HOME, process.cwd());\n}\n",
  "packages/provider-planted/tests/environment.test.ts": "console.log(process.env.PLANTED);\n",
  "packages/tooling/package.json": manifest("tooling"),
  "packages/tooling/src/console.ts": `export function expireTransaction(): void {\n  ${POSTGRES_WARN}\n}\n`,
};

/**
 * Every provider package the repository has, the kit excepted, gets a probe of its own in
 * the mirror, so a config entry that exempts one real package fails here by name.
 */
const REPOSITORY_PROVIDER_PACKAGES = workspacePackageDirectories(REPOSITORY_ROOT).filter((directory: string) => {
  const name = directory.slice("packages/".length);
  return name.startsWith("provider-") && name !== "provider-kit";
});

const PROBES: Record<string, string> = {};
for (const directory of REPOSITORY_PROVIDER_PACKAGES) {
  PROBES[`${directory}/package.json`] = manifest(directory.slice("packages/".length));
  PROBES[`${directory}/src/coupling-probe.ts`] = `export function expireTransaction(): void {\n  ${POSTGRES_WARN}\n}\n`;
}

interface LintMessage {
  readonly ruleId: string | null;
  readonly severity: number;
  readonly line: number;
  readonly message: string;
}

interface LintReport {
  readonly filePath: string;
  readonly messages: readonly LintMessage[];
}

let made: string;
let reports: LintReport[];

beforeAll(() => {
  made = plantedRoot({
    copy: ["eslint.config.mjs", "tsconfig.json"],
    workspaces: true,
    files: { ...PLANTED, ...PROBES },
    linkNodeModules: true,
  });
  const run = runTool(made, "eslint/bin/eslint.js", ["packages", "--format", "json"], { timeoutMs: 90_000 });
  reports = JSON.parse(run.stdout);
}, 120_000);

afterAll(() => {
  removePlantedRoot(made);
});

function reportFor(relative: string): LintReport {
  const suffix = path.join(...relative.split("/"));
  const found = reports.filter((report) => report.filePath.endsWith(suffix));
  if (found.length !== 1) throw new Error(`expected one ESLint report for ${relative}, found ${found.length}`);
  return found[0];
}

/** The file's errors, as `[ruleId, line]` pairs. */
function errors(relative: string): [string | null, number][] {
  return reportFor(relative)
    .messages.filter((message) => message.severity === 2)
    .map((message) => [message.ruleId, message.line]);
}

/** The file's coupling-rule messages, of any severity. */
function couplingMessages(relative: string): LintMessage[] {
  return reportFor(relative).messages.filter(
    (message) => message.ruleId !== null && COUPLING_RULES.has(message.ruleId),
  );
}

/** The 1-based line of the planted file that holds `text`, computed so a reordering cannot drift. */
function lineOf(relative: string, text: string): number {
  const lines = PLANTED[relative].split("\n");
  const index = lines.findIndex((line) => line.includes(text));
  if (index === -1 || lines.findIndex((line, at) => at > index && line.includes(text)) !== -1) {
    throw new Error(`expected exactly one line holding ${text} in ${relative}`);
  }
  return index + 1;
}

describe("the provider source coupling lint", () => {
  test("process.env is refused in provider source, in each form a provider reads it today", () => {
    const file = `${P}/environment.ts`;
    expect(errors(file)).toEqual([
      ["no-restricted-properties", lineOf(file, "const libDir = process.env.ORACLE_CLIENT_LIB_DIR;")],
      ["no-restricted-properties", lineOf(file, "const value = process.env[name]")],
      ["no-restricted-properties", lineOf(file, "const parent = process.env;")],
      ["no-restricted-properties", lineOf(file, "env: process.env,")],
      ["no-restricted-properties", lineOf(file, "const { env } = process;")],
    ]);
  });

  test("process.cwd() is refused in provider source", () => {
    const file = `${P}/working-directory.ts`;
    expect(errors(file)).toEqual([
      ["no-restricted-properties", lineOf(file, "const base = process.cwd();")],
      ["no-restricted-properties", lineOf(file, "const { cwd } = process;")],
    ]);
  });

  test("a reference to globalThis or global is refused, the write through an alias a provider makes today included", () => {
    const file = `${P}/global-state.ts`;
    expect(errors(file)).toEqual([
      ["no-restricted-globals", lineOf(file, "const holder = globalThis as LanesHolder;")],
      ["no-restricted-globals", lineOf(file, "= globalThis,")],
      ["no-restricted-globals", lineOf(file, "(global as unknown")],
    ]);
  });

  test("a type-only reference to globalThis is not refused", () => {
    expect(errors(`${P}/global-type.ts`)).toEqual([]);
  });

  test("console is refused in provider source, destructured or not", () => {
    const file = `${P}/console.ts`;
    expect(errors(file)).toEqual([
      ["no-restricted-globals", lineOf(file, POSTGRES_WARN)],
      ["no-restricted-globals", lineOf(file, 'console.error("[MSSQL] Pool error:", error);')],
      ["no-restricted-globals", lineOf(file, "const { warn } = console;")],
    ]);
  });

  test("process and console imported as modules are refused", () => {
    const file = `${P}/module-imports.ts`;
    expect(errors(file)).toEqual([
      ["no-restricted-imports", lineOf(file, 'import { env } from "node:process";')],
      ["no-restricted-imports", lineOf(file, 'import { warn } from "node:console";')],
    ]);
  });

  test("an inline disable comment does not lift a coupling rule", () => {
    const file = `${P}/inline-disable.ts`;
    expect(errors(file)).toEqual([["no-restricted-globals", lineOf(file, POSTGRES_WARN)]]);
  });

  test("every provider package in the repository is covered", () => {
    for (const directory of REPOSITORY_PROVIDER_PACKAGES) {
      expect({ directory, errors: errors(`${directory}/src/coupling-probe.ts`) }).toEqual({
        directory,
        errors: [["no-restricted-globals", 2]],
      });
    }
  });

  test("the SDK's source is covered", () => {
    expect(errors("packages/provider-sdk/src/console.ts")).toEqual([["no-restricted-globals", 2]]);
  });

  test("the kit, a package's tests and a package outside provider-* are not covered", () => {
    expect({
      kit: couplingMessages("packages/provider-kit/src/cli.ts"),
      tests: couplingMessages("packages/provider-planted/tests/environment.test.ts"),
      outside: couplingMessages("packages/tooling/src/console.ts"),
    }).toEqual({ kit: [], tests: [], outside: [] });
  });

  test("each coupling error names where its reason is written", () => {
    const coupling = reports.flatMap((report) =>
      report.messages.filter(
        (message) => message.severity === 2 && message.ruleId !== null && COUPLING_RULES.has(message.ruleId),
      ),
    );
    expect(coupling.length).toBeGreaterThan(0);
    for (const message of coupling) expect(message.message).toContain("docs/TOOLCHAIN.md");
  });

  test("the lint script runs ESLint over the whole tree", () => {
    const scripts = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8")).scripts;
    const commands = String(scripts.lint)
      .split("&&")
      .map((command) => command.trim());
    expect(commands).toContain("eslint .");
  });
});
