/**
 * The maintenance half of the engine facets contract (FND-4): the check `POST /api/db/maintenance` and
 * `POST /api/db/maintenance/preview` make before they build a provider, against the `maintenance` list of the
 * connection's `ENGINE_FACETS` row, and the one they make after connect, against what the connected server accepts.
 *
 * Both refuse with `FacetNotOfferedError`, answered `400 FACET_NOT_OFFERED`, in a sentence that names the operation,
 * quoted by `quoteTypeId` so a caller's value stays on one line, and the engine, by its `CONNECTION_FORM` label.
 *
 * `./index.ts` does not import this module, so a reader of the registry (the base provider, the VS Code child) does
 * not load `connection-form.ts` through it.
 */
import { CONNECTION_FORM } from "@/lib/db/connection-form";
import { FacetNotOfferedError } from "@/lib/db/errors";
import { assertDatabaseType, quoteTypeId, typeIdRow } from "@/lib/db/type-id";
import type { MaintenanceOperation, ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import { engineFacetsFor } from "./index";

/** The refusal of an operation the engine's row does not list, before any connection. */
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
 * Refuses an operation the connection's engine does not offer, read from its `ENGINE_FACETS` row before any provider
 * is built. Membership is `Array.prototype.includes` on the row's list, so a prototype key is simply not offered.
 *
 * @throws {UnknownProviderError} When `type` is absent, not text, or names no provider.
 * @throws {FacetNotOfferedError} When the row does not list `operation`.
 */
export function assertMaintenanceOffered(type: unknown, operation: string): asserts operation is MaintenanceOperation {
  assertDatabaseType(type);
  const offered: readonly string[] = engineFacetsFor(type).maintenance;
  if (offered.includes(operation)) return;
  throw new FacetNotOfferedError(
    maintenanceNotOfferedSentence(typeIdRow(CONNECTION_FORM, type).label, quoteTypeId(operation), offered),
    type,
    "maintenance",
    operation,
  );
}

/**
 * Refuses an operation the connected server does not accept: the provider's declaration after connect, which
 * PostgreSQL and MySQL narrow to what the server has (`narrowMaintenance`). A provider that reports
 * `supportsMaintenance` false accepts none.
 *
 * @throws {FacetNotOfferedError} When the connected provider does not accept `operation`.
 */
export function assertMaintenanceAccepted(
  type: DatabaseType,
  operation: MaintenanceOperation,
  capabilities: Pick<ProviderCapabilities, "supportsMaintenance" | "maintenanceOperations">,
): void {
  const accepted = capabilities.supportsMaintenance === true ? capabilities.maintenanceOperations : [];
  if (accepted.includes(operation)) return;
  throw new FacetNotOfferedError(
    maintenanceNotAcceptedSentence(typeIdRow(CONNECTION_FORM, type).label, quoteTypeId(operation), accepted),
    type,
    "maintenance",
    operation,
  );
}
