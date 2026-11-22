/**
 * The trust material a provider was built with, for its TLS (FND-2 slice 4).
 *
 * A provider whose TLS library does not read Node.js's trust store takes the operator's CA certificates from its build
 * context (`ProviderBuildContext.trust` in `../types`), which the provider factory fills from core's read of the file
 * `NODE_EXTRA_CA_CERTS` names. Pure: it reads no environment and no file.
 */
import { DatabaseConfigError } from "../errors";
import type { TrustMaterial } from "../types";

/** The refusal of a provider built without the trust material, by a caller other than the provider factory. */
export const TRUST_MATERIAL_MISSING =
  "This provider was built without the trust material Studio reads from the file NODE_EXTRA_CA_CERTS names, so it dials nothing";

/**
 * The material a provider was built with: `trust` itself, or, when the provider was built without it, a
 * `DatabaseConfigError` with `TRUST_MATERIAL_MISSING`. A provider calls it before it dials a connection that verifies
 * against the system trust store, never at construction, and there is no default material.
 */
export function requireTrustMaterial(trust: TrustMaterial | undefined): TrustMaterial {
  if (trust === undefined) throw new DatabaseConfigError(TRUST_MATERIAL_MISSING);
  return trust;
}
