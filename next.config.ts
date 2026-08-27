import type { NextConfig } from "next";
import packageJson from "./package.json";
// Relative, not "@/": Next loads this file before any tsconfig path alias exists for it, and
// src/lib/security/headers.ts is import-free by design precisely so a next.config can read it.
import { securityHeaders, type SecurityHeaderOptions } from "./src/lib/security/headers";

/**
 * The second delivery path for the security headers (backlog AU2, extended by #512).
 *
 * src/proxy.ts hardens every document, but its matcher deliberately skips `_next/static`,
 * `_next/image` and every path containing a dot, so `proxy()` never runs for a file under
 * `public/` or for `/monaco/vs/*.js`. That exclusion is right for AUTH - none of those needs a
 * login redirect - but header delivery and auth redirection are two concerns that happen to share
 * one matcher. `headers()` covers what the matcher skips.
 *
 * Which of the document headers may be delivered from HERE is decided by two exclusions, and both
 * used to be prose in this comment. They are derived below instead, because an asserted rule is
 * not a run rule: an allowlist of two names could not say WHY a third was absent.
 *
 * That derivation REVERSED the default, and saying so is the honest half of the change. AU2's
 * allowlist was fail-CLOSED - a header added to securityHeaders() was not baked until somebody
 * opted it in. `selectStaticAssetHeaders` below is fail-OPEN: a new constant document header IS
 * baked, onto /logo.svg and every `_next/static` chunk, unless somebody remembers to exclude it.
 * `Cross-Origin-Embedder-Policy` is the realistic next one and would be exactly that mistake.
 * What carries the closed default now is not a list in this file but the classification table in
 * tests/security/cross-origin-headers.test.ts: it requires every header securityHeaders() sends to
 * declare one of three named reasons, and then checks the declared reason against the class these
 * two exclusions actually produce. Appending a name to a list of names satisfies an equality
 * assertion; it does not satisfy that table.
 *
 * Delivered, therefore:
 * - `X-Content-Type-Options` (the header AU2 names): the one that is genuinely load-bearing on a
 *   subresource. `nosniff` makes the browser honour the declared MIME type instead of guessing,
 *   and additionally makes it refuse a script or stylesheet whose declared type is not one, so a
 *   response served with a wrong or generic type cannot be turned into executable code.
 * - `X-Frame-Options`: `public/` serves `.svg` files (`ls public/*.svg`), and an SVG reached by
 *   top-level navigation or `<object>` is a document context, not an image - it can execute script
 *   and can be framed. Constant value, no environment input.
 *
 * Excluded by OPTION_PROBE, because this function is evaluated at BUILD time and baked into the
 * routes manifest while src/lib/security/config.ts reads its environment per process:
 * - `Content-Security-Policy`: a subresource response's own CSP governs almost nothing (the
 *   loading document's policy applies), and baking it would strand it behind the build. The
 *   CSP_REPORT_ONLY escape hatch exists for the operator who cannot rebuild a prebuilt image; a
 *   build-time copy would keep enforcing after they flipped it.
 * - `Strict-Transport-Security`: HSTS is host-scoped, so a browser keeps whichever value arrived
 *   LAST. `includeSubDomains` is operator-configurable at runtime, so a baked copy would let a
 *   request for `/logo.svg` silently downgrade the policy the document just set. One authority for
 *   HSTS beats delivering it twice.
 *
 * Excluded by DOCUMENT_ONLY_HEADER_NAMES: `Referrer-Policy`, `Permissions-Policy` and - settled
 * by #512 - `Cross-Origin-Opener-Policy`. See that Set.
 *
 * Deliberately NOT delivered, and not excluded by either rule because it never enters
 * securityHeaders() at all:
 * - `Cross-Origin-Resource-Policy`: REFUSED (#512). CORP is the mirror image of the document-only
 *   class - it acts ONLY on a subresource, so this file is the only path that could carry it, and
 *   the refusal is about the delivery architecture rather than about the header.
 *
 *   It could not break the editor, and that is read out of the specification rather than assumed.
 *   Main fetch runs the cross-origin resource policy check only "If either request's response
 *   tainting or response's type is `opaque`". In the same algorithm, the branch whose condition is
 *   "request's current URL's origin is same origin with request's origin, and request's response
 *   tainting is `basic`" sets that tainting to "basic" and returns; the branch that sets "opaque"
 *   is "request's mode is `no-cors`", reached only when no earlier branch matched
 *   (https://fetch.spec.whatwg.org/#main-fetch; the check itself is defined at
 *   https://fetch.spec.whatwg.org/#cross-origin-resource-policy-check). So a same-origin
 *   subresource never reaches the check at all.
 *
 *   Under the shipped defaults every asset the editor needs is same-origin: /monaco/vs/*.js,
 *   editor.main.css, the codicon data: font, the blob: language workers and the ELK module worker.
 *   `NEXT_PUBLIC_MONACO_VS_PATH` is the one documented way that stops being true, and it does not
 *   weaken the paragraph above: a CORP header of OURS never labels another origin's responses, so
 *   an off-origin Monaco bundle is unaffected by what this file sends. It is the MIRROR case - this
 *   deployment's own subresources being read by a second origin - that the value argument below is
 *   about, and NEXT_PUBLIC_MONACO_VS_PATH is the proof that such deployments are real rather than
 *   hypothetical.
 *
 *   What refuses it is the VALUE. `same-origin`, `same-site` and `cross-origin` are each a
 *   constant string, so the build-time objection above does not apply to the string - but the
 *   CHOICE is the only one in this set that is a property of the deployment
 *   TOPOLOGY rather than of the application. `nosniff` is correct for every operator;
 *   `CORP: same-origin` is correct for the operator whose origin is the only one reading its own
 *   subresources and breaks any deployment that serves them to a second origin, cross-origin
 *   `importScripts` included (a classic worker-imported script is fetched with the default
 *   "no-cors" mode). Baking that choice into a prebuilt image leaves the affected operator with no
 *   runtime switch, which is what CSP_REPORT_ONLY and the HSTS exclusion above exist to prevent.
 *   Making it operator-configurable instead moves it into src/lib/security/config.ts, which by the
 *   rule above bars it from this file - and this file is the only path that reaches a subresource.
 *   Under the current two-path split there is no place a configurable CORP can land where it would
 *   act; widening src/proxy.ts's matcher for header-only paths is the way out, and is tracked as
 *   `docs/BACKLOG.md` AU4 rather than done here.
 *
 *   The protection given up is narrow, and that is read off this repository's own code rather than
 *   waved at. A cross-SITE no-cors subresource request already arrives without `auth-token`
 *   (`sameSite: "lax"` in src/lib/auth.ts, and a subresource load is not the top-level GET that
 *   lax excepts), so the response it can provoke is the one an anonymous attacker could fetch
 *   directly. `nosniff` above already refuses to execute a non-JavaScript response at a script
 *   destination. And CORP is not a framing defence, so it does not overlap `X-Frame-Options` or
 *   `frame-ancestors`: Fetch runs the check with forNavigation only for nested navigations, and
 *   that branch returns allowed while the embedding document's COEP is `unsafe-none`, which nothing
 *   here sets. What stays open is the same-SITE, cross-ORIGIN case - a sibling subdomain under the
 *   operator's own registrable domain does get the cookie and can time an authenticated endpoint.
 *   That residual is stated under "Known limits" in docs/SECURITY.md rather than closed with a
 *   baked constant.
 */

