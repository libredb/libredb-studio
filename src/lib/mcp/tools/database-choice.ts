import { scopeToCatalog } from "@/lib/db/catalog-scope";
import { DatabaseConfigError } from "@/lib/db/errors";
import type { DatabaseProvider } from "@/lib/db/types";
import { databaseContentNotice, type ToolResult } from "../output";

const LISTED_DATABASES = 50;

/** The `database` argument of both tools that take it (#1530). */
export const DATABASE_ARGUMENT_DESCRIPTION =
  "The database to read, required on a connection that reaches every database on its server and refused on one that names its own.";

/** A database-choice refusal, in Studio's words rather than the engine's (#1530). */
export class McpDatabaseChoiceError extends Error {}

/**
 * The provider one tool call reads; the provider's own refusal to open the database the call names, which the tool
 * answers as the provider's text behind a notice naming it; or, on a connection that reaches every database on its
 * server, a call that named none: the databases it could name, which are database content (`databaseRequiredAnswer`).
 * Studio's own choice refusals, which carry no database content, are thrown as `McpDatabaseChoiceError`.
 */
export type McpDatabaseChoice =
  | { readonly kind: "chosen"; readonly provider: DatabaseProvider }
  | { readonly kind: "provider-refused"; readonly error: DatabaseConfigError }
  | {
      readonly kind: "database-required";
      /** The first `LISTED_DATABASES` names the provider listed, as it listed them. */
      readonly listed: readonly string[];
      /** How many more it listed. */
      readonly more: number;
    };

/**
 * The answer to a call that named no database on a connection that reaches every database on its server: Studio's
 * sentence, which holds no database name, then the notice naming `author`, the provider that relayed the names, then
 * the names as one JSON list, so a name is one array element whatever characters it holds.
 */
export function databaseRequiredAnswer(
  choice: Extract<McpDatabaseChoice, { kind: "database-required" }>,
  author: string,
): ToolResult {
  const sentence =
    "This connection reaches every database on its server; call again with database set to one of the databases the last content block lists.";
  const counted =
    choice.more === 0
      ? sentence
      : `${sentence} It lists the first ${choice.listed.length} of ${choice.listed.length + choice.more}.`;
  return {
    content: [
      { type: "text", text: counted },
      { type: "text", text: databaseContentNotice(author) },
      { type: "text", text: JSON.stringify({ databases: choice.listed }) },
    ],
    isError: true,
  };
}

/** The provider one tool call reads: a server-level connection needs `database`, any other refuses it. */
export async function providerInDatabase(
  provider: DatabaseProvider,
  database: string | undefined,
): Promise<McpDatabaseChoice> {
  if (provider.getCapabilities().catalogSessions !== true) {
    if (database === undefined) return { kind: "chosen", provider };
    throw new McpDatabaseChoiceError("This connection reads only the database it names; call again without database.");
  }
  if (database === undefined) {
    const names = (await provider.listContainers()).map((container) => container.name);
    if (names.length === 0) {
      throw new McpDatabaseChoiceError(
        "This connection reaches every database on its server, and its role can open none of them.",
      );
    }
    return {
      kind: "database-required",
      listed: names.slice(0, LISTED_DATABASES),
      more: Math.max(0, names.length - LISTED_DATABASES),
    };
  }
  // Checked here, before the provider is asked, so `scopeToCatalog`'s own refusal of a provider that opens no database
  // by name is never mistaken for the provider's refusal below.
  if (provider.forCatalog === undefined) {
    throw new McpDatabaseChoiceError(
      "This connection reaches every database on its server, and its provider opens none of them by name.",
    );
  }
  try {
    return { kind: "chosen", provider: await scopeToCatalog(provider, database) };
  } catch (error) {
    if (error instanceof DatabaseConfigError) return { kind: "provider-refused", error };
    throw error;
  }
}
