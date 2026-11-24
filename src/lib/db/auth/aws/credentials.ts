/**
 * Typed AWS credentials, with no AWS SDK: the access key ID, the secret access key and, for a temporary credential,
 * the session token, as the provider read them from its own fields.
 *
 * Only typed keys are read here. No environment variable (AWS_ACCESS_KEY_ID and its relatives), no shared config or
 * credentials file, no profile, no SSO, no credential process and no instance metadata is consulted: an operator who
 * keeps a key in the environment writes ${AWS_ACCESS_KEY_ID} in the seed file, which the seed resolver expands, so
 * every key is explicit per connection. No refusal repeats a key, a secret or a token.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import type { DatabaseType } from "@/lib/types";
import type { AwsCredentials } from "./sigv4";

/** What a provider read from its fields; undefined and "" both mean "not given". */
export interface AwsCredentialInput {
  readonly accessKeyId: string | undefined;
  readonly secretAccessKey: string | undefined;
  /** A provider without a session-token field passes undefined. */
  readonly sessionToken: string | undefined;
}

export const AWS_CREDENTIAL_SENTENCES = Object.freeze({
  keysRequired: "An AWS access key ID and secret access key are required",
  tokenWithoutPair:
    "An AWS session token was given without an access key ID and secret access key: a session token signs only with its key pair",
  accessKeyIdMissing: "The AWS secret access key was given without an access key ID",
  secretMissing: "The AWS access key ID was given without a secret access key",
  accessKeyIdShape:
    "The AWS access key ID must be 3 to 512 visible ASCII characters with no space, comma, slash or equals sign",
  secretShape: "The AWS secret access key is not well-formed text",
  sessionTokenShape: "The AWS session token must be at most 8192 visible ASCII characters with no space",
});

const S = AWS_CREDENTIAL_SENTENCES;

/**
 * Visible ASCII without space, comma, slash or equals sign, 3 to 512 characters: the ID is written inside the
 * `Credential=` field of the Authorization value, whose own separators these are, and 3 is the shortest ID measured
 * on an AWS-compatible server, so an emulator's `test` passes.
 */
const ACCESS_KEY_ID = /^[\x21-\x2b\x2d\x2e\x30-\x3c\x3e-\x7e]{3,512}$/;
/** Visible ASCII, at most 8192 characters: the transport's limit for a value a signer returns. */
const SESSION_TOKEN = /^[\x21-\x7e]{1,8192}$/;

const given = (value: string | undefined): value is string => value !== undefined && value !== "";

/**
 * Typed keys only: an empty pair is `keysRequired`, a session token without a pair is `tokenWithoutPair`, half a pair
 * names the missing half, and each value must pass its format rule. The secret is any non-empty well-formed text (no
 * lone surrogate), since it is hashed as UTF-8 and its forms are URI-encoded for secretForms. A typed pair gives
 * frozen static credentials, with the session token when one is given. Every refusal is DatabaseConfigError labelled
 * with `provider` and quotes no value.
 */
export function resolveAwsCredentials(input: AwsCredentialInput, provider: DatabaseType | undefined): AwsCredentials {
  const { accessKeyId, secretAccessKey, sessionToken } = input;
  if (!given(accessKeyId) && !given(secretAccessKey)) {
    throw new DatabaseConfigError(given(sessionToken) ? S.tokenWithoutPair : S.keysRequired, provider);
  }
  if (!given(accessKeyId)) throw new DatabaseConfigError(S.accessKeyIdMissing, provider);
  if (!given(secretAccessKey)) throw new DatabaseConfigError(S.secretMissing, provider);
  if (!ACCESS_KEY_ID.test(accessKeyId)) throw new DatabaseConfigError(S.accessKeyIdShape, provider);
  if (!secretAccessKey.isWellFormed()) throw new DatabaseConfigError(S.secretShape, provider);
  if (!given(sessionToken)) return Object.freeze({ accessKeyId, secretAccessKey });
  if (!SESSION_TOKEN.test(sessionToken)) throw new DatabaseConfigError(S.sessionTokenShape, provider);
  return Object.freeze({ accessKeyId, secretAccessKey, sessionToken });
}

/**
 * The secret access key, the session token when present, and the access key ID, in that order, for secretForms; it
 * reads three fields and never throws.
 */
export function awsCredentialSecrets(credentials: AwsCredentials): readonly string[] {
  return credentials.sessionToken === undefined
    ? [credentials.secretAccessKey, credentials.accessKeyId]
    : [credentials.secretAccessKey, credentials.sessionToken, credentials.accessKeyId];
}
