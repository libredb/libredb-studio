/**
 * The three sentences of the shared egress refusal are exported, so a caller passes them through by identity and a test
 * imports them rather than quoting them, and the blocked-host sentence names no protocol: the flag guards every
 * destination that goes through these checks, not only an HTTP one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { egressDecision } from "@/lib/db/egress-decision";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  assertNoLinkLocalDnsAnswer,
  assertNotLinkLocalLiteral,
  assertPublicLiteralHost,
  BLOCKED_HOST,
  EGRESS_DECISION_MISSING,
  EGRESS_REFUSAL_SENTENCES,
  LINK_LOCAL_HOST,
  requireEgressDecision,
  UNUSABLE_ANSWER,
} from "@/lib/db/http/egress-policy";
import { BLOCKS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";
import { setEgressFlag } from "../../../helpers/egress-flag";

const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const original = process.env[FLAG];

afterEach(() => {
  setEgressFlag(original);
});

function refusal(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw");
}

describe("the egress refusal sentences", () => {
  test("the blocked-host sentence names the flag and no protocol", () => {
    expect(BLOCKED_HOST).toBe("Invalid host: this database destination is blocked by DB_HTTP_BLOCK_PRIVATE_HOSTS");
    expect(BLOCKED_HOST).not.toMatch(/\bHTTP\b(?!_)/);
  });

  test("the link-local and unusable-answer sentences keep their wording", () => {
    expect(LINK_LOCAL_HOST).toBe(
      "Invalid host: this connection never reaches a link-local address or AWS's IPv6 instance metadata address, whatever DB_HTTP_BLOCK_PRIVATE_HOSTS says",
    );
    expect(UNUSABLE_ANSWER).toBe("Invalid host: the name did not resolve to a usable IP address");
  });

  test("the set holds exactly the three sentences", () => {
    expect([...EGRESS_REFUSAL_SENTENCES].sort()).toEqual([BLOCKED_HOST, LINK_LOCAL_HOST, UNUSABLE_ANSWER].sort());
  });

  test("each check raises a DatabaseConfigError whose message is one of the three", () => {
    const blocked = refusal(() => assertPublicLiteralHost("10.0.0.5", BLOCKS_PRIVATE_HOSTS));
    expect(blocked).toBeInstanceOf(DatabaseConfigError);
    expect(blocked.message).toBe(BLOCKED_HOST);

    const linkLocal = refusal(() => assertNotLinkLocalLiteral("169.254.169.254"));
    expect(linkLocal).toBeInstanceOf(DatabaseConfigError);
    expect(linkLocal.message).toBe(LINK_LOCAL_HOST);

    const unusable = refusal(() => assertNoLinkLocalDnsAnswer([]));
    expect(unusable).toBeInstanceOf(DatabaseConfigError);
    expect(unusable.message).toBe(UNUSABLE_ANSWER);

    for (const error of [blocked, linkLocal, unusable]) expect(EGRESS_REFUSAL_SENTENCES.has(error.message)).toBe(true);
  });

  test("the invalid-flag sentence is not an egress refusal", () => {
    setEgressFlag("maybe");
    const invalid = refusal(() => egressDecision());
    expect(invalid).toBeInstanceOf(DatabaseConfigError);
    expect(EGRESS_REFUSAL_SENTENCES.has(invalid.message)).toBe(false);
  });

  test("the missing-decision sentence is not an egress refusal", () => {
    const missing = refusal(() => requireEgressDecision(undefined));
    expect(missing).toBeInstanceOf(DatabaseConfigError);
    expect(missing.message).toBe(EGRESS_DECISION_MISSING);
    expect(EGRESS_REFUSAL_SENTENCES.has(missing.message)).toBe(false);
  });
});
