/**
 * The names an engine declaration states that Studio must hold (src/lib/provider-host/held-names.ts): its explain
 * format, its query dialect, its query language, its Monaco language and its formatter language. The check is pure
 * and reads only the tables it is handed, so these cases hand it small tables of made-up names.
 */
import { describe, expect, test } from "bun:test";
import { type HeldNames, type NamingEngine, unheldNamePointers } from "@/lib/provider-host/held-names";

const HELD: HeldNames = Object.freeze({
  explainFormats: Object.freeze(["example-plan"]),
  queryDialects: Object.freeze(["exampledialect"]),
  queryLanguages: Object.freeze(["exampleql"]),
  monacoLanguages: Object.freeze(["example-editor"]),
  formatterLanguages: Object.freeze(["exampleformat"]),
});

/** An engine stating every held name, with `change` applied. */
function engine(change: (draft: Draft) => void = () => {}): NamingEngine {
  const draft: Draft = {
    explainFormat: "example-plan",
    dialect: "exampledialect",
    queryLanguage: "exampleql",
    monacoId: "example-editor",
    formatterLanguage: "exampleformat",
  };
  change(draft);
  return {
    editor: {
      explainFormat: draft.explainFormat,
      dialect:
        draft.dialect === null
          ? null
          : {
              name: draft.dialect,
              offersColumnProfiling: false,
              offersCodeGeneration: false,
              offersCountQuery: false,
              offersSqlExport: false,
              historyMask: null,
            },
      language: { queryLanguage: draft.queryLanguage, monacoId: draft.monacoId },
    },
    sqlText: { grammar: { formatterLanguage: draft.formatterLanguage } },
  };
}

interface Draft {
  explainFormat: string | null;
  dialect: string | null;
  queryLanguage: string;
  monacoId: string;
  formatterLanguage: string;
}

describe("unheldNamePointers", () => {
  test("an engine stating only held names has no unheld name", () => {
    expect(unheldNamePointers(engine(), HELD)).toEqual([]);
  });

  test("each member alone that names what Studio does not hold is its one pointer", () => {
    const cases: [(draft: Draft) => void, string][] = [
      [(draft) => (draft.explainFormat = "other-plan"), "/editor/explainFormat"],
      [(draft) => (draft.dialect = "otherdialect"), "/editor/dialect/name"],
      [(draft) => (draft.queryLanguage = "otherql"), "/editor/language/queryLanguage"],
      [(draft) => (draft.monacoId = "other-editor"), "/editor/language/monacoId"],
      [(draft) => (draft.formatterLanguage = "otherformat"), "/sqlText/grammar/formatterLanguage"],
    ];
    for (const [change, pointer] of cases) {
      expect(unheldNamePointers(engine(change), HELD)).toEqual([pointer]);
    }
  });

  test("every unheld name is a pointer, in the manifest's member order", () => {
    const two = engine((draft) => {
      draft.formatterLanguage = "otherformat";
      draft.explainFormat = "other-plan";
    });
    const all = engine((draft) => {
      draft.explainFormat = "other-plan";
      draft.dialect = "otherdialect";
      draft.queryLanguage = "otherql";
      draft.monacoId = "other-editor";
      draft.formatterLanguage = "otherformat";
    });

    expect(unheldNamePointers(two, HELD)).toEqual(["/editor/explainFormat", "/sqlText/grammar/formatterLanguage"]);
    expect(unheldNamePointers(all, HELD)).toEqual([
      "/editor/explainFormat",
      "/editor/dialect/name",
      "/editor/language/queryLanguage",
      "/editor/language/monacoId",
      "/sqlText/grammar/formatterLanguage",
    ]);
  });

  test("an inherited member of an object is never a held name", () => {
    const inherited = engine((draft) => {
      draft.dialect = "constructor";
      draft.queryLanguage = "toString";
      draft.monacoId = "constructor";
      draft.formatterLanguage = "valueOf";
      draft.explainFormat = "constructor";
    });

    expect(unheldNamePointers(inherited, HELD)).toHaveLength(5);
  });

  test("a null explain format and a null dialect state no name, so neither is a pointer", () => {
    const none = engine((draft) => {
      draft.explainFormat = null;
      draft.dialect = null;
    });

    expect(unheldNamePointers(none, HELD)).toEqual([]);
  });
});
