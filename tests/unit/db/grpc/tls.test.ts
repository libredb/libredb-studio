/**
 * The SSL / TLS panel mapping of the shared gRPC transport (src/lib/db/grpc/tls.ts): the panel read once for every
 * gRPC provider, the TLS identity of one dialled host, the dial target and the endpoint host rule.
 * The check order is pinned step by step through etcd's connection-options.test.ts; this file pins where the steps
 * meet the PEM (a pair half before the CA, the CA before the pair) and holds what the module adds: the sentences and
 * errors are the caller's, and the client-certificate hook is optional.
 */
import { describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  type GrpcConfigWords,
  type GrpcTlsMaterial,
  grpcEndpointHost,
  grpcTarget,
  grpcTlsIdentity,
  readGrpcTlsPanel,
} from "@/lib/db/grpc/tls";
import { validateHost } from "@/lib/db/http/endpoint";
import { loadTlsFixtures } from "../../../helpers/tls-fixtures";

const certificates = loadTlsFixtures();

const HOST_TAKES_NAME_ONLY = "Host takes a name or address only; put the port in Port and choose TLS under SSL / TLS.";
const CA_NOT_PEM =
  "The CA Certificate under SSL / TLS is not one or more PEM certificates: paste the certificate of the CA that issued Engine X's server certificate there.";
const CLIENT_PAIR =
  "The Client Certificate and the Client Private Key under SSL / TLS go together: add the missing one, or clear both.";
const CLIENT_KEY_MISMATCH =
  "The Client Private Key under SSL / TLS is not the key of the Client Certificate: paste the private key issued with that certificate there.";

/** A caller's words that keep every error they hand out, so a test can tell the thrown object is one of them. */
function recordingWords(hook?: GrpcConfigWords["clientCertificateRefusal"]) {
  const made: DatabaseConfigError[] = [];
  const wrongTypes: Array<{ field: string; expected: string }> = [];
  const refuse = (message: string) => {
    const error = new DatabaseConfigError(message);
    made.push(error);
    return error;
  };
  const words: GrpcConfigWords = {
    engine: "Engine X",
    refuse,
    wrongType: (field, expected) => {
      wrongTypes.push({ field, expected });
      return refuse(`wrong type: ${field} must be ${expected}`);
    },
    ...(hook === undefined ? {} : { clientCertificateRefusal: hook }),
  };
  return { words, made, wrongTypes };
}

/** What a call throws; a call that answers fails the test. */
function thrown(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  throw new Error("The call answered, though this test expects it to refuse");
}

