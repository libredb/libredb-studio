/**
 * Where a type-id's provider triad lives (CLAUDE.md, the provider triad under "Rules & patterns"), in either of the
 * two layouts a provider can have.
 *
 * The legacy layout: code under `src/lib/db/providers/<family>/`, as the file `<type-id>.ts`, the directory
 * `<type-id>/` holding `index.ts`, or a directory `tests/helpers/provider-directory-map.ts` maps to the type-id; the
 * doc `docs/providers/<type-id>.md`; the integration test `tests/integration/db/<type-id>-provider.test.ts`.
 * The package layout: the workspace package `packages/provider-<type-id>/` (packages/README.md, "Provider
 * packages"), with its code under `src/`, its doc `docs/<type-id>.md` and its integration test
 * `tests/integration/<type-id>-provider.test.ts`.
 *
 * Each refusal names the paths it is about, so a failing test says what to add, move or delete:
 * - a type-id lives in exactly one layout, so a package beside any remaining legacy leg is refused, because a move
 *   that left a doc or a test behind would leave two copies to drift apart;
 * - legacy code found in more than one place is refused, because a test that took the first would read the wrong one;
 * - a package serves only the type-id its directory names until the provider manifest can declare several, so a doc
 *   or an integration test for a type-id in any other package is refused;
 * - the agent leg (a non-null `AGENT_STATEMENT_LANGUAGE` row) has a place only in the legacy layout so far,
 *   `src/lib/agent/languages/<language>/engines/<type-id>.ts` beside that language's `client.ts`, so a type-id with
 *   such a row is refused in a package until the change that moves it gives the package a place for it.
 *
 * Every path is absolute, built with `path.join(root, ...)`; messages name repository-relative paths joined with `/`,
 * so they read the same on every platform. The root is a parameter, so a test can run the rules on a planted root.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { AGENT_STATEMENT_LANGUAGE } from "@/lib/db/compatibility";
import type { DatabaseType } from "@/lib/types";
import { workspacePackageDirectories } from "../../scripts/workspace-packages.mjs";
import { PROVIDER_DIRECTORY_MAP } from "./provider-directory-map";

export interface ProviderTriad {
  readonly type: DatabaseType;
  readonly layout: "legacy" | "package";
  /** A file for a flat legacy provider, otherwise a directory. */
  readonly code: string;
  readonly doc: string;
  readonly integrationTest: string;
  /** The overlay module and its language's client module, or null when the type-id speaks no statement language. */
  readonly agent: { readonly overlay: string; readonly client: string } | null;
}

type Segments = readonly string[];

const PROVIDERS: Segments = ["src", "lib", "db", "providers"];

const ONE_TYPE_PER_PACKAGE =
  "a provider package serves only the type-id its directory names until the provider manifest can declare several";

function relative(segments: Segments): string {
  return segments.join("/");
}

function isFile(root: string, segments: Segments): boolean {
  const file = path.join(root, ...segments);
  return existsSync(file) && statSync(file).isFile();
}

function isDirectory(root: string, segments: Segments): boolean {
  const directory = path.join(root, ...segments);
  return existsSync(directory) && statSync(directory).isDirectory();
}

/** Every distinct place the legacy layout holds `type`'s code, by the three routes the module docblock names. */
function legacyCode(root: string, type: DatabaseType): Segments[] {
  const found = new Map<string, Segments>();
  const add = (segments: Segments) => found.set(relative(segments), segments);
  for (const [key, entry] of Object.entries(PROVIDER_DIRECTORY_MAP)) {
    const directory = [...PROVIDERS, ...key.split("/")];
    if (Object.values(entry.byPrefix).includes(type) && isDirectory(root, directory)) add(directory);
  }
  const families = isDirectory(root, PROVIDERS)
    ? readdirSync(path.join(root, ...PROVIDERS)).filter((name) => isDirectory(root, [...PROVIDERS, name]))
    : [];
  for (const family of families) {
    if (isFile(root, [...PROVIDERS, family, `${type}.ts`])) add([...PROVIDERS, family, `${type}.ts`]);
    if (isFile(root, [...PROVIDERS, family, type, "index.ts"])) add([...PROVIDERS, family, type]);
  }
  return [...found.values()];
}

