/**
 * The Snowflake Account field: the reading of an account identifier, an account URL or a Snowsight URL into the one
 * host Studio connects to and the account part of the key-pair JWT claim, the exact suffix test, and the sentences the
 * dialog and `connect()` both show.
 *
 * Pure, and it imports nothing at all, not even a type: the connection dialog and the paste parser import it in the
 * browser, while `account.ts`, which builds the origin from this reading, reaches `node:net` through the shared
 * endpoint module. `tests/unit/db/snowflake/browser-modules.test.ts` holds the empty import set.
 */

/** The most labels the identifier may have before `.snowflakecomputing.com` or `.snowflakecomputing.cn`. */
export const SNOWFLAKE_MAX_HOST_LABELS = 5;

const SUFFIX_COM = ".snowflakecomputing.com";
const SUFFIX_CN = ".snowflakecomputing.cn";
const SNOWSIGHT_HOST = "app.snowflake.com";
const LABEL = /^[a-z0-9_-]+$/;
const SNOWSIGHT_SEGMENT = /^[A-Za-z0-9_-]+$/;
/**
 * A Snowsight path's first segment when it is a region, `eu-central-1` or `east-us-2.azure`: a region id always holds
 * a hyphen, which an organisation name never does, since the hyphen is what separates it in `orgname-account_name`.
 */
const SNOWSIGHT_REGION = /^[a-z]+(?:-[a-z0-9]+)+(?:\.(?:aws|azure|gcp))?$/i;
/** An account locator, the second segment after a region. */
const SNOWSIGHT_LOCATOR = /^[a-z0-9]+$/i;
/** AWS Oregon, the one region whose locator takes no region. */
const OREGON = /^us-west-2(?:\.aws)?$/i;

/** The sentences of the Snowflake fields, shown by the dialog's rules and again by `connect()` before any socket. */
export const SNOWFLAKE_FIELD_SENTENCES = {
  accountEmpty: "Enter Account: an account identifier such as myorg-myaccount, or its URL. Nothing was sent.",
  accountFormat:
    "Enter an account identifier such as myorg-myaccount, or its https URL; a jdbc: or snowflake:// URL goes into Paste URL instead. Nothing was sent.",
  privateLinkRegion:
    "A PrivateLink account locator needs its region, such as xy12345.us-east-1.privatelink. Nothing was sent.",
  userEmpty: "Enter the user's login name. Nothing was sent.",
  roleEmpty: "Enter the role every statement runs as. Nothing was sent.",
  keyEmpty: "Paste the private key for key-pair sign-in. Nothing was sent.",
  tokenEmpty: "Enter the programmatic access token. Nothing was sent.",
  method: "Choose Key pair or Programmatic access token for Sign-in. Nothing was sent.",
} as const;

/**
 * The Sign-in method a connection that leaves `authMethod` absent (undefined or null) reads as: in the dialog, which
 * declares it as the field's `fieldDefaults` value, at seed load, in core's refusal of a missing required secret before
 * the provider is built, and in `connect()`. One constant, so the four cannot disagree about which secret an absent
 * Sign-in needs.
 */
export const SNOWFLAKE_SIGN_IN_DEFAULT = "keypair";

/** What an account URL carried besides its host, for `account.ts` to refuse; empty strings when absent. */
export interface SnowflakeUrlParts {
  readonly port: string;
  readonly path: string;
  readonly search: string;
  readonly hash: string;
  readonly userinfo: boolean;
}

export type SnowflakeAccountReading =
  | { readonly ok: true; readonly host: string; readonly accountClaim: string; readonly url: SnowflakeUrlParts | null }
  | { readonly ok: false; readonly refusal: string };

function refusal(sentence: string): SnowflakeAccountReading {
  return { ok: false, refusal: sentence };
}

