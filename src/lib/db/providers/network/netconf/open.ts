/**
 * The composition root: a connection becomes a reader.
 *
 * Four things are joined here and nothing is decided: the egress rule and the host key check are
 * the dial's, the framing and the message matching are the session's, and which request answers
 * which question is the reader's. This function exists so that the join itself is testable, and so
 * that the one part that does not exist yet is a parameter rather than a gap.
 *
 * The parser is that part (K-10). It is passed in, so this path is complete today with a test
 * double and complete tomorrow with the real reader, and nothing here changes when it lands.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/db/types";
import { dialNetconf, NETCONF_PORT, type SocketPort, type SshPort } from "./dial";
import { nodeSocketPort, nodeSshPort } from "./node-ports";
import { asHouseError, type DialTarget } from "./failures";
import type { XmlReaderPort } from "./reader-port";
import { DeviceReaderImpl, type SessionPort } from "./reader";
import { NetconfSession, type SessionLimits } from "./session";

/**
 * The deadlines and sizes one session runs under.
 *
 * MEASURED 2026-10-13 against the fixture over SSH on loopback: the dial, host key check and
 * subsystem open together took 44 ms cold and 212 ms on a later run, a hello was always answered
 * well inside a second, and the five request sequence took 350 ms in all, the largest single reply
 * being 987,956 bytes.
 *
 * STILL A DEFAULT, and loopback is why: a device reached across a management network is the
 * measurement that decides a deadline, and it is UNMEASURED. These are generous against everything
 * seen so far rather than tuned to it, and the sizes come from the read caps rather than from a
 * guess: a reply larger than the parser would accept is refused by the framing first, with a
 * sentence, instead of being parsed and then refused.
 */
export const NETCONF_SESSION_LIMITS: SessionLimits = Object.freeze({
  helloMs: 15_000,
  requestMs: 120_000,
  maxMessageBytes: 16 * 1024 * 1024,
  maxBufferBytes: 32 * 1024 * 1024,
});

export interface OpenPorts {
  readonly xml: XmlReaderPort;
  readonly ssh?: SshPort;
  readonly socket?: SocketPort;
  readonly limits?: SessionLimits;
}

/**
 * The credential this provider dials with, read from the connection.
 *
 * It used to be a parameter, and the reason is worth keeping because it has now expired: the fields
 * did not exist. The house carries an engine's own settings as optional fields on
 * `DatabaseConnection`, and a key, its passphrase and a host key fingerprint were three the type did
 * not have, so taking them as an argument was how this file avoided inventing a shared surface
 * before the registration that owns it. The registration landed, the fields exist, and a provider
 * that still took them by hand would be declaring boxes in the connection form that nothing reads.
 *
 * `sshTunnel` is NOT where these come from: it describes a bastion to reach a target THROUGH, its
 * own docblock says so, and a device behind a bastion has two identities to check.
 *
 * A key and a password are both allowed, because a device may be configured for either. Neither is
 * required to be present at the same time as the other, and both are rejected together: MEASURED on
 * the fixture, no credential, an empty password and a wrong password are refused by the device with
 * one sentence and one kind, so dialling with nothing cannot learn anything and leaves a line in
 * the device's auth log.
 */
export interface NetconfCredential {
  readonly username: string;
  readonly hostKeyFingerprint: string;
  readonly privateKey?: string;
  readonly passphrase?: string;
  readonly password?: string;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/**
 * Not exported: `openNetconfReader` below is its only caller, and knip reported the export as a
 * leftover. The shape it builds is what `checked` then refuses or passes, and both doors run the
 * same check, which is the property the two tests hold.
 */
function credentialOf(config: DatabaseConnection): NetconfCredential {
  return checked({
    username: config.user ?? "",
    hostKeyFingerprint: typeof config.hostKeyFingerprint === "string" ? config.hostKeyFingerprint : "",
    ...(text(config.privateKey) === undefined ? {} : { privateKey: config.privateKey }),
    ...(text(config.privateKeyPassphrase) === undefined ? {} : { passphrase: config.privateKeyPassphrase }),
    ...(text(config.password) === undefined ? {} : { password: config.password }),
  });
}

/**
 * The same two refusals whichever way the credential arrived.
 *
 * A caller may hand one in instead of letting it be read off the connection, and a check that ran
 * only on the read path would let the handed-in one through unexamined. MEASURED by two tests that
 * passed an unusable credential and were answered a connection: the refusals had moved into the
 * reader and the other door had none.
 */
function checked(credential: NetconfCredential): NetconfCredential {
  if (text(credential.username) === undefined) {
    throw new DatabaseConfigError("this connection needs the device's account name");
  }
  if (text(credential.privateKey) === undefined && text(credential.password) === undefined) {
    throw new DatabaseConfigError("this connection needs the device's key or its password");
  }
  return credential;
}

export async function openNetconfReader(
  config: DatabaseConnection,
  ports: OpenPorts,
  override?: NetconfCredential,
): Promise<DeviceReaderImpl> {
  const host = config.host;
  if (typeof host !== "string" || host === "") {
    throw new DatabaseConfigError("this connection needs the device's address");
  }
  const port = typeof config.port === "number" && config.port > 0 ? config.port : NETCONF_PORT;
  // EVERY failure below leaves as the house class its SCOPE calls for, and naming the address is
  // part of it. MEASURED without this, through the real route: an address with nobody on it
  // answered HTTP 500 `INTERNAL_ERROR` logged "Unhandled error", and a port that listens and says
  // nothing answered the same 500 after 15,005 ms NAMING NO ADDRESS. The sentences were right and
  // the dress was not. The table is in `failures.ts`.
  try {
    return await compose(config, ports, override, { host, port });
  } catch (failure) {
    throw asHouseError(failure, { host, port });
  }
}

async function compose(
  config: DatabaseConnection,
  ports: OpenPorts,
  override: NetconfCredential | undefined,
  target: DialTarget,
): Promise<DeviceReaderImpl> {
  const { host } = target;
  const { username, hostKeyFingerprint, privateKey, passphrase, password } =
    override === undefined ? credentialOf(config) : checked(override);
  const limits = ports.limits ?? NETCONF_SESSION_LIMITS;
  const transport = await dialNetconf(
    {
      host,
      ...(typeof config.port === "number" && config.port > 0 ? { port: config.port } : {}),
      username,
      hostKeyFingerprint,
      ...(privateKey === undefined ? {} : { privateKey }),
      ...(passphrase === undefined ? {} : { passphrase }),
      ...(password === undefined ? {} : { password }),
      readyMs: limits.helloMs,
    },
    ports.ssh ?? nodeSshPort,
    ports.socket ?? nodeSocketPort,
  );
  // From here a session exists, so a failure has to close it rather than leave the device holding a
  // channel open until its own idle timer runs. The device's session table is a shared resource,
  // and a provider that leaks one entry per failed open is the provider that exhausts it.
  const { session, hello } = await NetconfSession.open(transport, limits);
  try {
    return await DeviceReaderImpl.open(session as SessionPort, ports.xml, hello);
  } catch (failure) {
    await session.close().catch(() => {});
    throw failure;
  }
}
