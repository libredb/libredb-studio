/**
 * A CDP virtual authenticator, configured explicitly rather than through Playwright's
 * `context.credentials` shim, so the browser runs its own WebAuthn code path end to end.
 * Chromium only: the WebAuthn domain is a Chrome DevTools Protocol feature.
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import type { Page } from "@playwright/test";

/** A credential as `WebAuthn.getCredentials` reports it: every binary field is base64, not base64url. */
export interface VirtualCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
}

export interface VirtualAuthenticator {
  credentials(): Promise<VirtualCredential[]>;
  overrideBits(bits: { isBadUV?: boolean; isBogusSignature?: boolean; isBadUP?: boolean }): Promise<void>;
  remove(): Promise<void>;
}

export async function addVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const session = await page.context().newCDPSession(page);
  // No browser UI: an account chooser or a PIN prompt would wait for a click nobody makes.
  await session.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      // Discoverable credentials and user verification are what Studio requires of a passkey.
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    async credentials() {
      const { credentials } = await session.send("WebAuthn.getCredentials", { authenticatorId });
      return credentials as VirtualCredential[];
    },
    async overrideBits(bits) {
      await session.send("WebAuthn.setResponseOverrideBits", { authenticatorId, ...bits });
    },
    async remove() {
      await session.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    },
  };
}

// CDP reports base64; WebAuthn JSON carries base64url.
function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/**
 * Signs a WebAuthn assertion in the test runner with a virtual authenticator's own private key, for a
 * `clientDataJSON.origin` the caller picks: a real browser cannot be made to name a foreign origin.
 * Built on node:crypto rather than tests/helpers/passkey-authenticator.ts, which signs only P-256:
 * Chromium's virtual authenticator takes the first algorithm Studio offers, Ed25519 (-8).
 */
export function signAssertion(
  credential: VirtualCredential,
  options: { challenge: string; rpId?: string },
  origin: string,
): Record<string, unknown> {
  const key = createPrivateKey({ key: Buffer.from(credential.privateKey, "base64"), format: "der", type: "pkcs8" });
  const rpId = options.rpId ?? new URL(origin).hostname;
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(credential.signCount + 1);
  // User present and user verified; the virtual authenticator's credentials are not backup eligible.
  const authenticatorData = Buffer.concat([createHash("sha256").update(rpId).digest(), Buffer.from([0x05]), counter]);
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }),
  );
  const signed = Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]);
  // Ed25519 signs the message itself; ECDSA hashes it with SHA-256, and node emits the DER form WebAuthn wants.
  const signature = sign(key.asymmetricKeyType === "ed25519" ? null : "sha256", signed, key);
  const id = base64url(Buffer.from(credential.credentialId, "base64"));
  return {
    id,
    rawId: id,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: base64url(clientDataJSON),
      authenticatorData: base64url(authenticatorData),
      signature: base64url(signature),
      userHandle: base64url(Buffer.from(credential.userHandle ?? "", "base64")),
    },
  };
}
