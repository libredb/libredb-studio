/**
 * An `http://` or `https://` address typed or pasted into the connection dialog's Host box, read into a host
 * and a port for an engine that declares `hostAcceptsUri` (src/lib/db-ui-config.ts).
 *
 * Pure and browser-safe: it imports types only, because the dialog runs it in the browser. That is why it
 * cannot call `validateHost` and `validatePort` from src/lib/db/http/endpoint.ts, which import `node:net` and
 * the egress policy: it holds their host and port rules instead, and
 * tests/unit/lib/connection-host-uri.test.ts holds every host and port it returns to those two functions, so
 * the copies cannot drift apart. The provider still runs them when it connects, and they stay the authority.
 * The one deliberate difference is a trailing dot, which `validateHost` accepts and this refuses.
 *
 * The port is read from the address text, never from `URL.port`, which is empty for an explicit `:443` under
 * https and `:80` under http. An explicit port is kept as typed; an address with no port means its scheme's
 * port, 80 or 443, never the engine's default, because a cloud endpoint serves on 443.
 *
 * A refusal names the part to remove and never repeats the value, the rule endpoint.ts keeps.
 */
import type { SSLMode } from "@/lib/types";

export type HostUriScheme = "http" | "https";

/** Why an address was refused: the part of it the Host box does not take. */
export type HostUriRefusal = "userinfo" | "path" | "query" | "fragment" | "scheme" | "host" | "port";

export type HostUriResult =
  /** No scheme: a host, which the provider validates when it connects. */
  | { readonly kind: "host" }
  | { readonly kind: "uri"; readonly scheme: HostUriScheme; readonly host: string; readonly port: number }
  | { readonly kind: "refused"; readonly reason: HostUriRefusal; readonly sentence: string };

const SCHEME_PORTS: Readonly<Record<HostUriScheme, number>> = { http: 80, https: 443 };

/** A scheme and its `://`: the shape that makes the Host box text an address rather than a host. */
const SCHEME_PREFIX = /^([a-z][a-z0-9+.-]*):\/\//i;

// endpoint.ts's host and port rules, held here because this module may not import it.
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i;
const NUMERIC_LABEL = /^(?:\d+|0x[0-9a-f]*)$/i;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const MAX_HOSTNAME_LENGTH = 253;
const PORT_DIGITS = /^\d{1,5}$/;
const MAX_PORT = 65535;

/** The characters an IPv6 literal is written in; a zone's `%` is not one of them, so a zone is refused. */
const IPV6_CHARACTERS = /^[0-9a-f:.]+$/i;

const SENTENCES: Readonly<Record<Exclude<HostUriRefusal, "scheme">, string>> = {
  userinfo:
    "Host takes no user name or password inside the address: remove the part before @ and enter the credentials in their own fields.",
  path: "Host takes a scheme, a host and a port only: remove the path after the host.",
  query: "Host takes a scheme, a host and a port only: remove the query string, from ? onwards.",
  fragment: "Host takes a scheme, a host and a port only: remove the fragment, from # onwards.",
  host: "The address names no valid host: expected a host name, an IPv4 address or an IPv6 address in brackets.",
  port: "The address names no valid port: expected an integer from 1 to 65535.",
};

function refused(reason: Exclude<HostUriRefusal, "scheme">): HostUriResult {
  return { kind: "refused", reason, sentence: SENTENCES[reason] };
}

function schemeRefusal(accepted: readonly HostUriScheme[]): HostUriResult {
  const sentence =
    accepted.length === 0
      ? "Host takes a host name or an address alone for this connection type, without a scheme."
      : `Host takes ${accepted.map((scheme) => `${scheme}://`).join(" or ")} addresses for this connection type, or a host name alone.`;
  return { kind: "refused", reason: "scheme", sentence };
}

