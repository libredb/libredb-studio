import { appFetch } from "@/lib/config/base-path";
import { buildConnectionPayload } from "@/hooks/use-connection-payload";
import type { ObjectSourceDocument, ObjectSourceForm, ObjectSourceOrigin } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

/**
 * Who answers a source read, and what a renderer is allowed to believe about the answer (#789).
 *
 * This is its OWN seam and not a fourth member of the tree's `ObjectReadRequest`, which is a
 * measured distinction rather than a preference. That type is paired with a `ReadSlot` whose
 * three kinds each land in a `TreeCache` map, and `isRenderableShape` dispatches on the slot
 * and not on the route; a source document is not an array, it caches nothing, and the surface
 * that wants it is a TAB holding no handle on the tree's private source at all. Adding a fourth
 * member would also oblige the embedded adapter's exhaustive switch to carry an arm for a state
 * the design says cannot occur, which is the deleted 501 in a new place under a coverage gate.
 *
 * The return is `unknown` on purpose, for both shells rather than for the embedded one alone: a
 * route's body and a host callback's return value are both ordinary values this component is
 * about to dereference, and only one of them has a type declaration.
 */
export type ObjectSourceReader = (
  connection: DatabaseConnection,
  path: readonly string[],
  kind: string,
) => Promise<unknown>;

/**
 * The default source: this application's own route.
 *
 * `buildConnectionPayload` sends a managed seed by id and anything else in full, which is how
 * every other db route is called and the only way a connection the server has never heard of
 * can be read at all.
 */
export const httpSourceReader: ObjectSourceReader = async (connection, path, kind) => {
  const response = await appFetch("/api/db/objects/source", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...buildConnectionPayload(connection), path, kind }),
  });
  // A route that answered with no body at all still answered something worth showing, so the
  // status stands in for the sentence rather than the read being reported as a parse error.
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `The source read failed with HTTP ${response.status}`);
  }
  return body;
};

const FORMS: readonly string[] = ["complete", "partial"] satisfies readonly ObjectSourceForm[];
const ORIGINS: readonly string[] = ["stored", "regenerated", "rendered"] satisfies readonly ObjectSourceOrigin[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string that carries a fact, rather than one that is present and says nothing. */
function isFilledString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The truncation mark, checked because the banner DEREFERENCES `reason` and prints it.
 *
 * A mark whose reason is missing would draw an empty warning banner above a text, which is a
 * second spelling of the collapse this whole design exists to prevent: an attention state with
 * nothing in it reads as decoration.
 */
function isTruncationShape(value: unknown): boolean {
  return isRecord(value) && typeof value.limit === "number" && isFilledString(value.reason);
}

function isPartShape(part: unknown): boolean {
  if (!isRecord(part)) return false;
  if (!isFilledString(part.id)) return false;
  if (!isFilledString(part.label)) return false;
  // Both keys at once is the collapse, and it is checked BEFORE either arm is examined,
  // because each arm on its own would accept the part.
  if (Object.hasOwn(part, "unavailable") && Object.hasOwn(part, "text")) return false;
  if (Object.hasOwn(part, "unavailable")) return isFilledString(part.unavailable);
  if (!isFilledString(part.text)) return false;
  if (!isFilledString(part.language)) return false;
  if (!FORMS.includes(part.form as string)) return false;
  if (!ORIGINS.includes(part.origin as string)) return false;
  if (Object.hasOwn(part, "truncated") && !isTruncationShape(part.truncated)) return false;
  return true;
}

/**
 * The client's shape check, and the LIVE home of the invariants the compiler cannot hold.
 *
 * A predicate rather than a boolean, unlike `isRenderableShape`, so the caller narrows instead
 * of casting. Written here because the embedded shell's document comes from a HOST: ordinary
 * JavaScript whose declared return type is not a runtime guarantee. It is live for the
 * standalone route too, where the body is JSON nobody typed.
 *
 * Four of these checks are not about malformed data at all, they are about two facts
 * collapsing into one:
 *   - a part carrying BOTH keys narrows to the refusal and drops the text in silence, and
 *     MEASURED against tsc 6.0.3 our own compiler admits that literal, because TypeScript's
 *     excess-property check on a union accepts any property declared on any member of it;
 *   - a refusal with an empty sentence draws our headline over a blank line, which is the
 *     empty-versus-unreadable collapse this whole design exists to prevent, one level in;
 *   - an empty text is not a definition, and an editor holding one is the DBeaver shape,
 *     measured in its source: an unreadable definition in a WRITABLE editor holding one line;
 *   - a truncation mark with no reason is a warning banner with nothing in it.
 *
 * Two parts sharing one id is rejected for a different reason, and it is the switcher's:
 * `activePartId` addresses a part by id, so two parts under one id make the selection
 * unresolvable and a click on the second tab select the first.
 */
export function isSourceDocumentShape(value: unknown): value is ObjectSourceDocument {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.path) || !value.path.every((segment) => typeof segment === "string")) return false;
  if (typeof value.kind !== "string") return false;
  if (!Array.isArray(value.parts) || value.parts.length === 0) return false;
  if (!value.parts.every(isPartShape)) return false;
  const ids = new Set((value.parts as Record<string, unknown>[]).map((part) => part.id as string));
  if (ids.size !== value.parts.length) return false;
  return true;
}
