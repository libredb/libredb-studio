/**
 * The statement language data the bundled engines' declarations state (`statementLanguageData` of each declaration
 * under `src/lib/db/engine-declarations/`), the null ones left out: the one source the agent's language registries and
 * the operation descriptors read a language declared as data from. Client-safe: it holds data and imports a type only.
 *
 * No declaration states data yet, so the list is empty, and a test holds it equal to the data the committed
 * declarations state. It exists only until the statement language projection lands: the change that gives a
 * declaration its first data generates that projection and points the registries at it in place of this list, which it
 * deletes.
 */
import type { StatementLanguageData } from "@libredb/provider-sdk/manifest";

export const DECLARED_STATEMENT_LANGUAGES: readonly NonNullable<StatementLanguageData>[] = Object.freeze([]);
