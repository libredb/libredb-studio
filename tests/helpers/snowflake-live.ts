/**
 * What the hand-run Snowflake harness (tests/live/snowflake-evidence.ts) and live check
 * (tests/live/snowflake-live-check.ts) share: the reading of their environment, refused with exit code 2 before any
 * socket, and the mask every line they print passes.
 *
 * Every input comes from the environment, never from a file of this repository: the account, the service user's and
 * the reader's login names and key files (each with an optional passphrase), the PAT user and the PAT, and the
 * warehouse. A refusal names the variable and never its value, since the value may be a secret. The key files are
 * read here, so a path that holds no private key is refused before anything is sent too.
 *
 * The evidence harness alone also reads the account's edition, the operator's egress IP when known, and the operator
 * user: the administrator who set the account up and registered the service user's key, whom an answer such as
 * `SHOW USER KEY PAIRS` names. The live check writes no file and prints no row of such an answer, so it reads none of
 * them.
 */
import { readFileSync } from "node:fs";
import { egressDecision } from "@/lib/db/egress-decision";
import { snowflakeEndpoint } from "@/lib/db/providers/sql/snowflake/account";
import type { SnowflakeEvidenceSecrets } from "./snowflake-evidence-scrub";

/** What every masked secret is printed as. */
export const SNOWFLAKE_LIVE_MASK = "<masked>";

export interface LiveKeyPrincipal {
  readonly user: string;
  readonly keyPem: string;
  readonly passphrase?: string;
}

export interface LiveArguments {
  /** As typed in SNOWFLAKE_ACCOUNT. */
  readonly account: string;
  /** The account's host, as the provider builds it from the account. */
  readonly host: string;
  readonly warehouse: string;
  /** `studio_svc`: key pair, role `studio_rw`. */
  readonly svc: LiveKeyPrincipal;
  /** `studio_reader`: key pair, roles `studio_ro` and `studio_nowh`. */
  readonly reader: LiveKeyPrincipal;
  /** `studio_pat`: a PAT restricted to `STUDIO_RO`. */
  readonly pat: { readonly user: string; readonly token: string };
}

export interface LiveRefusal {
  readonly exitCode: 2;
  readonly message: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

const LOGIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.$@-]{0,254}$/;
const WAREHOUSE_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,254}$/;
const TOKEN = /^\S{16,}$/;
const PRIVATE_KEY = /-----BEGIN (?:ENCRYPTED |RSA )?PRIVATE KEY-----/;

class Refused extends Error {}

const refuse = (name: string, why: string): never => {
  throw new Refused(`${name} ${why}; nothing was sent.`);
};

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === "") refuse(name, "is not set");
  return value as string;
}

