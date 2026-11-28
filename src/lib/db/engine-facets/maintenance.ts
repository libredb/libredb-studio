/**
 * The maintenance half of the engine facets contract (FND-4): the check `POST /api/db/maintenance` and
 * `POST /api/db/maintenance/preview` make before they open a session, against the `maintenance` list of the engine's
 * record (`EngineRecord` in src/lib/db/server-catalog.ts), and the one they make after the open, against what the
 * session's server accepts.
 *
 * Both refuse with `FacetNotOfferedError`, answered `400 FACET_NOT_OFFERED`, in a sentence that names the operation,
 * quoted by `quoteTypeId` so a caller's value stays on one line, and the engine, by its record's display name; the
 * error names the record's legacy provider type, none for a provider package's engine.
 */
import { FacetNotOfferedError } from "@/lib/db/errors";
import { type EngineRecord, legacyProviderType } from "@/lib/db/server-catalog";
import { quoteTypeId } from "@/lib/db/type-id";
import type { MaintenanceOperation, ProviderCapabilities } from "@/lib/db/types";

/** The refusal of an operation the engine's record does not list, before any connection. */
export function maintenanceNotOfferedSentence(engine: string, operation: string, offered: readonly string[]): string {
  const offers = offered.length === 0 ? "none" : offered.join(", ");
  return `${operation} is not a maintenance operation LibreDB Studio offers on ${engine}, which offers ${offers}; no connection was opened and nothing was run.`;
}

/** The refusal of an operation the connected server does not accept, after connect. */
export function maintenanceNotAcceptedSentence(engine: string, operation: string, accepted: readonly string[]): string {
  const accepts = accepted.length === 0 ? "none" : accepted.join(", ");
  return `${operation} is not a maintenance operation the ${engine} server this connection reaches accepts, which accepts ${accepts}; nothing was run.`;
}

/**
 * Refuses an operation `engine` does not offer, read from its record's maintenance list before any session opens.
 * Membership is `Array.prototype.includes` on the list, so a prototype key is simply not offered.
 *
 * @throws {FacetNotOfferedError} When the record does not list `operation`.
 */
export function assertMaintenanceOffered(
  engine: EngineRecord,
  operation: string,
): asserts operation is MaintenanceOperation {
  const offered: readonly string[] = engine.maintenance;
  if (offered.includes(operation)) return;
  throw new FacetNotOfferedError(
    maintenanceNotOfferedSentence(engine.displayName, quoteTypeId(operation), offered),
    legacyProviderType(engine),
    "maintenance",
    operation,
  );
}

/**
 * Refuses an operation the session's server does not accept: what the open session accepts, a legacy provider's
 * declaration after connect, which PostgreSQL and MySQL narrow to what the server has (`narrowMaintenance`), or a
 * provider package's narrowed maintenance. A session that reports `supportsMaintenance` false accepts none.
 *
 * @throws {FacetNotOfferedError} When the session does not accept `operation`.
 */
export function assertMaintenanceAccepted(
  engine: EngineRecord,
  operation: MaintenanceOperation,
  accepted: Pick<ProviderCapabilities, "supportsMaintenance" | "maintenanceOperations">,
): void {
  const operations = accepted.supportsMaintenance === true ? accepted.maintenanceOperations : [];
  if (operations.includes(operation)) return;
  throw new FacetNotOfferedError(
    maintenanceNotAcceptedSentence(engine.displayName, quoteTypeId(operation), operations),
    legacyProviderType(engine),
    "maintenance",
    operation,
  );
}
