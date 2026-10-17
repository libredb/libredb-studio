import { QueryError } from "@/lib/db/errors";
// One source for the floor. It was written out here as well, so the same RFC clause had two
// copies that nothing kept in step; a change to one of them would have passed every test.
import { MIN_PASSPHRASE } from "./usm";
/**
 * What a connection must carry before a datagram is allowed to leave (SN-S2, SN-S3).
 *
 * Everything here is checked before the socket is opened, because the failures it prevents are
 * not recoverable afterwards. A community travels in clear on every single request, so a v2c
 * connection to anything but this machine is a decision the operator has to make explicitly
 * rather than a default they fall into; and a passphrase that is too short weakens every
 * message it localises a key for, which no later check can undo.
 *
 * The bounds are the standard's, not ours, and each one carries its clause. Where the standard
 * says "must" the value is refused; where it warns, a caution is raised and the connection is
 * still allowed, because the operator may know something this code does not.
 *
 * Nothing in this module puts a credential into a message. Every refusal names the FIELD that
 * was wrong and never its value, so a message can be logged, shown and copied without carrying
 * the secret that caused it.
 */

export type SnmpVersion = "v2c" | "v3";
export type SecurityLevel = "noAuthNoPriv" | "authNoPriv" | "authPriv";

export interface SnmpConnectionInput {
  readonly host: string;
  readonly port: number;
  readonly version: SnmpVersion;
  /** v2c only. */
  readonly community?: string;
  /** v3 only. */
  readonly securityLevel?: SecurityLevel;
  readonly userName?: string;
  readonly authPassphrase?: string;
  readonly privacyPassphrase?: string;
  readonly contextName?: string;
  readonly engineIdPin?: string;
  /** The operator's explicit consent to send a credential in clear beyond this machine. */
  readonly allowInsecureAuth?: boolean;
}

export class ConnectionRefused extends QueryError {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionRefused";
    Object.setPrototypeOf(this, ConnectionRefused.prototype);
  }
}

export interface Caution {
  readonly field: string;
  readonly text: string;
}

/** RFC 3826 section 1.3 warns below this; it is a caution rather than a refusal. */
const ADVISED_PASSPHRASE = 12;
/** RFC 3414 section 2.4 and RFC 3415 section 4 bound these at 32 octets. */
const MAX_NAME_OCTETS = 32;
/** RFC 3411 section 5: an engine ID is 5 to 32 octets. */
const ENGINE_ID_MIN = 5;
const ENGINE_ID_MAX = 32;

const octets = (value: string): number => new TextEncoder().encode(value).length;

/** True for an address that cannot leave this machine. A name is never assumed to be local. */
export function isLoopback(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "::1" || bare === "localhost") return true;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return false;
  const parts = bare.split(".").map(Number);
  return parts.every((n) => n >= 0 && n <= 255) && parts[0] === 127;
}

export interface Checked {
  readonly cautions: readonly Caution[];
}

/**
 * Refuses what the standard refuses, cautions where it warns, and never echoes a secret.
 *
 * The order matters in one place: the version is settled first, because a v2c field on a v3
 * connection is a different mistake from a missing v3 field, and telling the operator the wrong
 * one sends them to the wrong box.
 */
