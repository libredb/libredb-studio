import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { parseResponseJSON } from "../../../helpers/mock-next";
import { getServerAuditBuffer } from "@/lib/audit";
import { mintPlanToken } from "@/lib/api/object-edit-plan-token";
import { connectionFingerprint } from "@/lib/db/connection-fingerprint";
import { EDIT_PLAN_EXECUTABLE_LIMIT } from "@/lib/db/object-edit";
import type { ObjectEditOutcome } from "@/lib/db/types";
import {
  POST_APPLY as POST,
  CONNECTION,
  CONSEQUENCE,
  EVERY_OUTCOME,
  REFUSAL,
  OUTCOME_BY_AUDIT_KEY,
  REVISION,
  mintValidPlan,
  mintValidPlanContaining,
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

  test("a plan for a connection that differs ONLY in its URI is refused, with its control", async () => {
    // THE HOLE AN EXTERNAL REVIEW OF PR #831 FOUND, driven end to end at the route rather than only
    // at the digest. REPRODUCED against the five-field frame: both connections below answered
    // `1c7e7b2e9f9ee023a97ad141dd3d3c92923bb03472f6b0ff0c726968c3fe28a5`, this request answered 200
    // and `provider.applyObjectEdit` was called once, which is the apply landing on another server.
    //
    // Why the URI and not the five fields: `src/lib/db/providers/sql/postgres.ts:2095-2099` returns
    // `{ ...baseConfig, connectionString }` and NEVER reaches the host/port/user/database branch
    // below it, so these two records are byte-identical in every field the old frame hashed, `id`
    // included, and reach two different servers.
    const ours = { ...CONNECTION, connectionString: "postgres://libredb@127.0.0.1:5432/appdb" };
    const theirs = { ...CONNECTION, connectionString: "postgres://libredb@evil.example:5432/appdb" };
    const { plan } = await mintValidPlan();
    const sealed = { ...plan, connectionFingerprint: await connectionFingerprint(ours) };
    const planToken = await mintPlanToken(sealed);

    mockResolveConnection.mockResolvedValueOnce(theirs);
    const response = await POST(request({ plan: sealed, planToken }));
    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ code: string }>(response)).code).toBe("EDIT_PLAN_INVALID");
    expect(provider.applyObjectEdit).toHaveBeenCalledTimes(0);

    // THE CONTROL, and it is not optional: a frame that refused every URI-bearing connection, or a
    // route that answered 400 for an unrelated reason, would pass every line above. Same plan, same
    // token, and the connection this request resolves is the one it was sealed against.
    mockResolveConnection.mockResolvedValueOnce(ours);
    expect((await POST(request({ plan: sealed, planToken }))).status).toBe(200);
    expect(provider.applyObjectEdit).toHaveBeenCalledTimes(1);
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

  test("a kind the CONNECTED provider does not declare editable answers 400 and calls no apply", async () => {
    // Fix round 1, finding 2. The apply route re-resolves editability on the CONNECTED provider
    // (D57) and NOTHING drove that line: deleting the whole `requireEditableKind` call from
    // `edit-apply/route.ts` left `bun test tests/api/db/objects` at 27 pass / 0 fail, so the line
    // was covered by the happy path walking past it and killed by no mutation. Its build-route twin
    // was pinned all along. `view` is DECLARED by the harness capabilities and NOT editable, which
    // drives `requireEditableKind`'s SECOND sentence rather than its undeclared-kind first one.
    const { plan, planToken } = await mintValidPlan({ kind: "view" });
    const response = await POST(request({ plan, planToken }));
    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toBe(
      'postgres does not apply an edited definition for the kind "view"',
    );
    expect(provider.applyObjectEdit).toHaveBeenCalledTimes(0);
    // Refused BEFORE the decision event, so a write that could never happen leaves no record.
    expect(getServerAuditBuffer().getAll()).toHaveLength(0);
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
    // The loop's own non-vacuity is asserted, and fix round 1 finding 6 is why: emptying
    // `EVERY_OUTCOME` left this suite at 27 pass / 0 fail, because a loop over nothing satisfies
    // every assertion inside it. The number is the audit record's key count and the harness derives
    // the array from that record, so an eighth arm moves both together or fails to compile.
    expect(EVERY_OUTCOME).toHaveLength(Object.keys(OUTCOME_BY_AUDIT_KEY).length);
    expect(EVERY_OUTCOME.length).toBe(7);
    let driven = 0;
    for (const outcome of EVERY_OUTCOME) {
      provider.applyObjectEdit.mockResolvedValueOnce(outcome);
      const response = await POST(request(await mintValidPlan()));
      expect([outcome.outcome, response.status]).toEqual([outcome.outcome, 200]);
      driven += 1;
    }
    expect(driven).toBe(EVERY_OUTCOME.length);
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

  test("THE HARNESS'S SENTINEL PLAN PLANTS NOTHING IN A FIELD THE AUDIT LEGITIMATELY CARRIES", async () => {
    // Fix round 1, finding 1, and the reason it is HERE rather than in wave 8: Task 12's headline
    // assertion is `for (const event of events) expect(JSON.stringify(event)).not.toContain(SENTINEL)`
    // over the events THIS route emits, and `mintValidPlanContaining` is the only producer of that
    // population. Task 11's brief asked for the sentinel in the plan id, and `plan.planId` IS the
    // audit's `correlationId`, so the shipped harness made that assertion go RED against a route
    // that leaks nothing. MEASURED before the harness was changed: EVENTS 2, CONTAINS-SENTINEL true
    // for both. The brief was wrong and this is the test that pins the correction, so a later hand
    // putting the sentinel back into the plan id fails here rather than in another wave's budget.
    const SENTINEL = "libredb-audit-sentinel-9f3a2c";
    const sealed = await mintValidPlanContaining(SENTINEL);
    // Still PRESENT in the two fields Task 12 asserts it is present in, so this is not a test that
    // passes by the sentinel having gone missing altogether.
    expect(sealed.plan.unit.medium === "statement" ? sealed.plan.unit.steps[0].text : "").toContain(SENTINEL);
    expect(sealed.plan.revision.check === "unavailable" ? "" : sealed.plan.revision.token).toContain(SENTINEL);
    expect(sealed.plan.planId).not.toContain(SENTINEL);
    await POST(request(sealed));
    const events = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "object_edit");
    expect(events).toHaveLength(2);
    for (const event of events) expect(JSON.stringify(event)).not.toContain(SENTINEL);
  });

  test("the two events share one correlation id and carry the strategy as the outcome's action", async () => {
    // Fix round 1, findings 7 and 8: every field the brief's audit table pins BY VALUE is asserted
    // against the value it is supposed to be, and not against the other event. The equality
    // `events[0].correlationId === events[1].correlationId` is true BY CONSTRUCTION, because both
    // events spread one `auditFields` object, so it was satisfied by `correlationId: "constant"`
    // and killed nothing. Same for `details`, which the outcome event's own `action` happens to
    // equal here, and for `duration`, which was unasserted.
    const sealed = await mintValidPlan();
    provider.applyObjectEdit.mockResolvedValueOnce({ outcome: "applied", revision: REVISION, duration: 4_711 });
    await POST(request(sealed));
    const events = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "object_edit");
    expect(events).toHaveLength(2);
    expect(events[0].correlationId).toBe(sealed.plan.planId);
    expect(events[1].correlationId).toBe(sealed.plan.planId);
    expect(events[0].action).toBe("PLAN");
    expect(events[1].action).toBe("guarded-atomic-batch");
    expect(events[0].target).toBe("function:app/order_total(integer):definition");
    expect(events[1].target).toBe("function:app/order_total(integer):definition");
    expect(events[0].details).toBe(sealed.plan.strategy);
    expect(events[1].details).toBe(sealed.plan.strategy);
    expect(events[0].result).toBe("success");
    expect(events[1].result).toBe("success");
    // `duration` is the OUTCOME's own number and never the wall clock the route measured: a
    // hardcoded 0 or a re-measured elapsed time would both pass a "there is a duration" assertion.
    expect(events[1].duration).toBe(4_711);
    // The DECISION event carries no duration and no reason: nothing has happened yet to time, and
    // `auditReadingFor({ outcome: "applied" })` returns no reason, so the outcome event carries
    // none either. `reason: undefined` spread in would make both of these true, which is why the
    // assertion is on the KEY and not on the value.
    expect(Object.hasOwn(events[0], "duration")).toBe(false);
    expect(Object.hasOwn(events[0], "reason")).toBe(false);
    expect(Object.hasOwn(events[1], "reason")).toBe(false);
  });

  test("the audit names the connection and the caller, and falls back through the arms in order", async () => {
    // Fix round 1, finding 8. `connectionName` is `name || database || "unknown"`, inherited
    // verbatim from `src/app/api/db/maintenance/route.ts:117`, and BOTH its fallback arms had no
    // population: the harness fixture always carries a name, so `?? "unknown"` on that line killed
    // nothing. `resolveConnection` returns an INLINE caller-supplied connection object verbatim, so
    // a connection whose `name` is empty is the caller's to send and is the live population here.
    //
    // `user`'s own `|| "unknown"` arm is NOT driven here and the reason is MEASURED rather than
    // preferred: `guardRoute` keys the rate limiter on `session.username` BEFORE the handler runs,
    // and a session without one dies at `truncatedKey` in `src/lib/api/rate-limit.ts:213` with
    // `TypeError: undefined is not an object (evaluating 'key.slice')`, which is what a first draft
    // of this test measured. `SessionPayload.username` is a required `string`; the fallback is an
    // obligation of `ObjectRouteContext`'s looser `username?: string` and has no live population.
    const sealed = await mintValidPlan();

    getServerAuditBuffer().clear();
    mockResolveConnection.mockResolvedValueOnce({ ...CONNECTION, name: "" });
    await POST(request(sealed));
    let events = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "object_edit");
    expect(events).toHaveLength(2);
    // The DATABASE arm, which `?? "unknown"` skips entirely.
    expect(events[0].connectionName).toBe("appdb");

    getServerAuditBuffer().clear();
    // Sealed against a connection with NO database, because `connectionFingerprint` folds
    // `database ?? ""` in: minting against `""` and resolving `undefined` are the same fingerprint,
    // and sealing against `appdb` here would drive the plan-invalid arm instead of this one.
    const noDatabase = await mintValidPlan({ database: "" });
    mockResolveConnection.mockResolvedValueOnce({ ...CONNECTION, name: "", database: undefined });
    await POST(request(noDatabase));
    events = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "object_edit");
    expect(events).toHaveLength(2);
    expect(events[0].connectionName).toBe("unknown");
    // And the default arm, so the two fallbacks above are not the only thing this route can answer.
    expect(events[0].user).toBe("reader");

    getServerAuditBuffer().clear();
    await POST(request(sealed));
    events = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "object_edit");
    expect(events[0].connectionName).toBe("Task 11");
  });

  test("the outcome event carries the reading's reason, and the decision event never does", async () => {
    // Fix round 1, finding 8: `...(reading.reason === undefined ? {} : { reason: reading.reason })`
    // had no test that distinguished it from `reason: reading.reason`, because the reason-ABSENT
    // arm (`applied`) was unasserted. Both arms are driven here, one test, so the conditional
    // spread is what is under test rather than the happy path.
    provider.applyObjectEdit.mockResolvedValueOnce({ outcome: "refused", refusal: REFUSAL, duration: 12 });
    await POST(request(await mintValidPlan()));
    const events = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "object_edit");
    expect(events).toHaveLength(2);
    expect(Object.hasOwn(events[0], "reason")).toBe(false);
    expect(events[1].reason).toBe("object_edit_refused");
    expect(events[1].result).toBe("failure");
    expect(events[1].duration).toBe(12);
  });
});
