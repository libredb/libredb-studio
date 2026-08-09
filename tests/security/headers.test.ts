import { describe, expect, test } from "bun:test";
import { HSTS_MAX_AGE_SECONDS, securityHeaders, studioCspDirectives } from "@/lib/security/headers";

/**
 * Threat: a Content-Security-Policy that lets an attacker load a script from, or send data to,
 * an origin the operator does not control. Credentials live in plaintext in localStorage, so
 * exfiltration containment is what this policy buys (script-src carries 'unsafe-inline' because
 * every document route is statically prerendered with nonce-less inline scripts).
 *
 * These assertions are about the policy's MEANING. They must not encode the serialized string:
 * a reordered directive list is not a regression, a newly admitted host is.
 */

/** Sources that cannot name a foreign host. */
const LOCAL_SOURCES = new Set(["'self'", "'none'", "'unsafe-inline'", "data:", "blob:"]);

describe("studioCspDirectives", () => {
  test("admits no source that could name an origin the operator does not control", () => {
    for (const [directive, sources] of Object.entries(studioCspDirectives())) {
      for (const source of sources) {
        expect({ directive, source, local: LOCAL_SOURCES.has(source) }).toEqual({
          directive,
          source,
          local: true,
        });
      }
    }
  });

  test("never allows eval: an injected string must not become executable code", () => {
    expect(studioCspDirectives()["script-src"]).not.toContain("'unsafe-eval'");
  });

  test("denies the plugin, frame, base-tag and framing vectors outright", () => {
    const directives = studioCspDirectives();

    expect(directives["object-src"]).toEqual(["'none'"]);
    expect(directives["frame-src"]).toEqual(["'none'"]);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(directives["base-uri"]).toEqual(["'none'"]);
  });

  test("confines form submission and network egress to this origin", () => {
    const directives = studioCspDirectives();

    expect(directives["form-action"]).toEqual(["'self'"]);
    expect(directives["connect-src"]).toEqual(["'self'"]);
  });

  test("keeps the schemes the export pipeline and the editor font depend on", () => {
    const directives = studioCspDirectives();

    // snapdom rasterizes by assigning a data:image/svg+xml URL to an <img>; Monaco's
    // editor.main.css embeds the codicon font as a base64 data: URI in @font-face.
    expect(directives["img-src"]).toContain("data:");
    expect(directives["img-src"]).toContain("blob:");
    expect(directives["font-src"]).toContain("data:");
  });

  test("admits an absolute Monaco origin to script-src and worker-src only", () => {
    const directives = studioCspDirectives({ monacoVsPath: "https://assets.example.com/monaco/vs" });

    expect(directives["script-src"]).toContain("https://assets.example.com");
    expect(directives["worker-src"]).toContain("https://assets.example.com");
    expect(directives["connect-src"]).toEqual(["'self'"]);
    expect(directives["img-src"]).not.toContain("https://assets.example.com");
  });

  test("admits the origin of a bare absolute Monaco URL with no path", () => {
    const directives = studioCspDirectives({ monacoVsPath: "https://assets.example.com" });

    expect(directives["script-src"]).toContain("https://assets.example.com");
  });

  test("admits nothing for a same-origin Monaco path", () => {
    expect(studioCspDirectives({ monacoVsPath: "/monaco/vs" })["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
  });

  test("merges an embedder's extra sources into an existing directive without duplicating them", () => {
    const directives = studioCspDirectives({
      extra: { "connect-src": ["https://api.platform.example", "'self'"] },
    });

    expect(directives["connect-src"]).toEqual(["'self'", "https://api.platform.example"]);
  });

  test("adds an embedder's extra directive that the base policy does not carry", () => {
    expect(studioCspDirectives({ extra: { "manifest-src": ["'self'"] } })["manifest-src"]).toEqual(["'self'"]);
  });

  test("ignores an extra directive whose source list is absent", () => {
    const directives = studioCspDirectives({ extra: { "connect-src": undefined } });

    expect(directives["connect-src"]).toEqual(["'self'"]);
  });
});

describe("securityHeaders", () => {
  test("enforces the policy by default", () => {
    const headers = securityHeaders();

    expect(headers["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(headers["Content-Security-Policy-Report-Only"]).toBeUndefined();
  });

  test("names the report-only header when asked, with the identical policy", () => {
    const enforced = securityHeaders()["Content-Security-Policy"];
    const reported = securityHeaders({ reportOnly: true });

    expect(reported["Content-Security-Policy-Report-Only"]).toBe(enforced);
    expect(reported["Content-Security-Policy"]).toBeUndefined();
  });

  test("serializes a valueless directive as its name alone", () => {
    const headers = securityHeaders({ extra: { "upgrade-insecure-requests": [] } });

    expect(headers["Content-Security-Policy"]).toContain("; upgrade-insecure-requests");
  });

  test("blocks MIME sniffing, cross-origin referrers and legacy framing", () => {
    const headers = securityHeaders();

    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("same-origin");
    expect(headers["X-Frame-Options"]).toBe("DENY");
  });

  test("denies every powerful feature it lists and lists nothing the app uses", () => {
    const policy = securityHeaders()["Permissions-Policy"];

    expect(policy).toContain("camera=()");
    expect(policy).toContain("geolocation=()");
    // Unlisted features keep their default 'self' allowlist. Listing clipboard-read or
    // clipboard-write here, even permissively, is how copy-to-clipboard in the results grid breaks.
    expect(policy).not.toContain("clipboard");
    expect(policy?.includes("=(self)")).toBe(false);
  });

  test("sends HSTS for 180 days without includeSubDomains by default", () => {
    expect(securityHeaders()["Strict-Transport-Security"]).toBe(`max-age=${HSTS_MAX_AGE_SECONDS}`);
    expect(HSTS_MAX_AGE_SECONDS).toBe(15552000);
  });

  test("adds includeSubDomains only when the operator opts in", () => {
    const headers = securityHeaders({ hsts: { maxAgeSeconds: 600, includeSubDomains: true } });

    expect(headers["Strict-Transport-Security"]).toBe("max-age=600; includeSubDomains");
  });

  test("omits HSTS entirely when an embedder disables it", () => {
    expect(securityHeaders({ hsts: false })["Strict-Transport-Security"]).toBeUndefined();
  });
});