export function checkConnection(input: SnmpConnectionInput): Checked {
  const cautions: Caution[] = [];
  // The annotation is on the CONST, not only on the arrow. TypeScript narrows through a call
  // that returns `never` only when the name it calls carries an explicit type, so without this
  // line every check below still sees `string | undefined` and the file does not compile.
  const refuse: (field: string, why: string) => never = (field, why) => {
    throw new ConnectionRefused(`${field}: ${why}`);
  };

  if (input.port < 1 || input.port > 65535 || !Number.isInteger(input.port)) {
    refuse("port", "a UDP port is an integer from 1 to 65535");
  }
  if (input.host.trim() === "") refuse("host", "a connection needs an agent to address");

  if (input.version === "v2c") {
    if (input.community === undefined || input.community === "") {
      refuse("community", "SNMPv2c carries a community on every request");
    }
    // SN-S2. The community is in clear in every datagram, and this provider has no transport
    // security to offer instead, so reaching past this machine is the operator's explicit call.
    if (!isLoopback(input.host) && input.allowInsecureAuth !== true) {
      refuse(
        "version",
        "SNMPv2c sends its community in clear on every request, and this agent is not on this machine. Choose SNMPv3, or consent to the community travelling in clear",
      );
    }
    cautions.push({
      field: "version",
      text: "SNMPv2c has no authentication: an answer can be forged by anything that can reach this connection, and the values travel in clear",
    });
    return { cautions };
  }

  if (input.securityLevel === undefined) refuse("securityLevel", "an SNMPv3 connection states its security level");
  const level = input.securityLevel;
  if (input.userName === undefined || input.userName === "") refuse("userName", "SNMPv3 names a user on every request");
  if (octets(input.userName) > MAX_NAME_OCTETS) {
    refuse("userName", `a user name is at most ${MAX_NAME_OCTETS} octets (RFC 3414 section 2.4)`);
  }
  if (input.contextName !== undefined && octets(input.contextName) > MAX_NAME_OCTETS) {
    refuse("contextName", `a context name is at most ${MAX_NAME_OCTETS} octets (RFC 3415 section 4)`);
  }
  if (input.engineIdPin !== undefined) {
    if (!/^[0-9a-fA-F]+$/.test(input.engineIdPin) || input.engineIdPin.length % 2 !== 0) {
      refuse("engineIdPin", "an engine ID is written as pairs of hexadecimal digits");
    }
    const length = input.engineIdPin.length / 2;
    if (length < ENGINE_ID_MIN || length > ENGINE_ID_MAX) {
      refuse("engineIdPin", `an engine ID is ${ENGINE_ID_MIN} to ${ENGINE_ID_MAX} octets (RFC 3411 section 5)`);
    }
  }

  const needsAuth = level === "authNoPriv" || level === "authPriv";
  if (needsAuth) {
    if (input.authPassphrase === undefined) refuse("authPassphrase", "this security level authenticates every request");
    checkPassphrase("authPassphrase", input.authPassphrase, refuse, cautions);
  }
  if (level === "authPriv") {
    if (input.privacyPassphrase === undefined) refuse("privacyPassphrase", "authPriv encrypts every request");
    checkPassphrase("privacyPassphrase", input.privacyPassphrase, refuse, cautions);
    if (input.authPassphrase !== undefined && input.authPassphrase === input.privacyPassphrase) {
      cautions.push({
        field: "privacyPassphrase",
        text: "the privacy and authentication passphrases are the same, so one disclosure costs both (RFC 3414 section 11.2)",
      });
    }
  }
  if (level === "noAuthNoPriv") {
    cautions.push({
      field: "securityLevel",
      text: "noAuthNoPriv neither authenticates nor encrypts: an answer can be forged and the values travel in clear",
    });
  }
  if (level === "authNoPriv") {
    cautions.push({
      field: "securityLevel",
      text: "authNoPriv authenticates but does not encrypt, so the values travel in clear",
    });
  }
  return { cautions };
}

function checkPassphrase(
  field: string,
  value: string | undefined,
  refuse: (field: string, why: string) => never,
  cautions: Caution[],
): void {
  if (value === undefined) return;
  const length = octets(value);
  if (length < MIN_PASSPHRASE) {
    // The length is named and the value is not: the message can be logged safely.
    refuse(field, `a passphrase is at least ${MIN_PASSPHRASE} characters (RFC 3414 section 11.2)`);
  }
  if (length < ADVISED_PASSPHRASE) {
    cautions.push({
      field,
      text: `a passphrase under ${ADVISED_PASSPHRASE} octets is short for the key it localises (RFC 3826 section 1.3)`,
    });
  }
}
