import { NextRequest, NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { resolveConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import {
  SOURCE_PART_LIMIT,
  applySourceBound,
  containerDepth,
  declaredKinds,
  findKind,
  isSourcePartUnavailable,
  kindAcceptsSourceEdits,
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
  ProviderCapabilities,
} from "@/lib/db/types";
import type { ApiErrorCode } from "@/lib/api/error-codes";

/**
 * Shared request handling for the nine object routes under /api/db/objects (#789).
 *
 * One handler rather than nine copies: the guard-then-parse ordering below is a security
 * property, and nine copies of it would be nine chances for one of them to drift back to
 * parsing first. The seventh, the source read, was built on this handler rather than beside it
 * and inherited auth-before-parse, rate limiting, connection resolution and error mapping with no
 * new line of any of them. The eighth and ninth, the edit plan and the edit apply, are Phase 3's
 * and were built the same way. SEVEN became NINE with the count's own basis, which is the route
 * directories under `src/app/api/db/objects/`, and not as a bare digit: `src/lib/api/rate-limit.ts`
 * carries the same census and moved in the same commit. All nine directories exist: this sentence
 * used to say seven of them did, because the count moved before the last two routes landed.
 *
 * `route` is the same string the caller passes for error-response context, so `POST /${route}`
 * reuses it rather than threading a second, guard-specific string through every call site.
 *
 * `run` receives a THIRD argument, the request context, which the two Phase 3 routes need and the
 * seven Phase 2 routes ignore. A callback declared with two parameters satisfies a three-parameter
 * function type in TypeScript, so none of the seven existing call sites changed. It carries the
 * RESOLVED connection, which the edit-plan route hands to `connectionFingerprint`, and the
 * session, which the edit-apply route writes into its audit events, and it hands them over rather
 * than letting a route resolve either a second time: a second resolution can answer a different
 * connection, and a second `getSession` can answer a different user.
 *
 * `options.readBody` SUBSTITUTES the body read. The default is this module's own
 * `await req.json()` arm, which is what the seven Phase 2 routes use and which answers
 * `{ error: "Empty request body" }` at 400 for a body TRUNCATED by the framework at 10,485,760
 * bytes: one condition, a wrong sentence, and a defect this phase FILES rather than inherits. The
 * two Phase 3 routes pass `readBoundedJson` instead, which counts the stream and answers a true
 * sentence for each of the three conditions the default arm collapses into one. It is a
 * substitution and not a flag for the reason every seam in this module is a value: a boolean here
 * would be a second way to reach one behaviour and would put the bound's NUMBER in this file,
 * where it has no business being.
 */
export async function handleObjectRequest(
  req: NextRequest,
  route: string,
  run: (provider: DatabaseProvider, body: Record<string, unknown>, context: ObjectRequestContext) => Promise<unknown>,
  options?: { readonly readBody?: (req: NextRequest) => Promise<Record<string, unknown>> },
): Promise<NextResponse> {
  // Ahead of body parsing: an unauthenticated caller never gets a body parsed on its behalf, and
  // the rate limiter sees the request before any work is done for it. Same ordering, and the same
  // reason, as `src/app/api/db/provider-meta/route.ts`.
  const guard = await guardRoute({ route: `POST /${route}`, bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  try {
    const body = await (options?.readBody === undefined ? readDefaultBody(req) : options.readBody(req));

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
    return NextResponse.json(await run(provider, body, { connection, session: guard.session, route }));
  } catch (error) {
    if (error instanceof ObjectRouteError) {
      // `{ error }`, the shape this handler's own body-shape refusals above already use, plus
      // `code` when the refusal carries one. The key is OMITTED rather than sent as `undefined`,
      // because `JSON.stringify` drops an undefined value and a reader of this line should not
      // have to know that to predict the wire shape.
      return NextResponse.json(objectRouteErrorBody(error), { status: error.status });
    }
    return createErrorResponse(error, { route });
  }
}

/**
 * The wire body for one `ObjectRouteError`, `{ error }` plus `code` when the refusal carries one.
 *
 * A named function rather than an object literal inside the catch above, and the reason is
 * measurement rather than tidiness: the `code` arm has NO PRODUCER IN THIS REPOSITORY YET. The one
 * code that uses it, `EDIT_PLAN_INVALID`, is thrown by the two edit routes, which are a later
 * task's, so a ternary buried in the catch would be a branch nothing in this phase's own suite can
 * reach, covered by line count and unexercised in fact. Exported, so the test drives BOTH arms
 * directly and the shape is asserted rather than assumed.
 *
 * The key is OMITTED rather than sent as `undefined`. `JSON.stringify` drops an undefined value, so
 * the two spellings reach a client identically, and a reader of this line should not have to know
 * that to predict the wire shape.
 */
export function objectRouteErrorBody(error: ObjectRouteError): {
  readonly error: string;
  readonly code?: ApiErrorCode;
} {
  return { error: error.message, ...(error.code === undefined ? {} : { code: error.code }) };
}

/**
 * What a route gets BESIDE the provider and the body, and the reason each field is here (#789).
 *
 * `connection` is the RESOLVED connection, after `resolveConnection` has turned a `connectionId`
 * into a stored connection or accepted an inline one. The edit-plan route digests it, and a
 * fingerprint computed from a second resolution would be a fingerprint of a possibly different
 * server.
 *
 * `session` is the guard's, unchanged, so an audit event names the caller this request was
 * authorised as rather than whoever a second `getSession` would answer.
 *
 * `route` is the same string the caller passed, repeated here so a route that needs it for an
 * audit event does not have to hold a second copy of its own name.
 *
 * The session is typed LOOSELY, `role: string` and an optional `username`, rather than as
 * `UserPayload`. It is a read-only view for a consumer that only ever writes these two into a log
 * line, and widening here means this interface does not move when the auth payload grows a field.
 */
export interface ObjectRequestContext {
  readonly connection: DatabaseConnection;
  readonly session: { readonly role: string; readonly username?: string };
  readonly route: string;
}

/**
 * The body read the seven Phase 2 object routes use, unchanged and DELIBERATELY not repaired.
 *
 * Its sentence is wrong for two of the three conditions it answers, and this phase FILES that
 * rather than fixing it: five existing routes answer `Empty request body` for a body that was
 * TRUNCATED by the framework at 10,485,760 bytes, and `POST /api/db/query` answers HTTP 500 with
 * a JSON parser's message for the same condition. Repairing it here would change the response of
 * five shipped routes inside a pull request whose subject is a write path, which is how a diff
 * grows. `readBoundedJson` below is what the two new routes use instead.
 */
async function readDefaultBody(req: NextRequest): Promise<Record<string, unknown>> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    throw new ObjectRouteError("Empty request body", 400);
  }
  if (!body || (typeof body === "object" && Object.keys(body).length === 0)) {
    throw new ObjectRouteError("Empty request body", 400);
  }
  return body;
}

/**
 * The request body, parsed, under a BYTE bound this route holds itself (#789 Phase 3).
 *
 * THE MEASURED FACT THIS FUNCTION EXISTS FOR. There is a hard inbound bound at exactly 10,485,760
 * bytes, `DEFAULT_BODY_CLONE_SIZE_LIMIT` in Next 16.3.4's `getCloneableBody`, which exists because
 * this repository has middleware and the request body is therefore cloned for it. It TRUNCATES
 * rather than refusing, so above it `POST /api/db/query` answers HTTP 500 carrying a JSON parser's
 * message and `POST /api/db/objects/source` answers HTTP 400 `Empty request body`. One condition,
 * two wrong sentences, and NEITHER IS TRUE: the body was neither malformed by its sender nor
 * absent. A caller reading either one has no way to learn that the fix is to send less.
 *
 * TWO EVIDENCE CLASSES IN THAT PARAGRAPH, said apart so a later reader does not have to guess.
 * The CONSTANT and the TRUNCATION are read from the installed dependency and re-checkable with a
 * grep: `node_modules/next/dist/server/body-streams.js` declares
 * `DEFAULT_BODY_CLONE_SIZE_LIMIT = 10 * 1024 * 1024`, and over it `cloneBodyStream` sets
 * `limitExceeded`, pushes `null` into both streams and logs a `console.warn`, which ENDS the body
 * early rather than failing the request.
 *
 * WHERE THAT TRUNCATION IS REACHED FROM, re-measured by grep against the installed next 16.3.4 in
 * this checkout, because an earlier revision of this docblock got it backwards. `next-server.js:1289`
 * calls `getCloneableBody` on every non-upgrade request, with `experimental.proxyClientMaxBodySize`
 * as the only override, but that call only REGISTERS the wrapper on the request meta and counts
 * nothing. The count and the truncation live entirely inside `cloneBodyStream`, `body-streams.js:80`
 * to `:118`, and `cloneBodyStream` has exactly THREE call sites: `next-server.js:1210`, which is
 * inside the middleware adapter invocation, `adapterFn({ ..., page: 'middleware' })`;
 * `web/sandbox/sandbox.js:94`; and `lib/router-server.js:417` for a proxied request. So the INSTALL
 * is unconditional and the TRUNCATION is conditional on middleware actually running. The outcome for
 * this repository is the same either way, because `src/proxy.ts` IS a middleware, and the truncated
 * clone is what the route then reads: `cloneBodyStream` assigns its second stream to `buffered`, and
 * `finalize()` calls `replaceRequestBody(readable, buffered)`, which swaps the short stream onto the
 * incoming request.
 *
 * The two HTTP SENTENCES are a live measurement made earlier in this phase against a running server,
 * not something this file re-ran, and they are recorded here because they are the reason the function
 * exists.
 *
 * THE ARITHMETIC, done here rather than asserted, because the three numbers only make sense
 * together. One part is bounded at `SOURCE_CHARACTER_LIMIT`, 1,000,000 UTF-16 code units. That is
 * up to 4 MB encoded as UTF-8, because one code unit encodes to at most three UTF-8 bytes and a
 * surrogate PAIR is two code units and four bytes; and up to 6 MB once JSON-escaped, because the
 * worst-case escape of one code unit is the six ASCII bytes of `\uXXXX`. `SOURCE_PART_LIMIT` is 8,
 * so a document at its own maxima is far above any single-part figure, which is exactly why the
 * bound belongs to the CALLER'S body here and not to a per-part count: a caller submits ONE part's
 * text per request. `EDIT_BODY_BYTE_LIMIT` is 8,388,608, which sits above the 6 MB worst case and
 * below the framework's 10,485,760, so an oversized body meets a sentence here rather than a
 * truncation reported as something else downstream.
 *
 * THE COUNT IS OVER THE STREAM AND NEVER OVER `Content-Length`, and that is the whole guard. A
 * check on the header is satisfied by OMITTING the header, and a chunked body carries none: the
 * framework then truncates in silence and the caller gets one of the two wrong sentences above,
 * which is the state this function exists to make unreachable. MEASURED on bun 1.4.2 with this
 * repository's own `next` while this was written: `new NextRequest(url, { body: <ReadableStream>,
 * duplex: "half" })` constructs, its `content-length` header is `null`, and reading `req.body` to
 * completion yields 4,107 bytes for a 4,096-character payload. The same measurement also says a
 * `NextRequest` built with `body: ""` reports `content-length: null` and yields ZERO bytes, so the
 * empty-body sentence below is reached through the byte count rather than through a header.
 *
 * THREE CONDITIONS, THREE SENTENCES, which is the point of the whole function:
 * - no body at all, 400, `this request carried no body`;
 * - a body that does not parse, or parses to something that is not a JSON object, 400,
 *   `this request body is not valid JSON`;
 * - a body over the bound, 413, `this request body is larger than ${byteLimit} bytes`.
 *
 * The second condition carries a REFINED second half when the body parsed and is not an object, an
 * array or a `null` or a number. It is not a fourth condition: the caller's mistake is the same
 * one, a body this route cannot read as a set of named fields, and telling a caller who sent
 * `[1,2,3]` that its JSON is invalid would be a fourth wrong sentence in a function written to
 * remove two.
 *
 * The parse is refused rather than coerced for the reason `optionalBoolean` gives above: a body
 * that is not an object would reach `resolveConnection` as one, and an array has no `connection`
 * and no `connectionId`, so the caller would meet a connection error for a body mistake.
 *
 * WHERE THIS DIVERGES FROM `readDefaultBody`, said out loud because the two now run on the SAME
 * handler and answer differently for one body. `readDefaultBody` refuses `{}` itself, with
 * `Empty request body` at 400. This function RETURNS `{}`: it parsed, and it is a JSON object, and
 * "carries no named field this route wants" is a question for the route and not for a body reader.
 * The caller's outcome is a 400 either way, because `resolveConnection({})` raises
 * `Either connection or connectionId is required` at 400, so this is a difference in SENTENCE and
 * not a hole. Both halves are pinned: the empty object is returned in
 * `tests/unit/lib/api/object-route-edit.test.ts` and both end-to-end answers are measured through
 * this handler in `tests/api/db-objects.test.ts`, under
 * `describe("the body read the handler actually performs")`. They live in that file rather than in
 * one of their own because a SECOND `mock.module("@/lib/db", ...)` in one bun process breaks the
 * real module graph for the files that mock `@/lib/db/factory` later: measured, a separate file
 * carrying the same mocks took `bun test tests/api` from 558 pass / 0 fail to 510 pass / 5 fail
 * with 5 `SyntaxError: Export named 'getOrCreateProvider' not found` errors.
 */
export async function readBoundedJson(req: NextRequest, byteLimit: number): Promise<Record<string, unknown>> {
  // `req.body` is null for a request that carried no body at all, which is what a GET or a bodiless
  // POST is. MEASURED as above, the empty-string construction is NOT null, so this fallback is for
  // the runtime's own null and the zero-byte sentence below covers both.
  const reader = (req.body ?? new Blob([]).stream()).getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > byteLimit) {
      // Cancelled rather than read to the end: the refusal is decided here and draining the rest
      // would be reading a body this route has already declined to hold.
      await reader.cancel();
      throw new ObjectRouteError(`this request body is larger than ${byteLimit} bytes`, 413);
    }
    // `{ stream: true }` because a multi-byte character can be split across two chunks, and a
    // decode without it would answer a replacement character for each half.
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();

  if (bytes === 0) {
    throw new ObjectRouteError("this request carried no body", 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ObjectRouteError("this request body is not valid JSON", 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ObjectRouteError(
      "this request body is not valid JSON for this route: it parsed, and what it parsed is not a JSON object",
      400,
    );
  }
  return parsed as Record<string, unknown>;
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
 *
 * TWO statuses use it now: 413 joined for a body over `readBoundedJson`'s bound (#789 Phase 3).
 *
 * EXPORTED as of Phase 3, because the two edit routes decide refusals of their own and minting a
 * second error class beside this one would put the status vocabulary in two files. That is the
 * thing this class's own privacy used to buy, so the export costs nothing only while every
 * thrower stays inside `src/app/api/db/objects/` and `src/lib/api/`.
 *
 * `code` is OPTIONAL and almost always absent. It is a machine-readable discriminant for the ONE
 * refusal a browser must respond to specifically, `EDIT_PLAN_INVALID`, where the client rebuilds
 * the preview rather than showing the sentence. Every other refusal here is rendered and read by a
 * human, and giving each one a code would put a vocabulary in the client for text it only ever
 * displays.
 */
export class ObjectRouteError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: ApiErrorCode,
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
 *
 * THE THIRD ARGUMENT is the CONNECTED provider's capabilities, and it is what makes the edit
 * affordance a route-enforced fact rather than a provider-reported one (#789 Phase 3). Same
 * precedent as the paragraph above: a declaration merely READ from an implementation is a report
 * and not a bound. A provider that offers `edit` on a part whose kind it never declared
 * `acceptsSourceEdits` would ship a client an Edit button for an object no `buildObjectEdit` can
 * plan, and the user would meet the refusal after typing rather than before.
 */
export function boundSourceDocument(
  document: ObjectSourceDocument,
  limit: number,
  capabilities: ProviderCapabilities,
): ObjectSourceDocument {
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
  const kindEditable = kindAcceptsSourceEdits(capabilities, document.kind);
  return {
    ...document,
    parts: [boundPart(first, limit, kindEditable), ...rest.map((part) => boundPart(part, limit, kindEditable))],
  };
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
function boundPart(part: ObjectSourcePart, limit: number, kindEditable: boolean): ObjectSourcePart {
  if (isSourcePartUnavailable(part) && Object.hasOwn(part, "text")) {
    throw new ObjectRouteError(
      "the source read answered a part that carries both a refusal and a text; a refusal and a definition " +
        "are different facts and a reader must never be shown one over the other",
      400,
    );
  }
  // THE ORDER IS THE GUARD. `boundText` MARKS `truncated` itself when a provider over-answered, and
  // `stripEdit` refuses a truncated part, so stripping first would carry the affordance through on
  // exactly the parts this route cut.
  return stripEdit(boundText(part, limit), kindEditable);
}

/**
 * The part under the character bound, with no affordance decision in it (#789).
 *
 * Split out of `boundPart` so the stripping below runs over the ALREADY BOUNDED part. The two were
 * one function through Phase 2, when there was nothing to strip.
 */
function boundText(part: ObjectSourcePart, limit: number): ObjectSourcePart {
  if (isSourcePartUnavailable(part) || part.text.length <= limit) return part;
  const reason = sourceBoundTruncationReason(limit);
  /*
   * ONE SLICER for the fleet, and the route was the second one (#789). It cut with a bare
   * `part.text.slice(0, limit)` while all sixteen providers cut through `applySourceBound`,
   * which drops an orphaned surrogate half: the bound counts UTF-16 CODE UNITS, so it can land
   * BETWEEN the two halves of an astral character, and MEASURED through this function, a text
   * holding an emoji at exactly the boundary came back ending in `\ud83d`, which is not a
   * character and which JSON serialises as a lone escape.
   *
   * Only `.text` is taken from it. The MARK is composed here, because this route's second bound
   * has a fact the helper does not: a provider that already bounded at its own smaller limit
   * keeps its own sentence and this one is JOINED to it rather than replacing it.
   */
  return {
    ...part,
    text: applySourceBound(part.text, limit).text,
    truncated: { limit, reason: part.truncated === undefined ? reason : `${part.truncated.reason}; ${reason}` },
  };
}

/**
 * The `edit` affordance, kept or DELETED, decided by the route and never by the provider (#789).
 *
 * THREE reasons to delete it, and they are checked in this order because each is a different fact:
 *
 * 1. THE PART IS A REFUSAL. Representable and not hypothetical: MEASURED against tsc 6.0.3 and
 *    already recorded on `boundPart` above, the excess-property check on a union admits any
 *    property declared on ANY member of it, so a part carrying `unavailable` BESIDE `edit`
 *    compiles with no cast. A provider spreading a conditional affordance onto a refusal would
 *    ship an editable refusal: a client narrows it to the refusal arm, draws "this could not be
 *    read", and offers an Edit button over the text it just said it does not have.
 * 2. THE PART IS TRUNCATED, whether the PROVIDER marked it or `boundText` just did. A truncated
 *    part is a PREFIX, and submitting a prefix back replaces the object with the part of itself
 *    the reader was shown, which is ruling 1b's second clause: a SUCCESS destroying something the
 *    user was not shown. It is the server-side half of the pair that closed backlog entry X17: the
 *    CAPTION tells a human that a bounded text is not whole, and THIS tells the machine not to
 *    offer an edit over it. X17 is closed, so the id no longer resolves and the pairing is named
 *    here instead. It WITHDRAWS THE OFFER; it does not make the submission impossible, and
 *    the write-path paragraph below says whose job that is.
 * 3. THE KIND IS NOT EDITABLE ON THE CONNECTED PROVIDER, by `kindAcceptsSourceEdits`. This is D57,
 *    the defect where a client's declaration can be a different server's, closed on the read path:
 *    the affordance travels with the document from the server that answered it.
 *
 * WHICH OF THE THREE RULES HAS A LIVE PRODUCER TODAY, measured by grep at this commit rather than
 * implied by the fact that all three are tested. This paragraph counted ONE producer when PostgreSQL
 * was the only engine that had landed; the day-one set is now three and the count was re-measured
 * rather than the digit bumped, because what it counts is what the paragraph is for.
 *
 * There are THREE producers of `edit`: `providers/sql/postgres.ts:2799`, gated on
 * `kindAcceptsSourceEdits(capabilities, kind)`; `providers/sql/trino/index.ts:1249` and
 * `providers/keyvalue/redis.ts:1657`, both gated on `spec.acceptsSourceEdits === true`, which is the
 * same fact read through the same declaration. All three sit on the READABLE arm, verified rather
 * than assumed: no producer attaches `edit` to a part carrying `unavailable`.
 *
 * So rules 1 and 3 still have NO live producer, and for the same reason as before: the only thing
 * that can build their population is a DEFECTIVE or a future provider, and the unit tests construct
 * it deliberately, which is this module's own ENFORCE-rather-than-trust precedent and not an
 * oversight.
 *
 * Rule 2's producer set GREW and its character changed, which is the part a bumped digit would have
 * hidden. On PostgreSQL it is a by-product: that site spreads `truncated` and `edit` from a single
 * read, so a routine over `SOURCE_CHARACTER_LIMIT` reaches it. On Redis it is a DECIDED POSITION,
 * stated at `redis.ts:1649-1656`: the affordance is offered on a truncated part deliberately, because
 * the bound is the CALLER's and the same object read without one is whole, so a provider that withheld
 * it there would be answering a property of the REQUEST as a property of the object. Rule 2 is what
 * makes that position safe on the standalone path, and the pane's predicate and `buildObjectEdit`'s
 * re-read are what make it safe on the other two.
 *
 * THE WRITE PATH IS NOT COVERED HERE AT ALL, and it is the larger gap. Deleting a field from a READ
 * response cannot bind a caller: a client that never calls `/api/db/objects/source`, or that simply
 * ignores the field that was deleted, can POST the truncated prefix straight to the edit routes.
 * MEASURED by grep at this commit, nothing on the write path enforces either fact: `object-edit.ts`
 * names neither `truncated` nor `acceptsSourceEdits`. That is an obligation ON THE EDIT-PLAN ROUTE,
 * stated here by name so it is not read as already discharged: that route must REFUSE a plan whose
 * part is truncated, and REFUSE a kind that fails `kindAcceptsSourceEdits` on the CONNECTED provider.
 * Until it does, this function decides what the UI is OFFERED and never what the server ACCEPTS.
 *
 * WHAT THIS CANNOT COVER ON THE READ PATH ITSELF, said out loud rather than left for a reader to
 * assume the opposite.
 * It kills the class on the ROUTE path ONLY. A HOST cannot reach here at all, MEASURED and already
 * recorded on `boundSourceDocument`: `handleObjectRequest` takes its provider from
 * `getOrCreateProvider`, which resolves through a closed `switch (connection.type)` in
 * `src/lib/db/factory.ts` with no registration point for anyone else, and the embedded shell has
 * no API routes, so a host implementing the workspace source seam answers its document straight to
 * the pane. The EMBEDDED half is the client-side predicate in
 * `src/components/object-source/source-editable.ts`, which asks the same three questions of the
 * document it was handed. Two halves, deliberately, because neither one covers the other's
 * population.
 *
 * The delete is a REST SPREAD and not a `delete` statement, so the answered part is a new object
 * and the provider's own is not mutated. `Object.hasOwn` and never `in`, on standing ruling 5g,
 * and never `part.edit !== undefined`: a part carrying an explicit `edit: undefined` has the key,
 * and `JSON.stringify` would drop it anyway, but a reader asking "does this part offer an edit"
 * gets the same answer either way only while the question is asked about the KEY.
 */
function stripEdit(part: ObjectSourcePart, kindEditable: boolean): ObjectSourcePart {
  if (
    Object.hasOwn(part, "edit") &&
    (isSourcePartUnavailable(part) || Object.hasOwn(part, "truncated") || !kindEditable)
  ) {
    const { edit: _dropped, ...rest } = part as ObjectSourcePart & { edit?: unknown };
    return rest as ObjectSourcePart;
  }
  return part;
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