/** The name lower-cased with one trailing dot removed. */
function canonical(name: string): string {
  const lower = name.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/** The suffix `name` (already canonical) ends with at a label boundary, or undefined. */
function suffixOf(name: string): typeof SUFFIX_COM | typeof SUFFIX_CN | undefined {
  if (name.endsWith(SUFFIX_COM)) return SUFFIX_COM;
  if (name.endsWith(SUFFIX_CN)) return SUFFIX_CN;
  return undefined;
}

/**
 * Whether `host` is a Snowflake API host: lower-cased with one trailing dot removed, it ends with
 * `.snowflakecomputing.com` or `.snowflakecomputing.cn` at a label boundary, and the part before the suffix has 1 to
 * `SNOWFLAKE_MAX_HOST_LABELS` non-empty labels.
 */
export function isSnowflakeHost(host: string): boolean {
  const name = canonical(host);
  const suffix = suffixOf(name);
  if (suffix === undefined) return false;
  const labels = name.slice(0, -suffix.length).split(".");
  return labels.length <= SNOWFLAKE_MAX_HOST_LABELS && labels.every((label) => label !== "");
}

/**
 * The identifier (lower-cased, its suffix off), the suffix the host takes and the URL parts, read from an `https://`
 * text; null when refused.
 */
function readUrl(text: string): { identifier: string; cn: boolean; url: SnowflakeUrlParts | null } | null {
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.hostname === SNOWSIGHT_HOST) {
    // A Snowsight URL's path is its own; Studio never sends a request to app.snowflake.com. The text is stored in the
    // public host field, so a query, a fragment, userinfo or a port, any of which can carry a secret, is refused.
    if (parsed.search !== "" || parsed.hash !== "" || parsed.port !== "") return null;
    if (parsed.username !== "" || parsed.password !== "") return null;
    const [, first, second] = parsed.pathname.split("/");
    if (first === undefined || second === undefined) return null;
    // `/<region>/<locator>/`, which Snowsight still issues (seen live 2026-10-13), is the locator form of the account.
    if (SNOWSIGHT_REGION.test(first)) {
      if (!SNOWSIGHT_LOCATOR.test(second)) return null;
      const identifier = OREGON.test(first) ? second : `${second}.${first}`;
      return { identifier: identifier.toLowerCase(), cn: false, url: null };
    }
    if (!SNOWSIGHT_SEGMENT.test(first) || !SNOWSIGHT_SEGMENT.test(second)) return null;
    return { identifier: `${first}-${second}`.toLowerCase(), cn: false, url: null };
  }
  if (!isSnowflakeHost(parsed.hostname)) return null;
  const name = canonical(parsed.hostname);
  const suffix = suffixOf(name) as string;
  return {
    identifier: name.slice(0, -suffix.length),
    cn: suffix === SUFFIX_CN,
    url: {
      port: parsed.port,
      path: parsed.pathname,
      search: parsed.search,
      hash: parsed.hash,
      userinfo: parsed.username !== "" || parsed.password !== "",
    },
  };
}

/**
 * Whether the identifier's labels still name a Snowflake domain once the suffix is off: a label holding
 * `snowflakecomputing`, even fused into a longer one, or the two labels `snowflake` and `com` in a row.
 */
function namesSnowflakeDomain(labels: readonly string[]): boolean {
  return labels.some(
    (label, i) => label.includes("snowflakecomputing") || (label === "snowflake" && labels[i + 1] === "com"),
  );
}

/**
 * The Account text read into the host Studio connects to and the JWT account claim (the identifier's first label,
 * upper-cased, as typed with `_` or `-`), or the sentence that refuses it.
 */
export function readSnowflakeAccount(text: string): SnowflakeAccountReading {
  const trimmed = text.trim();
  if (trimmed === "") return refusal(SNOWFLAKE_FIELD_SENTENCES.accountEmpty);

  const isHttps = trimmed.toLowerCase().startsWith("https://");
  if (trimmed.toLowerCase().startsWith("jdbc:") || (!isHttps && trimmed.includes("://"))) {
    return refusal(SNOWFLAKE_FIELD_SENTENCES.accountFormat);
  }

  let identifier: string;
  let cn = false;
  let url: SnowflakeUrlParts | null = null;
  if (isHttps) {
    const read = readUrl(trimmed);
    if (read === null) return refusal(SNOWFLAKE_FIELD_SENTENCES.accountFormat);
    ({ identifier, cn, url } = read);
  } else {
    // The suffix comes off once, here or in readUrl, so a doubled suffix leaves one behind to refuse.
    identifier = canonical(trimmed);
    const suffix = suffixOf(identifier);
    if (suffix !== undefined) {
      identifier = identifier.slice(0, -suffix.length);
      cn = suffix === SUFFIX_CN;
    }
  }

  const labels = identifier.split(".");
  if (namesSnowflakeDomain(labels)) return refusal(SNOWFLAKE_FIELD_SENTENCES.accountFormat);
  if (labels.length > SNOWFLAKE_MAX_HOST_LABELS || !labels.every((label) => LABEL.test(label))) {
    return refusal(SNOWFLAKE_FIELD_SENTENCES.accountFormat);
  }
  // A locator never holds a `-`, so only a locator lacks the region; `myorg-myacct.privatelink` is whole.
  if (labels.length === 2 && labels[1] === "privatelink" && !labels[0].includes("-")) {
    return refusal(SNOWFLAKE_FIELD_SENTENCES.privateLinkRegion);
  }

  return {
    ok: true,
    host: `${identifier}${cn ? SUFFIX_CN : SUFFIX_COM}`,
    accountClaim: labels[0].toUpperCase(),
    url,
  };
}

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;
/** A DNS name's limits, which `validateHost` in src/lib/db/http/endpoint.ts holds every host to. */
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

