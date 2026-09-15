/**
 * SSH Tunnel Manager
 * Creates SSH tunnels for database connections behind firewalls/bastion hosts.
 * Uses ssh2 library for tunnel creation.
 */

import { Client } from "ssh2";
import net from "net";
import crypto from "crypto";
import type { SSHTunnelConfig } from "@/lib/types";
import { logger } from "@/lib/logger";

export interface TunnelInfo {
  localHost: string;
  localPort: number;
  /**
   * The far end this forward was actually opened for: the address `forwardOut` dials for
   * every socket accepted on the local endpoint, and therefore the machine the bytes reach.
   *
   * It is on the returned value, and not left to the caller's own memory of what it asked
   * for, because a pooled tunnel is not always the one this call opened. The factory reads
   * these two to build the object-edit seal, so what a plan is bound to is the address the
   * transport reaches rather than the address a record claims (D86).
   */
  remoteHost: string;
  remotePort: number;
  close: () => Promise<void>;
  /**
   * The bastion host key this tunnel accepted, in OpenSSH's `SHA256:...` presentation.
   * The only place the product can show a fingerprint the user is able to compare.
   */
  hostKeyFingerprint?: string;
}

/** The far end a caller wants forwarded, as the pool's lookups ask for it. */
export interface TunnelRemoteEndpoint {
  host: string;
  port: number;
}

interface PooledTunnel {
  /** Kept beside the entry so the by-connection lookups can answer without parsing the key. */
  connectionId: string;
  info: TunnelInfo;
}

/**
 * Active pooled tunnels, keyed by connection id AND the far end the forward was opened for.
 *
 * WHY THE FAR END IS IN THE KEY (D86). Keyed by the connection id alone, this map answered a
 * lookup for `db-b:5432` with the forward a previous caller had opened to `db-a:5432`, and
 * `TunnelInfo` carried nothing for the caller to notice with. That is a mis-route in the
 * TRANSPORT, so every statement on the stale tunnel landed on the old machine; it became
 * reachable from the ordinary UI once editing a tunnelled connection's host was possible,
 * because `/api/db/disconnect` is called on connection DELETE and nothing else closes a
 * pooled tunnel when the record's address changes.
 *
 * Keying on the far end rather than REFUSING a mismatch, deliberately: refusing would leave
 * the connection unusable until something closed the stale forward, and nothing on that path
 * does. Refusing only when a tunnel pre-existed would be worse still, since every second
 * provider on a live tunnel legitimately reuses it. A request for an address nothing is
 * forwarding to now opens the forward it asked for, which is what the caller meant, and the
 * superseded one is closed by the same eviction that already owns it: `removeProvider` and
 * the idle sweep close BY CONNECTION ID, and `closeSSHTunnel` closes every far end under it.
 */
const activeTunnels = new Map<string, PooledTunnel>();

/**
 * Length-framed so two different (id, far end) triples cannot collide on one key - the same
 * rule `connectionFingerprint` frames its fields with, for the same reason: a connection id
 * is a string the caller supplies.
 */
function poolKey(connectionId: string, remoteHost: string, remotePort: number): string {
  return `${connectionId.length}:${connectionId}${remoteHost.length}:${remoteHost}:${remotePort}`;
}

/**
 * Trust-on-first-use host key memory, keyed by BASTION ADDRESS (`host:port`).
 *
 * Why TOFU and not "refuse until a fingerprint is configured": requiring a pasted
 * fingerprint up front makes the feature unusable for the self-hoster reaching their own
 * bastion, TOFU is what every SSH client does on first contact, and it is strictly better
 * than verifying nothing - which is what ssh2 does when `hostVerifier` is absent (it has
 * no default; `lib/protocol/kex.js` logs "Host accepted by default (no verification)").
 *
 * Why keyed by address rather than by connection id: a connection's OWN pin is
 * `SSHTunnelConfig.hostKeyFingerprint` and is authoritative when set - that is the
 * per-connection pin. This map is the first-contact memory, and it is the bastion, not the
 * connection, whose identity is being remembered - exactly what `known_hosts` keys on. It
 * also has to cover the one-shot callers (test-connection, schema-snapshot), which mint a
 * fresh connection id per build: keyed by id, their every attempt would be a first contact
 * and would verify nothing.
 *
 * Scope is this server process. A restart re-enters first contact, which is why a durable
 * pin belongs on the connection.
 */