describe("readGrpcTlsPanel", () => {
  test("the CA sentence names the caller's engine", () => {
    const { words, made } = recordingWords();
    const error = thrown(() => readGrpcTlsPanel({ mode: "verify-ca", caCert: "not a certificate" }, words));
    expect(error).toBe(made[0]);
    expect((error as Error).message).toBe(CA_NOT_PEM);
    // A block under the right label whose body is no certificate is the same sentence.
    const framed = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
    expect((thrown(() => readGrpcTlsPanel({ caCert: framed }, words)) as Error).message).toBe(CA_NOT_PEM);
  });

  test("every refusal is the caller's error", () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      ["verify-full", "wrong type: ssl must be an object"],
      [["verify-full"], "wrong type: ssl must be an object"],
      [{ mode: 1 }, "wrong type: ssl.mode must be disable, require, verify-system, verify-ca or verify-full"],
      [{ mode: "prefer" }, "wrong type: ssl.mode must be disable, require, verify-system, verify-ca or verify-full"],
      [{ caCert: 1 }, "wrong type: ssl.caCert must be a string"],
      [{ rejectUnauthorized: "no" }, "wrong type: ssl.rejectUnauthorized must be true or false"],
      [{ caCert: "not a certificate" }, CA_NOT_PEM],
      [
        { caCert: ` ${certificates.ca}` },
        "The CA Certificate under SSL / TLS has a -----BEGIN marker that does not start its line: put each -----BEGIN marker at the start of a line there, with nothing before it, not even a space or a byte order mark.",
      ],
      [
        { caCert: certificates.ca.replaceAll("CERTIFICATE-----", "TRUSTED CERTIFICATE-----") },
        "The CA Certificate under SSL / TLS holds a TRUSTED CERTIFICATE block, OpenSSL's form with trust settings, which not every runtime reads: paste the certificate in its plain PEM form there, as openssl x509 -in <file> prints it.",
      ],
      [{ clientCert: certificates.client.cert }, CLIENT_PAIR],
      [{ clientKey: certificates.client.key }, CLIENT_PAIR],
      [
        { clientCert: "not a certificate", clientKey: certificates.client.key },
        "The Client Certificate under SSL / TLS is not a PEM certificate: paste the certificate issued for this client there, and its key under Client Private Key.",
      ],
      [
        { clientCert: certificates.client.cert, clientKey: "not a key" },
        "The Client Private Key under SSL / TLS is not a PEM private key: paste the private key of the Client Certificate there.",
      ],
      [
        { clientCert: certificates.client.cert, clientKey: "Proc-Type: 4,ENCRYPTED\nnot a key" },
        "The Client Private Key under SSL / TLS is encrypted, and SSL / TLS has no passphrase field: paste the key unencrypted there.",
      ],
      [{ clientCert: certificates.client.cert, clientKey: certificates.server.key }, CLIENT_KEY_MISMATCH],
    ];
    for (const [panel, message] of cases) {
      const { words, made } = recordingWords();
      const error = thrown(() => readGrpcTlsPanel(panel, words));
      expect(made).toHaveLength(1);
      expect(error).toBe(made[0]);
      expect((error as Error).message).toBe(message);
    }
  });

  test("the wrong-type error is asked for by field and by what it must be", () => {
    const { words, wrongTypes } = recordingWords();
    thrown(() => readGrpcTlsPanel({ mode: "prefer" }, words));
    thrown(() => readGrpcTlsPanel({ clientKey: 1 }, words));
    expect(wrongTypes).toEqual([
      { field: "ssl.mode", expected: "disable, require, verify-system, verify-ca or verify-full" },
      { field: "ssl.clientKey", expected: "a string" },
    ]);
  });

  test("the panel is checked whole before its mode is read, a pair half before the CA, and the CA before the pair", () => {
    const { words } = recordingWords();
    // A disabled panel with a field of the wrong type is still refused.
    expect((thrown(() => readGrpcTlsPanel({ mode: "disable", clientCert: 1 }, words)) as Error).message).toBe(
      "wrong type: ssl.clientCert must be a string",
    );
    // A disabled panel reads none of its PEM.
    expect(readGrpcTlsPanel({ mode: "disable", caCert: "not a certificate" }, words)).toBeUndefined();
    expect(
      (
        thrown(() =>
          readGrpcTlsPanel({ caCert: "not a certificate", clientCert: certificates.client.cert }, words),
        ) as Error
      ).message,
    ).toBe(CLIENT_PAIR);
    // A CA that does not parse and a client pair that does not match: the CA, drawn first on the panel, answers.
    const badCaAndPair = {
      caCert: "not a certificate",
      clientCert: certificates.client.cert,
      clientKey: certificates.server.key,
    };
    expect((thrown(() => readGrpcTlsPanel(badCaAndPair, words)) as Error).message).toBe(CA_NOT_PEM);
  });

  test("the client-certificate hook runs after the certificate parses and before the key match, and only when given", () => {
    const mismatched = { clientCert: certificates.client.cert, clientKey: certificates.server.key };
    const seen: Array<{ x509: X509Certificate; now: number }> = [];
    const before = Date.now();
    const hooked = recordingWords((x509, now) => {
      seen.push({ x509, now });
      return "The hook's own sentence.";
    });
    const error = thrown(() => readGrpcTlsPanel(mismatched, hooked.words));
    expect(error).toBe(hooked.made[0]);
    expect((error as Error).message).toBe("The hook's own sentence.");
    expect(seen).toHaveLength(1);
    expect(seen[0].x509).toBeInstanceOf(X509Certificate);
    expect(seen[0].x509.fingerprint256).toBe(new X509Certificate(certificates.client.cert).fingerprint256);
    expect(seen[0].now).toBeGreaterThanOrEqual(before);
    expect(seen[0].now).toBeLessThanOrEqual(Date.now());

    // A certificate that does not parse never reaches the hook.
    const unparsed = recordingWords(() => {
      throw new Error("The hook ran on a certificate that does not parse");
    });
    expect(
      (thrown(() => readGrpcTlsPanel({ ...mismatched, clientCert: "not a certificate" }, unparsed.words)) as Error)
        .message,
    ).toStartWith("The Client Certificate under SSL / TLS is not a PEM certificate");

    // A hook with nothing to refuse leaves the key match to decide.
    const silent = recordingWords(() => undefined);
    expect((thrown(() => readGrpcTlsPanel(mismatched, silent.words)) as Error).message).toBe(CLIENT_KEY_MISMATCH);
    expect(
      readGrpcTlsPanel({ clientCert: certificates.client.cert, clientKey: certificates.client.key }, silent.words),
    ).toEqual({ mode: "verify-full", clientCertificate: certificates.client, verify: true });

    // With no hook, the two steps are the certificate and the key.
    const plain = recordingWords();
    expect((thrown(() => readGrpcTlsPanel(mismatched, plain.words)) as Error).message).toBe(CLIENT_KEY_MISMATCH);
  });

  test("disable and an absent or null panel are no TLS", () => {
    const { words, made } = recordingWords();
    expect(readGrpcTlsPanel(undefined, words)).toBeUndefined();
    expect(readGrpcTlsPanel(null, words)).toBeUndefined();
    expect(readGrpcTlsPanel({ mode: "disable" }, words)).toBeUndefined();
    expect(made).toHaveLength(0);
  });

  test("a panel with no mode verifies", () => {
    const { words } = recordingWords();
    expect(readGrpcTlsPanel({}, words)).toEqual({ mode: "verify-full", verify: true });
    expect(readGrpcTlsPanel({ mode: null, caCert: "", clientCert: null }, words)).toEqual({
      mode: "verify-full",
      verify: true,
    });
  });

  test("each TLS mode answers its row, and rejectUnauthorized decides when it is set", () => {
    const { words } = recordingWords();
    expect(readGrpcTlsPanel({ mode: "require" }, words)).toEqual({ mode: "require", verify: false });
    expect(readGrpcTlsPanel({ mode: "verify-system" }, words)).toEqual({ mode: "verify-system", verify: true });
    expect(readGrpcTlsPanel({ mode: "verify-ca" }, words)).toEqual({ mode: "verify-ca", verify: true });
    expect(readGrpcTlsPanel({ mode: "require", rejectUnauthorized: true }, words)).toEqual({
      mode: "require",
      verify: true,
    });
    expect(readGrpcTlsPanel({ mode: "verify-full", rejectUnauthorized: false }, words)).toEqual({
      mode: "verify-full",
      verify: false,
    });
    // A bundle of two certificates with a comment line between them is carried as configured.
    const bundle = `${certificates.ca}# the other one\n${certificates.otherCa}`;
    expect(readGrpcTlsPanel({ mode: "verify-ca", caCert: bundle }, words)).toEqual({
      mode: "verify-ca",
      ca: bundle,
      verify: true,
    });
  });
});

