/**
 * Writes src/lib/db/providers/network/snmp/mib-objects.ts: the tables, their columns and the scalar groups of the MIB
 * modules the SNMP provider bundles, with each object's syntax, access and status as net-snmp's own parser reads them.
 *
 * The input is `snmptranslate -Td` over every descriptor in `MIB_NAMES`, read on stdin. The object identifiers are
 * not taken from that text: they come from `MIB_NAMES` itself, so the tree has one source for where an object is and
 * this file adds only what an object is.
 *
 * Run, with the SNMP fixture image built (`docker build -t libredb-ci-snmp:test docker/snmp`) and net-snmp 5.9.4's own
 * `mibs/` directory unpacked at $MIBS (the Debian image carries the tools but not the IETF modules):
 *
 *   bun -e 'import {MIB_NAMES} from "./src/lib/db/providers/network/snmp/mib-names.ts";
 *     console.log([...MIB_NAMES.keys()].join("\n"))' > names.txt
 *   docker run --rm -v "$MIBS":/mibs:ro -v "$PWD/names.txt":/names.txt:ro libredb-ci-snmp:test sh -c \
 *     'snmptranslate -M /mibs -m SNMPv2-MIB:IF-MIB:IP-MIB:TCP-MIB:UDP-MIB:SNMP-FRAMEWORK-MIB:HOST-RESOURCES-MIB \
 *      -IR -Td -OS $(cat /names.txt)' | bun scripts/generate-snmp-mib-objects.ts
 *   bunx biome format --write src/lib/db/providers/network/snmp/mib-objects.ts
 *
 * The output is committed and never edited by hand.
 */
import { writeFileSync } from "node:fs";
import { posix } from "node:path";
import { MIB_NAMES } from "../src/lib/db/providers/network/snmp/mib-names";

const OUTPUT = posix.join(
  import.meta.dirname.replaceAll("\\", "/"),
  "../src/lib/db/providers/network/snmp/mib-objects.ts",
);

/** One `snmptranslate -Td` block, reduced to the clauses the catalog reads. */
export interface Definition {
  readonly name: string;
  readonly module: string;
  readonly textualConvention?: string;
  readonly syntax?: string;
  readonly access?: string;
  readonly status?: string;
  readonly index?: readonly string[];
  readonly augments?: string;
}

const clause = (lines: readonly string[], label: string): string | undefined => {
  const line = lines.find((candidate) => candidate.startsWith(`  ${label}\t`) || candidate.startsWith(`  ${label} `));
  return line?.slice(label.length + 2).trim();
};

const braced = (text: string): string[] =>
  text
    .replace(/^\{|\}$/g, "")
    .split(",")
    .map((part) => part.trim().replace(/^IMPLIED\s+/, ""))
    .filter((part) => part !== "");

