/**
 * nodeTlsMaterial and TransportError, the pure half of the shared REST transport (vector-family spec 3.7).
 *
 * nodeTlsMaterial maps the five SSLMode members through one exhaustive record by the repository's one rule,
 * rejectUnauthorized = ssl.rejectUnauthorized ?? ssl.mode !== "require": an absent, null or `disable` panel is
 * plaintext, a panel with no mode verifies, the PEM fields become Buffers, and the identity loses an IPv6 literal's
 * brackets. A panel arrives as its caller wrote it, so a value of the wrong kind is refused by name and never echoed.
 */
import { describe, expect, test } from "bun:test";
import { ConnectionError, DatabaseConfigError } from "@/lib/db/errors";
import { nodeTlsMaterial, TransportError } from "@/lib/db/http/node-transport";
import type { SSLConfig, SSLMode } from "@/lib/types";

// Stand-ins: nodeTlsMaterial never parses PEM, it only carries the text to node:https as bytes.
const CA = "ca-pem-text";
const CERT = "client-certificate-pem-text";
const KEY = "client-key-pem-text";

function refusal(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw");
}

/** A panel as an API body or a seed file may carry it, which SSLConfig does not describe. */
const loose = (panel: Record<string, unknown>): SSLConfig => panel as unknown as SSLConfig;

describe("nodeTlsMaterial: the SSL mode", () => {
  const MODES: [SSLMode, boolean | null][] = [
    ["disable", null],
    ["require", false],
    ["verify-system", true],
    ["verify-ca", true],
    ["verify-full", true],
  ];

  test("the table names every SSLMode member once", () => {
    // A sixth SSLMode member fails typecheck here until it is listed, and then fails this test until it is mapped.
    const every: Record<SSLMode, true> = {
      disable: true,
      require: true,
      "verify-system": true,
      "verify-ca": true,
      "verify-full": true,
    };
    expect(MODES.map(([mode]): string => mode).sort()).toEqual(Object.keys(every).sort());
  });

  test.each(MODES)("%s verifies: %p (null is plaintext)", (mode, verify) => {
    expect(nodeTlsMaterial({ mode }, "db.example.com")).toEqual(
      verify === null ? null : { rejectUnauthorized: verify, identity: "db.example.com" },
    );
  });

  test("an absent and a null panel are plaintext", () => {
    expect(nodeTlsMaterial(undefined, "db.example.com")).toBeNull();
    expect(nodeTlsMaterial(null, "db.example.com")).toBeNull();
  });

  test("a panel with no mode verifies, as a seed file's panel may omit it", () => {
    expect(nodeTlsMaterial(loose({}), "db.example.com")).toEqual({
      rejectUnauthorized: true,
      identity: "db.example.com",
    });
    expect(nodeTlsMaterial(loose({ mode: null }), "db.example.com")?.rejectUnauthorized).toBe(true);
  });

  test("disable is plaintext whatever else the panel holds", () => {
    expect(nodeTlsMaterial({ mode: "disable", caCert: CA, rejectUnauthorized: true }, "db.example.com")).toBeNull();
  });
});

describe("nodeTlsMaterial: rejectUnauthorized", () => {
  test.each([
    ["require", true, true],
    ["require", false, false],
    ["verify-full", false, false],
    ["verify-system", false, false],
    ["verify-ca", true, true],
  ] as const)("%s with rejectUnauthorized %p verifies: %p", (mode, flag, verify) => {
    expect(nodeTlsMaterial({ mode, rejectUnauthorized: flag }, "h.example")?.rejectUnauthorized).toBe(verify);
  });

  test("a null flag reads as absent, as a JSON body writes an absent field", () => {
    expect(nodeTlsMaterial(loose({ mode: "require", rejectUnauthorized: null }), "h.example")?.rejectUnauthorized).toBe(
      false,
    );
  });
});