describe("grpcTlsIdentity", () => {
  const bare: GrpcTlsMaterial = { mode: "verify-full", verify: true };

  test("a name is its own server name; an IPv4 and an IPv6 identity take the caller's IP server name", () => {
    expect(grpcTlsIdentity(bare, "db.example", "engine-x.invalid")).toEqual({
      mode: "verify-full",
      verify: true,
      identity: "db.example",
      identityIsIp: false,
      serverNameOverride: "db.example",
    });
    expect(grpcTlsIdentity(bare, "10.0.0.7", "engine-x.invalid")).toEqual({
      mode: "verify-full",
      verify: true,
      identity: "10.0.0.7",
      identityIsIp: true,
      serverNameOverride: "engine-x.invalid",
    });
    expect(grpcTlsIdentity(bare, "::1", "engine-x.invalid")).toEqual({
      mode: "verify-full",
      verify: true,
      identity: "::1",
      identityIsIp: true,
      serverNameOverride: "engine-x.invalid",
    });
  });

  test("the optional fields are present only when the material has them", () => {
    expect(Object.keys(grpcTlsIdentity(bare, "db.example", "engine-x.invalid"))).toEqual([
      "mode",
      "verify",
      "identity",
      "identityIsIp",
      "serverNameOverride",
    ]);
    const full: GrpcTlsMaterial = {
      mode: "require",
      ca: certificates.ca,
      clientCertificate: certificates.client,
      verify: false,
    };
    expect(grpcTlsIdentity(full, "db.example", "engine-x.invalid")).toEqual({
      mode: "require",
      ca: certificates.ca,
      clientCertificate: certificates.client,
      verify: false,
      identity: "db.example",
      identityIsIp: false,
      serverNameOverride: "db.example",
    });
  });
});

describe("grpcTarget", () => {
  test("a bare IPv6 host is bracketed, and every other host is written as it is", () => {
    expect(grpcTarget("::1", 443)).toBe("dns:[::1]:443");
    expect(grpcTarget("db.example", 6648)).toBe("dns:db.example:6648");
    expect(grpcTarget("10.0.0.7", 2379)).toBe("dns:10.0.0.7:2379");
  });
});

describe("grpcEndpointHost", () => {
  test("a validated host is answered bare and in lower case", () => {
    const { words, made } = recordingWords();
    expect(grpcEndpointHost("[::1]", words)).toBe("::1");
    expect(grpcEndpointHost("::1", words)).toBe("::1");
    expect(grpcEndpointHost("Host.Example", words)).toBe("host.example");
    expect(grpcEndpointHost("10.0.0.7", words)).toBe("10.0.0.7");
    expect(made).toHaveLength(0);
  });

  test("a pasted endpoint is refused with the Host sentence, as the caller's error", () => {
    for (const pasted of ["host:2379", "https://host.example", "[::1]:2379"]) {
      const { words, made } = recordingWords();
      const error = thrown(() => grpcEndpointHost(pasted, words));
      expect(error).toBe(made[0]);
      expect((error as Error).message).toBe(HOST_TAKES_NAME_ONLY);
    }
  });

  test("every other refusal is the host validator's own message, re-raised as the caller's error", () => {
    for (const refused of ["", 2379, undefined, "::1%lo"]) {
      const { words, made } = recordingWords();
      const error = thrown(() => grpcEndpointHost(refused, words));
      expect(made).toHaveLength(1);
      expect(error).toBe(made[0]);
      expect((error as Error).message).toBe((thrown(() => validateHost(refused)) as Error).message);
      expect((error as Error).message).not.toBe(HOST_TAKES_NAME_ONLY);
    }
  });
});
