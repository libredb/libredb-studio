import type { ParsedConnection } from "@/lib/connection-string-parser";

/**
 * The Paste URL reader of an Apache Spark Connect address: Spark's documented grammar
 * `sc://host[:port][/][;key=value]*`, the scheme fixed, the path empty, parameter names case-sensitive, port 15002 by
 * default. Pure, with type-only imports: `src/lib/connection-string-parser.ts` imports it, and the browser carries
 * that module. A refusal fills nothing and never repeats the text it refuses; when the text may hold a secret, a token
 * or a user part, it also sets `discardPaste`, so the form clears the paste box.
 *
 * `token` and `use_ssl` are read as Spark's 4.2.0 Python and Scala clients read them: the token percent-decoded,
 * `use_ssl` true or false in any case, and TLS on when `use_ssl` is true or when a token is set and the host is not
 * literally `localhost`, so `use_ssl=false` beside a token turns TLS off on `localhost` only.
 */
export const SPARK_PASTE_SENTENCES = Object.freeze({
  pathNotEmpty: "A Spark Connect address has no path: remove everything between the host and the first ;.",
  userInfo: "Host takes no user name or password inside the address: put the token in Token.",
  databricks:
    "This is a Databricks Connect address. Studio's Apache Spark connection reaches open-source Spark Connect servers; Databricks is not supported in this version.",
  jdbcPrefix: "Paste the sc:// address itself, without jdbc:.",
  scheme: "A Spark Connect address starts with sc://.",
  host: "The address names no valid host: expected a host name, an IPv4 address or an IPv6 address in brackets.",
  port: "The address names no valid port: expected an integer from 1 to 65535.",
  tokenEscape: "The token in the address is not valid percent-encoding: write a % sign inside the token as %25.",
});

const SCHEME = "sc://";
const JDBC_SCHEME = "jdbc:sc://";
/** Spark Connect's default port, `SPARK_DEFAULT_PORT` in `constants.ts`, written here because this module imports types only. */
const DEFAULT_PORT = "15002";
/** The parameter only a Databricks Connect address carries; the same text can hold a workspace token. */
const DATABRICKS_PARAMETER = "x-databricks-cluster-id";
/** Spark's own parameters Studio does not apply, named in the notice: it sends a fixed identity, opens a session per request and sets its own receive cap. */
const NAMED_NOT_APPLIED: ReadonlySet<string> = new Set([
  "user_id",
  "user_agent",
  "session_id",
  "grpc_max_message_size",
]);
/** The `use_ssl` values the paste applies: Spark's clients compare them without regard to case. */
const USE_SSL_VALUE = /^(?:true|false)$/i;
/** A token parameter wherever a refused text holds one: `token=` in any case, with or without a value. */
const TOKEN_PARAMETER = /token=/i;

// The host and port rules of src/lib/connection-host-uri.ts:37-45, copied because this module imports types only;
// tests/unit/db/spark/sc-uri.test.ts holds every host and port it returns to validateHost and validatePort.
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i;
const NUMERIC_LABEL = /^(?:\d+|0x[0-9a-f]*)$/i;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const MAX_HOSTNAME_LENGTH = 253;
const PORT_DIGITS = /^\d{1,5}$/;
const MAX_PORT = 65535;
const IPV6_CHARACTERS = /^[0-9a-f:.]+$/i;

function refused(sentence: string, discardPaste: boolean): ParsedConnection {
  return { type: "spark", refusal: sentence, ...(discardPaste ? { discardPaste } : {}) };
}

/** The parameter names after the first `;`, values never read. */
function parameterNames(text: string): string[] {
  const semicolon = text.indexOf(";");
  if (semicolon === -1) return [];
  return text
    .slice(semicolon + 1)
    .split(";")
    .map((part) => part.split("=")[0]);
}

/**
 * Whether a refused text may hold a secret, so the form clears the paste box rather than keep the text there to be
 * corrected: a token parameter, or a user part, an `@` before the first `;`, where the reader looks for one.
 */
