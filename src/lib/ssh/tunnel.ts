/**
 * SSH Tunnel Manager
 * Creates SSH tunnels for database connections behind firewalls/bastion hosts.
 * Uses ssh2 library for tunnel creation.
 */

import { Client, type ClientChannel } from "ssh2";
import net from "net";
import crypto from "crypto";
import { tunnelRoute } from "@/lib/db/connection-fingerprint";
import type { SSHTunnelConfig, TunnelFarEnd } from "@/lib/types";
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

/**
 * One forward, as the pool's lookups ask for it: the route it goes through and the address it
 * reaches. Both, because both are in the key - a forward is only the same forward when the bytes
 * enter by the same bastion and leave at the same far end.
 *
 * `farEnd` is {@link TunnelFarEnd} rather than a second `{ host, port }` of this module's own: it
 * is the same value the factory puts under `TUNNEL_FAR_END`, and one name for it keeps the pool
 * lookup and the seal talking about one thing.
 */
export interface TunnelForward {
  ssh: SSHTunnelConfig;
  farEnd: TunnelFarEnd;
}

/**
 * Who holds one pooled forward, for the one question a failed connect asks: may it close the forward?
 *
 * Concurrent connects of one forward are handed the one forward, so the answer is not the caller's
 * own: a sibling may still be connecting through it, or a provider may already serve through it.
 * `connecting` counts the callers handed the forward (the one that dialled it, those that joined the
 * dial, and those served it from the pool) whose provider has neither opened nor failed yet.
 * `providerOpened` records that a provider opened on it, which leaves the forward to the connection's
 * own teardown (`removeProvider`, the idle sweep), as every forward serving a provider is.
 */
interface ForwardClaims {
  connecting: number;
  providerOpened: boolean;
}

interface PooledTunnel {
  /** Kept beside the entry so the by-connection lookups can answer without parsing the key. */
  connectionId: string;
  info: TunnelInfo;
  claims: ForwardClaims;
}

/**
 * Active pooled tunnels, keyed by connection id AND the whole forward: the bastion route it is
 * opened through and the far end it reaches.
 *
 * WHY THE FORWARD IS IN THE KEY (D86). Keyed by the connection id alone, this map answered a
 * lookup for `db-b:5432` with the forward a previous caller had opened to `db-a:5432`, and
 * `TunnelInfo` carried nothing for the caller to notice with. That is a mis-route in the
 * TRANSPORT, so every statement on the stale tunnel landed on the old machine; it became
 * reachable from the ordinary UI once editing a tunnelled connection's host was possible,
 * because `/api/db/disconnect` is called on connection DELETE and nothing else closes a
 * pooled tunnel when the record's address changes.
 *
 * THE BASTION IS THE SAME DEFECT ONE FIELD ACROSS, and it is in the key for the same reason.
 * MEASURED 2026-09-15 against the live `p3fix-bastion`, with the far end keyed but the route
 * not: a record edited to name `bastion-elsewhere.invalid` as its bastion was handed the forward
 * already open through the real one, reached `libredb_dev` at `172.23.0.2`, and sealed a route
 * digest the edit-plan route recomputed to the same value - a plan accepted for a bastion the
 * statement never traversed, while the control (the same unreachable bastion on a fresh
 * connection id) failed with `ENOTFOUND`. `connectionFingerprint` frames the four addressing
 * fields "because the same `db:5432` reached through two different bastions is two different
 * databases"; a pool that shares one forward between them contradicts that in the transport.
 *
 * Keying on the forward rather than REFUSING a mismatch, deliberately: refusing would leave
 * the connection unusable until something closed the stale forward, and nothing on that path
 * does. Refusing only when a tunnel pre-existed would be worse still, since every second
 * provider on a live tunnel legitimately reuses it. A request for a forward nothing has opened
 * now opens the one it asked for, which is what the caller meant, and the superseded one is
 * closed by the same eviction that already owns it: `removeProvider` and the idle sweep close
 * BY CONNECTION ID, and `closeSSHTunnel` closes every forward under it.
 *
 * WHAT THAT COSTS, stated rather than left to be found: one connection id may hold as many live
 * forwards as it has been asked for distinct (route, far end) pairs, each an open SSH client and
 * a listening loopback socket, and nothing here bounds that count. MEASURED: 50 far ends across
 * two bastions under one id gave 50 live servers and 50 live clients. Nothing in this map reaps a
 * superseded forward either - the provider cache miss that opens the next one disconnects the
 * PROVIDER and leaves the forward pooled - so what takes them is the connection's own teardown,
 * `removeProvider` and the 30-minute idle sweep, both of which close BY CONNECTION ID and take
 * every forward with them, or the end of that forward's own SSH session. The count is therefore
 * what one id accumulates inside one idle window, and it is caller-driven:
 * `src/lib/seed/resolve-connection.ts` returns a posted inline connection verbatim, id included.
 * Refusing instead would cap it at one, and is exactly what the paragraph
 * above says the honest population cannot afford; bounding it is filed rather than guessed at.
 */
