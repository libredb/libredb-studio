import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { parseResponseJSON } from "../../../helpers/mock-next";
import { getServerAuditBuffer } from "@/lib/audit";
import { EDIT_PLAN_EXECUTABLE_LIMIT } from "@/lib/db/object-edit";
import type { ObjectEditOutcome } from "@/lib/db/types";
import {
  POST_APPLY as POST,
  CONNECTION,
  CONSEQUENCE,
  EVERY_OUTCOME,
  REVISION,
  mintValidPlan,
  mockGetOrCreateProvider,
  mockGetSession,
  mockResolveConnection,
  provider,
  request,
  resetHarness,
  unitOfLength,
} from "../../../helpers/object-edit-route-harness";

/**
 * `POST /api/db/objects/edit-apply`, the half that WRITES (#789 Phase 3, discussion #778).
 *
 * `POST` here is the APPLY handler, aliased at the import above; the harness never exports a bare
 * `POST`, because one module cannot export one `POST` that is two different handlers.
 *
 * This suite adds NO mocking of its own: the stack, the audit-ring reset and the rate-limit reset
 * are the harness's, and `mock.module()` is process-wide.
 *
 * The audit ring is read through `getAll()`. The brief's own test text says `list()`;
 * `AuditRingBuffer` in `src/lib/audit.ts` publishes `getAll()`, `getRecent()`, `filter()`,
 * `toJSON()` and `size`, and that file belongs to another task, so the reader here is the one the
 * shipped class actually has.
 */
