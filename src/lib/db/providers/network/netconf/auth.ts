/**
 * Login failures of the `netconf` provider, phase 1 (issue #1724), and which of them the user is
 * told apart.
 *
 * The rule in one line: separate locally, do not separate remotely (decision K-92).
 *
 * MEASURED 2026-10-13 with ssh2 1.17.0 against the pinned Netopeer2 fixture, ten attempts.
 * Locally, a passphrase protected key fails inside `connect()` before a packet leaves, and the two
 * cases carry different text:
 *   no passphrase supplied  `Cannot parse privateKey: Encrypted private OpenSSH key detected, but
 *                            no passphrase given`
 *   wrong passphrase        `Cannot parse privateKey: OpenSSH key integrity check failed -- bad
 *                            passphrase?`
 * These are configuration errors, not authentication failures: nothing was refused, the key file
 * was never read successfully. Reporting them as "authentication failed" sends the user to the
 * server or the account, when the fault is in the local file.
 *
 * Remotely, three different causes collapse into one sentence, and that is kept:
 *   a wrong password, an unknown user, and a password offered to a key only account all end as
 *   `All configured authentication methods failed`.
 * Telling these apart for the user would also tell them apart for anyone probing accounts, so the
 * provider says one sentence with no detail. The cost is that a user whose password is wrong and a
 * user who does not exist read the same sentence. That is the intended cost.
 */

export type LoginFailure =
  | {
      readonly kind: "configuration";
      /**
       * Which thing could not be read, and the two keys are NOT one reason.
       *
       * `key-unreadable` is the connection's private key, which an operator fixes by pasting the
       * whole file; `pin-unreadable` is the device's host key fingerprint, which they fix by
       * pasting the line `ssh-keygen -lf` prints. Both answered `key-unreadable` once: the
       * sentences differed while the machine-readable reason did not, so anything branching on this
       * field sent a reader to the wrong box, and a field that exists to be branched on has to
       * separate what the sentences separate.
       */
      readonly reason: "passphrase-missing" | "passphrase-wrong" | "key-unreadable" | "pin-unreadable";
      readonly message: string;
    }
  | { readonly kind: "refused"; readonly message: string }
  /**
   * The two fingerprints are fields and not only words inside `message`.
   *
   * A caller that has to show, log or compare them cannot be made to parse a sentence, and neither
   * can a test: a test that reads the fingerprints out of the message text asserts the wording
   * rather than the fact, so it goes red when the sentence is reworded and stays green when the
   * wrong key is reported. They are optional because this kind is also reached by classifying an
   * error ssh2 raised on its own, where no comparison was made here and there is nothing to put in
   * them.
   */
  | { readonly kind: "host-key"; readonly message: string; readonly expected?: string; readonly seen?: string }
  | { readonly kind: "transport"; readonly message: string };

/** The one sentence every server side refusal gets. */
export const REFUSED_SENTENCE = "authentication failed";

/**
 * Sorts one thrown error into the four kinds above.
 *
 * It branches on the shape ssh2 gives, never on a server's own message text, which is the rule the
 * rest of the provider follows for NETCONF errors as well: those are read by error-tag.
 */
export function classifyLoginFailure(error: unknown): LoginFailure {
  const text = error instanceof Error ? error.message : String(error);

  // Local, and distinguishable. ssh2 raises these synchronously from connect(), so no packet has
  // left and no account has been named to anyone.
  if (text.includes("Encrypted private OpenSSH key detected, but no passphrase given")) {
    return {
      kind: "configuration",
      reason: "passphrase-missing",
      message: "this private key is encrypted and no passphrase was given for it",
    };
  }
  if (text.includes("OpenSSH key integrity check failed")) {
    return {
      kind: "configuration",
      reason: "passphrase-wrong",
      message: "the passphrase does not open this private key",
    };
  }
  if (text.startsWith("Cannot parse privateKey")) {
    return {
      kind: "configuration",
      reason: "key-unreadable",
      message: "this private key cannot be read: check that the whole file was pasted",
    };
  }

  // Remote, and deliberately not distinguished.
  if (text.includes("All configured authentication methods failed")) {
    return { kind: "refused", message: REFUSED_SENTENCE };
  }

  // The host key rule has its own kind, because it must never be retried another way.
  if (text.includes("Host denied") || text.includes("verification failed")) {
    return { kind: "host-key", message: text };
  }

  return { kind: "transport", message: text };
}

/**
 * True when the failure may be shown with its own text.
 *
 * A configuration failure and a host key failure name what the user has to change. A refusal does
 * not: it carries `REFUSED_SENTENCE` and nothing else, so no username, no password, no key path and
 * no server text reaches the user through this path.
 */
export function mayShowDetail(failure: LoginFailure): boolean {
  return failure.kind === "configuration" || failure.kind === "host-key";
}
