/**
 * The transport options of a credential-endpoint lane: one socket, TLS checked against the origin's host, no 101
 * answer, and link-local addresses refused unless the lane is a metadata endpoint, which lives at one.
 */
import { describe, expect, test } from "bun:test";
import type { HttpOrigin } from "@/lib/db/http/endpoint";
import { type AuthLaneSpec, authLaneOptions } from "@/lib/db/auth/lanes";

const HTTPS: HttpOrigin = { scheme: "https", host: "oauth2.googleapis.com", port: 443 };
const HTTP: HttpOrigin = { scheme: "http", host: "meta.internal", port: 8080 };

describe("authLaneOptions", () => {
  test("an https endpoint: TLS against its host, one socket, no headers, link-local and upgrades refused", () => {
    expect(authLaneOptions({ origin: HTTPS })).toEqual({
      origin: HTTPS,
      tls: { rejectUnauthorized: true, identity: "oauth2.googleapis.com" },
      maxSockets: 1,
      headers: {},
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
  });

  test("a metadata endpoint: plain http, its headers, and the link-local key omitted", () => {
    const options = authLaneOptions({
      origin: HTTP,
      headers: { "metadata-flavor": "Google" },
      linkLocalEndpoint: true,
    });
    expect(options).toEqual({
      origin: HTTP,
      tls: null,
      maxSockets: 1,
      headers: { "metadata-flavor": "Google" },
      refusesUpgrade: true,
    });
    expect("refusesLinkLocal" in options).toBe(false);
  });

  test("a plain http endpoint that is not a metadata endpoint still refuses link-local addresses", () => {
    expect(authLaneOptions({ origin: HTTP }).refusesLinkLocal).toBe(true);
  });

  test("request header names pass through when given, and are absent otherwise", () => {
    expect(authLaneOptions({ origin: HTTPS, requestHeaderNames: ["x-sample"] }).requestHeaderNames).toEqual([
      "x-sample",
    ]);
    expect("requestHeaderNames" in authLaneOptions({ origin: HTTPS })).toBe(false);
  });

  test("no spec ever yields refusesLinkLocal false", () => {
    const specs: readonly AuthLaneSpec[] = [
      { origin: HTTPS },
      { origin: HTTP },
      { origin: HTTP, linkLocalEndpoint: true },
      { origin: HTTPS, headers: { a: "b" }, requestHeaderNames: [] },
    ];
    for (const spec of specs) expect(authLaneOptions(spec).refusesLinkLocal).not.toBe(false);
  });
});