interface Resolution {
  readonly triad: ProviderTriad | null;
  readonly problems: string[];
}

function resolve(root: string, type: DatabaseType): Resolution {
  const problems: string[] = [];
  const packages = workspacePackageDirectories(root);
  const own = ["packages", `provider-${type}`];

  for (const directory of packages.filter((candidate) => candidate !== relative(own))) {
    for (const leg of [
      ["docs", `${type}.md`],
      ["tests", "integration", `${type}-provider.test.ts`],
    ]) {
      if (isFile(root, [...directory.split("/"), ...leg])) {
        problems.push(`${type}: ${directory} holds ${relative(leg)}, but ${ONE_TYPE_PER_PACKAGE}.`);
      }
    }
  }

  const code = legacyCode(root, type);
  const legacyDoc = ["docs", "providers", `${type}.md`];
  const legacyTest = ["tests", "integration", "db", `${type}-provider.test.ts`];
  const language = AGENT_STATEMENT_LANGUAGE[type];
  const missing = (legs: Segments[]) => {
    for (const leg of legs)
      if (!existsSync(path.join(root, ...leg))) problems.push(`${type}: ${relative(leg)} is missing.`);
  };

  if (packages.includes(relative(own))) {
    const legacyLeft = [...code, ...[legacyDoc, legacyTest].filter((leg) => isFile(root, leg))];
    if (legacyLeft.length > 0) {
      problems.push(
        `${type} is in both layouts: ${relative(own)} and the legacy ${legacyLeft.map(relative).join(", ")}. The change that moves a provider deletes its legacy code, doc and integration test.`,
      );
    }
    const packageCode = [...own, "src"];
    const doc = [...own, "docs", `${type}.md`];
    const test = [...own, "tests", "integration", `${type}-provider.test.ts`];
    if (!isDirectory(root, packageCode)) problems.push(`${type}: ${relative(packageCode)} is missing.`);
    missing([doc, test]);
    if (language !== null) {
      problems.push(
        `${type} speaks ${language}, and a provider package has no place for its agent leg yet: keep ${type} in the legacy layout until the change that moves it gives ${relative(own)} one.`,
      );
    }
    return finish(problems, {
      type,
      layout: "package",
      code: path.join(root, ...packageCode),
      doc: path.join(root, ...doc),
      integrationTest: path.join(root, ...test),
      agent: null,
    });
  }

  if (code.length === 0) {
    problems.push(
      `${type} has no code: none of ${relative([...PROVIDERS, "<family>", `${type}.ts`])}, ${relative([...PROVIDERS, "<family>", type, "index.ts"])} or a directory tests/helpers/provider-directory-map.ts maps to it exists.`,
    );
  }
  if (code.length > 1) problems.push(`${type} has code in more than one place: ${code.map(relative).join(", ")}.`);
  missing([legacyDoc, legacyTest]);
  let agent: ProviderTriad["agent"] = null;
  if (language !== null) {
    const engines = ["src", "lib", "agent", "languages", language, "engines"];
    const overlay = [...engines, `${type}.ts`];
    const client = [...engines, "client.ts"];
    missing([overlay, client]);
    agent = { overlay: path.join(root, ...overlay), client: path.join(root, ...client) };
  }
  return finish(problems, {
    type,
    layout: "legacy",
    code: path.join(root, ...(code[0] ?? [])),
    doc: path.join(root, ...legacyDoc),
    integrationTest: path.join(root, ...legacyTest),
    agent,
  });
}

function finish(problems: string[], triad: ProviderTriad): Resolution {
  return { triad: problems.length === 0 ? triad : null, problems };
}

/** `type`'s triad, or an Error whose message lists every problem found for it, one per line. */
export function providerTriad(root: string, type: DatabaseType): ProviderTriad {
  const { triad, problems } = resolve(root, type);
  if (triad === null) throw new Error(problems.join("\n"));
  return triad;
}

/** Every problem of every listed type-id, in order; empty when each one resolves. */
export function providerTriadViolations(root: string, types: readonly DatabaseType[]): string[] {
  return types.flatMap((type) => resolve(root, type).problems);
}
