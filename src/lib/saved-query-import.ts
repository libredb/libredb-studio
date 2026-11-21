import { z } from "zod";
import { UnknownProviderError } from "@/lib/db/errors";
import { typeIdRefusal } from "@/lib/db/type-id";
import type { DatabaseType, SavedQuery } from "@/lib/types";

// This schema loads in the browser. Even Zod's caught eval-capability probe
// violates the app's CSP, so disable JIT before constructing the object schema.
z.config({ jitless: true });

const savedQuerySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  query: z.string(),
  description: z.string().optional(),
  // A type id is imported. Any other value, missing, empty, not text, or text that names a provider this Studio does
  // not have, refuses only its own entry (FND-1): storage keeps such an entry and Export all writes it as stored.
  connectionType: z.unknown().optional(),
  createdAt: z.string().pipe(z.coerce.date()),
  updatedAt: z.string().pipe(z.coerce.date()),
  tags: z.array(z.string()).optional(),
});

/**
 * An entry of a backup that is not imported because its `connectionType` names no provider this Studio has, is
 * missing or empty, or is not text.
 */
export interface RefusedSavedQuery {
  readonly name: string;
  readonly error: UnknownProviderError;
}

/** What a backup imports, and the entries it leaves out, both in file order. */
export interface SavedQueryBackup {
  readonly queries: SavedQuery[];
  readonly refused: readonly RefusedSavedQuery[];
}

/**
 * Validate the complete backup before any query is persisted.
 *
 * An entry whose `connectionType` is a type id is imported. An entry whose `connectionType` names no provider, such as
 * an engine of another Studio, or is missing, empty or not text, is not imported: it is answered in `refused` with the
 * `UnknownProviderError` that gives the reason, and the rest of the backup is imported (FND-1). An entry with any other
 * invalid field refuses the whole backup.
 *
 * @throws {SyntaxError} When the text is not JSON.
 * @throws {z.ZodError} When the backup is not a list of valid entries.
 */
export function parseSavedQueries(text: string): SavedQueryBackup {
  const entries = z.array(savedQuerySchema).parse(JSON.parse(text));
  const queries: SavedQuery[] = [];
  const refused: RefusedSavedQuery[] = [];
  for (const entry of entries) {
    const refusal = typeIdRefusal(entry.connectionType);
    if (refusal === null) {
      // `typeIdRefusal` answers null only for a type id.
      queries.push({ ...entry, connectionType: entry.connectionType as DatabaseType });
    } else {
      refused.push({ name: entry.name, error: new UnknownProviderError(refusal) });
    }
  }
  return { queries, refused };
}
