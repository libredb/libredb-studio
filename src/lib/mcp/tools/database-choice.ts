import { scopeToCatalog } from "@/lib/db/catalog-scope";
import { DatabaseConfigError } from "@/lib/db/errors";
import type { DatabaseProvider } from "@/lib/db/types";

const LISTED_DATABASES = 50;

/** The `database` argument of both tools that take it (#1530). */
export const DATABASE_ARGUMENT_DESCRIPTION =
  "The database to read, required on a connection that reaches every database on its server and refused on one that names its own.";

/** A database-choice refusal, in Studio's words rather than the engine's (#1530). */
export class McpDatabaseChoiceError extends Error {}

/**
 * The provider one tool call reads, or the provider's own refusal to open the database the call names, which the tool
 * answers as the provider's text behind a notice naming it. Studio's own choice refusals are thrown as
 * `McpDatabaseChoiceError`.
 */
export type McpDatabaseChoice =
  | { readonly kind: "chosen"; readonly provider: DatabaseProvider }
  | { readonly kind: "provider-refused"; readonly error: DatabaseConfigError };

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
    const listed = names.slice(0, LISTED_DATABASES).join(", ");
    const more = names.length > LISTED_DATABASES ? ` and ${names.length - LISTED_DATABASES} more` : "";
    throw new McpDatabaseChoiceError(
      names.length === 0
        ? "This connection reaches every database on its server, and its role can open none of them."
        : `This connection reaches every database on its server; call again with database set to one of: ${listed}${more}.`,
    );
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
