import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import * as simpleWebAuthn from "@simplewebauthn/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import {
  buildRegistrationOptions,
  buildSignInOptions,
  PasskeyRefusal,
  readAssertionIdentity,
  type VerifiedRegistration,
  verifyAssertion,
  verifyRegistration,
} from "@/lib/passkey/webauthn";
import { createPackedAttestationChain, trustPackedRoot } from "../../../helpers/attestation-chain";
import {
  type AttestationOverrides,
  CHAINED_ATTESTATION_FORMATS,
  SoftAuthenticator,
} from "../../../helpers/passkey-authenticator";

const RP = { origin: "http://localhost:3000", rpId: "localhost" };
const EMAIL = "owner@example.com";
const HANDLE = isoBase64URL.fromBuffer(new Uint8Array(64).fill(7));

function challengeOf(fill: number): string {
  return isoBase64URL.fromBuffer(new Uint8Array(32).fill(fill));
}

async function refusal(run: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof run === "function" ? run() : run);
  } catch (error) {
    expect(error).toBeInstanceOf(PasskeyRefusal);
    return (error as PasskeyRefusal).reason;
  }
  throw new Error("expected a PasskeyRefusal");
}

async function registrationResponse(
  challenge: string,
  overrides: AttestationOverrides = {},
  authenticator?: SoftAuthenticator,
): Promise<{ authenticator: SoftAuthenticator; response: RegistrationResponseJSON }> {
  const auth = authenticator ?? (await SoftAuthenticator.create({ origin: RP.origin }));
  const options = await buildRegistrationOptions({ rp: RP, challenge, userHandle: HANDLE, email: EMAIL, exclude: [] });
  return { authenticator: auth, response: await auth.register(options, overrides) };
}

async function enrolled(): Promise<{ authenticator: SoftAuthenticator; stored: VerifiedRegistration }> {
  const challenge = challengeOf(40);
  const { authenticator, response } = await registrationResponse(challenge, { backupEligible: true });
  const stored = await verifyRegistration({ response, challenge, rp: RP });
  return { authenticator, stored };
}

function credentialOf(stored: VerifiedRegistration) {
  return { credentialId: stored.credentialId, publicKey: stored.publicKey, transports: stored.transports };
}

async function signInOptions(challenge: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return buildSignInOptions({ rp: RP, challenge });
}

type FetchRecorder = { calls: string[]; restore: () => void };

