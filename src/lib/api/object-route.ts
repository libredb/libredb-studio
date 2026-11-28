import { NextRequest, NextResponse } from "next/server";
import { getOrCreateProvider } from "@/lib/db";
import { readBoundedJson } from "@/lib/api/bounded-json";
import { metadataTreeTarget } from "@/lib/api/editor-provider";
import { sourceModel } from "@/lib/api/object-source";
import { createErrorResponse } from "@/lib/api/errors";
import { isPackageFailure, packageFailureAnswer } from "@/lib/api/package-errors";
import type { TreeTarget } from "@/lib/api/session-target";
import { resolveConnection, resolveServedConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { FacetNotOfferedError, markNotSent } from "@/lib/db/errors";
import { HostDefectError } from "@/lib/provider-host/access";
import type { ObjectsSession } from "@/lib/provider-host/core/objects";
import {
  connectionTextScrub,
  type ProviderTextScrub,
  type ProviderWords,
  providerTextScrub,
} from "@/lib/db/operations/provider-text";
import {
  type EngineConnection,
  type EngineRecord,
  legacyConnection,
  legacyProviderType,
} from "@/lib/db/server-catalog";
import { type CallContext, checkObjectsFacet } from "@libredb/provider-sdk/calls";
import {
  acceptedContainerShapes,
  containerDepth,
  enumerableKinds,
  findKind,
  kindAcceptsSourceEdits,
  kindHasSource,
  type ObjectKindView,
  type ObjectModelView,
  renderContainerShapes,
} from "@/lib/db/object-kinds";
import type {
  DatabaseConnection,
  DatabaseObject,
  DatabaseProvider,
  ObjectDetail,
  ObjectSourceDocument,
  ObjectSourcePart,
} from "@/lib/db/types";
import type { ApiErrorCode } from "@/lib/api/error-codes";
import type { UserPayload } from "@/lib/auth";

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
 * two Phase 3 routes pass `readObjectRouteBody` instead, which counts the stream and answers a true
 * sentence for each of the three conditions the default arm collapses into one. It is a
 * substitution and not a flag for the reason every seam in this module is a value: a boolean here
 * would be a second way to reach one behaviour and would put the bound's NUMBER in this file,
 * where it has no business being.
 *
 * `options` decides how the request is resolved and what `run` is handed, as a value and never a function a route
 * hands in, so the routes import no provider builder:
 *
 * - `{ reads: "tree" }`, which the six tree routes pass: the connection and its engine's record are resolved through
 *   `resolveServedConnection`, so a provider package's engine resolves too, and `run` is handed the tree target of the
 *   record's metadata session (`metadataTreeTarget` in ./editor-provider), beside the editor's, so a tree read never
 *   waits for the editor's statements except on a connection that serves one session (docs/providers/CONTRACT.md,
 *   clause C-66). A package's session that does not offer `objects.tree` is opened and then refused by the session's
 *   offer when the route builds its tree (`objectTree` in ./object-tree), never as the route-level 501. A failure of
 *   the open, and of the run where the package's call raised it, is answered by the record (`packageFailureAnswer` in
 *   ./package-errors): a legacy record's as raised, a package's open failure as a not-sent `ConnectionError`, a refusal
 *   of what a package answered as the package's defect, and a package's own error by its record's grant of its words,
 *   logged once there. Every other failure of the run is Studio's own and is answered and logged as Studio's
 *   (`raisedByCall`). The context carries the record and how a provider's sentences in an answer reach the client
 *   (`TreeRequestContext.words`).
 * - `{ request: "editPlan" | "editApply" | "keyScan", readBody? }`, which the edit plan, the edit apply and the key
 *   scan pass: resolved through `resolveServedConnection` too, and a record that does not offer the request
 *   (`EngineOffers.objectEdit`, `EngineOffers.keyScan`) is refused before any open as `FacetNotOfferedError` naming the
 *   request, 400, outcome not-sent; no provider package's record offers either, since the provider contract has no
 *   edit or key scan call yet. Every other record opens the editor's provider through `getOrCreateProvider`.
 * - no options, which the source read passes: it reads through the host core's source call on the bridged session of
 *   the editor's provider (`objectSource` in ./object-source), and until a package's session is served there the
 *   connection is resolved through `resolveConnection`, which refuses a provider package's engine as
 *   `PACKAGE_ENGINE_UNSUPPORTED`, 501, and the editor's provider is opened through `getOrCreateProvider`.
 *
 * Every arm opens after the guard, the body read and the connection's resolution, with the execution context of the
 * guard's session and the resolved connection.
 */
