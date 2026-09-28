/**
 * Whether passkeys are available and which relying party they belong to, read from PASSKEY_ORIGIN on every call,
 * as src/lib/mcp/config.ts reads its own, so a changed value is seen by the next request.
 *
 * The origin comes only from configuration, never from a request's Host or forwarded headers.
 * A problem names the variable and the rule it broke and never quotes the value, which can carry credentials.
 * The proxy imports this module to decide the Permissions-Policy, so it stays a pure reader: no account or
 * storage module is imported here.
 */

import { isIP } from "node:net";
import { logger } from "@/lib/logger";
import { getStorageProviderType } from "@/lib/storage/provider-type";
import type { PasskeySignInOffer } from "@/lib/passkey/api-types";

const PASSKEY_ORIGIN_ENV = "PASSKEY_ORIGIN";

const PASSKEYS_OIDC = "Passkeys for this sign-in are managed by your identity provider.";
const PASSKEYS_LOCAL =
  "Passkeys need STORAGE_PROVIDER=sqlite or postgres: with STORAGE_PROVIDER=local there is no account registry to keep them in.";
const PASSKEYS_OFF =
  "Passkeys are off on this server. An administrator turns them on by setting PASSKEY_ORIGIN to the address people open Studio at, such as https://studio.example.com.";
const ORIGIN_NOT_URL =
  "PASSKEY_ORIGIN is not an absolute URL: set it to the address people open Studio at, such as https://studio.example.com.";
const ORIGIN_SCHEME =
  "PASSKEY_ORIGIN must use https: browsers offer passkeys only on a secure origin, and plain http works only for http://localhost.";
const ORIGIN_CREDENTIALS = "PASSKEY_ORIGIN must not carry a user name or password.";
const ORIGIN_NOT_ORIGIN =
  "PASSKEY_ORIGIN must be an origin (scheme, host and optional port) with no path, query or fragment; a BASE_PATH prefix does not belong in it.";
const ORIGIN_IP = "PASSKEY_ORIGIN must name the host by a domain name: browsers refuse passkeys on an IP address.";
const ORIGIN_TRAILING_DOT = "PASSKEY_ORIGIN must not end its host name with a dot.";

export interface RelyingParty {
  readonly origin: string;
  readonly rpId: string;
}

export type PasskeyAvailability =
  | { readonly state: "no-store"; readonly mode: "oidc" | "local-storage"; readonly reason: string }
  | { readonly state: "off"; readonly reason: string }
  | { readonly state: "misconfigured"; readonly reason: string }
  | ({ readonly state: "ready" } & RelyingParty);

let warned = false;

function readOrigin(): string {
  return (process.env[PASSKEY_ORIGIN_ENV] ?? "").trim();
}

/** The first rule for PASSKEY_ORIGIN the value breaks, or the relying party it names. */
function parseOrigin(raw: string): PasskeyAvailability {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { state: "misconfigured", reason: ORIGIN_NOT_URL };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) {
    return { state: "misconfigured", reason: ORIGIN_SCHEME };
  }
  if (url.username !== "" || url.password !== "") return { state: "misconfigured", reason: ORIGIN_CREDENTIALS };
  // The raw check catches an empty query or fragment, which the parsed URL reports as "".
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) {
    return { state: "misconfigured", reason: ORIGIN_NOT_ORIGIN };
  }
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) return { state: "misconfigured", reason: ORIGIN_IP };
  if (url.hostname.endsWith(".")) return { state: "misconfigured", reason: ORIGIN_TRAILING_DOT };
  return { state: "ready", origin: url.origin, rpId: url.hostname };
}

export function passkeyAvailability(): PasskeyAvailability {
  if (process.env.NEXT_PUBLIC_AUTH_PROVIDER === "oidc")
    return { state: "no-store", mode: "oidc", reason: PASSKEYS_OIDC };
  if (getStorageProviderType() === "local") {
    return { state: "no-store", mode: "local-storage", reason: PASSKEYS_LOCAL };
  }
  const raw = readOrigin();
  if (raw === "") return { state: "off", reason: PASSKEYS_OFF };
  return parseOrigin(raw);
}

/** The variable is non-empty after trimming, whatever its validity. */
export function passkeyOriginIsSet(): boolean {
  return readOrigin() !== "";
}

/** What the login page needs to offer passkey sign-in, or null when it must not. */
export function passkeySignInOffer(): PasskeySignInOffer | null {
  const availability = passkeyAvailability();
  if (availability.state === "ready") return { origin: availability.origin };
  // An operator who set the variable expects passkeys; say once why they are not there.
  if (!warned && availability.state !== "off" && passkeyOriginIsSet()) {
    warned = true;
    logger.warn(`PASSKEY_ORIGIN is set, but passkeys are unavailable: ${availability.reason}`, { route: "passkey" });
  }
  return null;
}

/** Test seam, like resetCookieSecurityWarning. */
export function resetPasskeyConfigWarning(): void {
  warned = false;
}