/** The part after the authority: nothing, or `/` alone, is all the Host box takes. */
function tailRefusal(tail: string): "path" | "query" | "fragment" | undefined {
  const query = tail.indexOf("?");
  const fragment = tail.indexOf("#");
  const pathEnd = Math.min(query === -1 ? tail.length : query, fragment === -1 ? tail.length : fragment);
  const path = tail.slice(0, pathEnd);
  if (path !== "" && path !== "/") return "path";
  if (query !== -1 && (fragment === -1 || query < fragment)) return "query";
  if (fragment !== -1) return "fragment";
  return undefined;
}

/** The authority's host and port texts, or null where it is not `host`, `host:port`, `[v6]` or `[v6]:port`. */
function splitAuthority(authority: string): { readonly host: string; readonly port?: string } | null {
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) return null;
    const host = authority.slice(0, close + 1);
    const after = authority.slice(close + 1);
    if (after === "") return { host };
    return after.startsWith(":") ? { host, port: after.slice(1) } : null;
  }
  const parts = authority.split(":");
  if (parts.length === 1) return { host: authority };
  return parts.length === 2 ? { host: parts[0], port: parts[1] } : null;
}

/** endpoint.ts's hostname rule, without its allowance for one trailing dot. */
function isHostname(name: string): boolean {
  if (name.length === 0 || name.length > MAX_HOSTNAME_LENGTH) return false;
  const labels = name.split(".");
  return labels.every((label) => LABEL.test(label)) && !NUMERIC_LABEL.test(labels[labels.length - 1]);
}

/** A bracketed IPv6 literal in lower case, or null. `URL` checks the address, as `isIPv6` does on the server. */
function ipv6Of(address: string): string | null {
  if (!IPV6_CHARACTERS.test(address) || !URL.canParse(`http://[${address}]/`)) return null;
  return `[${address.toLowerCase()}]`;
}

/** The host in the form `validateHost` returns it, or null. */
function hostOf(text: string): string | null {
  if (text.startsWith("[")) return ipv6Of(text.slice(1, -1));
  if (IPV4.test(text)) return text;
  return isHostname(text) ? text.toLowerCase() : null;
}

function portOf(text: string): number | null {
  const value = PORT_DIGITS.test(text) ? Number(text) : 0;
  return value >= 1 && value <= MAX_PORT ? value : null;
}

/**
 * The Host box text as an address the engine accepts, a host with no scheme, or a refusal naming the part to
 * remove. `accepted` is the engine's `hostAcceptsUri`; a scheme outside it is refused.
 */
export function parseHostUri(text: string, accepted: readonly HostUriScheme[]): HostUriResult {
  const trimmed = text.trim();
  const prefix = SCHEME_PREFIX.exec(trimmed);
  if (prefix === null) return { kind: "host" };
  const scheme = accepted.find((candidate) => candidate === prefix[1].toLowerCase());
  if (scheme === undefined) return schemeRefusal(accepted);

  const rest = trimmed.slice(prefix[0].length);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  if (authority.includes("@")) return refused("userinfo");
  const tail = tailRefusal(authorityEnd === -1 ? "" : rest.slice(authorityEnd));
  if (tail !== undefined) return refused(tail);

  const parts = splitAuthority(authority);
  const host = parts === null ? null : hostOf(parts.host);
  if (parts === null || host === null) return refused("host");
  const port = parts.port === undefined ? SCHEME_PORTS[scheme] : portOf(parts.port);
  if (port === null) return refused("port");
  return { kind: "uri", scheme, host, port };
}

/**
 * The TLS mode after an address's scheme: `https://` raises an absent or `disable` mode to `verify-system` and
 * keeps any other, and `http://` keeps whatever the dialog holds. A scheme never lowers the mode; a secret over
 * plain `http://` meets the provider's own plaintext rule when it connects.
 */
export function tlsModeAfterScheme(scheme: HostUriScheme, current: SSLMode | undefined): SSLMode | undefined {
  if (scheme === "https" && (current === undefined || current === "disable")) return "verify-system";
  return current;
}
