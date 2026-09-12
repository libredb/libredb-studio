import { NextRequest, NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import {
  SOURCE_PART_LIMIT,
  containerDepth,
  declaredKinds,
  findKind,
  isSourcePartUnavailable,
  kindHasSource,
  sourceBoundTruncationReason,
} from "@/lib/db/object-kinds";
import { INVENTORY_LIMIT, INVENTORY_PAIR_LIMIT, PAIR_TRUNCATION_REASON } from "@/lib/db/inventory-bounds";
import type {
  DatabaseConnection,
  DatabaseObject,
  DatabaseProvider,
  ObjectDetail,
  ObjectKindSpec,
  ObjectSourceDocument,
  ObjectSourcePart,
} from "@/lib/db/types";

/**
 * Shared request handling for the seven object routes under /api/db/objects (#789).
 *
 * One handler rather than seven copies: the guard-then-parse ordering below is a security
 * property, and seven copies of it would be seven chances for one of them to drift back to
 * parsing first. The seventh, the source read, was built on this handler rather than beside it
 * and inherited auth-before-parse, rate limiting, connection resolution and error mapping with no
 * new line of any of them.
 *
 * `route` is the same string the caller passes for error-response context, so `POST /${route}`
 * reuses it rather than threading a second, guard-specific string through every call site.
 */
export async function handleObjectRequest(
  req: NextRequest,
  route: string,
  run: (provider: DatabaseProvider, body: Record<string, unknown>) => Promise<unknown>,
): Promise<NextResponse> {
  // Ahead of body parsing: an unauthenticated caller never gets a body parsed on its behalf, and
  // the rate limiter sees the request before any work is done for it. Same ordering, and the same
  // reason, as `src/app/api/db/provider-meta/route.ts`.
  const guard = await guardRoute({ route: `POST /${route}`, bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Empty request body" }, { status: 400 });
    }

    if (!body || (typeof body === "object" && Object.keys(body).length === 0)) {
      return NextResponse.json({ error: "Empty request body" }, { status: 400 });
    }

    // The body goes to `resolveConnection` as-is, unlike the schema routes, which also accept a
    // bare connection object AS the whole body. These routes always carry named fields beside the
    // connection (`container`, `kind`, `path`, `term`), so a body that names neither `connection`
    // nor `connectionId` is a caller mistake, and reading it as a connection would turn that
    // mistake into a confusing provider error further down.
    const connection = await resolveConnection(body as ObjectRequestBody, guard.session);

    if (!connection.type) {
      return NextResponse.json({ error: "Valid connection configuration is required" }, { status: 400 });
    }

    const provider = await getOrCreateProvider(connection);
    return NextResponse.json(await run(provider, body));
  } catch (error) {
    if (error instanceof ObjectRouteError) {
      // `{ error }`, the shape this handler's own body-shape refusals above already use.
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return createErrorResponse(error, { route });
  }
}

interface ObjectRequestBody {
  connection?: DatabaseConnection;
  connectionId?: string;
}

/**
 * A refusal this layer decides for itself, rather than one an engine raised.
 *
 * One status uses it, 400: a caller mistake the provider must never be asked to interpret, such as
 * a container deeper than the engine has levels, a kind it does not declare, or a path that is not
 * a path.
 *
 * It carried a 501 as well, for the phase in which the object methods were optional and only some
 * engines implemented them. They are required now, so there is no provider gap left to name and no
 * `requireMethod` to name it with: a guard for a state the type cannot express is an unreachable
 * throw, which is a covered line nothing executes.
 */
class ObjectRouteError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ObjectRouteError";
  }
}

function isStringArray(value: unknown): value is readonly string[] {
  // Every level is walked: `Array.isArray` alone accepts `[null]`, and a null segment would reach
  // a provider as a path segment and be interpolated or bound as one.
  return Array.isArray(value) && value.every((segment) => typeof segment === "string");
}

export function requireStringArray(body: Record<string, unknown>, name: string): readonly string[] {
  const value = body[name];
  if (!isStringArray(value)) {
    throw new ObjectRouteError(`"${name}" must be an array of path segments`, 400);
  }
  return value;
}

