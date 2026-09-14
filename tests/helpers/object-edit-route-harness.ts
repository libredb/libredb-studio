import { mock } from "bun:test";
import type { NextRequest } from "next/server";
import { getServerAuditBuffer, type AuditEvent } from "@/lib/audit";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { mintPlanToken } from "@/lib/api/object-edit-plan-token";
import { connectionFingerprint } from "@/lib/db/connection-fingerprint";
import { QueryError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/types";
import type {
  ObjectEditBuild,
  ObjectEditConsequence,
  ObjectEditOutcome,
  ObjectEditPlan,
  ObjectEditPreimage,
  ObjectEditRefusal,
  ObjectEditRequest,
  ObjectEditRevision,
  ObjectEditStep,
  ObjectEditUnit,
  ObjectKindSpec,
  ProviderCapabilities,
} from "@/lib/db/types";
import { createMockProvider } from "./mock-provider";

/**
 * The ONE route-test scaffold the two edit-route suites and the security suite stand on
 * (#789 Phase 3, discussion #778).
 *
 * WHY IT IS A HELPER AND NOT THREE LOCALS. `mock.module()` is PROCESS-WIDE in bun, so the three
 * mocks below (`@/lib/auth`, `@/lib/db`, `@/lib/seed/resolve-connection`) are installed once at
 * import time and every importer gets the same stack. That is the property this file exists for.
 * The plan-minting half is not scaffolding a test file can keep private either:
 * `tests/api/db/objects/edit-apply.test.ts` and `tests/security/object-edit-audit.test.ts` both
 * need a token that VERIFIES, which means computing `connectionFingerprint(CONNECTION)` for real
 * and minting through `mintPlanToken`, and two independently written minters would be two chances
 * to seal a plan the route then refuses for a reason the test did not mean to drive. The shipped
 * precedent is `tests/helpers/mock-provider.ts`, which THIRTEEN suites under `tests/api/` import,
 * fourteen across `tests/` once `tests/security/audit-type-safety.test.ts` is counted; this one
 * adds the plan-minting the two edit routes need.
 *
 * THE TWO HANDLERS ARE `POST_PLAN` AND `POST_APPLY` AND NEVER A BARE `POST`. One module cannot
 * export one `POST` that is two different handlers, so the disambiguation lives at the CONSUMER:
 * each suite writes `import { POST_PLAN as POST, ... }` or `import { POST_APPLY as POST, ... }`,
 * which costs one import line and leaves every call site below it reading as `POST(request(...))`,
 * the shape a route test reads as.
 *
 * BOTH ROUTE MODULES ARE IMPORTED AFTER THE MOCKS, with a top-level `await import`, on
 * `tests/api/db-objects.test.ts`'s own precedent. A static import is hoisted above the
 * `mock.module()` calls and the routes would close over the real `@/lib/db`.
 *
 * THE RESET IS `resetHarness` AND EACH SUITE REGISTERS IT ITSELF, for a measured reason recorded on
 * that function: a `beforeEach` called at this module's import time binds to the FIRST importing
 * file only. Three suites assert `toHaveBeenCalledTimes(0)` on the provider mocks and two count the
 * audit ring's own contents, so each has to start every test empty; the rate-limit store is cleared
 * with them because the `query` bucket is 120 per minute per username and these suites drive dozens
 * of requests well inside one.
 */

const KINDS: readonly ObjectKindSpec[] = [
  // The editable kind the day-one PostgreSQL set declares.
  {
    id: "function",
    role: "routine",
    label: "Function",
    labelPlural: "Functions",
    hasSource: true,
    sourceLanguage: "pgsql",
    acceptsSourceEdits: true,
  },
  // DECLARED and NOT editable, which is what gives the build route's editability refusal a real
  // population: a kind this engine publishes a definition for and will not take one back for. A
  // kind that is simply undeclared would drive `requireEditableKind`'s FIRST sentence instead, and
  // the arm this suite means to drive is its second.
  { id: "view", role: "relation", label: "View", labelPlural: "Views", hasSource: true, sourceLanguage: "pgsql" },
];

const CAPABILITIES: Partial<ProviderCapabilities> = { objectKinds: KINDS };

/**
 * The resolved connection every request in these suites is answered for.
 *
 * `database` is `appdb`, which is NEITHER of the two values the apply suite's
 * differs-only-in-database test uses, so both sides of that comparison are overrides and the arm
 * it drives cannot pass on the default by accident.
 */
export const CONNECTION: DatabaseConnection = {
  id: "conn-task-11",
  name: "Task 11",
  type: "postgres",
  host: "127.0.0.1",
  port: 5432,
  database: "appdb",
  user: "libredb",
  createdAt: new Date("2026-09-13T00:00:00.000Z"),
};

const STEP_PROVIDER_TEXT = "CREATE OR REPLACE ";
const STEP_USER_TEXT = "FUNCTION app.order_total(integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$";

/** One statement with a real segment map: a provider prefix and the whole of the user's text. */
export const STEP: ObjectEditStep = {
  text: STEP_PROVIDER_TEXT + STEP_USER_TEXT,
  language: "pgsql",
  segments: [
    { from: "provider", text: STEP_PROVIDER_TEXT },
    { from: "user", start: 0, end: STEP_USER_TEXT.length },
  ],
};

export const PREIMAGE: ObjectEditPreimage = { text: STEP_USER_TEXT, language: "pgsql" };

export const REFUSAL: ObjectEditRefusal = {
  refusal: "privilege",
  sentence: "must be owner of function order_total",
  code: "42501",
  at: { within: "none" },
};

export const REVISION: ObjectEditRevision = {
  check: "guarded",
  token: "xmin:7841",
  basis: "pg_proc.xmin",
  scope: "server",
};

export const CONSEQUENCE: ObjectEditConsequence = {
  loses: "replaces-whole-container",
  fact: { source: "FUNCTION LIST LIBRARYNAME order_lib", observed: "order_total, order_tax" },
};

const FINGERPRINT = await connectionFingerprint(CONNECTION);

/** A valid plan against `CONNECTION`, carrying NO consequence, so a request needs no acknowledgement. */
export const PLAN: ObjectEditPlan = {
  planVersion: 1,
  planId: "plan-task-11",
  issuedAt: "2026-09-13T00:00:00.000Z",
  connectionFingerprint: FINGERPRINT,
  type: "postgres",
  path: ["app", "order_total(integer)"],
  kind: "function",
  partId: "definition",
  strategy: "guarded-atomic-batch",
  unit: { medium: "statement", steps: [STEP] },
  session: [{ mode: "pinned", setting: "search_path", value: "app, pg_catalog" }],
  revision: REVISION,
  consequences: [],
};

/** A well-formed BUILD request body: the four fields the build route reads, plus the connection. */
export const VALID: Record<string, unknown> = {
  connection: CONNECTION,
  path: ["app", "order_total(integer)"],
  kind: "function",
  partId: "definition",
  text: STEP_USER_TEXT,
};

/**
 * A statement unit whose `steps[0].text` is EXACTLY `characters` long.
 *
 * IT ASSERTS ITS OWN OUTPUT before returning, because a padder that lands one character on the
 * wrong side of a bound turns a bound test into a coin flip that passes for the wrong reason. The
 * map is ONE PROVIDER SEGMENT carrying the whole text, which is what `spansTheText` in
 * `src/lib/api/object-edit-wire.ts` requires: the segments laid end to end span the text exactly,
 * and a provider segment's bytes must BE the text at its computed offset.
 *
 * One padder for both bound tests, one at build and one at apply, because two independently
 * written ones would be two chances to sit on the wrong side of the same bound.
 */
export function unitOfLength(characters: number): ObjectEditUnit {
  const text = "x".repeat(characters);
  if (text.length !== characters) {
    throw new Error(`unitOfLength built ${text.length} characters and was asked for ${characters}`);
  }
  return { medium: "statement", steps: [{ text, language: "pgsql", segments: [{ from: "provider", text }] }] };
}

/** `PLAN` carrying `unitOfLength(characters)`, and it asserts the same length through it. */
export function planWithUnitOfLength(characters: number): ObjectEditPlan {
  const unit = unitOfLength(characters);
  return { ...PLAN, unit };
}

/**
 * A mock `DatabaseProvider` carrying the two Phase 3 methods as `mock()` functions.
 *
 * The two are assigned onto the object rather than passed through `MockProviderOverrides`, which
 * knows nothing about them: this file is their only consumer, and widening that helper would put a
 * Phase 3 concern into a file thirteen Phase 1 and 2 suites import.
 */
export const provider = Object.assign(createMockProvider({ capabilities: CAPABILITIES }), {
  buildObjectEdit: mock(
    async (_request: ObjectEditRequest): Promise<ObjectEditBuild> => ({ built: true, plan: PLAN, preimage: PREIMAGE }),
  ),
  applyObjectEdit: mock(
    async (_plan: ObjectEditPlan): Promise<ObjectEditOutcome> => ({
      outcome: "applied",
      revision: REVISION,
      duration: 3,
    }),
  ),
});

export const mockGetOrCreateProvider = mock(async () => provider);
export const mockGetSession = mock(async () => ({ role: "user", username: "reader" }) as unknown);
export const mockResolveConnection = mock(async (): Promise<DatabaseConnection> => CONNECTION);

mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

mock.module("@/lib/seed/resolve-connection", () => {
  class SeedConnectionError extends Error {
    constructor(
      message: string,
      public statusCode: number,
    ) {
      super(message);
      this.name = "SeedConnectionError";
    }
  }
  return { resolveConnection: mockResolveConnection, SeedConnectionError };
});

mock.module("@/lib/db", () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(),
  removeProvider: mock(),
  clearProviderCache: mock(),
  getProviderCacheStats: mock(),
  QueryError,
  BaseDatabaseProvider: class {},
}));

