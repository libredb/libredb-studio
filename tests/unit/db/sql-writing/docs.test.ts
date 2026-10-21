import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL_WRITING } from "@/lib/db/sql-writing";
import {
  EVERY_TYPE_IS_FLOAT64,
  EXACT_DECIMAL_TYPE_NAMES,
  FLOAT64_TYPE_NAMES,
  INSTANT_TYPE_NAMES,
  NO_BARE_SPELLING,
  NO_EXACT_DECIMAL_TYPE_NAMES,
  NO_INSTANT_TYPE_NAMES,
  NOTHING_STANDS_ALONE,
  NULL_NON_FINITE,
  QUOTED_WORD_NON_FINITE,
  STANDARD_DDL_TYPES,
  VERBATIM_DECLARED_TYPES_STAND_ALONE,
} from "@/lib/db/sql-writing/shared";
import type { DatabaseType } from "@/lib/types";
import { ENGINE_MODULES, ROOT, TYPED_LITERAL_MODULES } from "./engine-modules";

/**
 * Each provider doc says how a generated statement spells that engine's literals, names and
 * binds, so the doc and the module beside the provider cannot drift (the provider triad).
 *
 * The `SQL writing` subsection links the module and names, by function name, the literal
 * writer and reader, the identifier form and the placeholder form the module uses. A `null`
 * placeholder is named as "no placeholder", and a temporal form, where one exists, by its
 * field name.
 *
 * It also names `inlineEdit`, and for each key-column name set either the shared set it
 * holds, by that set's name, or the field itself where the engine states its own set. A
 * `boundEdit`, where one exists, is named too.
 *
 * And it names `export`: the binary literal form by function name, each export fact either
 * by the shared constant it holds or by its field name, `insertForm` where the engine writes
 * `INSERT ... SELECT`, every export hook the engine defines by field name, and the engine's
 * own `typed-literals` sibling by its path, where it has one.
 */
const HEADING = /^(#{2,4}) (?:\d+(?:\.\d+)*\.? +)?SQL writing$/gm;

function subsection(doc: string): string | undefined {
  const matches = [...doc.matchAll(HEADING)];
  if (matches.length !== 1) return undefined;
  const [match] = matches as [RegExpExecArray];
  const level = (match[1] as string).length;
  const rest = doc.slice((match.index as number) + match[0].length);
  const end = rest.search(new RegExp(`^#{1,${level}} `, "m"));
  return end === -1 ? rest : rest.slice(0, end);
}

const modulePath = new Map(ENGINE_MODULES.map((engine) => [engine.id, engine.repoPath]));
const siblingPath = new Map(TYPED_LITERAL_MODULES.map((sibling) => [sibling.ownerId, sibling.repoPath]));
const EXPORT_HOOKS = [
  "typedLiteral",
  "rewriteDeclared",
  "declareFromSample",
  "columnWriters",
  "createTableKey",
] as const;

describe("provider docs name their SQL writing rules", () => {
  for (const type of Object.keys(SQL_WRITING) as DatabaseType[]) {
    const spec = SQL_WRITING[type];
    test(`${type}: one SQL writing subsection naming the module's building blocks`, () => {
      const doc = readFileSync(join(ROOT, "docs", "providers", `${type}.md`), "utf8");
      const section = subsection(doc);
      expect(section).toBeDefined();
      const text = section as string;
      expect(text).toContain(`../../${modulePath.get(type)}`);
      expect(text).toContain(`\`${spec.escapeLiteral.name}\``);
      expect(text).toContain(`\`${spec.unescapeLiteral.name}\``);
      expect(text).toContain(`\`${spec.quoteIdentifier.name}\``);
      if (spec.placeholder === null) {
        expect(text).toContain("no placeholder");
      } else {
        expect(text).toContain(`\`${spec.placeholder.name}\``);
      }
      if (spec.temporalLiteral !== null) expect(text).toContain("`temporalLiteral`");
      expect(text).toContain("`inlineEdit`");
      const { inlineEdit } = spec;
      const sets = [
        [
          "instantTypeNames",
          inlineEdit.instantTypeNames,
          [
            [INSTANT_TYPE_NAMES, "INSTANT_TYPE_NAMES"],
            [NO_INSTANT_TYPE_NAMES, "NO_INSTANT_TYPE_NAMES"],
          ],
        ],
        [
          "float64TypeNames",
          inlineEdit.float64TypeNames,
          [
            [FLOAT64_TYPE_NAMES, "FLOAT64_TYPE_NAMES"],
            [EVERY_TYPE_IS_FLOAT64, "EVERY_TYPE_IS_FLOAT64"],
          ],
        ],
        [
          "exactDecimalTypeNames",
          inlineEdit.exactDecimalTypeNames,
          [
            [EXACT_DECIMAL_TYPE_NAMES, "EXACT_DECIMAL_TYPE_NAMES"],
            [NO_EXACT_DECIMAL_TYPE_NAMES, "NO_EXACT_DECIMAL_TYPE_NAMES"],
          ],
        ],
      ] as const;
      for (const [field, value, shared] of sets) {
        const held = shared.find(([constant]) => value === constant);
        expect(text).toContain(held !== undefined ? `\`${held[1]}\`` : `\`${field}\``);
      }
      if (inlineEdit.boundEdit !== undefined) expect(text).toContain("`boundEdit`");

      expect(text).toContain("`export`");
      const facts = spec.export;
      expect(text).toContain(`\`${facts.binaryLiteral.name}\``);
      const constants = [
        ["ddlTypes", facts.ddlTypes, [[STANDARD_DDL_TYPES, "STANDARD_DDL_TYPES"]]],
        [
          "standsAlone",
          facts.standsAlone,
          [
            [NOTHING_STANDS_ALONE, "NOTHING_STANDS_ALONE"],
            [VERBATIM_DECLARED_TYPES_STAND_ALONE, "VERBATIM_DECLARED_TYPES_STAND_ALONE"],
          ],
        ],
        ["bareSpelling", facts.bareSpelling, [[NO_BARE_SPELLING, "NO_BARE_SPELLING"]]],
        [
          "nonFinite",
          facts.nonFinite,
          [
            [NULL_NON_FINITE, "NULL_NON_FINITE"],
            [QUOTED_WORD_NON_FINITE, "QUOTED_WORD_NON_FINITE"],
          ],
        ],
      ] as const;
      for (const [field, value, shared] of constants) {
        const held = shared.find(([constant]) => value === constant);
        expect(text).toContain(held !== undefined ? `\`${held[1]}\`` : `\`${field}\``);
      }
      if (facts.insertForm === "select") expect(text).toContain("`insertForm`");
      for (const hook of EXPORT_HOOKS) {
        if (facts[hook] !== undefined) expect(text).toContain(`\`${hook}\``);
      }
      const sibling = siblingPath.get(type);
      if (sibling !== undefined) expect(text).toContain(`../../${sibling}`);
    });
  }
});