/**
 * Header names that act on a DOCUMENT and are inert on a subresource. AU2 established the class
 * for the first two; #512 settles the third.
 *
 * `Cross-Origin-Opener-Policy` is here rather than in the delivered set because the specification
 * gates it, not because of a judgement call. HTML's "create navigation params by fetching" obtains
 * a response's opener policy under exactly one step - "If navigable is a top-level traversable:
 * Set responseCOOP to the result of obtaining an opener policy given response and request's
 * reserved client"
 * (https://html.spec.whatwg.org/multipage/browsing-the-web.html#create-navigation-params-by-fetching).
 * Quoted whole on purpose: the opening clause alone occurs TWICE on that page, and the other
 * occurrence is an unrelated step about the top-level navigation initiator origin. So nothing ever
 * reads the header off a subresource, and it is ignored even for a framed document. Its value IS a
 * constant, which is exactly what makes baking it next to `nosniff` tempting - and would put a
 * header on /logo.svg that no algorithm consults.
 *
 * securityHeaders() has carried it since #512, per request, applied by src/proxy.ts; naming it here
 * is what keeps it out of the build-time baked set. WHY `same-origin` rather than the weaker
 * `same-origin-allow-popups`, and why it is deliberately not paired with
 * `Cross-Origin-Embedder-Policy`, is argued once - beside the header itself in
 * src/lib/security/headers.ts. Two prose copies of one argument drift, so this one does not
 * restate it.
 *
 * `Referrer-Policy` and `Permissions-Policy` are the same class for the same reason, and a smaller
 * honest set is worth more than a complete-looking one.
 */
