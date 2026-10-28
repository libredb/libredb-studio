import { safeDecodeURIComponent } from "@/lib/db/connection-string/shared";
import type { ParsedConnection } from "@/lib/db/connection-string/types";
import {
  isAccountIdentifier,
  isSnowflakeHost,
  readSnowflakeAccount,
  SNOWFLAKE_FIELD_SENTENCES,
} from "@/lib/db/providers/sql/snowflake/account-host";

/** The sentences of a Snowflake paste: two refusals, each naming the parameter in this list's own spelling. */
export const SNOWFLAKE_PASTE_SENTENCES = Object.freeze({
  inlineKey: (name: string) =>
    `Studio does not take ${name} from a pasted URL. Paste the key itself into Private key, not inside a URL.`,
  path: (name: string) =>
    `Studio does not take ${name} from a pasted URL. Studio reads no file: paste the key's contents into Private key.`,
  tls: "Studio checks TLS whatever insecureMode or disableOCSPChecks say.",
  foreignHost:
    "This URL names a host outside Snowflake. A jdbc:snowflake:// URL carries the account's host, ending in .snowflakecomputing.com or .snowflakecomputing.cn, and a snowflake:// URL that host or the account identifier, such as myorg-myaccount. Nothing was applied.",
});

const SNOWFLAKE_SCHEMES = ["jdbc:snowflake://", "snowflake://"] as const;
const SNOWSIGHT_HOST = "app.snowflake.com";

/** The Snowflake scheme `text` starts with, in any case (`JDBC:SNOWFLAKE://` too, SF-024), or undefined. */
function snowflakeScheme(text: string): (typeof SNOWFLAKE_SCHEMES)[number] | undefined {
  const lower = text.toLowerCase();
  return SNOWFLAKE_SCHEMES.find((scheme) => lower.startsWith(scheme));
}

