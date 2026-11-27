/**
 * The names an engine declaration states that only Studio's own tables give meaning to: its explain format, its query
 * dialect, its query language, its Monaco language and its formatter language (docs/providers/CONTRACT.md, M-48, M-50,
 * S-4 and S-23). The SDK's schema admits each by its form alone, so the schema names no engine; Studio holds the
 * membership rule here, on its own side.
 *
 * `unheldNamePointers` is pure and engine-neutral: it reads the tables it is handed (`HeldNames`), never one of
 * Studio's, so admission's import closure stays free of every table keyed by engine id. Boot hands admission Studio's
 * tables (`STUDIO_HELD_NAMES`, src/lib/db/studio-held-names.ts), and the declaration generator holds every legacy
 * declaration to the same tables. Membership is `includes` over a frozen array, so an inherited member of an object
 * (`constructor`, `toString`) is never a held name.
 */
import type { EngineDeclaration } from "@libredb/provider-sdk/manifest";

/** The names Studio holds for each member, each a frozen array. */
export interface HeldNames {
  /** The formats Studio holds an explain strategy for. */
  readonly explainFormats: readonly string[];
  /** The query dialects Studio holds a dialect row for. */
  readonly queryDialects: readonly string[];
  /** The query languages Studio holds a tab type for. */
  readonly queryLanguages: readonly string[];
  /** The Monaco languages Studio holds its own editor code for. */
  readonly monacoLanguages: readonly string[];
  /** The sql-formatter languages Studio's own engines state. */
  readonly formatterLanguages: readonly string[];
}

type Editor = EngineDeclaration["editor"];

/** The members of an engine declaration the check reads. */
export interface NamingEngine {
  readonly editor: {
    readonly explainFormat: Editor["explainFormat"];
    readonly dialect: Editor["dialect"];
    readonly language: Pick<Editor["language"], "queryLanguage" | "monacoId">;
  };
  readonly sqlText: {
    readonly grammar: Pick<EngineDeclaration["sqlText"]["grammar"], "formatterLanguage">;
  };
}

/**
 * The JSON Pointer, relative to the engine, of every name `engine` states that `held` does not hold, in the manifest's
 * member order: the explain format and the dialect only where they are not null, then the query language, the Monaco
 * language and the formatter language.
 */
export function unheldNamePointers(engine: NamingEngine, held: HeldNames): readonly string[] {
  const { explainFormat, dialect, language } = engine.editor;
  const stated: [string | null, readonly string[], string][] = [
    [explainFormat, held.explainFormats, "/editor/explainFormat"],
    [dialect === null ? null : dialect.name, held.queryDialects, "/editor/dialect/name"],
    [language.queryLanguage, held.queryLanguages, "/editor/language/queryLanguage"],
    [language.monacoId, held.monacoLanguages, "/editor/language/monacoId"],
    [engine.sqlText.grammar.formatterLanguage, held.formatterLanguages, "/sqlText/grammar/formatterLanguage"],
  ];
  return stated.filter(([name, names]) => name !== null && !names.includes(name)).map(([, , pointer]) => pointer);
}
