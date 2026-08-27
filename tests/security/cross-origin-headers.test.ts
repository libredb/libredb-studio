import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { NextConfig } from "next";
import nextConfig, { DOCUMENT_ONLY_HEADER_NAMES, OPTION_PROBE, selectStaticAssetHeaders } from "../../next.config";
import packageJson from "../../package.json";
import { securityHeaders } from "@/lib/security/headers";

/**
 * The two cross-origin headers AU2 left undecided, settled (#512).
 *
 * `Cross-Origin-Opener-Policy` is SENT, on the document path only: it is set in
 * src/lib/security/headers.ts, applied per request by src/proxy.ts, and classified document-only
 * in next.config.ts so it can never join the build-time baked set.
 * `Cross-Origin-Resource-Policy` is refused; the reason lives beside the header rule in
 * next.config.ts and the half of it that can stop being true is pinned below.
 *
 * What this file owns, and how it differs from tests/security/header-delivery.test.ts - which is
 * NOT the same fact spelled twice, though the two do overlap on one outcome:
 *
 * - header-delivery.test.ts asks what a PATH receives. It walks each rule's `source`, so its red
 *   says "/logo.svg got the wrong headers".
 * - this file asks what CLASS a HEADER NAME belongs to, and never looks at a `source`. Its red
 *   says "this header was given the wrong class", or - the case no other test in the suite can
 *   produce - "this header was added to securityHeaders() with no class at all".
 *
 * That last branch is the point. next.config.ts selects by EXCLUSION, which is fail-open: a new
 * constant document header is baked onto /logo.svg and every _next/static chunk unless somebody
 * remembers to exclude it. An exact-equality list of names goes red too, but the path of least
 * resistance is to append the name and move on. The classification table below cannot be satisfied
 * that way - it demands one of three named reasons, and each declared reason is then checked
 * against what the code actually does.
 */

const HEADERS_MODULE = "src/lib/security/headers.ts";
const HEADERS_SOURCE = readFileSync(path.resolve(import.meta.dir, "../..", HEADERS_MODULE), "utf8");

/**
 * The property names declared on one exported interface in src/lib/security/headers.ts, read from
 * the source because a TypeScript interface has no runtime shape to enumerate.
 *
 * Members are matched at exactly two spaces of indentation, which the doc comments between them
 * (three spaces, then `*`) cannot reach. Throws rather than returning [] when the interface is
 * gone, so a rename cannot make the callers below pass vacuously.
 */
function declaredOptionNames(interfaceName: string): string[] {
  const start = HEADERS_SOURCE.indexOf(`export interface ${interfaceName} `);
  if (start === -1) throw new Error(`${HEADERS_MODULE} declares no exported interface ${interfaceName}`);
  const body = HEADERS_SOURCE.slice(start, HEADERS_SOURCE.indexOf("\n}", start));
  return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1]);
}

function declaredOptionSurface(): string[] {
  return [...declaredOptionNames("CspOptions"), ...declaredOptionNames("SecurityHeaderOptions")].sort();
}

/**
 * Why a given header may or may not be baked into the routes manifest. Every header
 * securityHeaders() sends must name one, and the name must be the true one.
 *
 * - `baked`      acts on a subresource and is a constant, so next.config.ts delivers it too
 * - `document-only` no algorithm reads it off a subresource, so baking it is inert noise
 * - `option-dependent` src/lib/security/config.ts can change it per process, so a build-time copy
 *                  would outlive the operator's runtime decision
 */
type HeaderClass = "baked" | "document-only" | "option-dependent";

const HEADER_CLASSIFICATION: Record<string, HeaderClass> = {
  // nosniff is the one that is genuinely load-bearing on a subresource; X-Frame-Options matters
  // because public/ serves .svg files, which are document contexts when navigated to directly.
  "X-Content-Type-Options": "baked",
  "X-Frame-Options": "baked",
  // Read only for a top-level traversable (COOP), or only by the document that received them.
  "Cross-Origin-Opener-Policy": "document-only",
  "Referrer-Policy": "document-only",
  "Permissions-Policy": "document-only",
  // CSP_REPORT_ONLY renames it; HSTS is host-scoped and its includeSubDomains is operator-set.
  "Content-Security-Policy": "option-dependent",
  "Strict-Transport-Security": "option-dependent",
};