const activeTunnels = new Map<string, PooledTunnel>();

/**
 * The dial in progress for a pool key, under the same key as {@link activeTunnels}, so concurrent
 * calls for one tunnel share one SSH connection: a call that finds no pooled forward but a dial
 * under way is handed that dial, and every caller waiting on it receives the one forward it opens,
 * or the one error it fails with.
 *
 * An entry lives only while its dial is pending. A dial that succeeds has put its forward in
 * `activeTunnels` before it resolves, so the next call finds the forward there; a dial that fails
 * leaves nothing behind, so the next call dials again.
 */
const pendingDials = new Map<string, { dial: Promise<TunnelInfo>; claims: ForwardClaims }>();

/**
 * The claims of every pooled forward, by the `TunnelInfo` its callers were handed, which is what
 * {@link tunnelProviderOpened} and {@link releaseUnopenedTunnel} are given. A one-shot tunnel has none.
 */
const forwardClaims = new WeakMap<TunnelInfo, ForwardClaims>();

/**
 * Length-framed, every component by the same `${length}:${value}` rule and none of them bare, so
 * no two different (id, far end, route) tuples can slide across a boundary and answer one key -
 * `connectionFingerprint`'s own rule, for its own reason: a connection id is a string the caller
 * supplies, and so is a host.
 *
 * The route component is `tunnelRoute`'s output rather than a second reading of `SSHTunnelConfig`,
 * so the pool can only reuse a forward between two records the object-edit seal calls the same
 * server. That also decides what is NOT in the key: the tunnel's secrets and its pinned host key,
 * which `tunnelRoute` leaves out because they say who may reach the bastion and what this
 * connection trusts, not which machine it is - rotating a password must not strand the live
 * forward behind a second one.
 */