export function optionalStringArray(body: Record<string, unknown>, name: string): readonly string[] | undefined {
  return body[name] === undefined ? undefined : requireStringArray(body, name);
}

/**
 * A non-blank string, TRIMMED. Trimming here rather than at each call site is what stops `" table "`
 * reaching one provider's catalog lookup verbatim while the same surrounding space is stripped from
 * a search term two files away.
 */
export function requireString(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ObjectRouteError(`"${name}" must be a non-empty string`, 400);
  }
  return value.trim();
}

/** An object path addresses an object, so an empty one addresses nothing. */
export function requireObjectPath(body: Record<string, unknown>): readonly string[] {
  const path = requireStringArray(body, "path");
  if (path.length === 0) {
    throw new ObjectRouteError(`"path" must name an object, and an empty path names none`, 400);
  }
  return path;
}

export function optionalContainerList(
  body: Record<string, unknown>,
  name: string,
): readonly (readonly string[])[] | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isStringArray)) {
    throw new ObjectRouteError(`"${name}" must be an array of container paths`, 400);
  }
  if (value.length === 0) {
    // Absent, empty and non-empty are three different requests, and the empty one is a mistake.
    // Answering it with `{ objects: [] }` and a 200 would be indistinguishable from an empty
    // database, which is the collapse this whole surface exists to undo.
    throw new ObjectRouteError(
      `"${name}" was given as an empty list, which selects nothing. Omit it to read every container.`,
      400,
    );
  }
  return value;
}

/**
 * The same paths with repeats removed, first occurrence winning.
 *
 * A caller may send the same container twice, and a duplicate costs a full listing round trip per
 * kind. Applied to the enumerated list too, so there is one rule rather than one rule per source.
 */