/**
 * The Account text as `connect()` takes it: `readSnowflakeAccount`'s reading, further refused with the format sentence
 * for an account URL carrying a port other than 443, a path, a query, a fragment or userinfo (any of which can carry
 * a secret, and none of which Studio sends), an IPv4 literal as the identifier, and a label a DNS name cannot hold
 * (longer than 63 characters, or starting or ending with a hyphen) or a host longer than 253. The dialog's hint, the
 * dialog's check and `connect()` all read this one function, so a text the hint names a host for is never refused by
 * Test (SF-025).
 */
export function checkSnowflakeAccount(text: string): SnowflakeAccountReading {
  const reading = readSnowflakeAccount(text);
  if (!reading.ok) return reading;
  const { url, host } = reading;
  const urlExtra =
    url !== null &&
    ((url.port !== "" && url.port !== "443") ||
      (url.path !== "" && url.path !== "/") ||
      url.search !== "" ||
      url.hash !== "" ||
      url.userinfo);
  const identifier = host.slice(0, host.lastIndexOf(".snowflakecomputing."));
  const badLabel = identifier
    .split(".")
    .some((label) => label.length > MAX_LABEL_LENGTH || label.startsWith("-") || label.endsWith("-"));
  if (urlExtra || IPV4_LITERAL.test(identifier) || badLabel || host.length > MAX_HOST_LENGTH) {
    return refusal(SNOWFLAKE_FIELD_SENTENCES.accountFormat);
  }
  return reading;
}

/** The dialog's check of the Account field: `connect()`'s own refusal of the text, or undefined when it reads. */
export function snowflakeAccountRefusal(text: string): string | undefined {
  const reading = checkSnowflakeAccount(text);
  return reading.ok ? undefined : reading.refusal;
}

/** The Account field's hint once `connect()` would take the text: "Studio connects to <host>.", or undefined. */
export function snowflakeHostHint(text: string): string | undefined {
  const reading = checkSnowflakeAccount(text);
  return reading.ok ? `Studio connects to ${reading.host}.` : undefined;
}

/**
 * The account a text names, for telling whether a paste names the account already in the box: the host it resolves
 * to, or the text trimmed and lower-cased when it does not read, so `myorg-myacct` and its full URL are one account.
 */
export function snowflakeHostIdentity(text: string): string {
  const reading = readSnowflakeAccount(text);
  return reading.ok ? reading.host : text.trim().toLowerCase();
}

/** A region label of an account identifier: every Snowflake region id holds a hyphen (`eu-central-1`, `us-central1`). */
const REGION_LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const CLOUD_LABELS: ReadonlySet<string> = new Set(["aws", "azure", "gcp"]);

/**
 * Whether `text` has the shape of an account identifier without its suffix: one name (`myorg-myacct`, `xy12345`),
 * then optionally a region with its cloud, then optionally `privatelink`. A host on another domain, such as
 * `attacker.com`, is not one, so a URL that carries a host rather than an identifier cannot pass for an account.
 */
export function isAccountIdentifier(text: string): boolean {
  const [first, ...rest] = canonical(text).split(".");
  if (!LABEL.test(first)) return false;
  let at = 0;
  if (rest[at] !== undefined && REGION_LABEL.test(rest[at])) {
    at += 1;
    if (rest[at] !== undefined && CLOUD_LABELS.has(rest[at])) at += 1;
  }
  if (rest[at] === "privatelink") at += 1;
  return at === rest.length;
}