function poolKey(connectionId: string, sshConfig: SSHTunnelConfig, remoteHost: string, remotePort: number): string {
  return [connectionId, remoteHost, String(remotePort), tunnelRoute(sshConfig)]
    .map((value) => `${value.length}:${value}`)
    .join("");
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
   * connection. A tunnel whose SSH session ends, by an error or by the bastion ending it,
   * closes itself and leaves the pool, pooled or not.
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
  const key = poolKey(connectionId, sshConfig, remoteHost, remotePort);

  // Return the existing tunnel for THIS route and far end if one is already active.
  // A tunnel whose SSH session ssh2 has seen end is not here: that end runs its cleanup. A session that
  // drops without a FIN or an RST still is, and may be stale, since neither SSH nor TCP keepalive is configured.
  // A call made while the dial for this forward is still under way shares that dial.
  // Each such caller is counted as connecting through the forward until it reports its provider.
  if (shared) {
    const existing = activeTunnels.get(key);
    if (existing) {
      existing.claims.connecting += 1;
      return existing.info;
    }
    const pending = pendingDials.get(key);
    if (pending) {
      pending.claims.connecting += 1;
      return pending.dial;
    }
  }

  const claims: ForwardClaims = { connecting: 1, providerOpened: false };
  const dial = new Promise<TunnelInfo>((resolve, reject) => {
    const sshClient = new Client();
    let localServer: net.Server | null = null;
    // What the host key verifier decided, read back after ssh2 reports the handshake
    // failure. The library's own error ("Host denied (verification failed)") names neither
    // fingerprint, and the two fingerprints are the whole diagnostic value here.
    let hostKeyRejection: string | null = null;
    let acceptedFingerprint: string | undefined;
    // Whether this call has handed its tunnel out, which happens once the loopback listener is up.
    let handedOut = false;
    // Set by the first cleanup. The session's end reaches cleanup again after the owner closed the
    // tunnel, and by then a newer forward may hold this pool key, so only the first run may act.
    let closed = false;

    const cleanup = async () => {
      if (closed) return;
      closed = true;
      // Only a pooled tunnel owns its map entry, and only while the entry is still its own. A one-shot
      // tunnel may share the id of a pooled one serving live providers. A pooled forward is the only one
      // under its key while it lives, since a call for the key joins the dial under way instead of
      // dialling a second; the identity check keeps that invariant from being assumed here. Deleting
      // another forward's entry would orphan it: its SSH client and local server would stay open with
      // nothing left holding a handle.
      if (shared && activeTunnels.get(key)?.info.close === cleanup) {
        activeTunnels.delete(key);
      }
      if (localServer) {
        localServer.close();
        localServer = null;
      }
      sshClient.end();
    };

    // The SSH session is gone or can no longer open channels. Cleanup takes the forward out of the pool
    // and closes its loopback listener, so the provider that used it meets a refused connection on its
    // next dial, and the next request for the forward opens a new session. Once the tunnel was handed
    // out, the loss is logged once here, since the event that ended the session reaches no caller. Before
    // that, the same event is the dial's own failure, which the caller receives as the rejection.
    const sessionLost = (cause: string) => {
      if (handedOut && !closed) {
        logger.warn(`SSH tunnel for ${connectionId} to ${remoteHost}:${remotePort} closed: ${cause}`, {
          connectionId,
        });
      }
      cleanup();
    };

    // ssh2 (1.17.0) dials the bastion with Nagle left on, so under Node every small request
    // through the tunnel waited out the peer's delayed ACK: measured through POST /api/db/query
    // against PostgreSQL behind OpenSSH, SELECT 1 took a median 46 ms tunnelled and 3 ms direct.
    // Bun was unaffected. 'connect' is ssh2's own event for the socket being up.
    sshClient.on("connect", () => {
      sshClient.setNoDelay(true);
    });

    sshClient.on("ready", () => {
      // Create a local TCP server that forwards to the remote host through SSH
      localServer = net.createServer((socket) => {
        // Attached first: the socket can fail (a client reset) while the channel open is still pending,
        // and a socket with no 'error' listener raises the error instead of reporting it.
        let channel: ClientChannel | null = null;
        socket.on("error", () => {
          channel?.close();
        });
        // A channel the bastion refuses fails this connection only, with that error. One ssh2 cannot ask
        // for because its session is no longer writable ('Not connected', thrown synchronously) fails this
        // connection the same way and also ends the tunnel, since no later connection could open a channel.
        const failOpen = (err: Error) => {
          logger.warn(
            `SSH tunnel for ${connectionId} could not open a channel to ${remoteHost}:${remotePort}: ${err.message}`,
            { connectionId },
          );
          socket.destroy(err);
        };
        try {
          sshClient.forwardOut("127.0.0.1", 0, remoteHost, remotePort, (err, stream) => {
            if (err) {
              failOpen(err);
              return;
            }
            channel = stream;
            // Prevent unhandled stream errors from crashing the process
            stream.on("error", () => {
              socket.destroy();
            });
            // The loopback client went away while the open was pending. A reset destroys the socket without
            // an 'end', so a pipe would never end this channel, and the bastion would hold it open.
            if (socket.destroyed) {
              stream.close();
              return;
            }
            socket.pipe(stream).pipe(socket);
          });
        } catch (err) {
          failOpen(err as Error);
          sessionLost(`the SSH session can no longer open channels: ${(err as Error).message}`);
        }
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
        handedOut = true;
        if (shared) {
          forwardClaims.set(tunnelInfo, claims);
          activeTunnels.set(key, { connectionId, info: tunnelInfo, claims });
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
      sessionLost(`SSH connection error: ${err.message}`);
      reject(new Error(hostKeyRejection ?? `SSH connection error: ${err.message}`));
    });

    // A session that ends without an error: the bastion sent DISCONNECT by application, or closed its
    // side of the TCP connection with a FIN, as a restarting bastion does. ssh2 reports both as 'end'
    // and 'close' and not as 'error', so the tunnel listens for them as well. Before the tunnel is
    // ready, the same end is the dial's failure.
    const sessionEnded = () => {
      sessionLost("the bastion ended the SSH session");
      reject(
        new Error(`SSH connection to ${pinAddress(sshConfig.host, sshConfig.port)} closed before the tunnel was ready`),
      );
    };
    sshClient.on("end", sessionEnded);
    sshClient.on("close", sessionEnded);

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

  if (shared) {
    pendingDials.set(key, { dial, claims });
    const settled = () => pendingDials.delete(key);
    dial.then(settled, settled);
  }
  return dial;
}

function claimsOf(tunnel: TunnelInfo): ForwardClaims {
  const claims = forwardClaims.get(tunnel);
  if (!claims) {
    throw new Error(
      `The SSH tunnel to ${tunnel.remoteHost}:${tunnel.remotePort} is not pooled, so no connect holds a claim on it`,
    );
  }
  return claims;
}

/**
 * Report that the provider a caller connected through a pooled tunnel opened. The caller no longer
 * counts as connecting, and the forward is left to the connection's own teardown (`removeProvider`,
 * the idle sweep), which closes it once nothing serves the connection.
 */
export function tunnelProviderOpened(tunnel: TunnelInfo): void {
  const claims = claimsOf(tunnel);
  claims.connecting -= 1;
  claims.providerOpened = true;
}

/**
 * Release a pooled tunnel whose caller's provider did not open: its constructor refused the record,
 * its connect failed, or the caller refused it before connecting.
 *
 * The forward closes only when this release leaves no other caller connecting through it and no
 * provider opened on it. A concurrent connect of the same forward is handed the same forward, so
 * closing it for one caller's failure would close the transport of a sibling that is connecting
 * through it, or already serving through it. A forward every caller failed on is closed by the last
 * of them, since nothing else would close it soon: no cache entry holds a provider on it.
 */
export async function releaseUnopenedTunnel(tunnel: TunnelInfo): Promise<void> {
  const claims = claimsOf(tunnel);
  claims.connecting -= 1;
  if (claims.connecting === 0 && !claims.providerOpened) {
    await tunnel.close();
  }
}

/**
 * Close every pooled tunnel for a connection ID.
 *
 * All of them, not one: a connection may hold a forward to an address, or through a bastion, its
 * record no longer names, and this is the teardown for the whole connection - `removeProvider`,
 * the idle sweep and `/api/db/disconnect` all call it when nothing is left serving the connection.
 * Iterated over a copy because `close` deletes the entry it owns.
 *
 * ONE FAILURE MUST NOT STRAND THE REST, which is why each close is isolated and the failures are
 * reported together at the end. Every caller swallows what this throws, so aborting on the first
 * error would leave the remaining SSH clients and loopback listeners open with nothing holding a
 * handle and nothing saying so - the FD leak this function exists to prevent, arriving by the
 * teardown path instead. `AggregateError` rather than a log line, because whether a failed
 * teardown matters is the caller's decision and the three callers already make it differently.
 */
export async function closeSSHTunnel(connectionId: string): Promise<void> {
  const failures: unknown[] = [];
  for (const pooled of [...activeTunnels.values()]) {
    if (pooled.connectionId !== connectionId) continue;
    try {
      await pooled.info.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to close ${failures.length} SSH tunnel(s) for ${connectionId}`);
  }
}

/**
 * Whether a tunnel is pooled for a connection: `forward` specifically when one is given, and
 * any forward otherwise.
 *
 * It answers for forwards that are open, and not for a dial still under way. It does not decide
 * whether a failed connect may close a forward: a call that joins a dial would read `false` for a
 * forward a sibling is about to use, so that decision is {@link releaseUnopenedTunnel}'s.
 */
export function hasTunnel(connectionId: string, forward?: TunnelForward): boolean {
  return getTunnelInfo(connectionId, forward) !== undefined;
}

/**
 * The pooled tunnel for a connection: the one carrying `forward` when one is given, and
 * otherwise the first pooled for the id, which is all a caller asking the loose question can
 * be told once a connection may hold more than one.
 */
export function getTunnelInfo(connectionId: string, forward?: TunnelForward): TunnelInfo | undefined {
  if (forward) {
    return activeTunnels.get(poolKey(connectionId, forward.ssh, forward.farEnd.host, forward.farEnd.port))?.info;
  }
  for (const pooled of activeTunnels.values()) {
    if (pooled.connectionId === connectionId) return pooled.info;
  }
  return undefined;
}
