/**
 * A packed attestation chain under a test root, so a test can show that the library would fetch a
 * CRL for such an attestation, and that Studio's format allowlist refuses it before that.
 */
import { webcrypto } from "node:crypto";
import { SettingsService } from "@simplewebauthn/server";

const CRL_URL = "http://crl.invalid/passkey-test.crl";
const HOUR_MS = 60 * 60 * 1000;
const ALGORITHM = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;

export interface PackedAttestationChain {
  rootPem: string;
  leafDer: Uint8Array;
  crlUrl: string;
}

/** A self-signed root and a leaf under it that packed attestation accepts up to its signature: OU "Authenticator Attestation", CN, O, C "US", version 3, basic constraints CA false, valid from an hour ago for an hour, with a CRL distribution point. */
export async function createPackedAttestationChain(): Promise<PackedAttestationChain> {
  // Loaded late: its CommonJS build needs the reflect polyfill, which @simplewebauthn/server installs
  // when it loads, and a static import can be evaluated before that.
  const x509 = await import("@peculiar/x509");
  x509.cryptoProvider.set(webcrypto as unknown as Crypto);
  const notBefore = new Date(Date.now() - HOUR_MS);
  const notAfter = new Date(Date.now() + HOUR_MS);
  const rootKeys = await webcrypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"]);
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=Passkey Test Root, O=LibreDB Studio Tests, C=US",
    notBefore,
    notAfter,
    signingAlgorithm: ALGORITHM,
    keys: rootKeys as CryptoKeyPair,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  const leafKeys = await webcrypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"]);
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: "02",
    subject: "CN=Passkey Test Leaf, OU=Authenticator Attestation, O=LibreDB Studio Tests, C=US",
    issuer: root.subject,
    notBefore,
    notAfter,
    signingAlgorithm: ALGORITHM,
    publicKey: leafKeys.publicKey as CryptoKey,
    signingKey: rootKeys.privateKey as CryptoKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.CRLDistributionPointsExtension([CRL_URL]),
    ],
  });
  return { rootPem: root.toString("pem"), leafDer: new Uint8Array(leaf.rawData), crlUrl: CRL_URL };
}

/** Trust `rootPem` for the `packed` format through SettingsService.setRootCertificates; the returned function restores an empty list. */
export function trustPackedRoot(rootPem: string): () => void {
  SettingsService.setRootCertificates({ identifier: "packed", certificates: [rootPem] });
  return () => SettingsService.setRootCertificates({ identifier: "packed", certificates: [] });
}
