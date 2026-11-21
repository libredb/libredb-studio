import { z } from "zod";
import { UnknownProviderError } from "@/lib/db/errors";
import { isDatabaseType, unknownTypeSentence } from "@/lib/db/type-id";
import type { SavedQuery } from "@/lib/types";

// This schema loads in the browser. Even Zod's caught eval-capability probe
// violates the app's CSP, so disable JIT before constructing the object schema.
z.config({ jitless: true });

const savedQuerySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  query: z.string(),
  description: z.string().optional(),
  // A type id is imported. Any other text names a provider this Studio does not have, and refuses only its own entry
  // (FND-1); anything that is not non-empty text refuses the whole backup.
  connectionType: z.string().min(1),
  createdAt: z.string().pipe(z.coerce.date()),
  updatedAt: z.string().pipe(z.coerce.date()),
  tags: z.array(z.string()).optional(),
});

/** An entry of a backup that is not imported because its `connectionType` names no provider this Studio has. */
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
 * An entry whose `connectionType` is a type id is imported. An entry whose `connectionType` is text that names no
 * provider, such as an engine of another Studio, is not imported: it is answered in `refused` with the
 * `UnknownProviderError` that names its type, and the rest of the backup is imported (FND-1). Any other invalid entry,
 * including one whose `connectionType` is missing, empty or not text, refuses the whole backup.
 *
 * @throws {SyntaxError} When the text is not JSON.
 * @throws {z.ZodError} When the backup is not a list of valid entries.
 */
export function parseSavedQueries(text: string): SavedQueryBackup {
  const entries = z.array(savedQuerySchema).parse(JSON.parse(text));
  const queries: SavedQuery[] = [];
  const refused: RefusedSavedQuery[] = [];
  for (const entry of entries) {
    const { connectionType } = entry;
    if (isDatabaseType(connectionType)) {
      queries.push({ ...entry, connectionType });
    } else {
      refused.push({
        name: entry.name,
        error: new UnknownProviderError({
          reason: "unknown",
          typeId: connectionType,
          sentence: unknownTypeSentence(connectionType),
        }),
      });
    }
  }
  return { queries, refused };
}
