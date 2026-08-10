/**
 * Fail-closed operation registry (#328).
 *
 * Registration is a build-time act and fails loud (typed throw); resolution
 * handles untrusted runtime input and never throws — every lookup returns a
 * typed resolved/denied result with a reason code, so a caller cannot ignore
 * a denial by accident. The registry never guesses: an id that only
 * case/whitespace-normalizes to a registered one is denied as ambiguous
 * rather than helpfully corrected (alias-shaped bypass attempts stay denials).
 */

import type { RegistrableOperationDescriptor } from "./types";

/** Two or more lowercase alphanumeric segments separated by single dots. */
const CANONICAL_ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

const ACCESS_LEVELS: ReadonlySet<unknown> = new Set(["metadata-read", "data-read"]);
const RESOURCE_COSTS: ReadonlySet<unknown> = new Set(["light", "moderate", "heavy"]);

type OperationRegistrationDenyCode =
  | "INVALID_OPERATION_ID"
  | "UNREGISTRABLE_RISK_CLASS"
  | "UNVERIFIED_RISK_CLASS"
  | "MALFORMED_DESCRIPTOR"
  | "DUPLICATE_OPERATION_ID";

type OperationResolutionDenyCode = "UNKNOWN_OPERATION" | "AMBIGUOUS_OPERATION";

type OperationResolution =
  | { readonly kind: "resolved"; readonly descriptor: RegistrableOperationDescriptor }
  | { readonly kind: "denied"; readonly reasonCode: OperationResolutionDenyCode; readonly requestedId: string };

export class OperationRegistrationError extends Error {
  constructor(
    message: string,
    public readonly reasonCode: OperationRegistrationDenyCode,
  ) {
    super(message);
    this.name = "OperationRegistrationError";
    Object.setPrototypeOf(this, OperationRegistrationError.prototype);
  }
}

function isSubstantiveVerification(marker: unknown): boolean {
  if (typeof marker !== "object" || marker === null) return false;
  const { reviewedBy, boundary, verifiedOn } = marker as Record<string, unknown>;
  return [reviewedBy, boundary, verifiedOn].every((field) => typeof field === "string" && field.trim().length > 0);
}

/**
 * Shape checks for callers that bypass the compile-time model. Capability keys
 * are validated as non-empty strings only — an unknown key is not widened away
 * here because the capability stage treats it as unsupported, which fails
 * closed on its own.
 */
function isWellFormed(descriptor: RegistrableOperationDescriptor): boolean {
  const { accessLevel, requiredCapabilities, resourceCost, supportsDryRun, requiresApproval, inputSchema } = descriptor;
  if (!ACCESS_LEVELS.has(accessLevel) || !RESOURCE_COSTS.has(resourceCost)) return false;
  if (typeof supportsDryRun !== "boolean" || typeof requiresApproval !== "boolean") return false;
  if (!Array.isArray(requiredCapabilities)) return false;
  if (!requiredCapabilities.every((key) => typeof key === "string" && key.length > 0)) return false;
  return typeof (inputSchema as { safeParse?: unknown } | undefined)?.safeParse === "function";
}

export class OperationRegistry {
  private readonly descriptors = new Map<string, RegistrableOperationDescriptor>();

  register(descriptor: RegistrableOperationDescriptor): void {
    const { id, riskClass } = descriptor;
    if (typeof id !== "string" || !CANONICAL_ID_PATTERN.test(id)) {
      throw new OperationRegistrationError(
        `Operation id ${JSON.stringify(id)} is not canonical (lowercase dot-separated segments)`,
        "INVALID_OPERATION_ID",
      );
    }
    if (riskClass !== 0 && riskClass !== 1) {
      throw new OperationRegistrationError(
        `Operation "${id}" declares risk class ${String(riskClass)}; classes above 1 have no registrable representation`,
        "UNREGISTRABLE_RISK_CLASS",
      );
    }
    if (riskClass === 1 && !isSubstantiveVerification(descriptor.verification)) {
      throw new OperationRegistrationError(
        `Operation "${id}" is risk class 1 without a substantive verification marker`,
        "UNVERIFIED_RISK_CLASS",
      );
    }
    if (!isWellFormed(descriptor)) {
      throw new OperationRegistrationError(`Operation "${id}" descriptor is malformed`, "MALFORMED_DESCRIPTOR");
    }
    if (this.descriptors.has(id)) {
      throw new OperationRegistrationError(`Operation "${id}" is already registered`, "DUPLICATE_OPERATION_ID");
    }
    // Frozen snapshot: a reference retained by the registering caller must not
    // be able to rewrite policy-relevant fields after registration.
    const requiredCapabilities = Object.freeze([...descriptor.requiredCapabilities]);
    const snapshot: RegistrableOperationDescriptor =
      descriptor.riskClass === 1
        ? { ...descriptor, requiredCapabilities, verification: Object.freeze({ ...descriptor.verification }) }
        : { ...descriptor, requiredCapabilities };
    this.descriptors.set(id, Object.freeze(snapshot));
  }

  resolve(requestedId: string): OperationResolution {
    if (typeof requestedId !== "string") {
      return { kind: "denied", reasonCode: "UNKNOWN_OPERATION", requestedId: String(requestedId) };
    }
    const descriptor = this.descriptors.get(requestedId);
    if (descriptor) return { kind: "resolved", descriptor };
    const normalized = requestedId.trim().toLowerCase();
    if (normalized !== requestedId && this.descriptors.has(normalized)) {
      return { kind: "denied", reasonCode: "AMBIGUOUS_OPERATION", requestedId };
    }
    return { kind: "denied", reasonCode: "UNKNOWN_OPERATION", requestedId };
  }

  // Default (code-point) sort, NOT localeCompare: these are internal operation
  // ids, never user-facing text, and callers depend on the order being identical
  // on every host. localeCompare would tie it to the host locale. S2871 is
  // suppressed for this file in sonar-project.properties for exactly this reason.
  registeredIds(): readonly string[] {
    return [...this.descriptors.keys()].sort();
  }
}