const editPlanRoute = await import("@/app/api/db/objects/edit-plan/route");
const editApplyRoute = await import("@/app/api/db/objects/edit-apply/route");

/** The BUILD handler. Aliased to `POST` at each suite's own import, never exported as a bare `POST`. */
export const POST_PLAN = editPlanRoute.POST;
/** The APPLY handler, same rule. */
export const POST_APPLY = editApplyRoute.POST;

/**
 * A POST carrying `body` as JSON.
 *
 * A plain `Request` cast to `NextRequest`, which is what `tests/api/db-objects.test.ts` already
 * does at each of its own call sites: `handleObjectRequest` reads `req.body` as a stream and hands
 * the request to `guardRoute`, which reads headers, and both are `Request`'s own surface. The cast
 * lives here rather than at twenty-six call sites.
 */
export function request(body: Record<string, unknown>): NextRequest {
  return new Request("http://localhost:3100/api/db/objects/edit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;
}

/**
 * A plan that verifies, plus its token.
 *
 * `overrides` merges into the plan BEFORE the token is minted, so a caller asking for
 * `{ consequences: [CONSEQUENCE] }` gets a token that MATCHES the plan it is handed, rather than
 * one the route refuses for a digest mismatch the test did not mean to drive.
 *
 * `database` is NOT a plan field and is handled apart: it recomputes the fingerprint from
 * `{ ...CONNECTION, database }`, which is the only way to build the population the apply route's
 * different-server arm exists for. A plan built against `db1` reaching a request that resolved
 * `db2` differs ONLY in database, so `connection.id` is IDENTICAL on both sides and an id check
 * would pass. That is the case an id check cannot see: MEASURED, `resolveConnection` returns an
 * inline connection object verbatim, id included.
 *
 * `clock` is threaded to `mintPlanToken`, so the expiry arm is asserted rather than waited out.
 */
export async function mintValidPlan(
  overrides: Partial<ObjectEditPlan> & { readonly database?: string } = {},
  clock?: () => number,
): Promise<{ plan: ObjectEditPlan; planToken: string }> {
  const { database, ...planFields } = overrides;
  const fingerprint = database === undefined ? FINGERPRINT : await connectionFingerprint({ ...CONNECTION, database });
  const plan: ObjectEditPlan = { ...PLAN, connectionFingerprint: fingerprint, ...planFields };
  return { plan, planToken: await mintPlanToken(plan, clock) };
}

/**
 * The same, with `sentinel` placed in the unit's text, in the revision token and in the plan id.
 *
 * Three fields rather than one, because Task 12's single leak assertion is over the audit record
 * and the stdout line, and a sentinel sitting only in the statement would certify nothing about
 * the other plan strings an audit field could pick up. The plan id is the audit's `correlationId`,
 * so that one is deliberately a field the events DO carry.
 */
export async function mintValidPlanContaining(sentinel: string): Promise<{ plan: ObjectEditPlan; planToken: string }> {
  const text = `${STEP_PROVIDER_TEXT}${sentinel}`;
  return mintValidPlan({
    planId: `plan-${sentinel}`,
    unit: { medium: "statement", steps: [{ text, language: "pgsql", segments: [{ from: "provider", text }] }] },
    revision: { check: "guarded", token: sentinel, basis: "pg_proc.xmin", scope: "server" },
  });
}

/**
 * One member per arm of `ObjectEditOutcome`, INCLUDING BOTH `conflict` arms, so a loop over this is
 * a loop over the union and not over six of its seven.
 */
export const EVERY_OUTCOME: readonly ObjectEditOutcome[] = [
  { outcome: "applied", revision: REVISION, duration: 4 },
  { outcome: "applied-with-collateral", lost: [CONSEQUENCE], revision: REVISION, duration: 5 },
  { outcome: "applied-elsewhere", undone: true, wrote: "app.order_total(bigint)", duration: 6 },
  { outcome: "conflict", conflict: "object-changed", current: { text: "SELECT 2", language: "pgsql" }, duration: 7 },
  { outcome: "conflict", conflict: "engine-refused-concurrent", sentence: "tuple concurrently updated", duration: 8 },
  { outcome: "refused", refusal: REFUSAL, duration: 9 },
  { outcome: "interrupted", committed: "unknown", sentence: "Connection terminated unexpectedly", duration: 10 },
];

/** One valid apply, and the two `object_edit` events it left in the ring, in order. */
export async function applyAndRead(): Promise<readonly AuditEvent[]> {
  await POST_APPLY(request(await mintValidPlan()));
  return getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === "object_edit");
}

/**
 * The per-test reset, and it is EXPORTED and registered by each suite rather than registered here.
 *
 * The brief named twenty-one exports and this is a twenty-second, added because the shape it
 * replaces DOES NOT WORK and the failure is measured rather than argued. A `beforeEach` called at
 * this module's own import time binds to the file that was executing when the import ran, which is
 * the FIRST importer only. MEASURED at this commit: with the reset registered here,
 * `bun test tests/api/db/objects` ran 27 tests across the two suites and answered 21 pass, 6 fail,
 * every failure in `edit-apply.test.ts`, which is the second file bun loaded, and both files pass
 * when run one at a time. The three call-count assertions and the two audit-ring counts in that
 * suite were reading state the plan suite had left.
 *
 * The alternative was three copies of this body in three suites, which is the duplication D69 was
 * filed for and the exact thing this helper exists to prevent.
 */
export function resetHarness(): void {
  provider.buildObjectEdit.mockClear();
  provider.applyObjectEdit.mockClear();
  mockGetOrCreateProvider.mockClear();
  mockGetSession.mockClear();
  mockResolveConnection.mockClear();
  getServerAuditBuffer().clear();
  clearRateLimitState();
}