/**
 * The class next.config.ts's two exclusions actually put a header in, in the order the filter
 * applies them: the document-only Set is consulted first, so a header that is both is document-only
 * and the option comparison never decides it.
 */
function measuredClass(name: string, shipped: Record<string, string>, probed: Record<string, string>): HeaderClass {
  if (DOCUMENT_ONLY_HEADER_NAMES.has(name)) return "document-only";
  return probed[name] === shipped[name] ? "baked" : "option-dependent";
}

async function bakedHeaderNames(): Promise<string[]> {
  const rules = await (nextConfig.headers as NonNullable<NextConfig["headers"]>)();
  return rules.flatMap((rule) => rule.headers).map(({ key }) => key);
}

describe("#512: every header securityHeaders() sends is classified, and the class is measured", () => {
  test("a header with no declared class fails here, which is what the exclusion form cannot do alone", () => {
    // The fail-open guard. Adding a header to securityHeaders() and nothing else leaves it BAKED
    // by default - onto /logo.svg and every _next/static chunk - with no decision recorded.
    // `Cross-Origin-Embedder-Policy` is the realistic next one, and it would be exactly that
    // mistake: constant, document-facing, and inert on a subresource.
    expect(Object.keys(securityHeaders()).sort()).toEqual(Object.keys(HEADER_CLASSIFICATION).sort());
  });

  test("each declared class is the one the two exclusions actually produce", () => {
    const shipped = securityHeaders();
    const probed = securityHeaders(OPTION_PROBE);

    const measured = Object.fromEntries(
      Object.keys(HEADER_CLASSIFICATION).map((name) => [name, measuredClass(name, shipped, probed)]),
    );

    expect(measured).toEqual(HEADER_CLASSIFICATION);
  });

  test("what actually gets baked is exactly the headers classed baked, and nothing else", () => {
    // The outcome here overlaps header-delivery.test.ts by construction - it must, or the
    // classification would be decorative. What differs is the failure: a name appearing there says
    // a path was served the wrong set; a name appearing here says the class above is a lie.
    const bakeable = selectStaticAssetHeaders(securityHeaders(), securityHeaders(OPTION_PROBE)).map(({ key }) => key);
    const classedBaked = Object.entries(HEADER_CLASSIFICATION)
      .filter(([, headerClass]) => headerClass === "baked")
      .map(([name]) => name);

    expect(bakeable.sort()).toEqual(classedBaked.sort());
  });

  test("the document-only exclusion is what drops COOP, isolated from the option comparison", () => {
    // Both arguments are the same object, so the option filter is inert and only the Set decides.
    // Without this, a COOP that happened to vary under some future option would still be excluded
    // and the document-only classification above would be passing for the wrong reason.
    const shipped = securityHeaders();
    const names = selectStaticAssetHeaders(shipped, shipped).map(({ key }) => key);

    expect({
      coop: names.includes("Cross-Origin-Opener-Policy"),
      control: names.includes("X-Content-Type-Options"),
    }).toEqual({ coop: false, control: true });
  });

  test("a header whose value or presence depends on an option is dropped, measured not listed", () => {
    // AU2's rule, executed rather than asserted, and driven with synthetic maps because neither
    // interesting shape can be produced from the real header set. Both are covered: a value that
    // changes, and a NAME that changes (the CSP's report-only spelling), which reaches the filter
    // as an absence rather than as a difference.
    const shipped = { Constant: "a", Varies: "a", "Renamed-When-Off": "a" };
    const probed = { Constant: "a", Varies: "b", "Renamed-When-Off-Report-Only": "a" };

    expect(selectStaticAssetHeaders(shipped, probed)).toEqual([{ key: "Constant", value: "a" }]);
  });

  test("the option probe varies every option src/lib/security/headers.ts declares", () => {
    // The probe must be TOTAL over the declared option surface. Not for the discriminating power
    // next.config.ts's comment used to claim - the test below measures how little that is - but so
    // that the next option added, one that may well move a non-CSP header, is probed on the day it
    // lands rather than rotting unnoticed. `extra` had rotted exactly that way: declared on the
    // exported `CspOptions` interface and varied by no probe field at all until #512.
    const declared = declaredOptionSurface();

    expect(Object.keys(OPTION_PROBE).sort()).toEqual(declared);
    // Non-vacuity: a regex that stopped matching would return [] and make the equality above pass
    // against an empty probe.
    expect(declared).toContain("extra");
    expect(declared.length).toBeGreaterThanOrEqual(5);
  });

  test("only two of the probe's five fields discriminate anything today, and that is measured", () => {
    // The honest counterweight to the test above, and the reason next.config.ts no longer claims
    // that measuring the probe is what makes the rule enforceable. Reducing OPTION_PROBE to
    // { reportOnly, hsts } selects the identical set: `allowEval`, `monacoVsPath` and `extra` move
    // the CSP's VALUE and nothing else, and the CSP is already excluded because `reportOnly`
    // RENAMES it, which reaches the filter as an absence. Pinning the inertness rather than
    // asserting it in prose means the day one of those three - or a newly added option - starts
    // moving a non-CSP header, this goes red and that comment gets re-read instead of trusted.
    const full = selectStaticAssetHeaders(securityHeaders(), securityHeaders(OPTION_PROBE));
    const reduced = selectStaticAssetHeaders(securityHeaders(), securityHeaders({ reportOnly: true, hsts: false }));

    expect(reduced).toEqual(full);
    // Non-vacuity: two empty selections are equal, which would make the equality above meaningless.
    expect(full.length).toBeGreaterThan(0);
  });
});