function mayHoldSecret(text: string): boolean {
  const semicolon = text.indexOf(";");
  const head = semicolon === -1 ? text : text.slice(0, semicolon);
  return TOKEN_PARAMETER.test(text) || head.includes("@");
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

function isHostname(name: string): boolean {
  if (name.length === 0 || name.length > MAX_HOSTNAME_LENGTH) return false;
  const labels = name.split(".");
  return labels.every((label) => LABEL.test(label)) && !NUMERIC_LABEL.test(labels[labels.length - 1]);
}

/** A bracketed IPv6 literal in lower case, brackets kept, or null. */
function ipv6Of(address: string): string | null {
  if (!IPV6_CHARACTERS.test(address) || !URL.canParse(`http://[${address}]/`)) return null;
  return `[${address.toLowerCase()}]`;
}

function hostOf(text: string): string | null {
  if (text.startsWith("[")) return ipv6Of(text.slice(1, -1));
  if (IPV4.test(text)) return text;
  return isHostname(text) ? text.toLowerCase() : null;
}

function portOf(text: string): string | null {
  const value = PORT_DIGITS.test(text) ? Number(text) : 0;
  return value >= 1 && value <= MAX_PORT ? String(value) : null;
}

/** A parameter value percent-decoded, as Spark's clients read it, or null where an escape does not decode. */
function percentDecoded(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    // On a string, decodeURIComponent throws only URIError: a % not followed by two hex digits, or bytes not UTF-8.
    return null;
  }
}

function notAppliedNotice(names: readonly string[], unnamed: number): string {
  const counted = `${unnamed} ${names.length > 0 ? "other " : ""}parameter${unnamed === 1 ? "" : "s"}`;
  const listed = [names.join(", "), unnamed > 0 ? counted : ""].filter(Boolean).join(" and ");
  return `Not applied: ${listed}. Studio's Apache Spark connection takes the host, the port, token and use_ssl from an sc:// address: it sends one fixed user id, opens a Spark session per request and sets its own message size limit.`;
}

/** An `sc://` address as the dialog's fields, or a refusal that fills nothing. */
export function parseSparkConnectUri(text: string): ParsedConnection {
  const trimmed = text.trim();
  // First, and with the box cleared: a Databricks Connect address can carry a workspace token.
  if (parameterNames(trimmed).includes(DATABRICKS_PARAMETER)) return refused(SPARK_PASTE_SENTENCES.databricks, true);
  // Every other refusal clears the box only when the text may hold a secret: a token or a user part.
  const discardPaste = mayHoldSecret(trimmed);
  if (trimmed.startsWith(JDBC_SCHEME)) return refused(SPARK_PASTE_SENTENCES.jdbcPrefix, discardPaste);
  if (!trimmed.startsWith(SCHEME)) return refused(SPARK_PASTE_SENTENCES.scheme, discardPaste);
  const rest = trimmed.slice(SCHEME.length);
  const semicolon = rest.indexOf(";");
  const head = semicolon === -1 ? rest : rest.slice(0, semicolon);
  if (head.includes("@")) return refused(SPARK_PASTE_SENTENCES.userInfo, discardPaste);
  const slash = head.indexOf("/");
  if (slash !== -1 && head.slice(slash) !== "/") return refused(SPARK_PASTE_SENTENCES.pathNotEmpty, discardPaste);
  const split = splitAuthority(slash === -1 ? head : head.slice(0, slash));
  const host = split === null ? null : hostOf(split.host);
  if (split === null || host === null) return refused(SPARK_PASTE_SENTENCES.host, discardPaste);
  const port = split.port === undefined ? DEFAULT_PORT : portOf(split.port);
  if (port === null) return refused(SPARK_PASTE_SENTENCES.port, discardPaste);

  let token: string | undefined;
  let useSsl = false;
  const named: string[] = [];
  let unnamed = 0;
  const parameters = semicolon === -1 ? [] : rest.slice(semicolon + 1).split(";");
  for (const part of parameters) {
    if (part === "") continue;
    const equals = part.indexOf("=");
    const key = equals === -1 ? "" : part.slice(0, equals);
    const value = part.slice(equals + 1);
    if (key === "token") {
      const decoded = percentDecoded(value);
      if (decoded === null) return refused(SPARK_PASTE_SENTENCES.tokenEscape, discardPaste);
      token = decoded === "" ? undefined : decoded;
    } else if (key === "use_ssl" && USE_SSL_VALUE.test(value)) {
      useSsl = value.toLowerCase() === "true";
    } else if (key === "use_ssl" || NAMED_NOT_APPLIED.has(key)) {
      if (!named.includes(key)) named.push(key);
    } else {
      // A text with no name=, or a name Spark does not define: counted, never named, since its value may be a secret.
      unnamed += 1;
    }
  }
  // Spark's 4.2.0 Python and Scala clients turn TLS on with use_ssl=true, or with a token on any host but localhost.
  const sslMode: ParsedConnection["sslMode"] =
    useSsl || (token !== undefined && host !== "localhost") ? "verify-system" : "disable";
  return {
    type: "spark",
    host,
    port,
    ...(token === undefined ? {} : { password: token }),
    sslMode,
    ...(named.length > 0 || unnamed > 0 ? { notice: notAppliedNotice(named, unnamed) } : {}),
  };
}
