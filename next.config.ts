import type { NextConfig } from "next";
import packageJson from "./package.json";
// Relative, not "@/": Next loads this file before any tsconfig path alias exists for it, and
// src/lib/security/headers.ts is import-free by design precisely so a next.config can read it.
import { securityHeaders } from "./src/lib/security/headers";

/**
 * The second delivery path for the security headers (backlog AU2).
 *
 * src/proxy.ts hardens every document, but its matcher deliberately skips `_next/static`,
 * `_next/image` and every path containing a dot, so `proxy()` never runs for a file under
 * `public/` or for `/monaco/vs/*.js`. That exclusion is right for AUTH - none of those needs a
 * login redirect - but header delivery and auth redirection are two concerns that happen to share
 * one matcher. `headers()` covers what the matcher skips.
 *
 * Only TWO of the six headers are delivered here, and the deciding fact is the same on both sides
 * of the split: this function is evaluated at BUILD time and baked into the routes manifest, while
 * src/lib/security/config.ts reads CSP_REPORT_ONLY, HSTS_INCLUDE_SUBDOMAINS and
 * NEXT_PUBLIC_MONACO_VS_PATH per process. So a header whose value an operator can change must not
 * be delivered from here at all.
 *
 * Delivered:
 * - `X-Content-Type-Options` (the header AU2 names): the one that is genuinely load-bearing on a
 *   subresource. `nosniff` makes the browser honour the declared MIME type instead of guessing,
 *   and additionally makes it refuse a script or stylesheet whose declared type is not one, so a
 *   response served with a wrong or generic type cannot be turned into executable code.
 * - `X-Frame-Options`: `public/` serves `.svg` files (`ls public/*.svg`), and an SVG reached by
 *   top-level navigation or `<object>` is a document context, not an image - it can execute script
 *   and can be framed. Constant value, no environment input.
 *
 * Deliberately NOT delivered:
 * - `Content-Security-Policy`: a subresource response's own CSP governs almost nothing (the
 *   loading document's policy applies), and baking it would strand it behind the build. The
 *   CSP_REPORT_ONLY escape hatch exists for the operator who cannot rebuild a prebuilt image; a
 *   build-time copy would keep enforcing after they flipped it.
 * - `Strict-Transport-Security`: HSTS is host-scoped, so a browser keeps whichever value arrived
 *   LAST. `includeSubDomains` is operator-configurable at runtime, so a baked copy would let a
 *   request for `/logo.svg` silently downgrade the policy the document just set. One authority for
 *   HSTS beats delivering it twice.
 * - `Referrer-Policy` and `Permissions-Policy`: both act on a document. On an image or script
 *   response they are inert, and a smaller honest set is worth more than a complete-looking one.
 * - `Cross-Origin-Resource-Policy` / `Cross-Origin-Opener-Policy`: the headers that WOULD add real
 *   protection to a subresource, and out of scope by AU2's own text - a separate decision, not
 *   part of the agreed Phase 1 set.
 */
const STATIC_ASSET_HEADER_NAMES = new Set(["X-Content-Type-Options", "X-Frame-Options"]);

/**
 * Read from securityHeaders() rather than spelled again: two hand-maintained lists of security
 * header VALUES drift silently, and this file cannot see when the other one changes. No options
 * are passed because every name above is constant under all of them - the option-dependent
 * headers are exactly the ones excluded.
 */
function staticAssetHeaders(): { key: string; value: string }[] {
  return Object.entries(securityHeaders())
    .filter(([key]) => STATIC_ASSET_HEADER_NAMES.has(key))
    .map(([key, value]) => ({ key, value }));
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
  serverExternalPackages: ["pg", "mysql2", "mongodb", "better-sqlite3", "ssh2", "cassandra-driver"],

  // One rule over every path, not just the skipped ones: both values are constants and byte
  // identical to what proxy() already sets, so the overlap on documents is inert, while a narrower
  // source would be a second copy of the matcher's exclusion list - the drift this avoids.
  async headers() {
    return [{ source: "/:path*", headers: staticAssetHeaders() }];
  },
};

export default nextConfig;
