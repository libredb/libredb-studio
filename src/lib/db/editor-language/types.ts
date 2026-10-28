import type * as Monaco from "monaco-editor";
import type { ProviderCapabilities } from "@/lib/db/types";
import type { ConsoleLanguage } from "@/lib/editor/console-language";
import type { SchemaCompletionCache } from "@/lib/editor/sql-completions";
import type { SqlGrammar } from "@/lib/sql/grammar";
import type { DatabaseType } from "@/lib/types";

/** One object of the editor's schema context, as the schema tree hands it to `QueryEditor` in JSON. */
export interface EditorSchemaObject {
  readonly name: string;
  /** The object's address; Cypher completion reads a label or relationship type from its last segment. */
  readonly path?: string[];
  readonly rowCount?: number | null;
  readonly columns?: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly isPrimary?: boolean;
  }>;
}

/** What a language's completion source may read, all of it the editor's own props. */
export interface EditorCompletionContext {
  /** The schema context, pre-computed for the SQL and MongoDB completion sources. */
  readonly schemaCache: SchemaCompletionCache;
  /** The schema context as parsed, for a source that reads paths rather than the SQL cache's names. */
  readonly schemaObjects: readonly EditorSchemaObject[];
  readonly databaseType?: DatabaseType;
  readonly capabilities?: ProviderCapabilities;
}

/**
 * One Monaco language the query editor renders, declared by whoever owns it: the provider whose console language it
 * is, or the shared SQL layer for `sql`. The registry in `./index.ts` collects them, and the editor reads nothing else.
 */
export interface EditorLanguageContribution {
  /** The Monaco language id, which is also this contribution's key in the registry. */
  readonly monacoId: string;
  /**
   * Registers the language with Monaco before an editor mounts; idempotent, since every mount calls it. Absent for a
   * language Monaco ships (`sql`, `json`) and for a console language, which `console` registers instead.
   */
  readonly register?: (monaco: typeof Monaco) => void;
  /**
   * A console dialect's grammar facts and route table, which the registry registers under the dialect's id through
   * the shared console language. The Format button's tooltip also names the dialect from it.
   */
  readonly console?: ConsoleLanguage;
  /**
   * Registers this language's completion source for an editor of it, or answers undefined where the context gives it
   * nothing to complete. The editor disposes the answer when the language or the context changes.
   */
  readonly completions?: (monaco: typeof Monaco, context: EditorCompletionContext) => Monaco.IDisposable | undefined;
  /**
   * What Format writes for the editor's text; absent, the tab has no Format button and the shortcut does nothing.
   * `grammar` is the connection's SQL grammar, which the SQL formatter reads its language from; the others ignore it.
   */
  readonly format?: (text: string, grammar?: SqlGrammar) => string;
  /**
   * The border class an agent answer's statement block takes in this language. Identity, never status: no accent is
   * one of the rail's status hues (amber, rose, emerald), and each stands apart from every other language's.
   */
  readonly accent: string;
}