const hostKeyPins = new Map<string, string>();

/** `host:port`, with ssh2's own default port applied so one bastion is not two entries. */
function pinAddress(host: string, port: number | undefined): string {
  return `${host}:${port || 22}`;
}

/**
 * OpenSSH's fingerprint presentation: SHA256 over the raw public key blob (K_S - the same
 * bytes base64'd into a `.pub` line, which is what ssh2 hands `hostVerifier` when no
 * `hostHash` is configured), base64, `=` padding stripped.
 *
 * Measured rather than assumed: for generated ed25519 and RSA keys this reproduces
 * `ssh-keygen -lf <key>.pub` byte for byte, so what an error prints can be compared
 * against `ssh-keyscan <bastion> | ssh-keygen -lf -` or an existing `known_hosts` entry.
 */
function fingerprintOf(hostKey: Buffer): string {
  const digest = crypto.createHash("sha256").update(hostKey).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

/**
 * Forget the remembered host key for a bastion, so the next contact is a first contact.
 *
 * The remedy for a key that legitimately changed (a rebuilt bastion). Deliberately NOT an
 * "accept the new key?" prompt: whether to offer that, and where, is a separate decision.
 */
export function clearSSHHostKeyPin(host: string, port?: number): void {
  hostKeyPins.delete(pinAddress(host, port));
}

export interface CreateSSHTunnelOptions {
  /**
   * Whether the tunnel joins the by-connection-id pool every other provider for that
   * connection reuses. Default true, which is the pooled lifecycle: the tunnel outlives
   * the call, and `removeProvider` / the idle sweep close it once nothing serves the
   * connection.
   *
   * `false` requests a one-shot tunnel for a caller that owns the whole lifecycle and
   * closes it itself - the routes that build a provider outside both provider caches
   * (test-connection, schema-snapshot). Pooling those would leak: the connection dialog
   * mints a fresh id per build for an unsaved connection, so nothing would ever hold the
   * id needed to close the tunnel again, and neither cache would know to evict it.
   */
  shared?: boolean;
}

/**
 * Create an SSH tunnel for a database connection.
 * Returns the local host/port to connect the database client to.
 */
export async function createSSHTunnel(
  connectionId: string,
  sshConfig: SSHTunnelConfig,
  remoteHost: string,
  remotePort: number,
  options: CreateSSHTunnelOptions = {},
): Promise<TunnelInfo> {
  const shared = options.shared !== false;
  const key = poolKey(connectionId, remoteHost, remotePort);

  // Return the existing tunnel to THIS far end if one is already active.
  // Note: cached tunnel may be stale if the SSH connection dropped silently.
  // Callers should handle connection errors and call closeSSHTunnel() to evict stale entries.
  if (shared) {
    const existing = activeTunnels.get(key);
    if (existing) {
      return existing.info;
    }
  }

  return new Promise((resolve, reject) => {
    const sshClient = new Client();
    let localServer: net.Server | null = null;
    // What the host key verifier decided, read back after ssh2 reports the handshake
    // failure. The library's own error ("Host denied (verification failed)") names neither
    // fingerprint, and the two fingerprints are the whole diagnostic value here.
    let hostKeyRejection: string | null = null;
    let acceptedFingerprint: string | undefined;

    const cleanup = async () => {
      // Only a pooled tunnel owns its map entry. A one-shot tunnel may share the id of a
      // pooled one serving live providers, and deleting that entry would orphan it: the
      // SSH client and local server would stay open with nothing left holding a handle.
      if (shared) {
        activeTunnels.delete(key);
      }
      if (localServer) {
        localServer.close();
        localServer = null;
      }
      sshClient.end();
    };

    sshClient.on("ready", () => {
      // Create a local TCP server that forwards to the remote host through SSH
      localServer = net.createServer((socket) => {
        sshClient.forwardOut("127.0.0.1", 0, remoteHost, remotePort, (err, stream) => {
          if (err) {
            socket.end();
            return;
          }
          // Prevent unhandled stream errors from crashing the process
          stream.on("error", () => {
            socket.destroy();
          });
          socket.on("error", () => {
            stream.close();
          });
          socket.pipe(stream).pipe(socket);
        });
      });

      // Attach error handler before listen to catch bind/listen errors
      localServer.on("error", (err) => {
        cleanup();
        reject(new Error(`SSH tunnel local server error: ${err.message}`));
      });

      // Listen on a random available port
      localServer.listen(0, "127.0.0.1", () => {
        const address = localServer!.address() as net.AddressInfo;
        const tunnelInfo: TunnelInfo = {
          localHost: "127.0.0.1",
          localPort: address.port,
          remoteHost,
          remotePort,
          close: cleanup,
          hostKeyFingerprint: acceptedFingerprint,
        };
        if (shared) {
          activeTunnels.set(key, { connectionId, info: tunnelInfo });
        }
        logger.info(`Tunnel created for ${connectionId}: 127.0.0.1:${address.port} -> ${remoteHost}:${remotePort}`, {
          connectionId,
        });
        resolve(tunnelInfo);
      });
    });

    sshClient.on("error", (err) => {
      // Ensure SSH file descriptors are released before rejecting
      sshClient.end();
      cleanup();
      reject(new Error(hostKeyRejection ?? `SSH connection error: ${err.message}`));
    });

    // Build SSH connection options
    const connectOptions: Parameters<Client["connect"]>[0] = {
      host: sshConfig.host,
      port: sshConfig.port || 22,
      username: sshConfig.username,
      hostVerifier: (hostKey: Buffer) => {
        const offered = fingerprintOf(hostKey);
        const address = pinAddress(sshConfig.host, sshConfig.port);
        // The connection's own pin wins over the first-contact memory: it is the durable
        // one, and it is the one a user can inspect and correct.
        const expected = sshConfig.hostKeyFingerprint || hostKeyPins.get(address);
        if (expected && expected !== offered) {
          hostKeyRejection =
            `SSH host key verification failed for ${address}: offered ${offered}, expected ${expected}. ` +
            `Confirm the bastion's key with \`ssh-keyscan ${sshConfig.host} | ssh-keygen -lf -\`; ` +
            `if it changed legitimately, clear the pinned fingerprint for this connection.`;
          return false;
        }
        acceptedFingerprint = offered;
        if (!expected) {
          // Trust on first use, and pin what was trusted.
          hostKeyPins.set(address, offered);
        }
        return true;
      },
    };

    if (sshConfig.authMethod === "password") {
      connectOptions.password = sshConfig.password;
    } else if (sshConfig.authMethod === "privateKey") {
      connectOptions.privateKey = sshConfig.privateKey;
      if (sshConfig.passphrase) {
        connectOptions.passphrase = sshConfig.passphrase;
      }
    }

    sshClient.connect(connectOptions);
  });
}

/**
 * Close every pooled tunnel for a connection ID.
 *
 * All of them, not one: a connection may hold a forward to an address its record no longer
 * names, and this is the teardown for the whole connection - `removeProvider`, the idle
 * sweep and `/api/db/disconnect` all call it when nothing is left serving the connection.
 * Iterated over a copy because `close` deletes the entry it owns.
 */
export async function closeSSHTunnel(connectionId: string): Promise<void> {
  for (const pooled of [...activeTunnels.values()]) {
    if (pooled.connectionId === connectionId) {
      await pooled.info.close();
    }
  }
}

/**
 * Whether a tunnel is pooled for a connection: to `farEnd` specifically when one is given,
 * and to any far end otherwise.
 *
 * The factory asks the specific question, because the answer decides whether a failed
 * connect may tear the tunnel down: only a forward this call opened may be closed, and with
 * the far end in the pool key that is exactly "nothing was pooled for this far end before".
 */
export function hasTunnel(connectionId: string, farEnd?: TunnelRemoteEndpoint): boolean {
  return getTunnelInfo(connectionId, farEnd) !== undefined;
}

/**
 * The pooled tunnel for a connection: the one forwarding to `farEnd` when one is given, and
 * otherwise the first pooled for the id, which is all a caller asking the loose question can
 * be told once a connection may hold more than one.
 */
export function getTunnelInfo(connectionId: string, farEnd?: TunnelRemoteEndpoint): TunnelInfo | undefined {
  if (farEnd) {
    return activeTunnels.get(poolKey(connectionId, farEnd.host, farEnd.port))?.info;
  }
  for (const pooled of activeTunnels.values()) {
    if (pooled.connectionId === connectionId) return pooled.info;
  }
  return undefined;
}