describe("#512: Cross-Origin-Resource-Policy is refused, not forgotten", () => {
  test("neither delivery path carries it", async () => {
    const baked = await bakedHeaderNames();

    // The positive halves are the control. Without them a header rename or an empty rule set makes
    // the two absences pass forever, which is the failure mode a bare toBeUndefined() invites.
    // `Object.hasOwn` rather than an undefined check, so a name present with an empty value - which
    // a browser would treat as an unparseable policy and ignore - still reads as delivered.
    const shipped = securityHeaders();

    expect({
      document: Object.hasOwn(shipped, "Cross-Origin-Resource-Policy"),
      documentControl: shipped["X-Content-Type-Options"],
      baked: baked.includes("Cross-Origin-Resource-Policy"),
      bakedControl: baked.includes("X-Content-Type-Options"),
    }).toEqual({ document: false, documentControl: "nosniff", baked: false, bakedControl: true });
  });

  test("the half of the refusal that can stop being true: no caller can state its topology", () => {
    // Half the recorded reason is that CORP's correct value is a property of the DEPLOYMENT
    // TOPOLOGY rather than of the application. That half rests on securityHeaders() having no way
    // to be TOLD a topology: whatever value it carried would be one constant for every caller, and
    // its callers are unbounded because `./security` is a published npm subpath. It is deliberately
    // no longer stated as "libredb-platform adopts this policy" - CLAUDE.md records that platform
    // stopped embedding Studio on 2026-08-14, and a self-hoster's own arrangement of origins varies
    // whether or not anyone embeds the package.
    //
    // What goes red here is the day SecurityHeaderOptions grows a way to express that topology, at
    // which point the refusal is obsolete and next.config.ts's comment must be re-read rather than
    // trusted. What this does NOT pin, and what the previous `exports["./security"] is defined`
    // assertion silently pretended to: whether anyone out there actually consumes the subpath. No
    // test in this repository can see that.
    const declared = declaredOptionSurface();

    expect({
      topologyOptions: declared.filter((name) => /corp|crossorigin|origin|topology/i.test(name)),
      anchor: declared.includes("monacoVsPath"),
      publishedSubpath: Object.hasOwn(packageJson.exports, "./security"),
    }).toEqual({ topologyOptions: [], anchor: true, publishedSubpath: true });
  });
});
