/**
 * The transport options of a credential-endpoint lane: one socket, TLS checked against the origin's host, no 101
 * answer, link-local addresses refused unless the lane is a metadata endpoint, which lives at one, and the egress
 * decision the spec carries.
 */
import { describe, expect, test } from "bun:test";
import type { HttpOrigin } from "@/lib/db/http/endpoint";
import { type AuthLaneSpec, authLaneOptions } from "@/lib/db/auth/lanes";
import type { EgressDecision } from "@/lib/db/types";
import { ALLOWS_PRIVATE_HOSTS, BLOCKS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";

const HTTPS: HttpOrigin = { scheme: "https", host: "oauth2.googleapis.com", port: 443 };
const HTTP: HttpOrigin = { scheme: "http", host: "meta.internal", port: 8080 };
const egress = ALLOWS_PRIVATE_HOSTS;

describe("authLaneOptions", () => {
  test("an https endpoint: TLS against its host, one socket, no headers, link-local and upgrades refused", () => {
    expect(authLaneOptions({ origin: HTTPS, egress })).toEqual({
      origin: HTTPS,
      tls: { rejectUnauthorized: true, identity: "oauth2.googleapis.com" },
      maxSockets: 1,
      egress,
      headers: {},
      refusesLinkLocal: true,
      refusesUpgrade: true,
    });
  });

  test("a metadata endpoint: plain http, its headers, and the link-local key omitted", () => {
    const options = authLaneOptions({
      origin: HTTP,
      egress,
      headers: { "metadata-flavor": "Google" },
      linkLocalEndpoint: true,
    });
    expect(options).toEqual({
      origin: HTTP,
      tls: null,
      maxSockets: 1,
      egress,
      headers: { "metadata-flavor": "Google" },
      refusesUpgrade: true,
    });
    expect("refusesLinkLocal" in options).toBe(false);
  });

  test("a plain http endpoint that is not a metadata endpoint still refuses link-local addresses", () => {
    expect(authLaneOptions({ origin: HTTP, egress }).refusesLinkLocal).toBe(true);
  });

  test("request header names pass through when given, and are absent otherwise", () => {
    expect(authLaneOptions({ origin: HTTPS, egress, requestHeaderNames: ["x-sample"] }).requestHeaderNames).toEqual([
      "x-sample",
    ]);
    expect("requestHeaderNames" in authLaneOptions({ origin: HTTPS, egress })).toBe(false);
  });

  test("no spec ever yields refusesLinkLocal false", () => {
    const specs: readonly AuthLaneSpec[] = [
      { origin: HTTPS, egress },
      { origin: HTTP, egress },
      { origin: HTTP, egress, linkLocalEndpoint: true },
      { origin: HTTPS, egress, headers: { a: "b" }, requestHeaderNames: [] },
    ];
    for (const spec of specs) expect(authLaneOptions(spec).refusesLinkLocal).not.toBe(false);
  });

  test("a spec's egress decision reaches the lane options, the very object handed", () => {
    for (const handed of [BLOCKS_PRIVATE_HOSTS, ALLOWS_PRIVATE_HOSTS]) {
      expect(authLaneOptions({ origin: HTTPS, egress: handed }).egress).toBe(handed);
      expect(authLaneOptions({ origin: HTTP, egress: handed, linkLocalEndpoint: true }).egress).toBe(handed);
    }
    const own: EgressDecision = { blocksPrivateHosts: true, source: "default" };
    expect(authLaneOptions({ origin: HTTPS, egress: own }).egress).toBe(own);
  });
});