export async function handleObjectRequest(
  req: NextRequest,
  route: string,
  run: (tree: TreeTarget, body: Record<string, unknown>, context: TreeRequestContext) => Promise<unknown>,
  options: { readonly reads: "tree" },
): Promise<NextResponse>;
export async function handleObjectRequest(
  req: NextRequest,
  route: string,
  run: (provider: DatabaseProvider, body: Record<string, unknown>, context: ObjectRequestContext) => Promise<unknown>,
  options?: {
    readonly request?: ProviderRequest;
    readonly readBody?: (req: NextRequest) => Promise<Record<string, unknown>>;
  },
): Promise<NextResponse>;
export async function handleObjectRequest(
  req: NextRequest,
  route: string,
  run:
    | ((tree: TreeTarget, body: Record<string, unknown>, context: TreeRequestContext) => Promise<unknown>)
    | ((provider: DatabaseProvider, body: Record<string, unknown>, context: ObjectRequestContext) => Promise<unknown>),
  options?:
    | { readonly reads: "tree" }
    | {
        readonly request?: ProviderRequest;
        readonly readBody?: (req: NextRequest) => Promise<Record<string, unknown>>;
      },
): Promise<NextResponse> {
  // Ahead of body parsing: an unauthenticated caller never gets a body parsed on its behalf, and
  // the rate limiter sees the request before any work is done for it. Same ordering, and the same
  // reason, as `src/app/api/db/provider-meta/route.ts`.
  const guard = await guardRoute({ route: `POST /${route}`, bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  // Core's scrub of the resolved connection, held out here for the `catch` below: before the connection resolves no
  // provider ran. `failing` is the record's call a failure is answered by, once the tree arm reached it.
  const state: { scrub?: ProviderTextScrub; failing?: FailingCall } = {};
  try {
    const readBody = options !== undefined && "readBody" in options ? options.readBody : undefined;
    const body = await (readBody === undefined ? readDefaultBody(req) : readBody(req));

    // The body goes to the resolve as-is, unlike the schema routes, which also accept a
    // bare connection object AS the whole body. These routes always carry named fields beside the
    // connection (`container`, `kind`, `path`, `term`), so a body that names neither `connection`
    // nor `connectionId` is a caller mistake, and reading it as a connection would turn that
    // mistake into a confusing provider error further down.
    const reads = options !== undefined && "reads" in options;
    const request = options === undefined || "reads" in options ? undefined : options.request;
    // The source read: no tree and no request a record offers, so the legacy resolve.
    if (!reads && request === undefined) {
      const connection = await resolveConnection(body as ObjectRequestBody, guard.session);
      if (!connection.type) {
        return NextResponse.json({ error: "Valid connection configuration is required" }, { status: 400 });
      }
      state.scrub = providerTextScrub(connection, "any");
      return await providerRun(run as ProviderRun, body, connection, state.scrub, guard.session, route);
    }
    const { connection, engine } = await resolveServedConnection(body as ObjectRequestBody, guard.session);
    const scrub = connectionTextScrub(connection, legacyProviderType(engine), "any");
    state.scrub = scrub;
    // A tree read, the one arm that names no request.
    if (request === undefined) {
      return await treeRun(run as TreeRun, body, { connection, engine, scrub, session: guard.session, route }, state);
    }
    assertRequestOffered(engine, request);
    const legacy = legacyConnection(engine, connection);
    return await providerRun(run as ProviderRun, body, legacy, scrub, guard.session, route);
  } catch (error) {
    if (error instanceof ObjectRouteError) {
      // `{ error }`, the shape this handler's own body-shape refusals above already use, plus
      // `code` when the refusal carries one. The key is OMITTED rather than sent as `undefined`,
      // because `JSON.stringify` drops an undefined value and a reader of this line should not
      // have to know that to predict the wire shape.
      return NextResponse.json(objectRouteErrorBody(error), { status: error.status });
    }
    const { failing, scrub } = state;
    if (failing === undefined || scrub === undefined || !raisedByCall(failing, error)) {
      return createErrorResponse(error, { route, scrub });
    }
    // A provider package's failure is logged once where it is answered (`isPackageFailure`), so it gets no second line.
    const logged = isPackageFailure(failing.engine, error);
    return createErrorResponse(packageFailureAnswer(failing.engine, failing.call, error, scrub, route), {
      route,
      scrub,
      logged,
    });
  }
}

/** A provider route's `run`. */
type ProviderRun = (
  provider: DatabaseProvider,
  body: Record<string, unknown>,
  context: ObjectRequestContext,
) => Promise<unknown>;

/** A tree route's `run`. */
type TreeRun = (tree: TreeTarget, body: Record<string, unknown>, context: TreeRequestContext) => Promise<unknown>;

/**
 * The call of the tree arm a failure is answered by: the record's open, then its tree read, with every value the
 * session's own functions raised during the run (`recordingRaised`).
 */
type FailingCall =
  | { readonly engine: EngineRecord; readonly call: "open" }
  | { readonly engine: EngineRecord; readonly call: "tree read"; readonly raised: ReadonlySet<unknown> };

/**
 * Whether `error` is a failure of `failing`'s call, which the record answers (`packageFailureAnswer`): any failure of
 * the open; and of the run, a value the session's own functions raised, or a host defect, whose refusals name whose
 * defect it is (`REFUSAL_AUTHOR` in ./package-errors), such as a tree answer the host core refused. Any other failure
 * of the run, such as a session Studio's host built stating no object model (`objectTree` in ./object-tree) or a read
 * before the host core's install, is Studio's own.
 */
function raisedByCall(failing: FailingCall, error: unknown): boolean {
  if (failing.call === "open") return true;
  return failing.raised.has(error) || error instanceof HostDefectError;
}

/**
 * `target` with each function its session holds, the tree read and, where the session offers `objects.source`, the
 * source read, recording in `raised` each value it threw or rejected with, passed on as the same value, so a route
 * answers by the record only what the session's own calls raised (`raisedByCall`). The session handed on holds exactly
 * the members `target`'s session holds, so a function is present exactly where the session offers its call, as
 * `ObjectsSession` states.
 */
function recordingRaised(target: TreeTarget, raised: Set<unknown>): TreeTarget {
  const { session } = target;
  const { tree, source } = session;
  const recorded =
    <Request, Answer>(call: (request: Request, ctx: CallContext) => Promise<Answer>) =>
    async (request: Request, ctx: CallContext): Promise<Answer> => {
      try {
        return await call.call(session, request, ctx);
      } catch (error) {
        raised.add(error);
        throw error;
      }
    };
  return {
    ...target,
    session: {
      calls: session.calls,
      ...(session.objectModel === undefined ? {} : { objectModel: session.objectModel }),
      ...(tree === undefined ? {} : { tree: recorded(tree) }),
      ...(source === undefined ? {} : { source: recorded(source) }),
    },
  };
}

/**
 * The provider arm: the editor's provider of `connection`, opened under the guard's session's editor posture, and
 * `run`'s answer on it.
 */
async function providerRun(
  run: ProviderRun,
  body: Record<string, unknown>,
  connection: DatabaseConnection,
  scrub: ProviderTextScrub,
  session: ObjectRequestContext["session"] & { readonly role: string },
  route: string,
): Promise<NextResponse> {
  // Covers the source read, the edit routes and keys/scan: the DuckDB editor file-access posture is
  // derived from the verified session role and the resolved connection (non-admin DuckDB file access), so a non-admin
  // browsing or editing objects on a DuckDB connection opens a handle with external access off.
  const provider = await getOrCreateProvider(connection, {}, editorExecutionContext(session, connection));
  return NextResponse.json(await run(provider, body, { connection, session, route, scrub }));
}

/**
 * The tree arm: the tree target of the record's metadata session, and `run`'s answer on it, `state.failing` naming the
 * record's call a failure is answered by: the open, then the tree read, which answers by the record only the values
 * the session's own functions raised (`recordingRaised`).
 */
async function treeRun(
  run: TreeRun,
  body: Record<string, unknown>,
  resolved: {
    readonly connection: EngineConnection;
    readonly engine: EngineRecord;
    readonly scrub: ProviderTextScrub;
    readonly session: ObjectRequestContext["session"] & { readonly role: string };
    readonly route: string;
  },
  state: { failing?: FailingCall },
): Promise<NextResponse> {
  const { connection, engine, scrub, session, route } = resolved;
  state.failing = { engine, call: "open" };
  const raised = new Set<unknown>();
  const tree = recordingRaised(await metadataTreeTarget(session, connection, engine), raised);
  state.failing = { engine, call: "tree read", raised };
  const words: ProviderWords = { scrub, ownWords: engine.grants.ownWords, route };
  return NextResponse.json(await run(tree, body, { connection, engine, session, route, scrub, words }));
}

/** A request a provider route serves that a provider package's record offers none of yet, by its operation. */
export type ProviderRequest = "editPlan" | "editApply" | "keyScan";

/** The record's offer each provider request reads, and how its refusal names it. */
const PROVIDER_REQUESTS: Readonly<Record<ProviderRequest, { offer: "objectEdit" | "keyScan"; noun: string }>> =
  Object.freeze({
    editPlan: { offer: "objectEdit", noun: "object edit plan" },
    editApply: { offer: "objectEdit", noun: "object edit" },
    keyScan: { offer: "keyScan", noun: "key scan" },
  });

/**
 * Refuses `request` for `engine` when its record does not offer it, before any open: `FacetNotOfferedError` of the
 * object facet naming the request, outcome not-sent (docs/providers/CONTRACT.md, clause C-107).
 *
 * @throws {FacetNotOfferedError} Not-sent, when the record does not offer the request.
 */
function assertRequestOffered(engine: EngineRecord, request: ProviderRequest): void {
  const { offer, noun } = PROVIDER_REQUESTS[request];
  if (engine.offers[offer]) return;
  const error = new FacetNotOfferedError(
    `This connection's engine offers no ${noun} in this LibreDB Studio, so Studio opened nothing.`,
    legacyProviderType(engine),
    "objects",
    request,
  );
  markNotSent(error);
  throw error;
}

/**
 * The wire body for one `ObjectRouteError`, `{ error }` plus `code` and `fields` when the refusal carries them.
 *
 * A named function rather than an object literal inside the catch above, and the reason is
 * measurement rather than tidiness. The `code` arm has two producers:
 * `src/app/api/db/objects/edit-apply/route.ts` raises
 * `ObjectRouteError(verdict.reason, 400, ApiErrorCode.EDIT_PLAN_INVALID)` for a plan that no longer
 * verifies, and `src/app/api/db/objects/search/route.ts` raises `INVENTORY_PAIR_LIMIT` with its
 * `limit` and `pairs` fields. A ternary buried in the catch would therefore be a branch two routes
 * reach and everything else in this file's own suite cannot, covered by line count and unexercised in fact.
 * Exported, so the test drives BOTH arms directly and the shape is asserted rather than assumed.
 * An earlier revision of this paragraph said the arm had no producer at all and that the edit
 * routes were a later task's, which was true before they landed.
 *
 * The key is OMITTED rather than sent as `undefined`. `JSON.stringify` drops an undefined value, so
 * the two spellings reach a client identically, and a reader of this line should not have to know
 * that to predict the wire shape.
 */
export function objectRouteErrorBody(error: ObjectRouteError): {
  readonly error: string;
  readonly code?: ApiErrorCode;
  readonly [field: string]: unknown;
} {
  // The fields go first, so one named like the message or the code cannot replace them.
  return { ...error.fields, error: error.message, ...(error.code === undefined ? {} : { code: error.code }) };
}

/**
 * What a route gets BESIDE the provider and the body, and the reason each field is here (#789).
 *
 * `connection` is the RESOLVED connection, after `resolveConnection` or `resolveServedConnection` has turned a
 * `connectionId` into a stored connection or accepted an inline one. The edit-plan route digests it, and a
 * fingerprint computed from a second resolution would be a fingerprint of a possibly different
 * server.
 *
 * `session` is the guard's, unchanged, so an audit event names the caller this request was
 * authorised as rather than whoever a second `getSession` would answer.
 *
 * `route` is the same string the caller passed, repeated here so a route that needs it for an
 * audit event does not have to hold a second copy of its own name.
 *
 * `scrub` is core's scrub of the resolved connection (`providerTextScrub`, `connectionTextScrub`), so a route answers
 * a provider's sentences through the same scrub its errors are answered with.
 *
 * The session is a read-only view of the three `UserPayload` fields a consumer reads: the role and
 * username an audit line writes, and the identity provider subject a query event names its caller
 * by (docs/GOVERNANCE.md#query-events), so this interface moves only when a consumer needs another field.
 */
export interface ObjectRequestContext {
  readonly connection: DatabaseConnection;
  readonly session: Readonly<Pick<UserPayload, "role" | "username" | "idpSubject">>;
  readonly route: string;
  readonly scrub: ProviderTextScrub;
}

/**
 * What a tree route gets beside its tree target and the body: the context a provider route gets, with the connection of
 * any engine the server serves, the record of its engine, whose id the route's sentences name the engine by, and how a
 * provider's sentences in a tree answer reach the client (`providerSentence` in src/lib/db/operations/provider-text.ts):
 * through `scrub` where the record grants the engine its own words, and as Studio's sentence where it does not.
 */
export interface TreeRequestContext extends Omit<ObjectRequestContext, "connection"> {
  readonly connection: EngineConnection;
  readonly engine: EngineRecord;
  readonly words: ProviderWords;
}

/**
 * The body read the seven Phase 2 object routes use, unchanged and DELIBERATELY not repaired.
 *
 * Its sentence is wrong for two of the three conditions it answers, and this phase FILES that
 * rather than fixing it: five existing routes answer `Empty request body` for a body that was
 * TRUNCATED by the framework at 10,485,760 bytes, and `POST /api/db/query` answers HTTP 400
 * "Invalid request body" for the same condition. Repairing it here would change the response of
 * five shipped routes inside a pull request whose subject is a write path, which is how a diff
 * grows. `readObjectRouteBody` below is what the two new routes use instead.
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
 * rather than refusing, so above it `POST /api/db/query` answers HTTP 400 `Invalid request body`
 * and `POST /api/db/objects/source` answers HTTP 400 `Empty request body`. One condition,
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
 * this checkout, because an earlier revision of this docblock got it backwards. `NextNodeServer` in `next-server.js`
 * calls `getCloneableBody` on every non-upgrade request, with `experimental.proxyClientMaxBodySize`
 * as the only override, but that call only REGISTERS the wrapper on the request meta and counts
 * nothing. The count and the truncation live entirely inside `cloneBodyStream`, in `getCloneableBody` of `body-streams.js`, and `cloneBodyStream` has exactly THREE call sites: `NextNodeServer.runMiddleware` in `next-server.js`, which is
 * inside the middleware adapter invocation, `adapterFn({ ..., page: 'middleware' })`;
 * the request the sandbox builds in `web/sandbox/sandbox.js`; and the `proxyRequest` call in `lib/router-server.js` for a proxied request. So the INSTALL
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
 * THE COUNT IS OVER THE STREAM, and that is the whole guard. The shared reader this function
 * delegates to, `src/lib/api/bounded-json.ts`, also refuses a declared `Content-Length` over the
 * bound before reading, but only as a shortcut: a check on the header is satisfied by OMITTING the
 * header, and a chunked body carries none: the framework then truncates in silence and the caller gets one of the two wrong sentences above,
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
 * `describe("the body read the handler actually performs")`. They live in that file because it is
 * where this handler's end-to-end answers are measured. The original reason has since expired: a
 * SECOND `mock.module("@/lib/db", ...)` in one bun process broke the real module graph for the
 * files that mocked `@/lib/db/factory` later, and a separate file carrying the same mocks took
 * `bun test tests/api` from 558 pass / 0 fail to 510 pass / 5 fail with 5 `SyntaxError: Export
 * named 'getOrCreateProvider' not found` errors. `bun run test` now runs every test file in its
 * own process, so two files can hold that mock without meeting each other; the hazard is only
 * within a file now.
 */
export async function readObjectRouteBody(req: NextRequest, byteLimit: number): Promise<Record<string, unknown>> {
  // The shared reader counts the stream; this function only words its refusals for these routes.
  const read = await readBoundedJson(req, byteLimit);
  if (!read.ok) {
    if (read.reason === "too_large") {
      throw new ObjectRouteError(`this request body is larger than ${byteLimit} bytes`, 413);
    }
    if (read.reason === "empty") throw new ObjectRouteError("this request carried no body", 400);
    throw new ObjectRouteError("this request body is not valid JSON", 400);
  }
  const parsed = read.body;
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
 * a container path the engine does not accept as an address, a parent deeper than the engine has
 * levels, a kind it does not declare, or a path that is not a path.
 *
 * It carried a 501 as well, for the phase in which the object methods were optional and only some
 * engines implemented them. They are required now, so there is no provider gap left to name and no
 * `requireMethod` to name it with: a guard for a state the type cannot express is an unreachable
 * throw, which is a covered line nothing executes.
 *
 * TWO statuses use it now: 413 joined for a body over `readObjectRouteBody`'s bound (#789 Phase 3).
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
    /**
     * Machine-readable facts a refusal carries beside `error` and `code`, such as a bound and a count, or the outcome
     * `not-sent` of a refusal of a level or a kind the engine's object model does not state (clause M-89).
     */
    public readonly fields?: Readonly<Record<string, number | string>>,
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

/**
 * The database one read should reach, or undefined when the caller named none.
 *
 * ONE FUNCTION FOR THE TWO ROUTES THAT TAKE IT (`POST /api/db/keys/scan` and `POST /api/db/query`),
 * because they take it for the same reason and refuse it with the same sentence: Redis has no
 * database-qualified key syntax, so a run that must reach a key in another database has to say which
 * one, and two routes answering "what is an invalid database" differently would be two documents
 * about one rule.
 *
 * `0` IS A DATABASE, not an absence — which is why the test is presence on the FIELD and never
 * truthiness on the VALUE. A `null` or a string is refused rather than read as "no choice": a silent
 * `undefined` would hand the read to the session's own database while the caller believes it named
 * another one, which is the same defect the field exists to prevent.
 */
export function optionalDatabase(body: Record<string, unknown>, name: string): number | undefined {
  if (body[name] === undefined) return undefined;
  const database = body[name];
  if (typeof database !== "number" || !Number.isSafeInteger(database) || database < 0) {
    throw new ObjectRouteError(`"${name}" must be a non-negative integer`, 400);
  }
  return database;
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
 * The fields of a refusal of a level or a kind the engine's object model does not state: it is refused before any call,
 * so nothing reached the engine (docs/providers/CONTRACT.md, clause M-89). No `code`, like every other caller mistake
 * this layer decides for itself.
 */
const NOT_SENT = Object.freeze({ outcome: "not-sent" });

/**
 * A container PARENT the engine could list under, checked before the provider is called.
 *
 * `parent` on `POST /api/db/objects/containers` is a tree cursor rather than an address: the
 * tree walks down one level at a time, so on every engine any depth up to and including the
 * declared one is a valid place to stand, and only a path DEEPER than the declared depth is
 * refused. A path exactly at the depth is what a caller asking for the level below the last one
 * sends, and PostgreSQL's `listContainers` documents answering `[]` for it as a true statement
 * about the engine rather than a caller mistake, so refusing it here would contradict the
 * provider.
 *
 * It used to guard addresses too, and #1147 split that out: an ADDRESS is checked against the
 * declared shapes by `assertContainerAddress` below, because a depth ceiling admits a path one
 * segment short on an engine that accepts only the declared depth.
 *
 * `model` is the object model of the session the read is made on, and `engine` the engine's id the sentence names.
 */
export function assertContainerDepth(
  model: ObjectModelView,
  engine: string,
  name: string,
  path: readonly string[],
): void {
  const depth = containerDepth(model);
  if (path.length <= depth) return;
  throw new ObjectRouteError(
    `${engine} declares a container depth of ${depth}, and "${name}" has ${path.length} segments: ` +
      `${JSON.stringify(path)}`,
    400,
    undefined,
    NOT_SENT,
  );
}

/**
 * A container ADDRESS the engine accepts, checked at the HTTP edge before the provider is
 * called (#1147).
 *
 * `container` on `counts` and `list`, and every entry of `containers` on `inventory`, names the
 * container a read binds its segments from. It is checked against `acceptedContainerShapes()`,
 * the kernel reader the provider's own `assertContainerPathShape` refuses by, so the edge and the
 * provider apply one rule to one declaration. Before #1147 this layer applied the depth ceiling
 * to addresses as well, so on an `exact` engine a path one segment short passed here and the
 * provider refused it with `code` and `statusCode`, while a path one segment long was refused
 * here with neither.
 *
 * One sentence and one wire shape for both directions: a 400 in this module's own
 * `ObjectRouteError` family, `{ error, outcome: "not-sent" }` with no `code`, like every other caller
 * mistake this layer decides for itself. The shapes are spelled from the lowercased level LABELS by the
 * kernel's `renderContainerShapes()`, whichever field a provider's own sentence spells them by,
 * because this refusal binds nothing and is read by a person.
 *
 * The provider check stays behind it: MCP's `inspect-schema` and an embedded host reach the
 * provider without this route.
 *
 * `model` is the object model of the session the read is made on, and `engine` the engine's id the sentence names.
 */
export function assertContainerAddress(
  model: ObjectModelView,
  engine: string,
  name: string,
  path: readonly string[],
): void {
  const shapes = acceptedContainerShapes(model);
  if (shapes.some((shape) => shape.length === path.length)) return;
  throw new ObjectRouteError(
    `${engine} accepts "${name}" as ${renderContainerShapes(shapes, "label")}, received ${JSON.stringify(path)}`,
    400,
    undefined,
    NOT_SENT,
  );
}

/**
 * The enumerable kinds, narrowed to the ones the caller asked for.
 *
 * An undeclared kind is a 400 and never an empty result. Answering nothing for `view` on an engine
 * that declares no `view` reads as "this database holds no views", which is a claim about the
 * data; the truth is a claim about the engine.
 *
 * A kind only the Keys panel enumerates is a 400 too, pointing there (#1089 3.4). It is declared, so
 * the Source tab and both edit routes resolve it, and it is never listed here: a provider that
 * declares it refuses to list it, and a listing of every key would carry every key name into an
 * inventory, a search and plan mode's prompt. With no `kinds` the answer is `enumerableKinds()`, so
 * the `inventory` and `search` routes leave that kind out by default and say why only to a caller
 * who names it.
 *
 * `model` is the object model of the session the reads are made on, and `engine` the engine's id the sentences name.
 * Both refusals answer outcome `not-sent`, since each is made before any read: a kind the model does not state (clause
 * M-89), and a kind only the Keys panel enumerates.
 */
export function resolveKinds<K extends ObjectKindView>(
  model: ObjectModelView<K>,
  engine: string,
  requested?: readonly string[],
): readonly K[] {
  const enumerable = enumerableKinds(model);
  if (requested === undefined) return enumerable;
  return requested.map((id) => {
    const kind = findKind(model, id);
    if (kind === undefined) {
      throw new ObjectRouteError(`${engine} declares no object kind "${id}"`, 400, undefined, NOT_SENT);
    }
    if (!enumerable.some((listed) => listed.id === id)) {
      throw new ObjectRouteError(
        `${engine} enumerates the kind "${id}" in the Keys panel alone, so no inventory or search lists it; ` +
          "browse it in the Keys panel",
        400,
        undefined,
        NOT_SENT,
      );
    }
    return kind;
  });
}

/**
 * A 400 for a source read the connection's session cannot serve for one kind (#789 Phase 2).
 *
 * ONE branch with TWO conjuncts, on purpose. The first is reachable through a provider that
 * declares a kind with source and omits the method, which `readObjectSource` being optional makes
 * representable: the legacy bridge offers `objects.source` exactly where the provider defines it,
 * so its session does not offer the facet (`checkObjectsFacet`). The second is reachable on every
 * engine: a kind whose model states no source, or no such kind at all, is an ordinary thing to ask
 * for, because a caller can hold a stale menu or a path it built itself. The model is read only for
 * a session that offers the facet (`sourceModel`), so a session that offers it and states no model
 * is the host's defect and never this 400.
 *
 * It is a helper here rather than a `throw` in the route for the reason every 400 in this module
 * is: `ObjectRouteError` is module-private, and keeping it private is what keeps the status
 * vocabulary in one file rather than letting each route mint its own.
 *
 * 400 and not 404 or 501, following `resolveKinds`: answering nothing reads as a claim about the
 * DATA when the truth is a claim about the ENGINE. The refusal answers outcome `not-sent`: nothing
 * was asked of the engine (clause M-89). The host core's source call refuses the same two cases
 * before any call (clause C-115); this sentence, naming the engine and the kind, is the one the
 * source route has always answered for them.
 */
export function requireSourceReader(session: ObjectsSession, engine: string, kind: string): void {
  if (checkObjectsFacet(session.calls, "source").length > 0 || !kindHasSource(sourceModel(session), kind)) {
    throw new ObjectRouteError(`${engine} declares no readable source for kind "${kind}"`, 400, undefined, NOT_SENT);
  }
}

/**
 * The source document the host core's source call answered, with the edit affordance the route
 * decides (#789 Phase 3).
 *
 * The bound and the shape are the core's: `sourceCall` reads the answer once with
 * `checkSourceAnswer`, which refuses a document of no part or more parts than `SOURCE_PART_LIMIT`,
 * a part carrying both a refusal and a text, and a sentence past `SOURCE_CHARACTER_LIMIT`, and cuts
 * each readable text past that bound with `boundSourceAnswer`, so this function checks and cuts
 * nothing of its own (clause C-115).
 *
 * `model` is the object model of the session that answered, and it is what makes the edit
 * affordance a route-enforced fact rather than a provider-reported one: a declaration merely READ
 * from an implementation is a report and not a bound. A provider that offers `edit` on a part whose
 * kind it never declared `acceptsSourceEdits` would ship a client an Edit button for an object no
 * `buildObjectEdit` can plan, and the user would meet the refusal after typing rather than before.
 */
export function offeredSourceEdits(document: ObjectSourceDocument, model: ObjectModelView): ObjectSourceDocument {
  // Destructured rather than mapped, because `parts` is a NON-EMPTY tuple and `Array.prototype.map`
  // answers a plain array that no longer satisfies it.
  const [first, ...rest] = document.parts;
  const kindEditable = kindAcceptsSourceEdits(model, document.kind);
  return {
    ...document,
    parts: [stripEdit(first, kindEditable), ...rest.map((part) => stripEdit(part, kindEditable))],
  };
}

/**
 * The `edit` affordance, kept or DELETED, decided by the route and never by the provider (#789).
 *
 * TWO reasons to delete it, and they are checked in this order because each is a different fact:
 *
 * 1. THE PART IS TRUNCATED, whether the PROVIDER marked it or the host core's cut
 *    (`boundSourceAnswer`) did. A truncated part is a PREFIX, and submitting a prefix back replaces
 *    the object with the part of itself the reader was shown, which is ruling 1b's second clause: a
 *    SUCCESS destroying something the user was not shown. It is the server-side half of the pair
 *    that closed backlog entry X17: the CAPTION tells a human that a bounded text is not whole, and
 *    THIS tells the machine not to offer an edit over it. X17 is closed, so the id no longer
 *    resolves and the pairing is named here instead. It WITHDRAWS THE OFFER; it does not make the
 *    submission impossible, and the write-path paragraph below says whose job that is.
 * 2. THE KIND IS NOT EDITABLE ON THE CONNECTED PROVIDER, by `kindAcceptsSourceEdits`. This is D57,
 *    the defect where a client's declaration can be a different server's, closed on the read path:
 *    the affordance travels with the document from the server that answered it.
 *
 * A REFUSAL PART CARRYING AN OFFER needs no rule here. The excess-property check on a union admits
 * any property declared on ANY member of it, so a part carrying `unavailable` BESIDE `edit`
 * compiles with no cast (MEASURED against tsc 6.0.3 and recorded on `ObjectSourcePart`), but the
 * host core's `checkSourceAnswer` refuses it, since `edit` is no member of a refusal, and the only
 * caller of this function, `POST` in `src/app/api/db/objects/source/route.ts`, hands it only the
 * document the core checked and cut.
 *
 * WHICH OF THE TWO RULES HAS A LIVE PRODUCER TODAY, measured by grep at this commit rather than
 * implied by the fact that both are tested. This paragraph counted ONE producer when PostgreSQL
 * was the only engine that had landed; the day-one set is now three and the count was re-measured
 * rather than the digit bumped, because what it counts is what the paragraph is for.
 *
 * The day-one producers of `edit` are: `PostgresProvider.readObjectSource` in `providers/sql/postgres.ts`, gated on
 * `kindAcceptsSourceEdits(capabilities, kind)`; `TrinoProvider.readObjectSource` in `providers/sql/trino/index.ts` and
 * `RedisProvider.readObjectSource` in `providers/keyvalue/redis.ts`, both gated on `spec.acceptsSourceEdits === true`, which is the
 * same fact read through the same declaration. Later engines may produce it too, as etcd does for a
 * key in `providers/keyvalue/etcd/objects.ts`. Every producer sits on the READABLE arm, verified rather
 * than assumed: no producer attaches `edit` to a part carrying `unavailable`.
 *
 * So rule 2 still has NO live producer, and for the same reason as before: the only thing that can
 * build its population is a DEFECTIVE or a future provider, and the unit tests construct it
 * deliberately, the enforce-rather-than-trust precedent the host core's `checkSourceAnswer` and
 * `boundSourceAnswer` hold for the document's shape and bound, and not an oversight.
 *
 * Rule 1's producer set GREW and its character changed, which is the part a bumped digit would have
 * hidden. On PostgreSQL it is a by-product: that site spreads `truncated` and `edit` from a single
 * read, so a routine over `SOURCE_CHARACTER_LIMIT` reaches it. On Redis it is a DECIDED POSITION,
 * stated at `RedisProvider.readObjectSource` in `redis.ts`: the affordance is offered on a truncated part deliberately, because
 * the bound is the CALLER's and the same object read without one is whole, so a provider that withheld
 * it there would be answering a property of the REQUEST as a property of the object. Rule 1 is what
 * makes that position safe on the standalone path, and the pane's predicate and `buildObjectEdit`'s
 * re-read are what make it safe on the other two.
 *
 * THE WRITE PATH IS NOT COVERED HERE AT ALL, and it never can be. Deleting a field from a READ
 * response cannot bind a caller: a client that never calls `/api/db/objects/source`, or that simply
 * ignores the field that was deleted, can POST the truncated prefix straight to the edit routes.
 * That was an obligation ON THE EDIT-PLAN ROUTE and BOTH HALVES OF IT HAVE LANDED, so what follows
 * names the enforcer of each half and where it sits, MEASURED by grep at this commit.
 *
 * THE KIND, at `POST` in `src/app/api/db/objects/edit-plan/route.ts`: that route calls
 * `requireEditableKind(provider.getCapabilities(), kind, ...)` before it reaches the builder, on the
 * CONNECTED provider and never on the client's copy of the declaration, and its comment there cites
 * this docblock by name as the reason. `POST` in `src/app/api/db/objects/edit-apply/route.ts` asks the same
 * question of the plan's kind, so neither half of the write path takes a caller's word for it.
 *
 * THE BOUND, on both sides of the same constant. `POST` in `edit-plan/route.ts` refuses a SUBMITTED text
 * longer than `EDIT_CHARACTER_LIMIT`, and all three day-one providers refuse a READ definition longer
 * than it inside `buildObjectEdit`: `PostgresProvider.buildObjectEdit` in `providers/sql/postgres.ts`, `RedisProvider.buildObjectEdit` in `providers/keyvalue/redis.ts`
 * and `TrinoProvider.buildObjectEdit` in `providers/sql/trino/index.ts`. The second is what closes the class rather than narrowing
 * it: a plan is minted only from the build's own read, so a definition the pane could only have shown
 * truncated never reaches a plan at all, whatever the client POSTs.
 *
 * EVERY SITE ABOVE IS NAMED, NOT NUMBERED, AND PINNED BY A TEST, because "measured at this commit" is a
 * claim that expires at the next one and nothing in CI reads a code comment. A hand-copied line number
 * here once rotted by twelve lines inside the very branch that wrote this paragraph, from an insertion
 * above it in the provider file it names. `tests/unit/lib/api/object-route-edit.test.ts` holds that each
 * named method and route handler exists in the file this docblock says, and that no citation escapes its
 * table.
 *
 * So this function decides what the UI is OFFERED, and the two edit routes decide what the server
 * ACCEPTS.
 *
 * WHAT THIS CANNOT COVER ON THE READ PATH ITSELF, said out loud rather than left for a reader to
 * assume the opposite.
 * It kills the class on the ROUTE path ONLY. A HOST cannot reach here at all, MEASURED:
 * `handleObjectRequest` takes its provider from `getOrCreateProvider`, which resolves through a
 * closed `switch (connection.type)` in `src/lib/db/factory.ts` with no registration point for
 * anyone else, and the embedded shell has no API routes, so a host implementing the workspace
 * source seam answers its document straight to the pane. The EMBEDDED half is the client-side
 * predicate in `src/components/object-source/source-editable.ts`, which reads the affordance of
 * the document it was handed from that document alone, a refusal part drawn before it and a hybrid
 * refused by `isSourceDocumentShape`, since no host core checked that document. Two halves,
 * deliberately, because neither one covers the other's population.
 *
 * The delete is a REST SPREAD and not a `delete` statement, so the answered part is a new object
 * and the provider's own is not mutated. Each member is read by its VALUE, as the tree's readers
 * read theirs: the host core rebuilt each part to the form its check read it (`boundSourceAnswer`
 * drops every member holding no value), so a part reaching here holds `edit` and `truncated` only
 * with a value (clauses C-62 and C-115).
 */
function stripEdit(part: ObjectSourcePart, kindEditable: boolean): ObjectSourcePart {
  if (
    "edit" in part &&
    part.edit !== undefined &&
    (("truncated" in part && part.truncated !== undefined) || !kindEditable)
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
