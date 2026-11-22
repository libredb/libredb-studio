/**
 * The run confirmation mode: who the run routes refuse when a statement needs a confirmation and the request carries
 * none, as `LIBREDB_RUN_CONFIRMATION` sets it (FND-5, docs/API_DOCS.md "Server confirmation of a run").
 *
 * - `advisory`, the default: a request that carries no `confirmation` field runs as it did before the server
 *   classified runs, its answer says `"confirmation": "unconfirmed"`, and one warning is logged. A request that asks
 *   (`"confirmation": "ask"`), which every Studio editor run does, is answered 428 in this mode too.
 * - `required`: a statement that needs a confirmation runs only with a confirmation token the server issued, whoever
 *   sends it.
 *
 * The mode decides who is refused, never what the verdict says: the statement is classified the same way in both.
 *
 * The spellings: trimmed, one pair of matching surrounding quotes stripped (an env file can keep them), then trimmed
 * again and lower-cased, as `ALLOW_CUSTOM_CONNECTIONS` is read. Unset, empty or blank is the documented default. Any
 * other value is refused: `runConfirmationMode` throws a `DatabaseConfigError` with `INVALID_RUN_CONFIRMATION_SETTING`
 * on every call, so a run is never classified under a mode the operator did not write, and the boot preflight
 * (`@/lib/config/run-confirmation-preflight`) refuses the value before a standalone server serves.
 *
 * Read on every call, never kept: the reading is a few string operations, and nothing logs the mode, so there is no
 * line that a later change could contradict.
 */
import { DatabaseConfigError } from "@/lib/db/errors";

export type RunConfirmationMode = "advisory" | "required";

/** The refusal of a value outside the accepted spellings, on every read of the mode. */
export const INVALID_RUN_CONFIRMATION_SETTING = "Invalid LIBREDB_RUN_CONFIRMATION: expected advisory or required";

/** The mode and whether the operator set it, or the value as written when it is none of the accepted spellings. */
export type RunConfirmationSetting =
  | { readonly mode: RunConfirmationMode; readonly source: "default" | "set" }
  | { readonly invalid: string };

/** Trims, then strips one pair of matching surrounding quotes, as an env file may keep them. */
function unquote(raw: string): string {
  const trimmed = raw.trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(trimmed);
  return (quoted ? quoted[2] : trimmed).trim().toLowerCase();
}

/** The setting as written now, for the boot preflight: never throws. */
export function runConfirmationSetting(): RunConfirmationSetting {
  const raw = process.env.LIBREDB_RUN_CONFIRMATION;
  const spelled = unquote(raw ?? "");
  if (spelled === "") return { mode: "advisory", source: "default" };
  if (spelled === "advisory" || spelled === "required") return { mode: spelled, source: "set" };
  return { invalid: raw as string };
}

/** The mode the run routes decide under: throws `INVALID_RUN_CONFIRMATION_SETTING` for a refused setting. */
export function runConfirmationMode(): RunConfirmationMode {
  const setting = runConfirmationSetting();
  if ("invalid" in setting) throw new DatabaseConfigError(INVALID_RUN_CONFIRMATION_SETTING);
  return setting.mode;
}
