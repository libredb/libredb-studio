import type { AccessRefusal, DriverErrorClassifier } from "@/lib/db/driver-errors/types";

/** MongoDB server codes of an access refusal, from its error codes: 13 `Unauthorized`, 18 `AuthenticationFailed`. */
const MONGODB_ACCESS_REFUSALS: ReadonlyMap<number, AccessRefusal> = new Map([
  [13, "privilege"],
  [18, "credential"],
]);

/** The driver's numeric server `code`, which counts only beside its `codeName`. */
function serverCode(fields: { readonly code?: unknown; readonly codeName?: unknown }): unknown {
  return typeof fields.codeName === "string" ? fields.code : undefined;
}

/** The MongoDB driver's row: a server error carries a numeric `code` beside its `codeName`. */
export const MONGODB_DRIVER_ERRORS = Object.freeze({
  driver: "mongodb",
  accessRefusal: (fields) => {
    const code = serverCode(fields);
    return typeof code === "number" ? MONGODB_ACCESS_REFUSALS.get(code) : undefined;
  },
  carriesCode: (fields) => typeof serverCode(fields) === "number",
} satisfies DriverErrorClassifier);
