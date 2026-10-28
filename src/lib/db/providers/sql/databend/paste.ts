import { safeDecodeURIComponent } from "@/lib/db/connection-string/shared";
import type { ParsedConnection, TLSIntent } from "@/lib/db/connection-string/types";
import { databendCloudHostWarehouse } from "@/lib/db/providers/sql/databend/cloud-host";

/**
 * The sentences a refused Databend paste shows (design 6.2), one per refusal. Each refusal fills no field, so the
 * sentence says what to paste instead.
 */
export const DATABEND_DSN_REFUSALS = Object.freeze({
  fragment: "The DSN contains #, which ends a URL: percent-encode it as %23, or type the password in its own field.",
  userinfo:
    "The DSN has an @ after a / or ?, which end the address part of a URL: percent-encode a /, ? or @ in the user or password as %2F, %3F or %40, or type the password in its own field, and an @ in the path or a parameter as %40.",
  signIn:
    "Token and key-pair sign-in are not supported in this version: paste a DSN that signs in with a SQL user and password, or fill the fields.",
  flight: "Flight SQL (port 8900) is not supported: paste the HTTP DSN, databend://, for port 8000 or 443.",
  jdbc: "This is a JDBC URL, which reads TLS and ports differently (TLS off and port 8000 by default). Paste the databend:// DSN from Connect, or fill the fields.",
  shellExport: "Paste the DSN itself: the databend:// text inside the quotes.",
});

/**
 * What a Databend DSN's `sslmode=require` and `sslmode=enable` mean (X34): BendSQL connects over https with the
 * certificate verified, which is this form's verify-system and not its unverified require.
 */
export const DATABEND_SSLMODE_NOTICES = Object.freeze({
  require: "sslmode=require in a Databend DSN verifies the certificate, as BendSQL does, so SSL mode is verify-system.",
  enable: "sslmode=enable in a Databend DSN verifies the certificate, as BendSQL does, so SSL mode is verify-system.",
});

/**
 * The cautions of a Databend paste (`cautions`), for the TLS parameters it reads and does not apply: a CA file path,
 * which only the machine running BendSQL could read, and an sslmode BendSQL does not read, which the form's own TLS
 * sentence would list among the modes it says the parameter has no equivalent in.
 */
export const DATABEND_DSN_CAUTIONS = Object.freeze({
  caFile:
    "Studio reads no CA file path from a DSN, so tls_ca_file was not applied: paste the certificate's contents into the CA field under SSL / TLS.",
  sslmode: (mode: string) =>
    `sslmode=${mode} is not a Databend DSN mode (BendSQL reads disable, require and enable), so SSL mode was left as it was: choose one under SSL / TLS.`,
});

/**
 * The warning a Databend paste shows for the parameters it did not apply: BendSQL's own names, never valued, and a
 * count of the rest, which are never named.
 */
export function databendNotAppliedNotice(names: readonly string[], unnamed = 0): string {
  const counted = `${unnamed} ${names.length > 0 ? "other " : ""}parameter${unnamed === 1 ? "" : "s"}`;
  const listed = [names.join(", "), unnamed > 0 ? counted : ""].filter(Boolean).join(" and ");
  return `Not applied: ${listed}. Studio's Databend connection takes host, port, user, password, database, warehouse and TLS; the other fields were filled in.`;
}

function databendRefusal(key: keyof typeof DATABEND_DSN_REFUSALS): ParsedConnection {
  return { type: "databend", refusal: DATABEND_DSN_REFUSALS[key] };
}

/** The DSN parameters a paste reads, each into a field or a caution; every other name is reported as not applied. */
const DATABEND_APPLIED_PARAMETERS = new Set(["warehouse", "sslmode", "tls_ca_file"]);

/**
 * The other parameters BendSQL reads by name (`core/src/client.rs`, `from_dsn`), which a paste names when it does not
 * apply them. BendSQL sends any other name as a session setting; a paste counts those and never names them, since an
 * unencoded `&` inside a value makes the rest of the value read as a name.
 */
