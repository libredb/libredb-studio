/**
 * Failures are read from numbers the standard fixes, never from message text.
 *
 * The cases are the ones measured against Net-SNMP snmpd 5.9.4 on 13 October 2026. The rule they
 * enforce has a measurement of its own behind it: the same runtime failure reads
 * "Do not know how to serialize a BigInt" under Node 24.14.0 and
 * "JSON.stringify cannot serialize BigInt." under Bun 1.4.2, so any comparison against text is a
 * comparison against the runtime rather than against the agent.
 */
import { describe, expect, test } from "bun:test";
import type { SnmpFailure } from "@/lib/db/providers/network/snmp/errors";
import {
  ERROR_STATUS,
  USM_REPORT_OIDS,
  failureFromReport,
  failureFromSilence,
  failureFromSocket,
  failureFromStatus,
} from "@/lib/db/providers/network/snmp/errors";

describe("a Report names which credential failure it is", () => {
  const measured: ReadonlyArray<readonly [string, string]> = [
    ["an unknown user", USM_REPORT_OIDS.unknownUserName],
    ["a wrong authentication passphrase", USM_REPORT_OIDS.wrongDigest],
    ["a security level the user does not have", USM_REPORT_OIDS.unsupportedSecurityLevel],
  ];
  for (const [what, oid] of measured) {
    test(what, () => {
      const failure = failureFromReport(oid);
      expect(failure.kind).toBe("credential");
      expect(failure.retryable).toBe(false);
    });
  }
  test("no credential failure is ever retried", () => {
    for (const oid of Object.values(USM_REPORT_OIDS)) {
      expect(failureFromReport(oid).retryable).toBe(false);
    }
  });
  test("a Report this provider does not know is reported as itself, with its OID", () => {
    const failure = failureFromReport("1.3.6.1.6.3.15.1.1.99.0");
    expect(failure.kind).toBe("refused");
    expect(failure.reason).toContain("1.3.6.1.6.3.15.1.1.99.0");
  });
});

describe("an error-status is read as a number", () => {
  test("noError is not a failure", () => {
    expect(failureFromStatus(ERROR_STATUS.noError)).toBeUndefined();
  });
  test("tooBig says the answer was never sent, not that nothing is there", () => {
    expect(failureFromStatus(ERROR_STATUS.tooBig)?.kind).toBe("tooLarge");
  });
  test("authorizationError is a refusal", () => {
    expect(failureFromStatus(ERROR_STATUS.authorizationError)?.kind).toBe("refused");
  });
  test("a write-only status is reported as a defect rather than hidden", () => {
    const failure = failureFromStatus(ERROR_STATUS.noAccess);
    expect(failure?.reason).toContain("only a write draws");
  });
  test("an unknown status keeps its number", () => {
    expect(failureFromStatus(42)?.reason).toContain("42");
  });
});

/** Narrows to the silence arm, so a change of shape fails here instead of being cast away. */
const silence = (failure: SnmpFailure): Extract<SnmpFailure, { kind: "silence" }> => {
  if (failure.kind !== "silence") throw new Error(`expected silence, got ${failure.kind}`);
  return failure;
};

