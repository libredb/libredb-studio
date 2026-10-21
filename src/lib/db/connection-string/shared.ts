import type { RawParam, TLSIntent } from "./types";

/** The modes a TLS table maps onto, named through `TLSIntent` so this leaf imports nothing but `./types`. */
type TLSMode = NonNullable<TLSIntent["sslMode"]>;

/**
 * Map a documented value case-insensitively, or hand back the parameter verbatim.
 *
 * `Object.hasOwn` rather than a bare lookup: the tables are object literals, so an
 * all-lowercase Object.prototype key reaches them. `?sslmode=constructor` resolved to the
 * Object constructor FUNCTION - truthy, so it was written into `sslMode` and set as the
 * form's SSLMode, smuggling a non-SSLMode value past the banner this function exists to
 * raise. Pinned by tests/unit/lib/connection-string-parser.test.ts.
 */
export function mapTLSValue(param: RawParam, table: Readonly<Record<string, TLSMode>>): TLSIntent {
  const key = param.value.toLowerCase();
  return Object.hasOwn(table, key) ? { sslMode: table[key] } : { unmappedTLSParam: `${param.name}=${param.value}` };
}

/**
 * The boolean TLS spellings: postgres's JDBC/Heroku `ssl=true`, MySQL's `ssl` / `useSSL`
 * (Connector/J's pre-`sslMode` switch, still written by several ORMs) and MongoDB's `tls` /
 * `ssl`. A boolean has no opportunistic value, so unlike `sslmode`/`ssl-mode` both ends of it
 * are mappable.
 *
 * THE RULE (D26): a boolean TLS spelling is mapped onto the mode that matches what the
 * engine's OWN driver does with it, and never onto a weaker one. `true` therefore maps to
 * `verify-system`, because that is what the drivers do: `pg` given `ssl=true` and mysql2 given
 * `ssl: {}` both connect with Node's default `rejectUnauthorized: true`, and the mongodb
 * driver reads `tls=true` as TLS with chain verification. `false` maps to `disable`, which is
 * the same rule read the other way.
 *
 * `require` used to be the answer for `true`, and was wrong in one direction while the mongodb
 * refusal was wrong in the other: `require` is `rejectUnauthorized: false` in every provider
 * that has the knob, so a paste that asked for a verified connection got an unverified one,
 * and there was no mode to map onto that did not also demand a CA PEM the user does not have.
 * `verify-system` (src/lib/types.ts) is that mode, so the rule above no longer has to trade
 * security against completability.
 */
export function readBooleanTLS(param: RawParam): TLSIntent {
  const flag = param.value.toLowerCase();
  if (flag === "true" || flag === "1") return { sslMode: "verify-system" };
  if (flag === "false" || flag === "0") return { sslMode: "disable" };
  return { unmappedTLSParam: `${param.name}=${param.value}` };
}

/**
 * ADO.NET's Encrypt/TrustServerCertificate pair, from either the keyword string or an
 * mssql:// query. Encrypt on with TrustServerCertificate on is `require`: encrypted, chain
 * unchecked. Encrypt on with it off - including absent, which is the documented default -
 * validates the chain AND the name, so verify-full. `Strict` is TDS 8.0, where the driver
 * ignores TrustServerCertificate entirely and always validates.
 *
 * An absent Encrypt says nothing rather than "disable": System.Data.SqlClient defaults it to
 * false and Microsoft.Data.SqlClient 4.0+ to true, so the string alone does not carry the answer.
 */
export function readADONetTLS(get: (key: string) => string | undefined): TLSIntent {
  const encrypt = get("encrypt");
  if (encrypt === undefined) return {};
  const value = encrypt.toLowerCase();
  if (value === "false" || value === "no") return { sslMode: "disable" };
  if (value === "strict") return { sslMode: "verify-full" };
  if (value !== "true" && value !== "yes") return { unmappedTLSParam: `Encrypt=${encrypt}` };

  const trust = get("trustservercertificate");
  if (trust === undefined) return { sslMode: "verify-full" };
  const trusted = trust.toLowerCase();
  if (trusted === "true" || trusted === "yes") return { sslMode: "require" };
  if (trusted === "false" || trusted === "no") return { sslMode: "verify-full" };
  return { unmappedTLSParam: `TrustServerCertificate=${trust}` };
}