export function dedupePaths(paths: readonly (readonly string[])[]): readonly (readonly string[])[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = JSON.stringify(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A container path the engine could actually resolve, checked before the provider is called.
 *
 * Only a path DEEPER than the declared depth is refused. A path exactly at the depth is what a
 * caller asking for the level below the last one sends, and PostgreSQL's `listContainers`
 * documents answering `[]` for it as a true statement about the engine rather than a caller
 * mistake, so refusing it here would contradict the provider.
 */
export function assertContainerDepth(provider: DatabaseProvider, name: string, path: readonly string[]): void {
  const depth = containerDepth(provider.getCapabilities());
  if (path.length <= depth) return;
  throw new ObjectRouteError(
    `${provider.type} declares a container depth of ${depth}, and "${name}" has ${path.length} segments: ` +
      `${JSON.stringify(path)}`,
    400,
  );
}

/**
 * The declared kinds, narrowed to the ones the caller asked for.
 *
 * An undeclared kind is a 400 and never an empty result. Answering nothing for `view` on an engine
 * that declares no `view` reads as "this database holds no views", which is a claim about the
 * data; the truth is a claim about the engine.
 */
export function resolveKinds(provider: DatabaseProvider, requested?: readonly string[]): readonly ObjectKindSpec[] {
  const capabilities = provider.getCapabilities();
  if (requested === undefined) return declaredKinds(capabilities);
  return requested.map((id) => {
    const kind = findKind(capabilities, id);
    if (kind === undefined) {
      throw new ObjectRouteError(`${provider.type} declares no object kind "${id}"`, 400);
    }
    return kind;
  });
}

/**
 * The provider's source reader for one kind, or a 400 saying it has none (#789 Phase 2).
 *
 * ONE branch with TWO conjuncts, on purpose. The first is reachable on every engine: a kind that
 * declares no `hasSource` is an ordinary thing to ask for, because a caller can hold a stale menu
 * or a path it built itself. The second is reachable through a provider that declares the kind and
 * omits the method, which `readObjectSource` being optional makes representable and only this
 * check makes visible. Folding them into two `if`s would give the second one a line whose only
 * purpose is a state the first already excluded, which is the shape the deleted 501 arm had.
 *
 * It is a helper here rather than a `throw` in the route for the reason every 400 in this module
 * is: `ObjectRouteError` is module-private, and keeping it private is what keeps the status
 * vocabulary in one file rather than letting each route mint its own.
 *
 * 400 and not 404 or 501, following `resolveKinds`: answering nothing reads as a claim about the
 * DATA when the truth is a claim about the ENGINE.
 *
 * The returned function is BOUND to the provider, because it is read off the instance as a value
 * and a provider method that reaches its own pool through `this` would otherwise be called with
 * no receiver.
 */
export function requireSourceReader(
  provider: DatabaseProvider,
  kind: string,
): (path: readonly string[], kind: string, limit?: number) => Promise<ObjectSourceDocument> {
  const read = provider.readObjectSource;
  if (!kindHasSource(provider.getCapabilities(), kind) || read === undefined) {
    throw new ObjectRouteError(`${provider.type} declares no readable source for kind "${kind}"`, 400);
  }
  return read.bind(provider);
}

/**
 * The answered document under the route's OWN bound (#789 Phase 2).
 *
 * The route ENFORCES rather than trusts, which is the shipped precedent and not a new rule: the
 * inventory route applies its own two bounds on top of the bound it hands `describeObjects`. The
 * callers behind this one are the sixteen providers that implement `readObjectSource`, and the
 * route materialises the whole answer and serialises it in one `NextResponse.json`, so this is the
 * one place a memory bound can actually be held. A number merely PASSED to an implementation is a
 * request, not a bound.
 *
 * CORRECTED after review, because the first version of this paragraph named a caller that cannot
 * reach it. MEASURED: `handleObjectRequest` takes its provider from `getOrCreateProvider`, which
 * resolves through a closed `switch (connection.type)` in `src/lib/db/factory.ts` with no
 * registration point for anyone else, and the embedded shell has no API routes at all, so a host
 * implementing the workspace source seam reads through its own function and never through this
 * module. The bound is here for a PROVIDER defect, which is enough on its own.
 *
 * A provider that bounded correctly is returned unchanged, which is what makes the walk safe to
 * run on every answer. A provider that bounded at its own SMALLER limit is also unchanged, because
 * its text already fits. Only a provider that over-answered is sliced, and its own sentence is
 * KEPT and joined rather than replaced: a second bound is a second fact.
 *
 * `parts.length` is bounded too, because the tuple type has no upper bound and the real response
 * size is `limit` times the part count. `SOURCE_PART_LIMIT` is four times the largest shape any
 * engine in the fleet produces, so no correct provider can reach it and a provider that does is a
 * defect rather than a database fact.
 *
 * The EMPTY document is refused by name rather than left to the destructuring below. `parts` is a
 * non-empty tuple in the type and a JavaScript caller is not held to it, and MEASURED before this
 * guard existed, `parts: []` reached `"unavailable" in part` on `undefined` and raised
 * `TypeError: part is not an Object`, which `createErrorResponse` reports as an unhandled error
 * rather than as the caller's mistake it is.
 */
export function boundSourceDocument(document: ObjectSourceDocument, limit: number): ObjectSourceDocument {
  if (document.parts.length === 0) {
    throw new ObjectRouteError(
      "the source read answered a document with no parts, and a source document names at least one",
      400,
    );
  }
  if (document.parts.length > SOURCE_PART_LIMIT) {
    throw new ObjectRouteError(
      `the source read answered ${document.parts.length} parts and this route carries at most ${SOURCE_PART_LIMIT}`,
      400,
    );
  }
  // Destructured rather than mapped, because `parts` is a NON-EMPTY tuple and `Array.prototype.map`
  // answers a plain array that no longer satisfies it.
  const [first, ...rest] = document.parts;
  return { ...document, parts: [boundPart(first, limit), ...rest.map((part) => boundPart(part, limit))] };
}

/**
 * One part under the bound, and the one malformed shape the bound cannot hold.
 *
 * The hybrid is refused BEFORE the narrowing, and that order is the whole guard. MEASURED against
 * tsc 6.0.3 and recorded on `ObjectSourcePart` itself: a part carrying `unavailable` BESIDE
 * `text`, `language`, `form` and `origin` COMPILES with no cast, because the excess-property check
 * on a union admits any property declared on ANY member of it. `isSourcePartUnavailable` asks
 * `"unavailable" in part`, so such a part narrows to the refusal arm and the line below would
 * return it untouched: MEASURED through this function at a 1,000,000 bound, a hybrid carrying
 * 2,000,000 characters came back with its text whole, 2,000,141 characters of JSON on the wire,
 * while a client narrowing the same way renders a refusal over the definition the engine really
 * returned. `assertObjectSurface` refuses the shape for our own providers, and the check runs only
 * in the provider suites, so this is where the same refusal reaches a running server (#789).
 *
 * A 400 in this module's own vocabulary and not a silent repair. Bounding the text would keep the
 * memory bound and still ship a part that reads as a refusal over a real definition, which is the
 * exact collapse the union exists to prevent.
 *
 * Below it, a refusal carries no text, so there is nothing to bound and nothing to mark. Reading
 * `.text` on one would be a property access on the arm that does not declare it.
 */
function boundPart(part: ObjectSourcePart, limit: number): ObjectSourcePart {
  if (isSourcePartUnavailable(part) && Object.hasOwn(part, "text")) {
    throw new ObjectRouteError(
      "the source read answered a part that carries both a refusal and a text; a refusal and a definition " +
        "are different facts and a reader must never be shown one over the other",
      400,
    );
  }
  if (isSourcePartUnavailable(part) || part.text.length <= limit) return part;
  const reason = sourceBoundTruncationReason(limit);
  return {
    ...part,
    text: part.text.slice(0, limit),
    truncated: { limit, reason: part.truncated === undefined ? reason : `${part.truncated.reason}; ${reason}` },
  };
}

// The four inventory bounds are `src/lib/db/inventory-bounds.ts`'s, and they are re-exported
// here because this route and the agent's grounding walk have to bound one read the same way.
// They were declared in both modules until Task 28a gave them one owner (#789).
export {
  INVENTORY_LIMIT,
  INVENTORY_PAIR_LIMIT,
  INVENTORY_TRUNCATION_REASON,
  PAIR_TRUNCATION_REASON,
} from "@/lib/db/inventory-bounds";

/**
 * Whether one inventory read also carries columns, indexes and foreign keys.
 *
 * `false` and absent are the same request, and the flag is refused rather than coerced when it
 * is anything else: a caller that sent `"true"` meant to ask for columns, and answering the
 * cheap read to a caller who is about to render an empty column list is the silent degradation
 * this surface exists to avoid.
 */
export function optionalBoolean(body: Record<string, unknown>, name: string): boolean {
  const value = body[name];
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new ObjectRouteError(`"${name}" must be true or false`, 400);
  }
  return value;
}

export interface ObjectInventory {
  readonly objects: readonly DatabaseObject[];
  /**
   * Columns, indexes and foreign keys for the objects above, when `includeColumns` asked (#789).
   *
   * A SEPARATE array keyed by `ObjectDetail.path` rather than fields merged onto each object, and
   * that is what keeps the two facts apart: `objects` is what the engine NAMED and `details` is
   * what it could DESCRIBE, and a kind that legitimately has no columns - a routine, a trigger, a
   * sequence on some engines - answers no detail at all rather than an object carrying three
   * empty arrays that a reader cannot tell from a refused read.
   *
   * Absent, not empty, when the caller did not ask. An empty array would say every object was
   * described and none had anything.
   */
  readonly details?: readonly ObjectDetail[];
  /** Absent when the whole inventory fits. Never absent when it did not. */
  readonly truncated?: { readonly limit: number; readonly reason: string };
  /**
   * The container this connection's session is in, where the enumeration could say (#789).
   *
   * It is what the object browser's FLAT reading is a reading of, and so what breaks a tie when a
   * bare flat name answers to two objects in two containers. Absent whenever the walk did not
   * happen or did not say, which includes every call that named its own containers: a default
   * answered from a walk that never ran would be an invention.
   */
  readonly defaultContainer?: readonly string[];
}
