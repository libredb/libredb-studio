/**
 * The behaviour-neutral oracle of the dialect registry: every answer a reader of `queryLanguage` and `queryDialect`
 * gives, for every shipped type-id, from the provider's own declared capabilities.
 *
 * `golden-dialect-outputs.json` beside this file is this module's output on the commit before the registry
 * existed, and `tests/isolated/dialect-golden.test.ts` holds today's output to it byte for byte. When a later
 * change means to move an answer, regenerate the file from the base it starts from, with that base's code, and
 * commit it on its own before the change, so the diff of the change shows exactly which answers moved:
 *
 *   bun tests/fixtures/dialect-registry/golden-dialect-outputs.ts > tests/fixtures/dialect-registry/golden-dialect-outputs.json
 *
 * Every provider is built unconnected through the real factory (`tests/helpers/census-connection.ts`), which is
 * why the test that reads this runs under `tests/isolated/`.
 */
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { createDatabaseProvider } from "@/lib/db/factory";
import { offersCodeGeneration, offersColumnProfiling, offersCountQuery } from "@/lib/db/types";
import { editorLanguageForTabType, resolveTabType } from "@/lib/editor/tab-language";
import { generateCountQuery, generateSelectQuery, generateTableQuery } from "@/lib/query-generators";
import type { ColumnSchema } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";

/** Two columns, so a projection has something to name and a Redis key no sampled type. */
const COLUMNS: ColumnSchema[] = [
  { name: "id", type: "int", nullable: false, isPrimary: true },
  { name: "name", type: "string", nullable: true, isPrimary: false },
];

/** A container and an object whose name holds a double quote, which every quoting rule has to spell. */
const PATH = ["c0", 'Order"Items'];

/** A generator's text, or the refusal it throws, so one engine's refusal is an answer and not a failed run. */
function attempt(generate: () => unknown): unknown {
  try {
    return generate();
  } catch (error) {
    return `THROWS ${(error as Error).message.slice(0, 80)}`;
  }
}

/** The oracle's text: one JSON object keyed by type-id, one space of indentation, and a final newline. */
export async function goldenDialectOutputs(): Promise<string> {
  const out: Record<string, unknown> = {};
  const realLog = console.log;
  // The factory logs one line per provider it builds, and the command-line form writes the oracle to stdout.
  console.log = () => undefined;
  try {
    const providers = await Promise.all(
      SHIPPED_DATABASE_TYPES.map((type) => createDatabaseProvider(CENSUS_CONNECTION[type])),
    );
    for (const [index, type] of SHIPPED_DATABASE_TYPES.entries()) {
      const caps = providers[index].getCapabilities();
      const tab = resolveTabType(caps);
      out[type] = {
        queryLanguage: caps.queryLanguage,
        queryDialect: caps.queryDialect ?? null,
        tabType: tab,
        monacoLanguage: editorLanguageForTabType(tab),
        offersColumnProfiling: offersColumnProfiling(caps),
        offersCodeGeneration: offersCodeGeneration(caps),
        offersCountQuery: offersCountQuery(caps),
        tableQuery: attempt(() => generateTableQuery(PATH, caps, COLUMNS, { readOnly: false })),
        selectQuery: attempt(() => generateSelectQuery(PATH, COLUMNS, caps, { readOnly: false })),
        countQuery: attempt(() => generateCountQuery(PATH, caps)),
      };
    }
  } finally {
    console.log = realLog;
  }
  return `${JSON.stringify(out, null, 1)}\n`;
}

if (import.meta.main) {
  process.stdout.write(await goldenDialectOutputs());
  process.exit(0);
}
