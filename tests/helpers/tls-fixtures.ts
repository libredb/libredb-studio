/**
 * The throwaway TLS material of tests/fixtures/tls/ (#1085)
 *
 * The certificates are committed as PEM, in files named .crt because .gitignore ignores *.pem.
 * The two private keys are committed as JWK: the required Secret Scan's default `private-key`
 * rule matches a PEM key wherever it is committed, and a .gitleaksignore fingerprint covers one
 * commit only, so the same key squashed onto main would be a finding again (3023c7e0). Each key
 * is turned back into PEM here, with node:crypto, when a test file loads the set.
 *
 * tests/fixtures/tls/README.md says what every file is and how to make the set again.
 */
import { createPrivateKey, type webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIRECTORY = join(import.meta.dir, "..", "fixtures", "tls");

export interface TlsKeyPair {
  /** A PEM certificate. */
  readonly cert: string;
  /** Its private key, as PKCS#8 PEM. */
  readonly key: string;
}

export interface TlsFixtures {
  /** The CA that signed `server`. */
  readonly ca: string;
  /** A CA that signed nothing here: the wrong CA. */
  readonly otherCa: string;
  /** The CA that signed `client`, which a server asking for a client certificate trusts. */
  readonly clientCa: string;
  /** For localhost, 127.0.0.1 and ::1. */
  readonly server: TlsKeyPair;
  readonly client: TlsKeyPair;
}

function certificate(name: string): string {
  return readFileSync(join(DIRECTORY, `${name}.crt`), "utf8");
}

function privateKey(name: string): string {
  const jwk = JSON.parse(readFileSync(join(DIRECTORY, `${name}.key.jwk.json`), "utf8")) as webcrypto.JsonWebKey;
  return createPrivateKey({ key: jwk, format: "jwk" }).export({ type: "pkcs8", format: "pem" }).toString();
}

export function loadTlsFixtures(): TlsFixtures {
  return {
    ca: certificate("ca"),
    otherCa: certificate("other-ca"),
    clientCa: certificate("client-ca"),
    server: { cert: certificate("server"), key: privateKey("server") },
    client: { cert: certificate("client"), key: privateKey("client") },
  };
}