const DATABEND_NAMED_PARAMETERS = new Set([
  "wait_time_secs",
  "max_rows_in_buffer",
  "max_rows_per_page",
  "connect_timeout",
  "page_request_timeout_secs",
  "presign",
  "tenant",
  "role",
  "login",
  "session_token",
  "body_format",
  "query_result_format",
  "retry_count",
  "retry_delay_secs",
]);

/**
 * The query parameters a Databend paste did not apply: BendSQL's own names, each once in the order pasted, and how
 * many others there are. A text with no `=` is counted even when it spells a name, since it can be a value's tail.
 */
function databendIgnoredParameters(search: string): { names: string[]; unnamed: number } {
  const names = new Set<string>();
  const unnamed = new Set<string>();
  for (const pair of search.slice(1).split("&")) {
    if (pair === "") continue;
    const equals = pair.indexOf("=");
    if (equals < 0) {
      unnamed.add(pair);
      continue;
    }
    const name = [...new URLSearchParams(pair).keys()][0];
    if (DATABEND_APPLIED_PARAMETERS.has(name)) continue;
    if (DATABEND_NAMED_PARAMETERS.has(name)) names.add(name);
    else unnamed.add(name);
  }
  return { names: [...names], unnamed: unnamed.size };
}

/** The `sslmode` values BendSQL reads; any other refuses the DSN there. */
const DATABEND_SSLMODES = new Set(["disable", "require", "enable"]);

/** BendSQL's sign-in parameters other than a password, which this version does not support. */
const DATABEND_SIGN_IN_PARAMETERS = new Set([
  "access_token",
  "access_token_file",
  "private_key_file",
  "private_key_passphrase_file",
]);

/**
 * A Databend DSN, read the way BendSQL reads it (`core/src/client.rs`, `from_dsn`): TLS unless `sslmode=disable`,
 * where `require` and `enable` verify the certificate; the DSN's port, else 443 with TLS and 80 without; the path is
 * the database and `warehouse=` the warehouse. `databend+http://` and `databend+https://` set the transport as
 * databend-go reads them, and an explicit `sslmode` wins over either; one BendSQL does not read leaves SSL mode as it
 * was, with a caution, and the port the scheme's. A repeated parameter takes its last value, as BendSQL's does
 * (databend-go takes the first).
 *
 * Three departures, each refusing rather than guessing: a `#` ends a URL, so a password holding one would be cut short;
 * a `/` or `?` ends the address part, so with one in the user or the password the URL parser reads the rest of the
 * password as the database or a parameter, and since an `@` past the address part can also be a path's or a
 * parameter's, and a password can hold an unencoded `@` before its `/`, every such `@` is refused, naming each
 * encoding; and BendSQL's token and key-pair sign-in have no field here. Unlike BendSQL, which decodes the password
 * only, the user and the database path are percent-decoded too, as every other scheme here does. With no
 * `warehouse=`, the warehouse an older Databend Cloud host names (`<tenant>--<warehouse>.gw...`) fills Warehouse.
 */
