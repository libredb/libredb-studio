import { NextRequest, NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { containerDepth, declaredKinds, findKind } from "@/lib/db/object-kinds";
import type {
  DatabaseConnection,
  DatabaseObject,
  DatabaseProvider,
  ObjectDetail,
  ObjectKindSpec,
} from "@/lib/db/types";

/**
 * Shared request handling for the six object-tree routes under /api/db/objects (#789).
 *
 * One handler rather than six copies, on the precedent of `src/lib/api/schema-route.ts`: the
 * guard-then-parse ordering below is a security property, and six copies of it would be six
 * chances for one of them to drift back to parsing first.
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

/** The hard ceiling on the objects one inventory read returns. Never a caller parameter (#789). */
export const INVENTORY_LIMIT = 5000;
export const INVENTORY_TRUNCATION_REASON = "inventory limit reached";

/**
 * The hard ceiling on the LISTINGS one inventory read issues, one per container and kind.
 *
 * `INVENTORY_LIMIT` bounds what comes back and does not bound the work done to get it: a body
 * naming fifty thousand container paths buys fifty thousand sequential round trips, each taking a
 * pool client, under a single rate-limit token, and every one of them may legitimately answer zero
 * objects so the object budget never advances. Nothing else in this app limits a request body, so
 * this is the only bound in that path.
 *
 * 1000, which is 142 containers at the seven kinds PostgreSQL declares. It only ever bites on a
 * fan-out of near-empty containers: at any real object density `INVENTORY_LIMIT` is reached first,
 * because 142 containers holding an average of 36 objects already saturates it. That is the
 * amplification this bounds, rather than a claim about how many schemas a database may have.
 */
export const INVENTORY_PAIR_LIMIT = 1000;
export const PAIR_TRUNCATION_REASON = "container and kind pair limit reached";

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
