import { NextRequest, NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { containerDepth, declaredKinds, findKind } from "@/lib/db/object-kinds";
import { ApiErrorCode } from "@/lib/api/error-codes";
import type { DatabaseConnection, DatabaseObject, DatabaseProvider, ObjectKindSpec } from "@/lib/db/types";

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
      // A 501 carries a code because the tree has to render it as a state of its own, and keying
      // on the HTTP status alone would make that rendering break the first time another status
      // means something else. The 400s stay `{ error }`, the shape this handler's own body-shape
      // refusals above already use.
      return NextResponse.json(
        error.code === undefined
          ? { error: error.message }
          : { error: error.message, code: error.code, statusCode: error.status },
        { status: error.status },
      );
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
 * Two statuses use it. 400 is a caller mistake the provider must never be asked to interpret: a
 * container deeper than the engine has levels, a kind it does not declare, a path that is not a
 * path. 501 is the provider gap: through Phase 1 the four object methods are optional and only
 * some engines implement them, and a 501 naming the method and the engine is the only answer that
 * keeps "this engine has not been migrated yet" apart from "this database holds nothing". An
 * empty 200 would collapse those two, which is the same collapse `KindCount` exists to prevent
 * one level down.
 */
class ObjectRouteError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: ApiErrorCode,
  ) {
    super(message);
    this.name = "ObjectRouteError";
  }
}

/** The four object methods, and nothing else, may be demanded of a provider. */
type ObjectMethod = "listContainers" | "countObjects" | "listObjects" | "describeObject";

/**
 * The provider's implementation of one object method, or a 501 that names both the method and the
 * engine, so the reader of a failed tree knows which of the two facts it is looking at.
 */
export function requireMethod<K extends ObjectMethod>(
  provider: DatabaseProvider,
  method: K,
): NonNullable<DatabaseProvider[K]> {
  const implementation = provider[method];
  if (implementation === undefined) {
    throw new ObjectRouteError(
      `The ${provider.type} provider does not implement ${method} yet (#789). ` +
        `That is a gap in the provider, not an empty database.`,
      501,
      ApiErrorCode.OBJECT_SURFACE_UNIMPLEMENTED,
    );
  }
  return implementation.bind(provider) as NonNullable<DatabaseProvider[K]>;
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
 * Every container that can hold an object, walked one level at a time down to the declared depth.
 *
 * An engine with no container level answers a single empty path rather than an empty list: SQLite
 * and friends address every object by a bare name, so there IS one container to scan and it is the
 * connection itself. An empty list there would inventory nothing at all.
 */
export async function enumerateContainers(provider: DatabaseProvider): Promise<readonly (readonly string[])[]> {
  const depth = containerDepth(provider.getCapabilities());
  if (depth === 0) return [[]];

  const listContainers = requireMethod(provider, "listContainers");
  let level = (await listContainers()).map((container) => container.path);
  for (let below = 1; below < depth; below++) {
    const next: (readonly string[])[] = [];
    for (const parent of level) {
      next.push(...(await listContainers(parent)).map((container) => container.path));
    }
    level = next;
  }
  return level;
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

export interface ObjectInventory {
  readonly objects: readonly DatabaseObject[];
  /** Absent when the whole inventory fits. Never absent when it did not. */
  readonly truncated?: { readonly limit: number; readonly reason: string };
}