describe("nodeTlsMaterial: the PEM fields and the identity", () => {
  test("CA, certificate and key are read from the panel as Buffers, never as paths", () => {
    const material = nodeTlsMaterial({ mode: "verify-ca", caCert: CA, clientCert: CERT, clientKey: KEY }, "h.example");
    expect(Buffer.isBuffer(material?.ca)).toBe(true);
    expect(material?.ca?.toString("utf8")).toBe(CA);
    expect(material?.cert?.toString("utf8")).toBe(CERT);
    expect(material?.key?.toString("utf8")).toBe(KEY);
  });

  test("an empty field is left out, because a cleared form field is not a certificate", () => {
    expect(nodeTlsMaterial({ mode: "verify-ca", caCert: "", clientCert: "", clientKey: "" }, "h.example")).toEqual({
      rejectUnauthorized: true,
      identity: "h.example",
    });
  });

  test.each([
    ["a DNS name", "qdrant.example.com", "qdrant.example.com"],
    ["an IPv4 literal", "10.0.0.5", "10.0.0.5"],
    ["an IPv6 literal in the brackets httpOrigin writes", "[::1]", "::1"],
    ["an IPv6 literal without brackets", "fd00::5", "fd00::5"],
  ])("the identity of %s is %p", (_label, identity, expected) => {
    expect(nodeTlsMaterial({ mode: "verify-full" }, identity)?.identity).toBe(expected);
  });
});

describe("nodeTlsMaterial: refusals name the field and never repeat the value", () => {
  const MODE = "Invalid ssl.mode: expected disable, require, verify-system, verify-ca or verify-full";
  const PAIR = "Invalid ssl.clientCert and ssl.clientKey: give both or neither";
  test.each([
    ["an unknown mode", loose({ mode: "verify-everything-secret" }), MODE],
    ["a mode that names an Object prototype key", loose({ mode: "__proto__" }), MODE],
    ["a mode that is not text", loose({ mode: 1 }), MODE],
    [
      "a rejectUnauthorized that is text",
      loose({ mode: "require", rejectUnauthorized: "false-secret" }),
      "Invalid ssl.rejectUnauthorized: expected true or false",
    ],
    ["a CA that is not text", loose({ mode: "verify-ca", caCert: 42 }), "Invalid ssl.caCert: expected PEM text"],
    [
      "a client certificate that is not text",
      loose({ mode: "verify-ca", clientCert: {}, clientKey: KEY }),
      "Invalid ssl.clientCert: expected PEM text",
    ],
    [
      "a client key that is not text",
      loose({ mode: "verify-ca", clientCert: CERT, clientKey: [] }),
      "Invalid ssl.clientKey: expected PEM text",
    ],
    ["a client certificate with no key", loose({ mode: "verify-ca", clientCert: CERT }), PAIR],
    ["a client key with no certificate", loose({ mode: "verify-ca", clientKey: KEY }), PAIR],
  ])("%s", (_label, panel, message) => {
    const error = refusal(() => nodeTlsMaterial(panel, "h.example"));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(message);
    expect(error.message).not.toContain("secret");
  });
});

describe("nodeTlsMaterial: a panel that is not an object", () => {
  test.each([false, true, "disable", "verify-full-secret", 0, ["verify-full"]])(
    "%p is refused by name, never read as a panel that verifies",
    (panel) => {
      const error = refusal(() => nodeTlsMaterial(panel as unknown as SSLConfig, "h.example"));
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toBe("Invalid ssl: expected an object");
      expect(error.message).not.toContain("secret");
    },
  );
});

describe("TransportError", () => {
  test("is a ConnectionError that carries its kind", () => {
    const error = new TransportError(
      "too-large",
      "The response exceeded the 8-byte limit for one response, so it was not read to the end",
    );
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error).toBeInstanceOf(TransportError);
    expect(error.name).toBe("TransportError");
    expect(error.kind).toBe("too-large");
    expect(error.code).toBe("CONNECTION_ERROR");
  });
});
