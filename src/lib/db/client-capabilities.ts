import { GRANTED_MASKING_EXEMPT_COLUMNS } from "./claim-grants";
import { typeIdRow } from "./type-id";
import type { ProviderCapabilities } from "./types";
import type { DatabaseType } from "@/lib/types";

/**
 * The capabilities Studio hands on from a built provider: the provider's own, with the masking exemption answered from
 * `GRANTED_MASKING_EXEMPT_COLUMNS`, Studio's grant of it (./claim-grants), and never from the provider's declaration
 * (docs/providers/CONTRACT.md, clauses M-54 and M-57).
 *
 * Where the granted row is null the answer holds no `maskingExemptColumns` at all, the provider's own dropped, so JSON
 * and a strict comparison read it as exempting nothing, exactly as a provider that declares none reads. Every other
 * member is the provider's, and the provider's object is never changed, since a provider may return a frozen constant.
 *
 * Read by `readProviderDeclarations` (./factory), which `POST /api/db/provider-meta` answers the browser with, and by
 * the VS Code backend's `openConnection`. It reads the grant by the connection's type, so a client never reads the
 * grant itself, and a client with no answer yet exempts nothing.
 *
 * @throws {UnknownProviderError} When `type` names no provider, through `typeIdRow`.
 */
export function clientCapabilities(type: DatabaseType, capabilities: ProviderCapabilities): ProviderCapabilities {
  const row = typeIdRow(GRANTED_MASKING_EXEMPT_COLUMNS, type);
  const answered: ProviderCapabilities = { ...capabilities };
  delete answered.maskingExemptColumns;
  if (row !== null) answered.maskingExemptColumns = row;
  return answered;
}
