import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { getServerAuditBuffer } from "@/lib/audit";
import { auditReadingFor } from "@/lib/db/object-edit";
import {
  POST_APPLY as POST,
  EVERY_OUTCOME,
  applyAndRead,
  mintValidPlan,
  mintValidPlanContaining,
  provider,
  request,
  resetHarness,
} from "../helpers/object-edit-route-harness";

/**
 * Control 3.6: the first security control row in this repository that covers a database WRITE
 * (#789 Phase 3, discussion #778).
 *
 * WHAT THIS SUITE IS FOR, as distinct from `tests/api/db/objects/edit-apply.test.ts`. That suite
 * asks whether the route behaves; this one asks the two questions the posture page's row makes a
 * claim about, and it asks them over the AUTHORITATIVE channel. `src/lib/audit.ts:480-489` states
 * which channel that is: the in-process ring buffer is a convenience view for the admin UI, and the
 * one JSON line per event on stdout is the record a log pipeline consumes. A leak that reaches the
 * ring and not stdout, and the reverse, are two different defects, so both are asserted separately
 * and both carry their own mutation in this task's work file.
 *
 * RULING 1c IS WHAT IS UNDER TEST: an apply emits a new `AuditEventType` arm, `object_edit`, and
 * its outcome cannot be a boolean, because seven measured paths across five engines succeed while
 * destroying something the user was not shown. So the outcome map is walked at RUNTIME here, over
 * every arm the union can produce, and not merely trusted because it type-checks.
 *
 * THREE DEVIATIONS FROM THE BRIEF'S OWN TEST TEXT, each because the shipped code says otherwise.
 *
 * 1. The ring is read through `getAll()` and not `list()`. `AuditRingBuffer` publishes `getAll()`,
 *    `getRecent()`, `filter()`, `toJSON()` and `size`; there is no `list()`, and `src/lib/audit.ts`
 *    belongs to another task. `tests/api/db/objects/edit-apply.test.ts` records the same deviation.
 * 2. `resetHarness` is imported alongside the seven names the brief named. Task 11's harness
 *    exports the per-test reset deliberately UNREGISTERED, with the measurement on it: a
 *    `beforeEach` called at the harness's own import time binds to the first importing file only.
 *    Two of the four tests below assert an exact event COUNT, so a suite that does not start each
 *    test with an empty ring is asserting against whatever the previous test left.
 * 3. `plan.unit.steps[0].text` is reached through the `medium === "statement"` narrowing.
 *    `ObjectEditUnit` is a union and its `command` arm carries no `steps`, so the brief's
 *    unnarrowed spelling does not compile. Same narrowing, same reason, as the apply suite.
 *
 * This suite builds NO mocking of its own: the `@/lib/auth` + `@/lib/db` + `resolve-connection`
 * stack, the mock provider, the request builder and the plan minting are all Task 11's harness,
 * because `mock.module()` is process-wide and two copies of one route-mock stack drift in the
 * direction that makes both suites pass (D69).
 */
