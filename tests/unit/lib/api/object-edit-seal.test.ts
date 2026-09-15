import { describe, expect, test } from "bun:test";
import { SignJWT } from "jose";
import {
  PLAN_FIELDS,
  PLAN_TOKEN_TTL_SECONDS,
  digestPlan,
  mintPlanToken,
  planDigestLeaves,
  verifyPlanToken,
} from "@/lib/api/object-edit-plan-token";
import { getJwtSecret } from "@/lib/config/auth-env";
import type { ObjectEditPlan } from "@/lib/db/types";

const FINGERPRINT = "fp-under-test";

function plan(): ObjectEditPlan {
  // Every LEAF value is a distinct string or number, so a tamper at one leaf cannot accidentally
  // look like a tamper at another.
  return {
    planVersion: 1,
    planId: "leaf-planId",
    issuedAt: "2026-09-13T00:00:00.000Z",
    connectionFingerprint: FINGERPRINT,
    type: "postgres",
    path: ["leaf-path-0", "leaf-path-1"],
    kind: "function",
    partId: "definition",
    strategy: "guarded-atomic-batch",
    unit: {
      medium: "statement",
      steps: [
        {
          text: "leaf-step-text",
          language: "pgsql",
          segments: [
            { from: "provider", text: "leaf-provider-text" },
            { from: "user", start: 0, end: 14 },
          ],
        },
      ],
    },
    session: [
      { mode: "pinned", setting: "search_path", value: "leaf-session-value" },
      { mode: "asserted", setting: "check_function_bodies", value: "on" },
    ],
    revision: { check: "guarded", token: "leaf-revision-token", basis: "leaf-basis", scope: "server" },
    consequences: [
      { loses: "replaces-whole-container", fact: { source: "leaf-fact-source", observed: "leaf-fact-observed" } },
    ],
  };
}

/**
 * Tamper with ONE leaf of the walk, by the path the walk itself reported.
 *
 * The two SYNTHETIC leaves, an object's `.keys` and an array's `.length`, are tampered with by
 * ADDING a slot whose value is `undefined`, and that is not a stylistic choice. Round 1 review
 * measured the earlier form, which deleted a key and popped an element: a deletion also removes
 * every ordinary value leaf under it, so the digest moves whether or not the synthetic leaf is in
 * the digest input, and all 14 synthetic leaves of this fixture were UNDISCRIMINATED by a loop
 * whose headline is one tamper per leaf. RE-RUN with this form under the brief's mutation (b),
 * which filters the synthetic leaves out of the digest input: this loop now goes RED and names
 * them. `walk` returns on its first line for `undefined`, so adding an undefined slot leaves every
 * other leaf byte-identical and moves the synthetic leaf ALONE.
 */
function tamper(root: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  const last = parts[parts.length - 1];
  let cursor: Record<string, unknown> = root;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] as Record<string, unknown>;
  if (last === "keys") {
    cursor["tamper-added-key"] = undefined;
    return;
  }
  if (last === "length") {
    (cursor as unknown as unknown[]).push(undefined);
    return;
  }
  const current = cursor[last];
  cursor[last] = typeof current === "number" ? current + 1 : `${String(current)}X`;
}

/**
 * The fixture's unit, narrowed to the `statement` arm.
 *
 * `ObjectEditUnit` is a discriminated union and `command` carries a `payload` rather than `steps`,
 * so the two tests below cannot reach `steps` without this. The throw is not decoration: it is what
 * makes those tests fail loudly rather than silently assert nothing if the fixture ever moves to
 * the command arm.
 */
function statementUnit(subject: ObjectEditPlan): Extract<ObjectEditPlan["unit"], { medium: "statement" }> {
  if (subject.unit.medium !== "statement") throw new Error("the fixture's unit is not a statement unit");
  return subject.unit;
}

/** The UNFRAMED concatenation of the walk, which is what `frame()` in the module exists to refuse. */
function unframedWalk(subject: ObjectEditPlan): string {
  return planDigestLeaves(subject)
    .map((leaf) => leaf.path + leaf.value)
    .join("");
}

/**
 * A token signed with the module's own derived key, so a CLAIM can be given a value the mint would
 * never produce.
 *
 * The label is duplicated here as a literal rather than imported, because it is private to the
 * module on purpose. A label change does not make these tests pass silently: the forged token then
 * fails the signature check and answers "this preview could not be verified", which is not the
 * sentence any of them assert.
 */
async function forgePlanToken(claims: Record<string, unknown>): Promise<string> {
  const raw = getJwtSecret().slice().buffer as ArrayBuffer;
  const base = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", base, new TextEncoder().encode("libredb.object-edit.plan.v1"));
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new Uint8Array(derived));
}