/** The SYNTAX clause without its range, size or enumeration: `OCTET STRING (0..255)` reads `OCTET STRING`. */
const baseOf = (syntax: string): string => syntax.split(/\s[({]/)[0].trim();

export function parseDefinitions(text: string): Definition[] {
  const definitions: Definition[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const header = lines.findIndex((line) => /^[A-Za-z0-9-]+::[A-Za-z0-9-]+$/.test(line));
    if (header === -1) continue;
    const [module, name] = lines[header].split("::");
    const body = lines.slice(header + 1);
    const tc = body.find((line) => line.startsWith("  -- TEXTUAL CONVENTION "));
    const syntax = clause(body, "SYNTAX");
    const index = clause(body, "INDEX");
    const augments = clause(body, "AUGMENTS");
    definitions.push({
      name,
      module: clause(body, "-- FROM") ?? module,
      ...(tc === undefined ? {} : { textualConvention: tc.slice("  -- TEXTUAL CONVENTION ".length).trim() }),
      ...(syntax === undefined ? {} : { syntax: baseOf(syntax) }),
      ...(clause(body, "MAX-ACCESS") === undefined ? {} : { access: clause(body, "MAX-ACCESS") }),
      ...(clause(body, "STATUS") === undefined ? {} : { status: clause(body, "STATUS") }),
      ...(index === undefined ? {} : { index: braced(index) }),
      ...(augments === undefined ? {} : { augments: braced(augments)[0] }),
    });
  }
  return definitions;
}

const oidOf = (name: string): readonly number[] => {
  const oid = MIB_NAMES.get(name);
  if (oid === undefined) throw new Error(`${name} is not in MIB_NAMES`);
  return oid;
};

const parentKey = (oid: readonly number[]): string => oid.slice(0, -1).join(".");

/** The module text for `definitions`. Throws on anything the catalog cannot place, rather than dropping it. */
export function renderMibObjects(definitions: readonly Definition[]): string {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const byOid = new Map(definitions.map((definition) => [oidOf(definition.name).join("."), definition]));
  const entries = definitions.filter(
    (definition) => definition.index !== undefined || definition.augments !== undefined,
  );
  const entryKeys = new Set(entries.map((entry) => oidOf(entry.name).join(".")));
  const tableKeys = new Set(entries.map((entry) => parentKey(oidOf(entry.name))));

  const objectTypes = definitions.filter(
    (definition) => definition.access !== undefined && definition.syntax !== undefined,
  );
  const column = (definition: Definition) => ({
    name: definition.name,
    subId: oidOf(definition.name).at(-1),
    syntax: definition.textualConvention ?? definition.syntax,
    ...(definition.textualConvention === undefined ? {} : { baseSyntax: definition.syntax }),
    access: definition.access,
    ...(definition.status === "current" ? {} : { status: definition.status }),
  });
  const sortBySubId = <T extends { subId: number | undefined }>(items: T[]): T[] =>
    items.sort((a, b) => (a.subId as number) - (b.subId as number));

  const tables = entries.map((entry) => {
    const table = byOid.get(parentKey(oidOf(entry.name)));
    if (table === undefined) throw new Error(`${entry.name} has no table above it`);
    const indexSource = entry.augments === undefined ? entry : byName.get(entry.augments);
    if (indexSource?.index === undefined)
      throw new Error(`${entry.name} augments ${entry.augments}, which has no INDEX`);
    const entryKey = oidOf(entry.name).join(".");
    return {
      name: table.name,
      module: table.module,
      entry: entry.name,
      index: indexSource.index,
      ...(entry.augments === undefined ? {} : { augments: entry.augments }),
      ...(table.status === undefined || table.status === "current" ? {} : { status: table.status }),
      columns: sortBySubId(
        objectTypes.filter((candidate) => parentKey(oidOf(candidate.name)) === entryKey).map(column),
      ),
    };
  });

  const groups = new Map<string, Definition[]>();
  for (const scalar of objectTypes) {
    const key = parentKey(oidOf(scalar.name));
    if (entryKeys.has(key) || tableKeys.has(key)) continue;
    groups.set(key, [...(groups.get(key) ?? []), scalar]);
  }
  const scalarGroups = [...groups.entries()].map(([key, scalars]) => {
    const group = byOid.get(key);
    if (group === undefined) throw new Error(`${scalars[0].name} has no group above it in MIB_NAMES`);
    return { name: group.name, module: group.module, scalars: sortBySubId(scalars.map(column)) };
  });

  const byOidOrder = <T extends { name: string }>(items: T[]): T[] =>
    items.sort((a, b) => {
      const left = oidOf(a.name);
      const right = oidOf(b.name);
      for (let i = 0; i < Math.min(left.length, right.length); i += 1)
        if (left[i] !== right[i]) return left[i] - right[i];
      return left.length - right.length;
    });

  return [
    "// GENERATED FILE - do not edit. Run: see scripts/generate-snmp-mib-objects.ts",
    "/**",
    " * The tables, columns and scalar groups of the bundled MIB modules, read by net-snmp 5.9.4's `snmptranslate -Td`",
    " * from net-snmp 5.9.4's own copies of the modules `BUNDLED` in `./mib` names. Object identifiers are not repeated",
    " * here: a table's comes from `MIB_NAMES`, and a column's is its entry's followed by `subId`.",
    " */",
    'import type { MibScalarGroup, MibTable } from "./mib-tree";',
    "",
    `export const MIB_TABLES: readonly MibTable[] = ${JSON.stringify(byOidOrder(tables), null, 2)};`,
    "",
    `export const MIB_SCALAR_GROUPS: readonly MibScalarGroup[] = ${JSON.stringify(byOidOrder(scalarGroups), null, 2)};`,
    "",
  ].join("\n");
}

if (import.meta.main) {
  const input = await new Response(Bun.stdin.stream()).text();
  writeFileSync(OUTPUT, renderMibObjects(parseDefinitions(input)));
  console.log(`wrote ${OUTPUT}`);
}