function optional(env: Environment, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

function loginName(env: Environment, name: string): string {
  const value = required(env, name);
  if (!LOGIN_NAME.test(value)) refuse(name, "is not a Snowflake login name");
  return value;
}

function keyPrincipal(
  env: Environment,
  prefix: "SNOWFLAKE_SVC" | "SNOWFLAKE_READER",
  readFile: (path: string) => string,
): LiveKeyPrincipal {
  const user = loginName(env, `${prefix}_USER`);
  const fileName = `${prefix}_KEY_FILE`;
  const path = required(env, fileName);
  let keyPem = "";
  try {
    keyPem = readFile(path);
  } catch {
    refuse(fileName, "names a file that cannot be read");
  }
  if (!PRIVATE_KEY.test(keyPem)) refuse(fileName, "names a file that holds no PEM private key");
  const passphrase = optional(env, `${prefix}_KEY_PASSPHRASE`);
  return passphrase === undefined ? { user, keyPem } : { user, keyPem, passphrase };
}

/**
 * The run's arguments, or the exit code 2 refusal of the first variable that is missing or malformed. Reads the two
 * key files through `readFile`; opens no socket.
 */
export function readLiveArguments(
  env: Environment,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): LiveArguments | LiveRefusal {
  try {
    const account = required(env, "SNOWFLAKE_ACCOUNT");
    let host = "";
    try {
      host = snowflakeEndpoint(account, egressDecision()).host;
    } catch {
      refuse("SNOWFLAKE_ACCOUNT", "is not a Snowflake account identifier or account URL");
    }
    const svc = keyPrincipal(env, "SNOWFLAKE_SVC", readFile);
    const reader = keyPrincipal(env, "SNOWFLAKE_READER", readFile);
    const patUser = loginName(env, "SNOWFLAKE_PAT_USER");
    const token = required(env, "SNOWFLAKE_PAT");
    if (!TOKEN.test(env.SNOWFLAKE_PAT ?? "")) refuse("SNOWFLAKE_PAT", "is not a programmatic access token");
    const warehouse = required(env, "SNOWFLAKE_WAREHOUSE");
    if (!WAREHOUSE_NAME.test(warehouse)) refuse("SNOWFLAKE_WAREHOUSE", "is not an unquoted warehouse name");
    return { account, host, warehouse, svc, reader, pat: { user: patUser, token } };
  } catch (error) {
    if (error instanceof Refused) return { exitCode: 2, message: error.message };
    throw error;
  }
}

/** The inputs only the evidence harness reads. */
export interface EvidenceInputs {
  /** For the manifest. */
  readonly edition: string;
  /** When the operator knows it, for the scrub to look for. */
  readonly egressIp?: string;
  /** The administrator who set the account up. */
  readonly operatorUser: string;
}

/** The evidence harness's own inputs, or the exit code 2 refusal of the first one that is missing or malformed. */
export function readEvidenceInputs(env: Environment): EvidenceInputs | LiveRefusal {
  try {
    const edition = required(env, "SNOWFLAKE_EDITION");
    const operatorUser = loginName(env, "SNOWFLAKE_OPERATOR_USER");
    const egressIp = env.SNOWFLAKE_EGRESS_IP?.trim() || undefined;
    return egressIp === undefined ? { edition, operatorUser } : { edition, egressIp, operatorUser };
  } catch (error) {
    if (error instanceof Refused) return { exitCode: 2, message: error.message };
    throw error;
  }
}

/** What the account answered about itself: `CURRENT_ACCOUNT()`, `CURRENT_ORGANIZATION_NAME()`, `CURRENT_ACCOUNT_NAME()`. */
export interface EvidenceAccount {
  readonly locator: string;
  readonly organization: string;
  readonly accountName: string;
}

/**
 * The scrub's secrets: the three principals and then the operator as users, so the operator is `<user-4>`, the
 * operator alone as a private name no file may hold anywhere (the principals' setup names stay in each scenario's
 * connection block, which the replay signs as), and the
 * account's names as the account answered them, whatever form SNOWFLAKE_ACCOUNT took. A name split out of an
 * org-account SNOWFLAKE_ACCOUNT adds nothing to those answers, and splits wrongly at a hyphen inside the account name.
 */
export function evidenceScrubSecrets(
  args: LiveArguments,
  inputs: EvidenceInputs,
  account: EvidenceAccount,
): SnowflakeEvidenceSecrets {
  return {
    users: [args.svc.user, args.reader.user, args.pat.user, inputs.operatorUser],
    privateNames: [inputs.operatorUser],
    pats: [args.pat.token],
    passphrases: [args.svc.passphrase, args.reader.passphrase].filter((value): value is string => value !== undefined),
    accountLocator: account.locator,
    organization: account.organization,
    accountName: account.accountName,
    host: args.host,
    egressIp: inputs.egressIp,
  };
}

/** Every value of the run no printed line may show: the PAT, the passphrases, the keys, the host and the account. */
export function liveSecrets(args: LiveArguments): string[] {
  return [
    args.pat.token,
    args.svc.keyPem,
    args.reader.keyPem,
    ...[args.svc.passphrase, args.reader.passphrase].filter((value): value is string => value !== undefined),
    args.host,
    args.account,
  ];
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Each spelling of a secret a printed line may carry: as it is, each long line of it, encoded and escaped. */
function spellings(secret: string): string[] {
  const forms = [secret, ...secret.split(/\r?\n/).filter((line) => line.trim().length >= 16)];
  return forms.flatMap((form) => {
    const bytes = Buffer.from(form, "utf8");
    return [
      form,
      encodeURIComponent(form),
      bytes.toString("base64").replace(/=+$/, ""),
      bytes.toString("base64url"),
      JSON.stringify(form).slice(1, -1),
    ];
  });
}

/** The text with every spelling of every secret replaced by {@link SNOWFLAKE_LIVE_MASK}, in any letter case. */
export function mask(text: string, secrets: readonly string[]): string {
  const forms = [...new Set(secrets.filter((secret) => secret !== "").flatMap(spellings))].sort(
    (a, b) => b.length - a.length,
  );
  return forms.reduce((line, form) => line.replace(new RegExp(escapeRegExp(form), "gi"), SNOWFLAKE_LIVE_MASK), text);
}