/**
 * A deep copy whose every object has its key order REVERSED, at EVERY depth.
 *
 * Arrays keep their order, because an array's order is data the plan means and the walk carries
 * it as a `.length` leaf plus positional paths; reversing one would assert something else.
 *
 * It is a function rather than an inline `Object.entries(...).reverse()` because the inline form
 * reaches only the top level, which the walk drives from `PLAN_FIELDS` and therefore cannot
 * discriminate. MEASURED in node: the top-level-only form digests the same with and without the
 * walk's `.sort()`.
 */
function reverseKeysAtEveryDepth(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeysAtEveryDepth);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, nested]) => [key, reverseKeysAtEveryDepth(nested)]),
    );
  }
  return value;
}

describe("the plan digest", () => {
  test("the top-level field list is exhaustive over the plan's own keys", () => {
    // Widened to `string[]`: `PLAN_FIELDS` is `as const`, so the spread carries the literal union
    // and `Object.keys()` answers `string[]`, which tsc refuses against it (TS2769). The assertion
    // is the brief's, unchanged; only the static type of the left side is widened so it compiles.
    expect([...PLAN_FIELDS].sort() as string[]).toEqual(Object.keys(plan()).sort());
  });

  test("the same plan digests the same, and a re-ordered object digests the same AT EVERY DEPTH", async () => {
    const first = await digestPlan(plan());
    // Key order surviving a JSON.parse/stringify round trip is a V8 behaviour rather than a
    // contract, and this product is already measured re-spelling a payload on a round trip. A
    // digest that depended on order would answer "forged" for a correct client.
    //
    // THE REVERSAL IS AT EVERY DEPTH AND THAT IS WHAT MAKES MUTATION (c) BELOW KILL. RUN IN
    // NODE while this plan was repaired: a shuffle that reverses only the TOP-LEVEL key order,
    // `Object.fromEntries(Object.entries(reordered).reverse())`, digests IDENTICALLY with and
    // without the walk's `.sort()`, so it certifies nothing about the sort. Two reasons, both
    // structural: the top level is driven by `PLAN_FIELDS` and never by `Object.keys`, and
    // `JSON.parse(JSON.stringify(...))` preserves the insertion order of every nested object,
    // so `revision`, `unit`, the segments and the consequence all come back in their original
    // order. With the reversal at every depth the sorted walk still matches and the unsorted
    // one does not.
    const shuffled = reverseKeysAtEveryDepth(JSON.parse(JSON.stringify(plan()))) as ObjectEditPlan;
    expect(await digestPlan(shuffled)).toBe(first);
  });

  test("EVERY leaf of the walk changes the digest, enumerated from the walk itself", async () => {
    const leaves = planDigestLeaves(plan());
    // The population is refused BY NAME when it is empty, because a walk that emitted nothing
    // would make every assertion below vacuous.
    if (leaves.length === 0) throw new Error("the digest walk emitted 0 leaves, so this test certifies nothing");
    // The census, stated rather than implied, because round 1 review found the headline "one
    // tamper test per leaf" was true of 31 of these 45 and the report did not say which. The 14
    // synthetic leaves are now tampered with ADDITIVELY, see `tamper` above, so all 45 are
    // discriminated: under the brief's mutation (b) this loop names all 14 by path.
    const synthetic = leaves.filter((leaf) => leaf.path.endsWith(".keys") || leaf.path.endsWith(".length"));
    expect(leaves.length).toBe(45);
    expect(synthetic.length).toBe(14);
    const baseline = await digestPlan(plan());
    const survivors: string[] = [];
    for (const leaf of leaves) {
      const mutated = plan() as unknown as Record<string, unknown>;
      tamper(mutated, leaf.path);
      if ((await digestPlan(mutated as unknown as ObjectEditPlan)) === baseline) survivors.push(leaf.path);
    }
    // A digest that covers 44 of the 45 passes every test that only tampers with the 44, so the
    // assertion is over the WHOLE enumeration and names any leaf that survived.
    expect(survivors).toEqual([]);
  });

  test("a key whose value is explicitly undefined is VISIBLE, which only the `.keys` leaf can see", async () => {
    // The property the `.keys` synthetic leaf exists for, asserted directly rather than through
    // the walk-derived population above, because a mutation that removes the leaf also removes it
    // from that population and the assertion cancels itself.
    //
    // MEASURED in node: `walk` returns on its first line for `undefined`, so this plan and the one
    // below it emit the SAME value leaves. `revision.keys` is the only leaf that differs, and with
    // the synthetic leaves removed from the digest the two collide.
    const present = { ...plan(), revision: { ...plan().revision, extra: undefined } } as unknown as ObjectEditPlan;
    expect(await digestPlan(present)).not.toBe(await digestPlan(plan()));
  });

  test("an array element that is explicitly undefined is VISIBLE, which only the `.length` leaf can see", async () => {
    const trailing = { ...plan(), session: [...plan().session, undefined] } as unknown as ObjectEditPlan;
    expect(await digestPlan(trailing)).not.toBe(await digestPlan(plan()));
  });

  test("a plain deletion is visible with or WITHOUT the synthetic leaves, and that is the control", async () => {
    // The control that makes the split in mutation (b) readable. Removing a key removes a leaf,
    // so the framed walk sees it either way. Without this, an implementer running mutation (b)
    // and seeing two of four tests survive would have no way to tell a partial kill from a
    // broken mutation.
    const { basis: _basis, ...withoutBasis } = plan().revision as { basis?: string };
    const shortened = { ...plan(), revision: withoutBasis } as unknown as ObjectEditPlan;
    expect(await digestPlan(shortened)).not.toBe(await digestPlan(plan()));
  });

  test("two plans that collide UNFRAMED are told apart, which is what the length framing buys", async () => {
    // The live population the module's `frame()` docblock claimed could not exist, and round 1
    // review REFUTED that claim by running the shipped walk. `kind` and `partId` are both plain
    // `string` on `ObjectEditPlan` and both are engine-derived, so a value can absorb the NEXT
    // leaf's path literal.
    //
    // The review's pair is `kind: "XpartIdY", partId: "P"` against `kind: "X", partId: "YpartIdP"`,
    // and it is spelled with `partIdstring:` here because the walk now emits
    // `${typeof value}:${String(value)}` for a value leaf, which is finding 4's repair in the same
    // round. RE-RUN after that repair: the review's untagged pair no longer collides unframed, the
    // control below went RED and named both concatenations, and the absorbed literal is now
    // "partId" plus the next leaf's tag. The property is the review's; only the absorbed string
    // grew by seven characters.
    const left = { ...plan(), kind: "XpartIdstring:Y", partId: "P" };
    const right = { ...plan(), kind: "X", partId: "YpartIdstring:P" };
    // The control. Without it this is a pair of plans that differ, and the assertion below would
    // pass for any digest at all instead of for the framing.
    expect(unframedWalk(left)).toBe(unframedWalk(right));
    expect(await digestPlan(left)).not.toBe(await digestPlan(right));
  });

  test("a lone surrogate in the statement text moves the digest, so the seal is over the text the client sent", async () => {
    // Round 1 review measured this against the shipped module: `TextEncoder` maps EVERY unpaired
    // surrogate to U+FFFD, while `JSON.parse`/`JSON.stringify` on the wire preserves the code unit,
    // so a token approved for "A\uD800B" verified a plan carrying "A\uDC00B". Ruling 1a is byte
    // identity between what was approved and what the engine receives, so the digest is taken over
    // the UTF-16 code units.
    const withText = (text: string): ObjectEditPlan => {
      const base = plan();
      const unit = statementUnit(base);
      return { ...base, unit: { ...unit, steps: [{ ...unit.steps[0], text }] } } as ObjectEditPlan;
    };
    expect(await digestPlan(withText("A\uD800B"))).not.toBe(await digestPlan(withText("A\uDC00B")));
  });

  test("a number and its decimal spelling are different leaves, so a retyped coordinate moves the digest", async () => {
    // Same class, second instance from the same review: `String(value)` alone makes the number 0
    // and the string "0" one leaf, so a client could retype a segment coordinate inside an
    // approved digest. The walk carries `typeof` with the value. The cast is the point: the type
    // says number, the wire is JSON, and the digest is what stands between them.
    const base = plan();
    const unit = statementUnit(base);
    const retyped = {
      ...base,
      unit: {
        ...unit,
        steps: [{ ...unit.steps[0], segments: [unit.steps[0].segments[0], { from: "user", start: "0", end: "14" }] }],
      },
    } as unknown as ObjectEditPlan;
    expect(await digestPlan(retyped)).not.toBe(await digestPlan(base));
  });

  test("the leaves include the places the bytes actually live", async () => {
    const paths = planDigestLeaves(plan()).map((leaf) => leaf.path);
    for (const required of [
      "unit.steps.0.text",
      "unit.steps.0.segments.1.start",
      "unit.steps.0.segments.1.end",
      "revision.token",
      "session.0.value",
      "consequences.0.fact.observed",
      "partId",
      "connectionFingerprint",
    ]) {
      expect(paths).toContain(required);
    }
  });
});

