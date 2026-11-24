import type {
  ConnectionStringPasteReader,
  SeedCheck,
  SeedCheckedFields,
  SeedFieldRefusal,
} from "@/lib/db/connection-string/types";
import {
  checkSnowflakeAccount,
  SNOWFLAKE_FIELD_SENTENCES,
  SNOWFLAKE_SIGN_IN_DEFAULT,
} from "@/lib/db/providers/sql/snowflake/account-host";
import { isSnowflakePaste, parseSnowflakeURL } from "@/lib/db/providers/sql/snowflake/paste";

const blank = (value: string | undefined): boolean => value === undefined || value.trim() === "";

/**
 * Snowflake's checks before any socket, as `connect()` makes them (the account by `checkSnowflakeAccount`, then the
 * user, the sign-in method, the credential that method needs and the role), each skipped for a field holding a
 * reference. Every refusal is the provider's own sentence.
 */
function snowflakeLoadRefusals(
  conn: SeedCheckedFields,
  isReference: (value: string | undefined) => boolean,
): SeedFieldRefusal[] {
  /** Whether a value can be judged at load: not a reference, which is resolved only after the file is validated. */
  const judgeable = (value: string | undefined): boolean => !isReference(value);
  const found: SeedFieldRefusal[] = [];
  if (judgeable(conn.host)) {
    const reading = checkSnowflakeAccount(conn.host ?? "");
    if (!reading.ok) found.push({ field: "host", sentence: reading.refusal });
  }
  if (judgeable(conn.user) && blank(conn.user))
    found.push({ field: "user", sentence: SNOWFLAKE_FIELD_SENTENCES.userEmpty });
  const method = conn.authMethod ?? SNOWFLAKE_SIGN_IN_DEFAULT;
  if (judgeable(method)) {
    if (method !== "keypair" && method !== "pat") {
      found.push({ field: "authMethod", sentence: SNOWFLAKE_FIELD_SENTENCES.method });
    } else if (method === "keypair" && blank(conn.privateKey)) {
      found.push({ field: "privateKey", sentence: SNOWFLAKE_FIELD_SENTENCES.keyEmpty });
    } else if (method === "pat" && blank(conn.password)) {
      found.push({ field: "password", sentence: SNOWFLAKE_FIELD_SENTENCES.tokenEmpty });
    }
  }
  if (judgeable(conn.role) && blank(conn.role))
    found.push({ field: "role", sentence: SNOWFLAKE_FIELD_SENTENCES.roleEmpty });
  return found;
}

/**
 * `snowflake`'s paste reader, of a `jdbc:snowflake://`, `snowflake://` or Snowflake `https://` URL or a bare Snowflake
 * host. An account identifier with no `.snowflakecomputing.com` suffix is not read, and its declaration lists no such
 * format: it is a single word, which would claim any text pasted.
 */
export const SNOWFLAKE_PASTE_READER: ConnectionStringPasteReader = Object.freeze({
  claims: isSnowflakePaste,
  names: isSnowflakePaste,
  parse: parseSnowflakeURL,
});

/** `snowflake`'s seed load check: its provider's checks, run at seed load. */
export const SNOWFLAKE_SEED_CHECK: SeedCheck = snowflakeLoadRefusals;
