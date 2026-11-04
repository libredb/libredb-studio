import { consoleTextByteLimit } from "@/lib/db/destructive-commands";
import type { ProviderCapabilities, TypedConfirmationAsk } from "@/lib/db/types";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { isMultiStatement } from "@/lib/sql/statement-splitter";
import type { DatabaseType } from "@/lib/types";

/**
 * What Run does with the editor's text, decided as the web editor decides it, in parts that hold no component, no React
 * and no Monaco, so that a caller outside the browser reads the same answers.
 */

/**
 * Whether Run sends this statement to `POST /api/db/multi-query`, the route that cuts a script into its statements and
 * runs them one by one, rather than to `POST /api/db/query`.
 *
 * Only the statement's own question: a run inside a transaction, with bound params or of an explain never takes the
 * script route, and those conditions stay with the caller, which knows them.
 *
 * Only SQL text is a script. The splitter is a SQL splitter: it cuts on `;` outside quotes. A dialect that is not SQL
 * has no such separator, so every cut it makes there is an invented fragment. Measured on Redis (#427): the generated
 * cheatsheet carried a `;` inside a `#` comment, so the buffer was split, and the first "statement" was comments only -
 * the run failed with "No command to run" and the panel reported a successful empty result. JSON, and PromQL since
 * #1085, whose single expression the splitter would cut at a `;` inside a `#` comment exactly as it cut Redis's, are
 * declared not to be SQL by `queryLanguage`. A type whose vocabulary row declares a console text bound is never SQL
 * either, and that declaration is static, so it holds even where `queryLanguage` is a caller's default: the web editor
 * passes `"sql"` while the provider's metadata is still loading, the window in which that default would send one
 * console text to the splitter.
 *
 * Read under the connection's own dialect, the same record the confirmation gate reads the statement with: whether a
 * `;` is code depends on the engine's comment, quoting and bracket rules, and a fragment this disagrees about is a
 * fragment the route RUNS (S1). The same record says where a procedural body holds its `;` and which line is a script
 * separator (#1312), so a PL/SQL unit alone stays on the single-statement route, and one followed by `/` goes to the
 * route that strips the `/`.
 */
export function runsAsScript(
  statement: string,
  databaseType: DatabaseType,
  queryLanguage: ProviderCapabilities["queryLanguage"],
): boolean {
  return (
    consoleTextByteLimit(databaseType) === undefined &&
    queryLanguage === "sql" &&
    isMultiStatement(statement, resolveSqlGrammar(databaseType))
  );
}

/**
 * The text a typed confirmation is compared with (#1089, section 5.5): the ask's own text, or the connection's name, or
 * undefined where the ask is the name and there is none to type.
 *
 * An empty name is no name: an exact comparison would let an empty field confirm it. The safety dialog answers
 * undefined with a refusal in place of the typed field and a Proceed button that stays disabled.
 */
export function typedConfirmationExpected(
  ask: TypedConfirmationAsk,
  connectionName: string | undefined,
): string | undefined {
  if (ask.type === "text") return ask.text;
  return connectionName === "" ? undefined : connectionName;
}