describe("POST /api/db/objects/edit-apply", () => {
  beforeEach(resetHarness);

  test("refuses an unauthenticated caller BEFORE any provider is built", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const response = await POST(request({}));
    expect(response.status).toBe(401);
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(0);
  });

  test("a tampered plan answers 400 EDIT_PLAN_INVALID, emits ONE audit event, and calls no provider", async () => {
    const { plan, planToken } = await mintValidPlan();
    const response = await POST(request({ plan: { ...plan, partId: "body" }, planToken }));
    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ code: string }>(response)).code).toBe("EDIT_PLAN_INVALID");
    expect(provider.applyObjectEdit).toHaveBeenCalledTimes(0);
    const events = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "object_edit");
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("object_edit_plan_invalid");
    expect(events[0].result).toBe("failure");
  });

  test("a body carrying no readable plan answers 400 and emits NO audit event", async () => {
    // NOT in the brief's list. The shape check runs BEFORE the seal, because the audit event the
    // seal's refusal emits reads `plan.kind`, `plan.path` and `plan.planId`, and a body that is not
    // a plan has none of them. So this arm has to answer without an event, and a route that emitted
    // one anyway would be writing `undefined:undefined:undefined` into the operator's log.
    const response = await POST(request({ plan: { planVersion: 2 }, planToken: "x" }));
    expect(response.status).toBe(400);
    expect(getServerAuditBuffer().getAll()).toHaveLength(0);
    expect(provider.applyObjectEdit).toHaveBeenCalledTimes(0);
  });

  test("a plan for a connection that differs ONLY in database is refused", async () => {
    // This is the case a `connection.id` check cannot see: MEASURED, `resolveConnection` returns an
    // inline connection object verbatim, id included, and the browser drove it with a made-up id and
    // different credentials.
    const { plan, planToken } = await mintValidPlan({ database: "db1" });
    mockResolveConnection.mockResolvedValueOnce({ ...CONNECTION, database: "db2" });
    expect((await POST(request({ plan, planToken }))).status).toBe(400);
  });

  test("an expired token is refused with its own sentence", async () => {
    // The clock is injected through the mint helper rather than waited out: the TTL is 900 seconds.
    const { plan, planToken } = await mintValidPlan({}, () => Date.now() - 3_600_000);
    const response = await POST(request({ plan, planToken }));
    expect(response.status).toBe(400);
    const body = await parseResponseJSON<{ error: string; code: string }>(response);
    expect(body.code).toBe("EDIT_PLAN_INVALID");
    expect(body.error).toBe("this preview has expired");
    expect(provider.applyObjectEdit).toHaveBeenCalledTimes(0);
  });

  test("a VALIDLY SEALED plan above the executable bound is REFUSED HERE TOO, and calls no provider", async () => {
    // ENFORCING rather than trusting. The token proves this server issued the plan; it proves
    // nothing about what this server's bound is TODAY. `mintValidPlan` seals whatever it is given,
    // so this drives the exact case a valid token cannot exclude: a plan whose unit is over the
    // bound arriving with a signature that verifies.
    const { plan, planToken } = await mintValidPlan({ unit: unitOfLength(EDIT_PLAN_EXECUTABLE_LIMIT + 1) });
    const response = await POST(request({ plan, planToken }));
    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("this apply would send");
    expect(provider.applyObjectEdit).toHaveBeenCalledTimes(0);
  });

  test("a plan carrying a consequence the request did not acknowledge answers 400 and calls no provider", async () => {
    // A client-only confirmation satisfies nothing a server can assert: the shipped query
    // confirmation is a client modal with a `skipSafety` bypass.
    const { plan, planToken } = await mintValidPlan({ consequences: [CONSEQUENCE] });
    expect((await POST(request({ plan, planToken }))).status).toBe(400);
    expect((await POST(request({ plan, planToken, acknowledged: ["destroys-comment"] }))).status).toBe(400);
    expect(provider.applyObjectEdit).toHaveBeenCalledTimes(0);
    expect((await POST(request({ plan, planToken, acknowledged: ["replaces-whole-container"] }))).status).toBe(200);
  });

  test("a provider that declares the kind and holds no applyObjectEdit answers 400", async () => {
    // NOT in the brief's list, and here for the same reason its build-route twin is: the method is
    // OPTIONAL on `DatabaseProvider`, so the route holds a branch for its absence and a branch
    // nothing drives is a line the coverage gate counts and no mutation can kill.
    const apply = provider.applyObjectEdit;
    (provider as { applyObjectEdit?: unknown }).applyObjectEdit = undefined;
    try {
      const response = await POST(request(await mintValidPlan()));
      expect(response.status).toBe(400);
      expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("no edit applier");
      // The refusal is decided BEFORE the decision event, so an apply that could never run leaves
      // no record claiming it was about to.
      expect(getServerAuditBuffer().getAll()).toHaveLength(0);
    } finally {
      (provider as { applyObjectEdit?: unknown }).applyObjectEdit = apply;
    }
  });

  test("every outcome answers 200 with the typed union", async () => {
    for (const outcome of EVERY_OUTCOME) {
      provider.applyObjectEdit.mockResolvedValueOnce(outcome);
      const response = await POST(request(await mintValidPlan()));
      expect([outcome.outcome, response.status]).toEqual([outcome.outcome, 200]);
    }
  });

  test("a provider that THROWS answers 200 interrupted, never a 500, and the audit records it", async () => {
    // Once `applyObjectEdit` has been CALLED, no error escapes this route as an HTTP error. That one
    // rule closes three measured defects at once: a deliberate refusal can never be a 500, a timeout
    // can never answer `retryable: true`, and a provider that forgets to classify one of its
    // engine's errors degrades to "the disposition is unknown" rather than to a false success.
    provider.applyObjectEdit.mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));
    const response = await POST(request(await mintValidPlan()));
    expect(response.status).toBe(200);
    const body = await parseResponseJSON<{ outcome: string; committed: string; retryable?: unknown }>(response);
    expect(body.outcome).toBe("interrupted");
    expect(body.committed).toBe("unknown");
    // `retryable` appears nowhere on this route at any status: a client that retries an apply whose
    // disposition is unknown applies twice.
    expect(Object.hasOwn(body, "retryable")).toBe(false);
    const events = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "object_edit");
    expect(events).toHaveLength(2);
    expect(events[1].reason).toBe("object_edit_interrupted");
  });

  test("a provider that answers a MALFORMED outcome is interrupted rather than trusted", async () => {
    // Cast for the reason the build suite's hybrid records: tsc narrows a LITERAL discriminant and
    // rejects the extra property here, while a provider assembling the same answer through a wider
    // expression compiles with none. That is the population this arm exists for.
    provider.applyObjectEdit.mockResolvedValueOnce({
      outcome: "applied",
      revision: REVISION,
      duration: 1,
      conflict: "object-changed",
    } as unknown as ObjectEditOutcome);
    const body = await parseResponseJSON<{ outcome: string }>(await POST(request(await mintValidPlan())));
    // The engine has already acted, so the honest answer is that the disposition is unknown. A 400
    // here would say the CALLER made a mistake, and a success would be the lie this arm exists to
    // prevent.
    expect(body.outcome).toBe("interrupted");
  });

  test("THE DECISION EVENT PRECEDES THE PROVIDER CALL, and an unauditable apply never happens", async () => {
    // `src/lib/db/operations/execution.ts:11-20` states the rule for the agent path: emission is not
    // wrapped in a try/catch, so ANY audit-sink failure propagates and the provider is never invoked.
    const sealed = await mintValidPlan();
    const sink = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink is down");
    });
    try {
      const response = await POST(request(sealed));
      expect(response.status).toBe(500);
      expect(provider.applyObjectEdit).toHaveBeenCalledTimes(0);
    } finally {
      sink.mockRestore();
    }
  });

  test("the OUTCOME event's sink throwing leaves the 200 intact", async () => {
    // `src/app/api/db/maintenance/route.ts:108-131` verbatim, including its stated reason: the
    // engine has already acted and a broken sink must not turn a completed apply into a 500 that
    // invites a retry that would be a SECOND DDL.
    const sealed = await mintValidPlan();
    let calls = 0;
    const sink = spyOn(console, "log").mockImplementation(() => {
      calls += 1;
      if (calls > 1) throw new Error("audit sink is down");
    });
    try {
      expect((await POST(request(sealed))).status).toBe(200);
    } finally {
      sink.mockRestore();
    }
    expect(calls).toBe(2);
  });

  test("the two events share one correlation id and carry the strategy as the outcome's action", async () => {
    await POST(request(await mintValidPlan()));
    const events = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "object_edit");
    expect(events).toHaveLength(2);
    expect(events[0].correlationId).toBe(events[1].correlationId);
    expect(events[0].action).toBe("PLAN");
    expect(events[1].action).toBe("guarded-atomic-batch");
    expect(events[1].target).toBe("function:app/order_total(integer):definition");
  });
});
