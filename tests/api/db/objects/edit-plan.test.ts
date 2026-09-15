import { beforeEach, describe, expect, test } from "bun:test";
import { parseResponseJSON } from "../../../helpers/mock-next";
import { getServerAuditBuffer } from "@/lib/audit";
import { EDIT_CHARACTER_LIMIT, EDIT_PLAN_EXECUTABLE_LIMIT } from "@/lib/db/object-edit";
import type { ObjectEditBuild } from "@/lib/db/types";
import {
  POST_PLAN as POST,
  PLAN,
  PREIMAGE,
  REFUSAL,
  STEP,
  VALID,
  mockGetOrCreateProvider,
  mockGetSession,
  planWithUnitOfLength,
  provider,
  request,
  resetHarness,
} from "../../../helpers/object-edit-route-harness";

/**
 * `POST /api/db/objects/edit-plan`, the BUILD half (#789 Phase 3, discussion #778).
 *
 * `POST` here is the BUILD handler, aliased at the import above. The harness exports the two
 * handlers as `POST_PLAN` and `POST_APPLY` and never as a bare `POST`, because one module cannot
 * export one `POST` that is two different handlers; the alias is what keeps every call site below
 * reading as a route test.
 *
 * This suite adds NO mocking of its own. The whole `@/lib/auth` + `@/lib/db` +
 * `resolve-connection` stack, the audit-ring reset and the rate-limit reset are the harness's, and
 * `mock.module()` is process-wide, so a second copy here would be a second stack over one graph.
 */