describe("the plan token", () => {
  test("a minted token verifies against its own plan", async () => {
    const subject = plan();
    const token = await mintPlanToken(subject);
    expect(await verifyPlanToken(token, subject, FINGERPRINT)).toEqual({ valid: true });
  });

  test("a tampered plan does not verify, and the reason names the digest", async () => {
    const subject = plan();
    const token = await mintPlanToken(subject);
    const mutated = { ...subject, partId: "body" };
    expect(await verifyPlanToken(token, mutated, FINGERPRINT)).toEqual({
      valid: false,
      reason: "this preview no longer matches the plan it was issued for",
    });
  });

  test("fifteen minutes and one second is too late; fourteen fifty-nine is not", async () => {
    // The clock is INJECTED, the way drive-token.ts already takes one, so a lifetime is asserted
    // rather than waited out.
    const subject = plan();
    const minted = Date.parse("2026-09-13T12:00:00.000Z");
    const token = await mintPlanToken(subject, () => minted);
    expect(PLAN_TOKEN_TTL_SECONDS).toBe(900);
    expect(await verifyPlanToken(token, subject, FINGERPRINT, () => minted + (900 - 1) * 1000)).toEqual({
      valid: true,
    });
    expect(await verifyPlanToken(token, subject, FINGERPRINT, () => minted + (900 + 1) * 1000)).toEqual({
      valid: false,
      reason: "this preview has expired",
    });
  });

  test("a session token does not verify as a plan", async () => {
    // The key is HMAC(JWT_SECRET, label) rather than the secret itself, so the two credentials
    // cannot be used for each other. Without this a session cookie would be a valid plan token.
    const forged = await new SignJWT({ digest: await digestPlan(plan()), fingerprint: FINGERPRINT, planVersion: 1 })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(getJwtSecret());
    expect(await verifyPlanToken(forged, plan(), FINGERPRINT)).toEqual({
      valid: false,
      reason: "this preview could not be verified",
    });
  });

  test("a plan for a different server is refused even with a valid token", async () => {
    const subject = plan();
    const token = await mintPlanToken(subject);
    expect(await verifyPlanToken(token, subject, "a-different-server")).toEqual({
      valid: false,
      reason: "this preview was built against a different connection",
    });
  });

  test("an unknown planVersion is refused rather than mis-verified", async () => {
    const subject = { ...plan(), planVersion: 2 } as unknown as ObjectEditPlan;
    const token = await mintPlanToken(subject);
    expect(await verifyPlanToken(token, subject, FINGERPRINT)).toEqual({
      valid: false,
      reason: "this preview was issued by a different version of this server",
    });
  });

  test("garbage is refused with the verification sentence and never a throw", async () => {
    expect(await verifyPlanToken("not-a-token", plan(), FINGERPRINT)).toEqual({
      valid: false,
      reason: "this preview could not be verified",
    });
  });

  // The four tests below pin ONE clause each, holding the other constant. Round 1 review deleted
  // each of the four clauses in turn with the suite fully green, because the two tests above build
  // inputs in which both clauses of a pair trip at once. The claim side cannot be moved by minting,
  // since `mintPlanToken` copies it off the plan and the digest covers the plan's copy, so these
  // forge the claims with the module's own key. This is redundancy by design and not a live hole
  // today: the digest covers `connectionFingerprint` and `planVersion`, so the two halves can only
  // disagree through a SHA-256 collision. What the tests defend is the redundancy itself.
  test("the CLAIM's fingerprint alone refuses, with the plan's copy matching", async () => {
    const subject = plan();
    const token = await forgePlanToken({
      digest: await digestPlan(subject),
      fingerprint: "a-different-server",
      planVersion: 1,
    });
    expect(subject.connectionFingerprint).toBe(FINGERPRINT);
    expect(await verifyPlanToken(token, subject, FINGERPRINT)).toEqual({
      valid: false,
      reason: "this preview was built against a different connection",
    });
  });

  test("the PLAN's fingerprint alone refuses, with the claim matching", async () => {
    const subject = { ...plan(), connectionFingerprint: "a-different-server" };
    const token = await forgePlanToken({ digest: await digestPlan(subject), fingerprint: FINGERPRINT, planVersion: 1 });
    expect(await verifyPlanToken(token, subject, FINGERPRINT)).toEqual({
      valid: false,
      reason: "this preview was built against a different connection",
    });
  });

  test("the CLAIM's planVersion alone refuses, with the plan's copy at 1", async () => {
    const subject = plan();
    const token = await forgePlanToken({ digest: await digestPlan(subject), fingerprint: FINGERPRINT, planVersion: 2 });
    expect(subject.planVersion).toBe(1);
    expect(await verifyPlanToken(token, subject, FINGERPRINT)).toEqual({
      valid: false,
      reason: "this preview was issued by a different version of this server",
    });
  });

  test("the PLAN's planVersion alone refuses, with the claim at 1", async () => {
    const subject = { ...plan(), planVersion: 2 } as unknown as ObjectEditPlan;
    const token = await forgePlanToken({ digest: await digestPlan(subject), fingerprint: FINGERPRINT, planVersion: 1 });
    expect(await verifyPlanToken(token, subject, FINGERPRINT)).toEqual({
      valid: false,
      reason: "this preview was issued by a different version of this server",
    });
  });
});
