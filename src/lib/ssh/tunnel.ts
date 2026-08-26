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
  close: () => Promise<void>;
  /**
   * The bastion host key this tunnel accepted, in OpenSSH's `SHA256:...` presentation.
   * The only place the product can show a fingerprint the user is able to compare.
   */
  hostKeyFingerprint?: string;
}

// Cache active tunnels by connection ID
const activeTunnels = new Map<string, TunnelInfo>();

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

  // Return existing tunnel if already active
  // Note: cached tunnel may be stale if the SSH connection dropped silently.
  // Callers should handle connection errors and call closeSSHTunnel() to evict stale entries.
  if (shared) {
    const existing = activeTunnels.get(connectionId);
    if (existing) {
      return existing;
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
        activeTunnels.delete(connectionId);
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
          close: cleanup,
          hostKeyFingerprint: acceptedFingerprint,
        };
        if (shared) {
          activeTunnels.set(connectionId, tunnelInfo);
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
 * Close an SSH tunnel by connection ID
 */
export async function closeSSHTunnel(connectionId: string): Promise<void> {
  const tunnel = activeTunnels.get(connectionId);
  if (tunnel) {
    await tunnel.close();
  }
}

/**
 * Check if a tunnel exists for a connection
 */
export function hasTunnel(connectionId: string): boolean {
  return activeTunnels.has(connectionId);
}

/**
 * Get tunnel info for a connection
 */
export function getTunnelInfo(connectionId: string): TunnelInfo | undefined {
  return activeTunnels.get(connectionId);
}
