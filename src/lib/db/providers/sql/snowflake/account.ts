/**
 * The Snowflake API origin: `https://<host>:443`, built by the provider itself from the Account field's reading, so a
 * connection or a paste can never point the bearer token at another host.
 *
 * Every check is `checkSnowflakeAccount`'s in `account-host.ts`, the one the dialog's hint and field check read too
 * (SF-025): an account URL with a port other than 443, a path, a query, a fragment or userinfo, an IPv4 literal as the
 * identifier, and a label or host a DNS name cannot hold. Every refusal is the Account format sentence, raised before
 * any socket, and never repeats the text, since a pasted URL can carry a token. `httpOrigin` then holds the host to
 * the shared host rules, which the reading already met, and checks it with the egress decision the provider was built
 * with, which refuses no host the reading admits, since the reading admits no address literal.
 */
import { type HttpOrigin, httpOrigin } from "@/lib/db/http/endpoint";
import type { EgressDecision } from "@/lib/db/types";
import { checkSnowflakeAccount, SNOWFLAKE_FIELD_SENTENCES } from "./account-host";
import { SnowflakeError } from "./errors";

export interface SnowflakeEndpoint {
  readonly origin: HttpOrigin;
  readonly host: string;
  /** The JWT account claim: the identifier's first label, upper-cased. */
  readonly accountClaim: string;
}

/** The origin, host and account claim of the Account field, or a `config` refusal before any socket. */
export function snowflakeEndpoint(account: unknown, egress: EgressDecision): SnowflakeEndpoint {
  if (typeof account !== "string") throw new SnowflakeError("config", SNOWFLAKE_FIELD_SENTENCES.accountEmpty);
  const reading = checkSnowflakeAccount(account);
  if (!reading.ok) throw new SnowflakeError("config", reading.refusal);
  const { host, accountClaim } = reading;
  return { origin: httpOrigin("https", host, 443, egress), host, accountClaim };
}