function recordFetch(): FetchRecorder {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("registration options", () => {
  test("registration options require a discoverable credential and user verification, offer EdDSA, ES256 and RS256, and time out after 300 seconds", async () => {
    const challenge = challengeOf(1);
    const excluded = isoBase64URL.fromBuffer(new Uint8Array(16).fill(9));
    const options = await buildRegistrationOptions({
      rp: RP,
      challenge,
      userHandle: HANDLE,
      email: EMAIL,
      exclude: [{ credentialId: excluded, transports: ["usb", "nfc"] }],
    });
    expect(options.rp).toEqual({ id: "localhost", name: "LibreDB Studio" });
    expect(options.user).toEqual({ id: HANDLE, name: EMAIL, displayName: EMAIL });
    expect(options.challenge).toBe(challenge);
    expect(options.pubKeyCredParams.map((param) => param.alg)).toEqual([-8, -7, -257]);
    expect(options.timeout).toBe(300000);
    expect(options.attestation).toBe("none");
    expect(options.authenticatorSelection).toEqual({
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    });
    expect(options.excludeCredentials).toEqual([{ id: excluded, transports: ["usb", "nfc"], type: "public-key" }]);
  });

  test("registration options never share an authenticatorSelection object between calls", async () => {
    const input = { rp: RP, challenge: challengeOf(2), userHandle: HANDLE, email: EMAIL, exclude: [] };
    const first = await buildRegistrationOptions(input);
    const second = await buildRegistrationOptions(input);
    expect(first.authenticatorSelection).not.toBe(second.authenticatorSelection);
    expect(first.authenticatorSelection).not.toHaveProperty("authenticatorAttachment");
    expect(second.authenticatorSelection).not.toHaveProperty("authenticatorAttachment");
  });
});

describe("registration verification", () => {
  test("an accepted registration returns the COSE key, counter, filtered transports and backup flags", async () => {
    const challenge = challengeOf(3);
    const { authenticator, response } = await registrationResponse(challenge, {
      transports: ["internal", "warp", "internal"],
      backupEligible: true,
      backupState: true,
    });
    const verified = await verifyRegistration({ response, challenge, rp: RP });
    expect(verified.credentialId).toBe(authenticator.credentialId);
    expect(isoBase64URL.isBase64URL(verified.publicKey)).toBe(true);
    expect(verified.publicKey.length).toBeGreaterThan(0);
    expect(verified.signCount).toBe(0);
    expect(verified.transports).toEqual(["internal"]);
    expect(verified.backupEligible).toBe(true);
    expect(verified.backupState).toBe(true);
  });

  test("a registration without transports stores none", async () => {
    const challenge = challengeOf(4);
    const { response } = await registrationResponse(challenge);
    delete response.response.transports;
    const verified = await verifyRegistration({ response, challenge, rp: RP });
    expect(verified.transports).toEqual([]);
    expect(verified.backupEligible).toBe(false);
    expect(verified.backupState).toBe(false);
  });

  test("a registration made on another origin is refused before the library is called", async () => {
    const challenge = challengeOf(5);
    const { response } = await registrationResponse(challenge, { origin: "http://evil.example" });
    expect(await refusal(verifyRegistration({ response, challenge, rp: RP }))).toBe("passkey_origin_mismatch");
  });

  test("a registration with crossOrigin or topOrigin is refused", async () => {
    const challenge = challengeOf(6);
    const cross = await registrationResponse(challenge, { crossOrigin: true });
    expect(await refusal(verifyRegistration({ response: cross.response, challenge, rp: RP }))).toBe("passkey_rejected");
    const top = await registrationResponse(challenge, { topOrigin: "http://localhost:3000" });
    expect(await refusal(verifyRegistration({ response: top.response, challenge, rp: RP }))).toBe("passkey_rejected");
  });

  test("a registration without user verification is refused", async () => {
    const challenge = challengeOf(7);
    const { response } = await registrationResponse(challenge, { userVerified: false });
    expect(await refusal(verifyRegistration({ response, challenge, rp: RP }))).toBe("passkey_rejected");
  });

  test("a registration whose rpIdHash names another RP ID is refused", async () => {
    const challenge = challengeOf(8);
    const { response } = await registrationResponse(challenge, { rpId: "evil.example" });
    expect(await refusal(verifyRegistration({ response, challenge, rp: RP }))).toBe("passkey_rejected");
  });

  test("a registration for another challenge or type is refused", async () => {
    const challenge = challengeOf(9);
    const other = await registrationResponse(challengeOf(10));
    expect(await refusal(verifyRegistration({ response: other.response, challenge, rp: RP }))).toBe("passkey_rejected");
    const typed = await registrationResponse(challenge, { type: "webauthn.get" });
    expect(await refusal(verifyRegistration({ response: typed.response, challenge, rp: RP }))).toBe("passkey_rejected");
  });

  test("only none and packed self attestation are accepted", async () => {
    const challenge = challengeOf(11);
    const self = await registrationResponse(challenge, { format: "packed-self" });
    const verified = await verifyRegistration({ response: self.response, challenge, rp: RP });
    expect(verified.credentialId).toBe(self.authenticator.credentialId);
    const x5c = await registrationResponse(challenge, { format: "packed-x5c" });
    expect(await refusal(verifyRegistration({ response: x5c.response, challenge, rp: RP }))).toBe("passkey_rejected");
    const u2f = await registrationResponse(challenge, { format: "fido-u2f" });
    expect(await refusal(verifyRegistration({ response: u2f.response, challenge, rp: RP }))).toBe("passkey_rejected");
  });

  test("the stored credential ID is the attested one and must equal the response id", async () => {
    const challenge = challengeOf(12);
    const shortId = isoBase64URL.fromBuffer(new Uint8Array(16).fill(1));
    const substituted = await registrationResponse(challenge, { responseId: shortId });
    expect(await refusal(verifyRegistration({ response: substituted.response, challenge, rp: RP }))).toBe(
      "passkey_rejected",
    );
    const longShort = await registrationResponse(challenge, { credentialIdBytes: 1024, responseId: shortId });
    expect(await refusal(verifyRegistration({ response: longShort.response, challenge, rp: RP }))).toBe(
      "passkey_rejected",
    );
    const long = await registrationResponse(challenge, { credentialIdBytes: 1024 });
    expect(long.response.id).toBe(long.authenticator.credentialId);
    expect(await refusal(verifyRegistration({ response: long.response, challenge, rp: RP }))).toBe("passkey_rejected");
    const longest = await registrationResponse(challenge, { credentialIdBytes: 1023 });
    const verified = await verifyRegistration({ response: longest.response, challenge, rp: RP });
    expect(verified.credentialId).toBe(longest.authenticator.credentialId);
    expect(isoBase64URL.toBuffer(verified.credentialId).length).toBe(1023);
  });

  test("a malformed registration response is refused", async () => {
    const challenge = challengeOf(13);
    const { response } = await registrationResponse(challenge);
    const malformed: unknown[] = [
      null,
      {},
      { ...response, rawId: `${response.rawId}A` },
      { ...response, type: "password" },
      { ...response, response: "not an object" },
      { ...response, response: { ...response.response, clientDataJSON: 7 } },
      { ...response, response: { ...response.response, clientDataJSON: "not json" } },
      { ...response, response: { ...response.response, attestationObject: "%%%not base64url%%%" } },
    ];
    const reasons = await Promise.all(
      malformed.map((candidate) => refusal(verifyRegistration({ response: candidate, challenge, rp: RP }))),
    );
    expect(reasons).toEqual(malformed.map(() => "passkey_rejected"));
  });
});

describe("sign-in", () => {
  let recorder: FetchRecorder;

  beforeEach(() => {
    recorder = recordFetch();
  });

  afterEach(() => {
    try {
      // No sign-in step may reach the network, in any case of this block.
      expect(recorder.calls).toEqual([]);
    } finally {
      recorder.restore();
    }
  });

  test("sign-in options carry no allowCredentials and require user verification", async () => {
    const challenge = challengeOf(20);
    const options = await signInOptions(challenge);
    expect(options.rpId).toBe("localhost");
    expect(options.challenge).toBe(challenge);
    expect(options.timeout).toBe(300000);
    expect(options.userVerification).toBe("required");
    expect(options.allowCredentials).toBeUndefined();
  });

  test("readAssertionIdentity returns the credential ID and the canonical user handle", async () => {
    const { authenticator } = await enrolled();
    const options = await signInOptions(challengeOf(21));
    const assertion = await authenticator.assert(options);
    expect(readAssertionIdentity(assertion, RP)).toEqual({
      credentialId: authenticator.credentialId,
      userHandle: HANDLE,
    });
    const padded = await authenticator.assert(options, { userHandle: `${HANDLE}==` });
    expect(readAssertionIdentity(padded, RP).userHandle).toBe(HANDLE);
    // The last character of a 64-byte handle carries 2 data bits; setting an unused low bit re-encodes the same bytes.
    expect(HANDLE.endsWith("w")).toBe(true);
    const reencoded = await authenticator.assert(options, { userHandle: `${HANDLE.slice(0, -1)}x` });
    expect(readAssertionIdentity(reencoded, RP).userHandle).toBe(HANDLE);
    const nullHandle = { ...assertion, response: { ...assertion.response, userHandle: null } };
    expect(await refusal(() => readAssertionIdentity(nullHandle, RP))).toBe("passkey_unknown");
  });

  test("an assertion without a user handle is refused as unknown", async () => {
    const { authenticator } = await enrolled();
    const options = await signInOptions(challengeOf(22));
    const absent = await authenticator.assert(options, { userHandle: null });
    expect(await refusal(() => readAssertionIdentity(absent, RP))).toBe("passkey_unknown");
    const empty = await authenticator.assert(options, { userHandle: "" });
    expect(await refusal(() => readAssertionIdentity(empty, RP))).toBe("passkey_unknown");
    const padding = await authenticator.assert(options, { userHandle: "==" });
    expect(await refusal(() => readAssertionIdentity(padding, RP))).toBe("passkey_unknown");
  });

  test("a malformed assertion is refused", async () => {
    const { authenticator } = await enrolled();
    const assertion = await authenticator.assert(await signInOptions(challengeOf(23)));
    const malformed: unknown[] = [
      null,
      {},
      { ...assertion, rawId: `${assertion.rawId}A` },
      { ...assertion, type: "password" },
      { ...assertion, response: null },
      { ...assertion, response: { ...assertion.response, signature: 7 } },
      { ...assertion, response: { ...assertion.response, authenticatorData: undefined } },
      { ...assertion, response: { ...assertion.response, userHandle: 7 } },
      { ...assertion, response: { ...assertion.response, userHandle: "not+base64url" } },
      // Padding belongs only at the end.
      { ...assertion, response: { ...assertion.response, userHandle: `${HANDLE.slice(0, 8)}=${HANDLE.slice(8)}` } },
      { ...assertion, response: { ...assertion.response, userHandle: `=${HANDLE}` } },
      { ...assertion, response: { ...assertion.response, clientDataJSON: isoBase64URL.fromUTF8String("null") } },
      { ...assertion, response: { ...assertion.response, clientDataJSON: "not json" } },
    ];
    const reasons = await Promise.all(
      malformed.map((candidate) => refusal(() => readAssertionIdentity(candidate, RP))),
    );
    expect(reasons).toEqual(malformed.map(() => "passkey_rejected"));
  });

  test("an assertion from another origin is refused as an origin mismatch", async () => {
    const { authenticator } = await enrolled();
    const assertion = await authenticator.assert(await signInOptions(challengeOf(24)), {
      origin: "http://evil.example",
    });
    expect(await refusal(() => readAssertionIdentity(assertion, RP))).toBe("passkey_origin_mismatch");
  });

  test("an assertion carrying crossOrigin or topOrigin is refused", async () => {
    const { authenticator, stored } = await enrolled();
    const challenge = challengeOf(25);
    const options = await signInOptions(challenge);
    const assertions = await Promise.all(
      [{ crossOrigin: true }, { topOrigin: "http://localhost:3000" }].map((overrides) =>
        authenticator.assert(options, overrides),
      ),
    );
    const reasons = await Promise.all(
      assertions.flatMap((assertion) => [
        refusal(() => readAssertionIdentity(assertion, RP)),
        refusal(verifyAssertion({ response: assertion, challenge, rp: RP, credential: credentialOf(stored) })),
      ]),
    );
    expect(reasons).toEqual(["passkey_rejected", "passkey_rejected", "passkey_rejected", "passkey_rejected"]);
  });

  test("an accepted assertion returns the new counter and backup flags", async () => {
    const { authenticator, stored } = await enrolled();
    const challenge = challengeOf(26);
    const assertion = await authenticator.assert(await signInOptions(challenge), {
      backupEligible: true,
      backupState: true,
    });
    const verified = await verifyAssertion({
      response: assertion,
      challenge,
      rp: RP,
      credential: credentialOf(stored),
    });
    expect(verified).toEqual({ signCount: authenticator.signCount, backupEligible: true, backupState: true });
    expect(verified.signCount).toBe(1);
  });

  test("an assertion for another credential than the one looked up is refused", async () => {
    const { authenticator } = await enrolled();
    const other = await enrolled();
    const challenge = challengeOf(27);
    const assertion = await authenticator.assert(await signInOptions(challenge));
    expect(
      await refusal(
        verifyAssertion({ response: assertion, challenge, rp: RP, credential: credentialOf(other.stored) }),
      ),
    ).toBe("passkey_rejected");
  });

  test("an assertion with a bad signature is refused", async () => {
    const { authenticator, stored } = await enrolled();
    const challenge = challengeOf(28);
    const assertion = await authenticator.assert(await signInOptions(challenge), { badSignature: true });
    expect(
      await refusal(verifyAssertion({ response: assertion, challenge, rp: RP, credential: credentialOf(stored) })),
    ).toBe("passkey_rejected");
  });

  test("an assertion without user verification, or without user presence, is refused", async () => {
    const { authenticator, stored } = await enrolled();
    const challenge = challengeOf(29);
    const options = await signInOptions(challenge);
    const assertions = await Promise.all(
      [{ userVerified: false }, { userPresent: false }].map((overrides) => authenticator.assert(options, overrides)),
    );
    const reasons = await Promise.all(
      assertions.map((assertion) =>
        refusal(verifyAssertion({ response: assertion, challenge, rp: RP, credential: credentialOf(stored) })),
      ),
    );
    expect(reasons).toEqual(["passkey_rejected", "passkey_rejected"]);
  });

  test("an assertion for another RP ID or another challenge is refused", async () => {
    const { authenticator, stored } = await enrolled();
    const challenge = challengeOf(30);
    const options = await signInOptions(challenge);
    const otherRp = await authenticator.assert(options, { rpId: "evil.example" });
    expect(
      await refusal(verifyAssertion({ response: otherRp, challenge, rp: RP, credential: credentialOf(stored) })),
    ).toBe("passkey_rejected");
    const otherChallenge = await authenticator.assert(options, { challenge: challengeOf(31) });
    expect(
      await refusal(verifyAssertion({ response: otherChallenge, challenge, rp: RP, credential: credentialOf(stored) })),
    ).toBe("passkey_rejected");
  });

  test("an assertion whose stored public key cannot be decoded is refused", async () => {
    const { authenticator, stored } = await enrolled();
    const challenge = challengeOf(32);
    const assertion = await authenticator.assert(await signInOptions(challenge));
    const credential = { ...credentialOf(stored), publicKey: isoBase64URL.fromBuffer(new Uint8Array([1, 2, 3])) };
    expect(await refusal(verifyAssertion({ response: assertion, challenge, rp: RP, credential }))).toBe(
      "passkey_rejected",
    );
  });

  test("the library's counter check does not decide a counter regression", async () => {
    const { authenticator, stored } = await enrolled();
    const challenge = challengeOf(33);
    const options = await signInOptions(challenge);
    const three = await authenticator.assert(options, { signCount: 3 });
    const credential = credentialOf(stored);
    expect((await verifyAssertion({ response: three, challenge, rp: RP, credential })).signCount).toBe(3);
    const zero = await authenticator.assert(options, { signCount: 0 });
    expect((await verifyAssertion({ response: zero, challenge, rp: RP, credential })).signCount).toBe(0);
  });

  test("sign-in verification never calls fetch", async () => {
    const { authenticator, stored } = await enrolled();
    const challenge = challengeOf(34);
    const options = await signInOptions(challenge);
    const credential = credentialOf(stored);
    const good = await authenticator.assert(options);
    readAssertionIdentity(good, RP);
    await verifyAssertion({ response: good, challenge, rp: RP, credential });
    const assertions = await Promise.all(
      [{ badSignature: true }, { userVerified: false }, { rpId: "evil.example" }].map((overrides) =>
        authenticator.assert(options, overrides),
      ),
    );
    await Promise.all(
      assertions.map((assertion) => refusal(verifyAssertion({ response: assertion, challenge, rp: RP, credential }))),
    );
    expect(recorder.calls).toEqual([]);
  });
});

describe("attestation never reaches the network", () => {
  test("a packed attestation chained to a trusted root makes the library fetch its CRL", async () => {
    const chain = await createPackedAttestationChain();
    const untrust = trustPackedRoot(chain.rootPem);
    const recorder = recordFetch();
    try {
      const challenge = challengeOf(50);
      const { response } = await registrationResponse(challenge, { format: "packed-x5c", x5c: [chain.leafDer] });
      await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: RP.origin,
        expectedRPID: RP.rpId,
      }).catch(() => undefined);
      expect(recorder.calls).toContain(chain.crlUrl);
    } finally {
      recorder.restore();
      untrust();
    }
  });

  // The allowlist is the only thing keeping a chained format out: each of their library verifiers validates the
  // chain and can fetch a CRL, so each must be refused before the library is called at all.
  test("every format the library could verify with a chain is refused before the library runs", async () => {
    const chain = await createPackedAttestationChain();
    const library = spyOn(simpleWebAuthn, "verifyRegistrationResponse");
    try {
      // Control: an attestation "none" response does reach the library, so the spy sees Studio's call.
      const challenge = challengeOf(52);
      const plain = await registrationResponse(challenge);
      await verifyRegistration({ response: plain.response, challenge, rp: RP });
      expect(library).toHaveBeenCalledTimes(1);

      for (const format of CHAINED_ATTESTATION_FORMATS) {
        library.mockClear();
        // oxlint-disable-next-line no-await-in-loop -- one format after another.
        const { response } = await registrationResponse(challenge, { format, x5c: [chain.leafDer] });
        // oxlint-disable-next-line no-await-in-loop -- as above.
        const reason = await refusal(verifyRegistration({ response, challenge, rp: RP }));
        expect({ format, reason, libraryCalls: library.mock.calls.length }).toEqual({
          format,
          reason: "passkey_rejected",
          libraryCalls: 0,
        });
      }
    } finally {
      library.mockRestore();
    }
  });

  test("verifyRegistration refuses the same attestation before the library, so nothing is fetched", async () => {
    const chain = await createPackedAttestationChain();
    const untrust = trustPackedRoot(chain.rootPem);
    const recorder = recordFetch();
    try {
      const challenge = challengeOf(51);
      const { response } = await registrationResponse(challenge, { format: "packed-x5c", x5c: [chain.leafDer] });
      expect(await refusal(verifyRegistration({ response, challenge, rp: RP }))).toBe("passkey_rejected");
      expect(recorder.calls).toEqual([]);
    } finally {
      recorder.restore();
      untrust();
    }
  });
});