describe("silence lists its causes and claims none", () => {
  test("over v2c the community is a possible cause", () => {
    const failure = silence(failureFromSilence({ version: "v2c", contextNameSet: false }));
    expect(failure.kind).toBe("silence");
    expect(failure.causes.some((c: string) => c.includes("community"))).toBe(true);
    expect(failure.causes.some((c: string) => c.includes("privacy passphrase"))).toBe(false);
  });
  test("over v3 at authPriv the privacy passphrase is, and the community is not", () => {
    const failure = silence(failureFromSilence({ version: "v3", securityLevel: "authPriv", contextNameSet: false }));
    expect(failure.causes.some((c: string) => c.includes("privacy passphrase"))).toBe(true);
    expect(failure.causes.some((c: string) => c.includes("community"))).toBe(false);
  });
  test("at authNoPriv the privacy passphrase is NOT a cause, because none was sent", () => {
    // Without this case, making the privacy cause unconditional passed. The v3 test
    // above only proved the cause is PRESENT at authPriv; it took a second security level to
    // prove the list actually narrows rather than always carrying everything.
    const failure = silence(failureFromSilence({ version: "v3", securityLevel: "authNoPriv", contextNameSet: false }));
    expect(failure.causes.some((c: string) => c.includes("privacy passphrase"))).toBe(false);
  });
  test("a context name is a cause only when one was sent", () => {
    const withContext = silence(failureFromSilence({ version: "v3", securityLevel: "authPriv", contextNameSet: true }));
    const without = silence(failureFromSilence({ version: "v3", securityLevel: "authPriv", contextNameSet: false }));
    expect(withContext.causes.some((c: string) => c.includes("context name"))).toBe(true);
    expect(without.causes.some((c: string) => c.includes("context name"))).toBe(false);
  });
  test("the reason says it does not know which, rather than picking one", () => {
    expect(failureFromSilence({ version: "v2c", contextNameSet: false }).reason).toContain("does not say which");
  });
});

describe("a socket failure is not a reading of the agent", () => {
  test("EMSGSIZE says the agent was never asked", () => {
    const failure = failureFromSocket("EMSGSIZE");
    expect(failure.kind).toBe("requestTooLarge");
    expect(failure.reason).toContain("never asked");
  });
  test("EMSGSIZE is not reported as a timeout", () => {
    expect(failureFromSocket("EMSGSIZE").kind).not.toBe("silence");
  });
  test("a name that does not resolve is a transport failure", () => {
    expect(failureFromSocket("ENOTFOUND").kind).toBe("transport");
  });
  test("an unknown socket code keeps its name", () => {
    expect(failureFromSocket("EPERM").reason).toContain("EPERM");
  });
});

/**
 * The last branch of the socket mapping, which is the one that decides what an UNKNOWN failure
 * looks like to a caller. The opposite shape has been found in another provider in this
 * repository: an unmatched error passed through raw and surfaced as an internal error, so an
 * unreachable address read as our defect. This one returns a typed transport failure and names the code, and the test exists
 * because "it happens not to today" is not a property.
 */
describe("an unmapped socket code is still a transport failure", () => {
  test("it is typed, not passed through, and it names the code", () => {
    const failure = failureFromSocket("EPERM");
    expect(failure.kind).toBe("transport");
    expect(failure.retryable).toBe(false);
    expect(failure.reason).toContain("EPERM");
  });

  /**
   * ECONNREFUSED used to land in that branch and read "the socket refused the send", which
   * points at this machine. The send succeeded; the far host answered that nothing is there.
   */
  test("a refused port says the host answered, not that the send failed", () => {
    expect(failureFromSocket("ECONNREFUSED").reason).toContain("nothing is listening");
    expect(failureFromSocket("ECONNREFUSED").reason).not.toContain("refused the send");
  });

  test("the codes that are mapped do not fall into the last branch", () => {
    for (const code of ["EMSGSIZE", "EACCES", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]) {
      expect(failureFromSocket(code).reason).not.toContain(code);
    }
  });
});

describe("an error-status a read should never draw", () => {
  test("noSuchName is refused with the sentence that says why it cannot be ours", () => {
    // v1's way of saying an object is missing. This provider speaks v2c and v3, where the same
    // fact arrives inside the varbind as noSuchObject, so a noSuchName in an answer is about the
    // agent or about something that built a v1 message, and the sentence says so rather than
    // passing a bare status number to the reader.
    const failure = failureFromStatus(ERROR_STATUS.noSuchName);
    expect(failure).toMatchObject({ kind: "refused", retryable: false });
    expect(failure?.reason).toContain("noSuchName");
  });
});
