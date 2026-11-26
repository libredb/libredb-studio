/**
 * Credentials a connection type warns about, declared as data, and the readers of that data.
 *
 * One record, three readers: the connection dialog draws `credentialWarningFor`'s sentence beside the password
 * before Test Connection, through `useConnectionForm`; the seed schema refuses a `readOnly: true` seed at load
 * with `readOnlySeedRefusal` over the literal credential the file shows; and a provider whose type declares an
 * entry runs `readOnlySeedRefusal` again on a seed connection once its `${ENV}` and `${vault:...}` references
 * have resolved, before it dials. The seed schema also refuses a seed's agent credential that is a declared pair, with
 * `publishedDefaultPairWarning`. `CONNECTION_FORM` (src/lib/db/connection-form.ts) takes each type's array from here
 * by reference, so the data exists once.
 *
 * Pure, browser-safe and UI-free: it imports types and the generated record only. It is not in
 * src/lib/db-ui-config.ts because that module imports React icon components, which the seed loader must not load.
 *
 * A JWT is decoded here, locally, with `atob`: its signature is never checked and nothing is sent anywhere. The
 * sentence says what the token declares, never what a server granted, and names no claim value.
 */
import type { DatabaseType } from "@/lib/types";
import { BUNDLED_CREDENTIAL_WARNINGS } from "./engine-catalog/connection.generated";

export type CredentialWarning =
  | { readonly kind: "pair"; readonly user: string; readonly password: string; readonly message: string }
  | {
      readonly kind: "jwt";
      readonly noExp: true;
      readonly access: readonly ("m" | "absent")[];
      readonly message: string;
    }
  | { readonly kind: "no-secret"; readonly message: string };

/**
 * Each connection type's declared warnings: each engine's `connection.credentialWarnings`, authored in its declaration
 * (src/lib/db/engine-declarations/<type-id>.json) and projected into `./engine-catalog/connection.generated.ts` by
 * scripts/generate-engine-catalog.ts (docs/providers/CONTRACT.md, clause M-71), a row only for an engine that declares
 * at least one warning. Why each engine warns about what it does is in its provider doc.
 *
 * A copy of the generated record, unfrozen as this record has always been, because the synthetic warnings of
 * tests/helpers/synthetic-credential-warnings.ts declare a row on it for a test's duration and remove it after; each
 * row and warning stays frozen.
 */
export const CREDENTIAL_WARNINGS: Readonly<Partial<Record<DatabaseType, readonly CredentialWarning[]>>> = {
  ...BUNDLED_CREDENTIAL_WARNINGS,
};

interface Credential {
  readonly user?: string;
  readonly password?: string;
}

type PairWarning = Extract<CredentialWarning, { kind: "pair" }>;
type JwtWarning = Extract<CredentialWarning, { kind: "jwt" }>;
type NoSecretWarning = Extract<CredentialWarning, { kind: "no-secret" }>;

/** The fixed frame of every sentence both readers return, and the string the package closure check looks for. */
const SENTENCE_FRAME = "Credential warning: ";

function framed(message: string): string {
  return `${SENTENCE_FRAME}${message}`;
}

function entriesOf(type: DatabaseType): readonly CredentialWarning[] {
  return CREDENTIAL_WARNINGS[type] ?? [];
}

function isPair(entry: CredentialWarning): entry is PairWarning {
  return entry.kind === "pair";
}

function isJwt(entry: CredentialWarning): entry is JwtWarning {
  return entry.kind === "jwt";
}

function isNoSecret(entry: CredentialWarning): entry is NoSecretWarning {
  return entry.kind === "no-secret";
}

/**
 * The user and password a pair is compared with. An empty user with a password holding a colon is read as
 * `user:password`, split at the first colon, because a token in the password box can be the pair written as one.
 */
function pairCredential(credential: Credential): { readonly user: string; readonly password: string } {
  const user = credential.user ?? "";
  const password = credential.password ?? "";
  const colon = password.indexOf(":");
  if (user !== "" || colon === -1) return { user, password };
  return { user: password.slice(0, colon), password: password.slice(colon + 1) };
}

/** The declared pair this credential is, read with the colon rule only where the type declares a pair at all. */
function matchingPair(entries: readonly CredentialWarning[], credential: Credential): PairWarning | undefined {
  const pairs = entries.filter(isPair);
  if (pairs.length === 0) return undefined;
  const { user, password } = pairCredential(credential);
  return pairs.find((pair) => pair.user === user && pair.password === password);
}

/** A JWT's claims, decoded locally from its base64url payload, or undefined for anything that is not one. */
function jwtClaims(token: string): Readonly<Record<string, unknown>> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  try {
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof claims === "object" && claims !== null && !Array.isArray(claims)
      ? (claims as Readonly<Record<string, unknown>>)
      : undefined;
  } catch {
    // Not a token: an opaque key, or a dotted string that only looks like one. The warning is a caution about
    // a token, never a check of what the user typed, so this is no warning and no error.
    return undefined;
  }
}

function jwtWarns(entry: JwtWarning, claims: Readonly<Record<string, unknown>>): boolean {
  const exp = claims.exp;
  const noExpiry = typeof exp !== "number" || !Number.isFinite(exp);
  const access = claims.access;
  const declaredAccess =
    (access === "m" && entry.access.includes("m")) || (access === undefined && entry.access.includes("absent"));
  return (entry.noExp && noExpiry) || declaredAccess;
}

/**
 * The dialog's warning for a credential, or undefined. A `pair` entry warns when the credential is that pair; a
 * `jwt` entry when the password is a token that declares no expiry, manage access, or no access claim; a
 * `no-secret` entry never warns here, because an empty password box is not a credential to warn about.
 */
export function credentialWarningFor(type: DatabaseType, credential: Credential): string | undefined {
  const entries = entriesOf(type);
  const pair = matchingPair(entries, credential);
  if (pair !== undefined) return framed(pair.message);
  const jwts = entries.filter(isJwt);
  if (jwts.length === 0) return undefined;
  const claims = jwtClaims(credential.password ?? "");
  const warning = claims === undefined ? undefined : jwts.find((entry) => jwtWarns(entry, claims));
  return warning === undefined ? undefined : framed(warning.message);
}

/**
 * The dialog's sentence for this credential when it is a declared `pair`, a published default, or undefined. Pairs
 * only: a `jwt` entry is a caution about a token and a `no-secret` entry a caution about none, and neither is a
 * credential anyone could know. The seed schema reads it over a seed's agent credential, which exists to narrow the
 * principal, so a published default is refused there.
 */
export function publishedDefaultPairWarning(type: DatabaseType, credential: Credential): string | undefined {
  const pair = matchingPair(entriesOf(type), credential);
  return pair === undefined ? undefined : framed(pair.message);
}

/**
 * Why a `readOnly: true` seed may not use this credential, or undefined: it is a declared `pair`, or it has no
 * password where the type declares `no-secret`. The sentence is the dialog's for the same pair, so the two
 * readers cannot disagree. A `jwt` entry refuses nothing.
 */
export function readOnlySeedRefusal(type: DatabaseType, credential: Credential): string | undefined {
  const entries = entriesOf(type);
  const pair = matchingPair(entries, credential);
  if (pair !== undefined) return framed(pair.message);
  if ((credential.password ?? "") !== "") return undefined;
  const noSecret = entries.find(isNoSecret);
  return noSecret === undefined ? undefined : framed(noSecret.message);
}
