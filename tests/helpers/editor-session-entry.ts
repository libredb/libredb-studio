/**
 * A provider-form entry of the provider factory's editor cache, built for a route test whose stand-in of
 * `getOrCreateEditorSession` (src/lib/db/factory.ts) answers it: the entry that open answers for a record that offers a
 * legacy provider, holding `provider`, with the server catalog's record of the provider's type and the scrub of its
 * connection. It builds a value and makes no call.
 */
import type { CachedSession } from "@/lib/db/factory";
import { providerTextScrub } from "@/lib/db/operations/provider-text";
import { servedEngineRecord } from "@/lib/db/server-catalog";
import type { DatabaseProvider } from "@/lib/db/types";

/** The editor cache's provider-form entry of `provider`, as `getOrCreateEditorSession` answers a legacy record's. */
export function editorEntryOf(provider: DatabaseProvider): CachedSession {
  return {
    opened: { form: "provider", provider, scrub: providerTextScrub(provider.config, "any") },
    engine: servedEngineRecord(provider.type),
    connectionId: provider.config.id,
    frame: provider.config.id,
    lastUsed: Date.now(),
    running: 0,
  };
}
