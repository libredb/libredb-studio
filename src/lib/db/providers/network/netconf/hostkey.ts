/**
 * The device host key pin of the `netconf` provider, phase 1 (issue #1724).
 *
 * STANDARD: RFC 6242 section 6 requires the client to verify the server's identity before any
 * configuration or state data, or any password, is sent.
 * ssh2 documents the opposite default: with no `hostVerifier` it accepts whatever answers. So a
 * verifier is always installed and an empty pin is a configuration error rather than first contact.
 *
 * MEASURED 2026-10-13 against the pinned fixture: a wrong pin stops the handshake with
 * `Host denied (verification failed)` before any user authentication packet, and it does so through
 * an SSH tunnel as well, where the key seen inside the forward is the device's own and not the
 * bastion's (the two fingerprints differed).
 *
 * `docs/BACKLOG.md` D34 records that nothing writes the tunnel's own fingerprint field today. This
 * file is the writer side of that gap for this provider: it parses what a user pastes, says what is
 * wrong with it, and compares. The connection form field itself is a shared surface and is not
 * touched here (decision K-53).
 */

import { createHash } from "node:crypto";

/** A `SHA256:` fingerprint as `ssh-keygen -lf` prints it: base64, no padding. */
const SHA256_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

export type PinProblem =
  | { readonly kind: "empty" }
  | { readonly kind: "not-sha256"; readonly given: string }
  | { readonly kind: "malformed"; readonly given: string };

export type PinCheck =
  | { readonly ok: true; readonly pin: string }
  | { readonly ok: false; readonly problem: PinProblem; readonly message: string };

/**
 * Reads a pasted fingerprint.
 *
 * Accepts the exact spelling `ssh-keygen -lf` prints, with or without surrounding whitespace, and
 * refuses everything else with a sentence that says what to paste. An MD5 fingerprint is refused by
 * name rather than as a general format error, because it is the form an older runbook will carry.
 */
export function readPin(given: string): PinCheck {
  const pin = given.trim();
  if (pin === "") {
    return {
      ok: false,
      problem: { kind: "empty" },
      message: "this connection needs the device's host key fingerprint: paste the SHA256: line of ssh-keygen -lf",
    };
  }
  if (/^(MD5:)?([0-9a-f]{2}:){15}[0-9a-f]{2}$/i.test(pin)) {
    return {
      ok: false,
      problem: { kind: "not-sha256", given: pin },
      message: "this is an MD5 fingerprint: paste the SHA256: line instead, which ssh-keygen -lf prints by default",
    };
  }
  if (!SHA256_FINGERPRINT.test(pin)) {
    return {
      ok: false,
      problem: { kind: "malformed", given: pin },
      message: "a host key fingerprint reads SHA256: followed by 43 base64 characters",
    };
  }
  return { ok: true, pin };
}

/** The fingerprint of a key as presented on the wire, in the same spelling as a pasted pin. */
export function fingerprintOf(hostKey: Buffer): string {
  return `SHA256:${createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "")}`;
}

export interface PinMismatch {
  readonly expected: string;
  readonly seen: string;
  readonly message: string;
}

/**
 * Compares the key the device presented against the pin.
 *
 * On a mismatch the message names BOTH fingerprints and both plausible causes, because the two are
 * indistinguishable from the wire: the device may have been rebuilt without its old key, or another
 * host may be answering. A message that says only that something is wrong leaves a legitimate
 * rebuild looking like an attack and an attack looking like a rebuild.
 */
export function checkHostKey(hostKey: Buffer, pin: string): PinMismatch | null {
  const seen = fingerprintOf(hostKey);
  if (seen === pin) return null;
  return {
    expected: pin,
    seen,
    message:
      `the device presented host key ${seen}, and this connection is pinned to ${pin}. ` +
      "Either the device was reinstalled without its old key, or another host is answering on this address. " +
      "Nothing was sent to it.",
  };
}