function parseDatabendDSN(uri: string): ParsedConnection | null {
  if (uri.includes("#")) return databendRefusal("fragment");
  // An @ past the address part reads more than one way: the sign-in's own, after a / or ? in the user or password; a
  // later @ of a password that also holds one, as `root:p@ss/x@host` does; or an unencoded @ of the path or a
  // parameter. An @ inside the address part settles none of them, so every such text is refused.
  const address = uri.slice(uri.indexOf("://") + 3);
  const addressEnd = address.search(/[/?]/);
  if (addressEnd >= 0 && address.includes("@", addressEnd)) return databendRefusal("userinfo");
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }

  const names = [...new Set(url.searchParams.keys())];
  if (names.some((name) => DATABEND_SIGN_IN_PARAMETERS.has(name))) return databendRefusal("signIn");

  // A repeated parameter takes its last value, as BendSQL's loop over the pairs overwrites, and an sslmode it
  // cannot read refuses the DSN wherever it stands.
  const sslmodes = url.searchParams.getAll("sslmode");
  const sslmode = sslmodes.find((mode) => !DATABEND_SSLMODES.has(mode)) ?? sslmodes.at(-1) ?? null;
  const plainScheme = uri.startsWith("databend+http://");
  let tls: TLSIntent = { sslMode: plainScheme ? "disable" : "verify-system" };
  let notice: string | undefined;
  const cautions: string[] = [];
  if (sslmode === "disable") tls = { sslMode: "disable" };
  else if (sslmode === "require" || sslmode === "enable") {
    tls = { sslMode: "verify-system" };
    notice = DATABEND_SSLMODE_NOTICES[sslmode];
  } else if (sslmode !== null) {
    tls = {};
    cautions.push(DATABEND_DSN_CAUTIONS.sslmode(sslmode));
  }
  // BendSQL reads the CA file on its own machine; Studio reads no path, and its CA box takes the certificate itself.
  if (url.searchParams.has("tls_ca_file")) cautions.push(DATABEND_DSN_CAUTIONS.caFile);

  const warehouse = url.searchParams.getAll("warehouse").at(-1) || databendCloudHostWarehouse(url.hostname);
  const ignored = databendIgnoredParameters(url.search);
  // An sslmode BendSQL does not read leaves the mode unset, so the port is the scheme's: 80 for +http, else 443.
  const plain = tls.sslMode === undefined ? plainScheme : tls.sslMode === "disable";
  return {
    type: "databend",
    host: url.hostname || "localhost",
    port: url.port || (plain ? "80" : "443"),
    user: url.username ? safeDecodeURIComponent(url.username) : undefined,
    password: url.password ? safeDecodeURIComponent(url.password) : undefined,
    database: url.pathname.length > 1 ? safeDecodeURIComponent(url.pathname.slice(1)) : undefined,
    ...(warehouse ? { warehouse } : {}),
    ...tls,
    allowInsecureAuth: false,
    ...(notice ? { notice } : {}),
    ...(cautions.length > 0 ? { cautions } : {}),
    ...(ignored.names.length > 0 ? { ignoredParameters: ignored.names } : {}),
    ...(ignored.unnamed > 0 ? { unnamedParameters: ignored.unnamed } : {}),
  };
}

/** BendSQL's REST DSN schemes: `databend://`, `databend+http://` and `databend+https://`. */
const DATABEND_DSN = /^databend(\+https?)?:\/\//;

/**
 * Whether a paste is Databend's: a REST DSN, or one of the spellings a paste refuses by name (a `BENDSQL_DSN=` shell
 * line, a `jdbc:databend://` URL, or a `databend+flight://` or `databend+grpc://` DSN).
 */
export function claimsDatabendPaste(text: string): boolean {
  return (
    /^(export\s+)?BENDSQL_DSN=/.test(text) ||
    text.startsWith("jdbc:databend://") ||
    text.startsWith("databend+flight://") ||
    text.startsWith("databend+grpc://") ||
    DATABEND_DSN.test(text)
  );
}

/** Whether a paste is a REST DSN, the only Databend spelling `detectConnectionStringType` names. */
export function namesDatabendPaste(text: string): boolean {
  return DATABEND_DSN.test(text);
}

/**
 * A Databend paste (design 6.2). The refusals first: each names a Databend spelling Studio does not connect with.
 */
export function parseDatabendPaste(text: string): ParsedConnection | null {
  if (/^(export\s+)?BENDSQL_DSN=/.test(text)) return databendRefusal("shellExport");
  if (text.startsWith("jdbc:databend://")) return databendRefusal("jdbc");
  if (text.startsWith("databend+flight://") || text.startsWith("databend+grpc://")) return databendRefusal("flight");
  return parseDatabendDSN(text);
}
