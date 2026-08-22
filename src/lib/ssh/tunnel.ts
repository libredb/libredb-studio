/**
 * SSH Tunnel Manager
 * Creates SSH tunnels for database connections behind firewalls/bastion hosts.
 * Uses ssh2 library for tunnel creation.
 */

import { Client } from "ssh2";
import net from "net";
import type { SSHTunnelConfig } from "@/lib/types";
import { logger } from "@/lib/logger";

export interface TunnelInfo {
  localHost: string;
  localPort: number;
  close: () => Promise<void>;
}

// Cache active tunnels by connection ID
const activeTunnels = new Map<string, TunnelInfo>();

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
      reject(new Error(`SSH connection error: ${err.message}`));
    });

    // Build SSH connection options
    const connectOptions: Parameters<Client["connect"]>[0] = {
      host: sshConfig.host,
      port: sshConfig.port || 22,
      username: sshConfig.username,
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