export const DOCUMENT_ONLY_HEADER_NAMES = new Set([
  "Referrer-Policy",
  "Permissions-Policy",
  "Cross-Origin-Opener-Policy",
]);

/**
 * Every option src/lib/security/headers.ts declares, set away from its shipped default. A header
 * whose value or whose very presence differs between `securityHeaders()` and
 * `securityHeaders(OPTION_PROBE)` is caller-configurable and must not be baked into the routes
 * manifest this file writes at BUILD time.
 *
 * What that measurement is worth today, stated honestly because this comment used to claim more:
 * only `reportOnly` and `hsts` discriminate anything. Reducing the probe to those two leaves the
 * selected set byte-identical - `allowEval`, `monacoVsPath` and `extra` move the CSP's VALUE and
 * nothing else, and the CSP is already excluded because `reportOnly` RENAMES it, which reaches the
 * filter as an absence rather than as a difference. That is measured in
 * tests/security/cross-origin-headers.test.ts, not left as a claim here.
 *
 * The three inert fields stay, and the same test requires this probe to be TOTAL over the declared
 * option surface. That is the property worth having: the next option added - one that may well
 * move a non-CSP header - is probed on the day it lands instead of rotting here unnoticed, which
 * is what happened to `extra`, declared on `CspOptions` and varied by no probe field at all until
 * #512.
 *
 * Exported for that test: totality is a property of this object, and nothing else can check it.
 *
 * `monacoVsPath` and `extra` name `.invalid` hosts on purpose (RFC 2606 reserves the TLD): a probe
 * must never look like a real asset origin somebody could come to depend on.
 */
export const OPTION_PROBE: SecurityHeaderOptions = {
  reportOnly: true,
  allowEval: true,
  hsts: false,
  monacoVsPath: "https://monaco.invalid/vs",
  extra: { "connect-src": ["https://probe.invalid"] },
};

/**
 * The subset of `shipped` that may be baked: not document-only, and byte-identical in `probed`.
 *
 * A header the probe RENAMES rather than revalues (the CSP becomes
 * `Content-Security-Policy-Report-Only`) reaches this filter as an absence, and an absence is a
 * difference, so it is excluded by the same comparison.
 *
 * Exported for tests/security/cross-origin-headers.test.ts, which drives it with synthetic maps:
 * the interesting shapes are a value that changes between the two calls and a NAME that changes,
 * and neither can be produced from the real header set.
 */
export function selectStaticAssetHeaders(
  shipped: Record<string, string>,
  probed: Record<string, string>,
): { key: string; value: string }[] {
  return Object.entries(shipped)
    .filter(([key, value]) => !DOCUMENT_ONLY_HEADER_NAMES.has(key) && probed[key] === value)
    .map(([key, value]) => ({ key, value }));
}

/**
 * Read from securityHeaders() rather than spelled again: two hand-maintained lists of security
 * header VALUES drift silently, and this file cannot see when the other one changes.
 */
function staticAssetHeaders(): { key: string; value: string }[] {
  return selectStaticAssetHeaders(securityHeaders(), securityHeaders(OPTION_PROBE));
}

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: packageJson.version,
  },
  // Use standalone output for Docker/Kubernetes deployments
  // For Vercel, this is automatically handled
  output: process.env.DOCKER_BUILD === "true" ? "standalone" : undefined,

  // Externalize native modules to reduce bundle size and memory usage
  // These packages will be loaded from node_modules at runtime
  // `cassandra-driver` is pure JavaScript, unlike the rest of this list, and it is
  // here for a different reason: it does `require('kerberos')` inside a try/catch as
  // an OPTIONAL dependency, so bundling it makes the build try to resolve a module
  // nobody installed. Externalizing leaves the try/catch to fail at runtime the way
  // the driver intends.
  // `@duckdb/node-bindings` is listed next to `@duckdb/node-api` on purpose: it is
  // the loader that does a bare top-level `require('@duckdb/node-bindings-<platform>-
  // <arch>/duckdb.node')`, so it is the module that must never be bundled.
  serverExternalPackages: [
    "pg",
    "mysql2",
    "mongodb",
    "better-sqlite3",
    "ssh2",
    "cassandra-driver",
    "@duckdb/node-api",
    "@duckdb/node-bindings",
  ],

  // One rule over every path, not just the skipped ones: both values are constants and byte
  // identical to what proxy() already sets, so the overlap on documents is inert, while a narrower
  // source would be a second copy of the matcher's exclusion list - the drift this avoids.
  async headers() {
    return [{ source: "/:path*", headers: staticAssetHeaders() }];
  },
};

export default nextConfig;