/** The host of an `https://` text, lower-cased, or undefined when it is not a URL. */
function httpsHost(text: string): string | undefined {
  if (!text.toLowerCase().startsWith("https://")) return undefined;
  try {
    return new URL(text).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Whether the paste is Snowflake's: a `jdbc:snowflake://` or `snowflake://` URL, an `https://` URL whose host is a
 * Snowflake host or Snowsight, or a bare Snowflake host. An identifier with no suffix is not claimed: it would claim
 * any word, so it is typed in Account instead.
 */
export function isSnowflakePaste(text: string): boolean {
  if (snowflakeScheme(text) !== undefined) return true;
  const host = httpsHost(text);
  if (host !== undefined) return host === SNOWSIGHT_HOST || isSnowflakeHost(host);
  return !/[\s/:?#@]/.test(text) && isSnowflakeHost(text);
}

/** Applied to their own fields, value percent-decoded once. */
const SNOWFLAKE_FIELD_PARAMETERS: Readonly<Record<string, "user" | "warehouse" | "database" | "schema" | "role">> = {
  user: "user",
  warehouse: "warehouse",
  db: "database",
  database: "database",
  schema: "schema",
  role: "role",
};
const SNOWFLAKE_PASSPHRASE_PARAMETERS = new Set(["private_key_pwd", "private_key_file_pwd", "private_key_passphrase"]);
const SNOWFLAKE_AUTHENTICATORS: Readonly<Record<string, "keypair" | "pat">> = {
  snowflake_jwt: "keypair",
  programmatic_access_token: "pat",
};
/** An inline key, refused by name; each spelled as the refusal names it. */
const SNOWFLAKE_INLINE_KEYS = ["private_key", "private_key_raw", "privatekey", "private_key_base64"];
/** A parameter naming a file or a directory on the machine, refused by name; each spelled as the refusal names it. */
const SNOWFLAKE_PATH_PARAMETERS = [
  "private_key_file",
  "private_key_path",
  "token_file_path",
  "client_config_file",
  "DIAGNOSTICS_ALLOWLIST_FILE",
  "CRL_RESPONSE_CACHE_DIR",
  "ocsp_response_cache_filename",
  "crl_cache_dir",
];
const SNOWFLAKE_DIAG_PATH = /^connection_diag_.*_path$/;
/** Named as not applied, value never applied; each spelled as the notice names it. */
const SNOWFLAKE_NAMED_PARAMETERS = [
  "password",
  "passcode",
  "oauthClientSecret",
  "oauth_client_secret",
  "proxyPassword",
  "insecureMode",
  "disableOCSPChecks",
];
const SNOWFLAKE_TLS_PARAMETERS = new Set(["insecureMode", "disableOCSPChecks"]);

/** The list entry `name` (lower-cased) matches, in the list's own spelling, or undefined. */
function listed(list: readonly string[], name: string): string | undefined {
  return list.find((entry) => entry.toLowerCase() === name);
}

/** The refusal of a parameter that is refused by name, or undefined. */
function snowflakeParameterRefusal(name: string): string | undefined {
  const inline = listed(SNOWFLAKE_INLINE_KEYS, name);
  if (inline !== undefined) return SNOWFLAKE_PASTE_SENTENCES.inlineKey(inline);
  const path = listed(SNOWFLAKE_PATH_PARAMETERS, name);
  if (path !== undefined) return SNOWFLAKE_PASTE_SENTENCES.path(path);
  if (SNOWFLAKE_DIAG_PATH.test(name)) return SNOWFLAKE_PASTE_SENTENCES.path("connection_diag_*_path");
  return undefined;
}

/** `Not applied: <names>, and <k> other parameters.`, with the TLS sentence when a TLS name is among them. */
function snowflakeNotice(names: readonly string[], others: number): string | undefined {
  if (names.length === 0 && others === 0) return undefined;
  const counted = `${others} other parameter${others === 1 ? "" : "s"}`;
  let text: string;
  if (names.length === 0) text = `Not applied: ${counted}.`;
  else text = `Not applied: ${names.join(", ")}${others > 0 ? `, and ${counted}` : ""}.`;
  return names.some((name) => SNOWFLAKE_TLS_PARAMETERS.has(name)) ? `${text} ${SNOWFLAKE_PASTE_SENTENCES.tls}` : text;
}

/** The address, userinfo and query of a Snowflake paste, split by hand so no URL parser reinterprets the account. */
function splitSnowflakePaste(text: string): {
  scheme: (typeof SNOWFLAKE_SCHEMES)[number] | undefined;
  account: string;
  user?: string;
  hasPassword: boolean;
  segments: string[];
  query: string;
} {
  const scheme = snowflakeScheme(text);
  if (scheme === undefined && !text.toLowerCase().startsWith("https://")) {
    return { scheme, account: text, hasPassword: false, segments: [], query: "" };
  }
  const rest = text.slice(scheme === undefined ? "https://".length : scheme.length).split("#")[0];
  const queryAt = rest.indexOf("?");
  const address = queryAt === -1 ? rest : rest.slice(0, queryAt);
  const query = queryAt === -1 ? "" : rest.slice(queryAt + 1);
  const slash = address.indexOf("/");
  const authority = slash === -1 ? address : address.slice(0, slash);
  const segments = (slash === -1 ? "" : address.slice(slash + 1))
    .split("/")
    .filter((segment) => segment !== "")
    .map(safeDecodeURIComponent);
  const at = authority.lastIndexOf("@");
  const userinfo = at === -1 ? undefined : authority.slice(0, at);
  const host = (at === -1 ? authority : authority.slice(at + 1)).replace(/:443$/, "");
  const colon = userinfo?.indexOf(":") ?? -1;
  const user =
    userinfo === undefined ? undefined : safeDecodeURIComponent(colon === -1 ? userinfo : userinfo.slice(0, colon));
  const hasPassword = colon !== -1;
  if (scheme === undefined) {
    // An https:// account URL is read by the Account field's own reader; a Snowsight URL carries the account in its
    // first two segments, and every other segment of either is the page's own.
    const snowsight = host.toLowerCase() === SNOWSIGHT_HOST;
    return {
      scheme,
      account: snowsight ? `https://${host}/${segments.slice(0, 2).join("/")}` : `https://${host}`,
      user,
      hasPassword,
      segments: [],
      query,
    };
  }
  return { scheme, account: safeDecodeURIComponent(host), user, hasPassword, segments, query };
}

/**
 * A Snowflake paste decomposed into the form's fields. The text itself is never kept: no `connectionString`,
 * and no value but an applied one leaves this function. A refused account, an inline key or a path parameter refuses
 * the whole paste, and nothing but `type` and the sentence is set.
 */
export function parseSnowflakeURL(text: string): ParsedConnection {
  const parts = splitSnowflakePaste(text);
  const reading = readSnowflakeAccount(parts.account);
  if (!reading.ok) return { type: "snowflake", refusal: reading.refusal, discardPaste: true };
  // Snowflake serves its API on 443 only, so an account URL naming another port is refused as the Account field does.
  if (reading.url !== null && reading.url.port !== "") {
    return { type: "snowflake", refusal: SNOWFLAKE_FIELD_SENTENCES.accountFormat, discardPaste: true };
  }
  // A JDBC URL carries the whole host, so one outside Snowflake's domains is refused, never read as a locator and a
  // region under it; a snowflake:// URL may carry the host or the bare account identifier.
  const foreign =
    parts.scheme === "jdbc:snowflake://"
      ? !isSnowflakeHost(parts.account)
      : parts.scheme === "snowflake://" && !isSnowflakeHost(parts.account) && !isAccountIdentifier(parts.account);
  if (foreign) return { type: "snowflake", refusal: SNOWFLAKE_PASTE_SENTENCES.foreignHost, discardPaste: true };

  const fields: Partial<Record<"user" | "warehouse" | "database" | "schema" | "role", string>> = {};
  if (parts.user) fields.user = parts.user;
  if (parts.segments[0]) fields.database = parts.segments[0];
  if (parts.segments[1]) fields.schema = parts.segments[1];
  const named: string[] = parts.hasPassword ? ["the password in the URL"] : [];
  let others = 0;
  let authMethod: "keypair" | "pat" | undefined;
  let token: string | undefined;
  let privateKeyPassphrase: string | undefined;

  for (const piece of parts.query.split("&")) {
    if (piece === "") continue;
    const equals = piece.indexOf("=");
    const name = safeDecodeURIComponent(equals === -1 ? piece : piece.slice(0, equals)).toLowerCase();
    const value = equals === -1 ? "" : safeDecodeURIComponent(piece.slice(equals + 1));
    const refused = snowflakeParameterRefusal(name);
    if (refused !== undefined) return { type: "snowflake", refusal: refused, discardPaste: true };
    if (Object.hasOwn(SNOWFLAKE_FIELD_PARAMETERS, name)) {
      if (value !== "") fields[SNOWFLAKE_FIELD_PARAMETERS[name]] = value;
    } else if (SNOWFLAKE_PASSPHRASE_PARAMETERS.has(name)) {
      if (value !== "") privateKeyPassphrase = value;
    } else if (name === "token") {
      if (value !== "") token = value;
    } else if (name === "authenticator") {
      const method = value.toLowerCase();
      if (Object.hasOwn(SNOWFLAKE_AUTHENTICATORS, method)) authMethod = SNOWFLAKE_AUTHENTICATORS[method];
      else if (!named.includes("authenticator")) named.push("authenticator");
    } else {
      const spelled = listed(SNOWFLAKE_NAMED_PARAMETERS, name);
      if (spelled === undefined) others++;
      else if (!named.includes(spelled)) named.push(spelled);
    }
  }

  if (token !== undefined && authMethod === undefined) authMethod = "pat";
  const notice = snowflakeNotice(named, others);
  return {
    type: "snowflake",
    host: reading.host,
    ...fields,
    ...(token !== undefined ? { password: token } : {}),
    ...(authMethod !== undefined ? { authMethod } : {}),
    ...(privateKeyPassphrase !== undefined ? { privateKeyPassphrase } : {}),
    ...(notice !== undefined ? { notice } : {}),
  };
}