describe("object edit apply: the audited write (control 3.6)", () => {
  beforeEach(resetHarness);

  test("every apply emits exactly two events sharing one correlation id", async () => {
    // "EVERY apply" is driven as every OUTCOME the provider can answer with, rather than as one
    // happy path called every: the pairing is what an operator groups by, and an outcome arm that
    // emitted one event, or three, or two under different ids, would be invisible to a test that
    // drove `applied` alone. The ring is cleared per iteration so the count is exact rather than
    // cumulative, which is what makes the assertion able to see a THIRD event as well as a missing
    // second one.
    //
    // A plan the seal refuses is deliberately not in this population and is not a counter-example:
    // it emits ONE event and calls no provider, because no write happened. That arm is asserted in
    // `tests/api/db/objects/edit-apply.test.ts`.
    //
    // EVERY ITERATION DRIVES A DIFFERENT PLAN ID, and that is the half of this claim a reviewer
    // MEASURED as vacuous in fix round 1: with every iteration minting the harness default
    // `plan-task-11`, replacing `correlationId: plan.planId` in the route with the LITERAL
    // `"plan-task-11"` left `bun test tests/security/object-edit-audit.test.ts
    // tests/api/db/objects` at 35 pass / 0 fail. A route that stamped every apply in a deployment
    // with one constant id passes an equality assertion against one constant, and it is precisely
    // the failure that breaks an operator grouping a decision with its verdict. The ids are also
    // collected and their distinctness asserted after the loop, so an id that tracks the ITERATION
    // rather than the plan cannot pass either.
    expect(EVERY_OUTCOME.length).toBeGreaterThan(0);
    const correlationIds: string[] = [];
    for (const [index, outcome] of EVERY_OUTCOME.entries()) {
      getServerAuditBuffer().clear();
      provider.applyObjectEdit.mockResolvedValueOnce(outcome);
      const sealed = await mintValidPlan({ planId: `plan-correlation-${index}` });
      await POST(request(sealed));
      const events = getServerAuditBuffer()
        .getAll()
        .filter((event) => event.type === "object_edit");
      expect(events).toHaveLength(2);
      expect(events[0].correlationId).toBe(sealed.plan.planId);
      expect(events[1].correlationId).toBe(sealed.plan.planId);
      correlationIds.push(String(events[0].correlationId));
      // The two are a DECISION and an OUTCOME and not the same record twice: the decision is the
      // one emitted before the provider was called, and it is the one that survives when the
      // engine never answers.
      expect(events[0].action).toBe("PLAN");
      expect(events[1].action).toBe(sealed.plan.strategy);
    }
    expect(new Set(correlationIds).size).toBe(EVERY_OUTCOME.length);
  });

  test("the outcome map is TOTAL over every arm, walked at runtime as well as typed", async () => {
    // The type-level totality is proven by deleting a key from `OBJECT_EDIT_AUDIT` and running
    // `bun run typecheck`, which is recorded in this task's work file. This is the runtime half:
    // every arm the union can produce reaches an event with a reading. A `Record` that type-checks
    // says nothing about whether the route READS it on the path an outcome actually travels.
    for (const outcome of EVERY_OUTCOME) {
      provider.applyObjectEdit.mockResolvedValueOnce(outcome);
      await POST(request(await mintValidPlan()));
      const [, last] = getServerAuditBuffer()
        .getAll()
        .filter((event) => event.type === "object_edit")
        .slice(-2);
      expect(last.result).toBe(auditReadingFor(outcome).result);
      // `reason` is asserted through `Object.hasOwn` on the absent arm as well as by value on the
      // present one: `applied` has no reason, and `expect(undefined).toBe(undefined)` passes
      // against an event that dropped the field and against one that never had it.
      const reason = auditReadingFor(outcome).reason;
      expect(last.reason).toBe(reason);
      expect(Object.hasOwn(last, "reason")).toBe(reason !== undefined);
    }
  });

  test("NO event carries a character of the statement, the payload, the engine's words or either token", async () => {
    // The sentinel appears in the unit text, in the revision token and in the engine's message, so
    // a leak through ANY of those is one assertion.
    //
    // THE PLAN TOKEN IS CHECKED AGAINST ITSELF AND NOT AGAINST THE SENTINEL, which is fix round 1
    // finding 3: the token is an HMAC over the plan, so it CANNOT textually contain a planted
    // string, and this test's title names it. A sentinel population is structurally incapable of
    // seeing a plan-token leak, and MEASURED it did not: with the decision event carrying
    // `connectionName: planToken.slice(0, 200)`, this suite answered 4 pass / 0 fail. The bearer
    // proof that re-authorises the write is therefore asserted by value, below, against both the
    // ring record and the stdout line.
    //
    // The sentinel is deliberately NOT in the plan id:
    // `plan.planId` IS the correlation id both events carry by design, and Task 11 MEASURED that a
    // sentinel planted there turns this assertion red against a route that leaks nothing.
    const SENTINEL = "libredb-audit-sentinel-9f3a2c";
    const sealed = await mintValidPlanContaining(SENTINEL);
    const { plan } = sealed;
    const lines: string[] = [];
    const sink = spyOn(console, "log").mockImplementation((line: string) => void lines.push(String(line)));
    try {
      provider.applyObjectEdit.mockResolvedValueOnce({
        outcome: "refused",
        refusal: {
          refusal: "definition",
          sentence: `syntax error near ${SENTINEL}`,
          code: SENTINEL,
          at: { within: "none" },
        },
        duration: 1,
      });
      await POST(request(sealed));
    } finally {
      sink.mockRestore();
    }
    const events = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "object_edit");
    expect(events).toHaveLength(2);
    for (const event of events) expect(JSON.stringify(event)).not.toContain(SENTINEL);

    // THE PLAN TOKEN, BY VALUE, AND AS A PROBE RATHER THAN AS THE WHOLE STRING, and which of the
    // two is asserted where is MEASURED and not chosen. `sanitizeAuditField` in `src/lib/audit.ts`
    // bounds every free-text field at `MAX_AUDIT_FIELD_LENGTH`, 254, "before it can reach either
    // destination", and this harness's token is 343 characters long (measured at this commit, 278
    // of them the payload segment). So a leaked token NEVER appears verbatim in an AuditEvent
    // field: `not.toContain(sealed.planToken)` over an event is a guard whose population cannot
    // contain the case, which is this epic's signature defect, and it is deliberately not written
    // here. MEASURED both ways in this task's fix round: with the decision event carrying
    // `connectionName: planToken.slice(0, 200)` AND with it carrying the whole `planToken`, the
    // failure landed on the PROBE assertion below, by line number, at 3 pass / 1 fail each time.
    //
    // The probe is forty characters taken from inside the JWS payload segment, past the header
    // every token of this type shares, so it is unique to THIS token and survives truncation. Its
    // own length is asserted first, because `not.toContain("")` is true of every string.
    const tokenPayload = sealed.planToken.split(".")[1] ?? "";
    const tokenProbe = tokenPayload.slice(0, 40);
    expect(tokenProbe).toHaveLength(40);
    for (const event of events) expect(JSON.stringify(event)).not.toContain(tokenProbe);

    // THE POPULATION IS PROVEN NON-EMPTY BEFORE IT IS WALKED.
    // `for (const line of lines) expect(line).not.toContain(...)` CERTIFIES NOTHING when `lines` is
    // `[]`, and `lines` is `[]` whenever the spy is installed after the emitter binds its writer or
    // the route writes through a different channel. This epic's signature defect is a guard over a
    // population that cannot contain its case, and this is acceptance criterion 7.
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // And the sentinel must be PRESENT in the two places it was planted, so the assertion below is
    // known to be discriminating rather than trivially true of a string nobody produced.
    expect(plan.unit.medium === "statement" ? plan.unit.steps[0].text : "").toContain(SENTINEL);
    expect(plan.revision.check === "unavailable" ? plan.revision.reason : plan.revision.token).toContain(SENTINEL);
    // And in no line the emitter wrote to stdout, which is the authoritative channel and the one a
    // log pipeline consumes. The token is checked on this channel too: a leak that reaches stdout
    // and not the ring, and the reverse, are two different defects.
    // The WHOLE token is asserted on this channel and not on the ring, and the asymmetry has a
    // reason: a line on stdout need not have come through `sanitizeAuditField` at all, and a stray
    // `console.log` of the request body would carry all 343 characters untruncated. The probe
    // covers the sanitized path on both channels.
    for (const line of lines) {
      expect(line).not.toContain(SENTINEL);
      expect(line).not.toContain(sealed.planToken);
      expect(line).not.toContain(tokenProbe);
    }
  });

  test("the claim the log makes is the NARROW one, and the target names the address", async () => {
    // The event says an edit was applied AT THIS ADDRESS, with this strategy, and with this
    // outcome. It does NOT say the round trip carried nothing else, and it cannot: the day-one
    // PostgreSQL unit is a multi-statement simple query and this repository has measured itself
    // unable to count the statements in a routine body. That limit is written on the posture page
    // under "Notes on individual rows" rather than left for a reader of the log to discover.
    const events = await applyAndRead();
    expect(events[1].target).toBe("function:app/order_total(integer):definition");
    expect(events[1].details).toBe("guarded-atomic-batch");
  });
});