describe("POST /api/db/objects/edit-plan", () => {
  beforeEach(resetHarness);

  test("refuses an unauthenticated caller BEFORE any provider is built", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const response = await POST(request({}));
    expect(response.status).toBe(401);
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(0);
  });

  test("a body above the byte bound answers 413 with a sentence naming the real reason", async () => {
    const response = await POST(request({ text: "x".repeat(9_000_000) }));
    expect(response.status).toBe(413);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("larger than");
  });

  test("a text above the character bound answers 413, and never a truncated body reported as empty", async () => {
    const response = await POST(
      request({ path: ["app", "f(integer)"], kind: "function", partId: "definition", text: "x".repeat(1_000_001) }),
    );
    expect(response.status).toBe(413);
  });

  test("a kind the CONNECTED provider does not declare editable answers 400 and calls no build", async () => {
    // The client predicate is an affordance and not a gate: a tampered client, an old client, or a
    // host that lies gets the provider's refusal. D57 is why this is re-resolved here.
    const response = await POST(
      request({ path: ["app", "order_summary"], kind: "view", partId: "definition", text: "SELECT 1" }),
    );
    expect(response.status).toBe(400);
    expect(provider.buildObjectEdit).toHaveBeenCalledTimes(0);
  });

  test("a provider that declares the kind and holds no buildObjectEdit answers 400", async () => {
    // NOT in the brief's list and added because the method is OPTIONAL on `DatabaseProvider`, so
    // the route holds a branch for its absence and a branch nothing drives is a line the coverage
    // gate counts and no mutation can kill. Same two-conjunct shape and same 400 grammar as
    // `requireSourceReader`, whose second conjunct exists for exactly this state.
    const build = provider.buildObjectEdit;
    (provider as { buildObjectEdit?: unknown }).buildObjectEdit = undefined;
    try {
      const response = await POST(request(VALID));
      expect(response.status).toBe(400);
      expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("no edit");
    } finally {
      (provider as { buildObjectEdit?: unknown }).buildObjectEdit = build;
    }
  });

  test("a build that answers a plan answers 200 with the plan, the pre-image and a token", async () => {
    const body = await parseResponseJSON<{ built: boolean; plan: unknown; preimage: unknown; planToken: string }>(
      await POST(request(VALID)),
    );
    expect(body.built).toBe(true);
    expect(typeof body.planToken).toBe("string");
    // The pre-image rides in the RESPONSE and never inside the plan: the response is outbound and is
    // subject to no body clone, while a plan carrying both would be about 12 MB inbound on the apply
    // and would be silently cut at 10,485,760 bytes.
    expect(body.preimage).toBeDefined();
    expect(Object.hasOwn(body.plan as object, "preimage")).toBe(false);
  });

  test("a build that REFUSES answers 200 with the refusal, because the engine's verdict is the payload", async () => {
    provider.buildObjectEdit.mockResolvedValueOnce({
      built: false,
      refusal: {
        refusal: "privilege",
        sentence: "must be owner of function order_total",
        code: "42501",
        at: { within: "none" },
      },
    });
    const response = await POST(request(VALID));
    expect(response.status).toBe(200);
    // A deliberate engine refusal is never a 4xx and never a 5xx: the request was well formed and
    // was carried out, and today the identical refusal reaches the browser as HTTP 401
    // "Authentication failed: permission denied for schema app".
    expect((await parseResponseJSON<{ built: boolean }>(response)).built).toBe(false);
  });

  test("a build answering BOTH a plan and a refusal answers 400 and nothing is returned to the caller", async () => {
    // THE CAST IS PART OF THE EVIDENCE. Measured against tsc 6.0.3 at this commit: written out as a
    // literal with a LITERAL discriminant, tsc narrows to the `built: false` member and rejects the
    // two extra properties, so the hybrid needs the cast HERE. A provider assembling the same object
    // through a wider expression compiles with none, which is the population the route's runtime
    // refusal exists for.
    provider.buildObjectEdit.mockResolvedValueOnce({
      built: false,
      refusal: REFUSAL,
      plan: PLAN,
      preimage: PREIMAGE,
    } as unknown as ObjectEditBuild);
    expect((await POST(request(VALID))).status).toBe(400);
  });

  test("a plan whose EXECUTABLE TEXT exceeds the bound is refused at BUILD, with the real reason", async () => {
    // Refusing to issue a plan it knows cannot be posted back, rather than issuing one the apply
    // route will refuse ninety seconds later. The bound is EDIT_PLAN_EXECUTABLE_LIMIT and NOT
    // EDIT_CHARACTER_LIMIT, and the literal below is above the former.
    provider.buildObjectEdit.mockResolvedValueOnce({
      built: true,
      plan: planWithUnitOfLength(EDIT_PLAN_EXECUTABLE_LIMIT + 1),
      preimage: PREIMAGE,
    });
    const response = await POST(request(VALID));
    expect(response.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(response)).error).toContain("this apply would send");
  });

  test("THE CONTROL: a MAXIMAL part wrapped in a guard block still builds, which the read bound would refuse", async () => {
    // This is the regression for the defect the pre-flight caught. A maximal readable part is
    // 1,000,000 characters and every day-one unit wraps it, so a plan bound equal to
    // EDIT_CHARACTER_LIMIT refuses THIS ROUTE'S OWN PLAN: the reader opens a 999,500-character
    // function, the preview renders, they press Apply, and the route that issued the plan ninety
    // seconds earlier answers 400. The PostgreSQL fixture's under-limit control sits at about
    // 975,134 characters, inside the guard block's distance of that edge, so the population is
    // real and committed rather than hypothetical.
    provider.buildObjectEdit.mockResolvedValueOnce({
      built: true,
      plan: planWithUnitOfLength(EDIT_CHARACTER_LIMIT + 1_500),
      preimage: PREIMAGE,
    });
    const response = await POST(request(VALID));
    expect(response.status).toBe(200);
  });

  test("a provider that answers a HYBRID UNIT is refused at BUILD, before a token is minted", async () => {
    // Design 7.9 by name: a unit whose `medium` is `command` and which also carries `steps`
    // answers 400. It is REPRESENTABLE because the excess-property check on a union admits any
    // property declared on any member, so the type cannot stop it and only `isObjectEditPlanShape`
    // at this seam can. Without this the hybrid gets a sealed plan and a 200, and the design's
    // named 400 has no producer anywhere.
    provider.buildObjectEdit.mockResolvedValueOnce({
      built: true,
      plan: {
        ...PLAN,
        unit: { medium: "command", name: "F", arguments: [], payload: STEP, steps: [STEP] },
      },
      preimage: PREIMAGE,
    } as unknown as ObjectEditBuild);
    const response = await POST(request(VALID));
    expect(response.status).toBe(400);
    expect(await parseResponseJSON<{ planToken?: string }>(response)).not.toHaveProperty("planToken");
  });

  test("a plan sealed against a DIFFERENT server is refused at BUILD, and no token is minted", async () => {
    // NOT in the brief's list and added for the same reason as the missing-method test: this is
    // the fingerprint arm on the BUILD side, and Task 4's seal had no consumer at all before this
    // route, so nothing in this repository built the population for it. The provider writes the
    // fingerprint from the connection it was built with; the route recomputes it from the
    // connection THIS request resolved and refuses the difference, which is the enforce-rather-than-
    // trust precedent `boundSourceDocument` set.
    provider.buildObjectEdit.mockResolvedValueOnce({
      built: true,
      plan: { ...PLAN, connectionFingerprint: `${PLAN.connectionFingerprint}00` },
      preimage: PREIMAGE,
    });
    const response = await POST(request(VALID));
    expect(response.status).toBe(400);
    expect(await parseResponseJSON<{ planToken?: string }>(response)).not.toHaveProperty("planToken");
  });

  test("THE BUILD ROUTE EMITS NO AUDIT EVENT", async () => {
    // It executes no statement, it is a read, every other read in this product is unaudited, and
    // auditing one read of nine would be a signal an operator would misread.
    const before = getServerAuditBuffer().getAll().length;
    await POST(request(VALID));
    expect(getServerAuditBuffer().getAll().length).toBe(before);
  });
});
