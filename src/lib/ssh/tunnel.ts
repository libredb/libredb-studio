/**
 * SSH Tunnel Manager
 * Creates SSH tunnels for database connections behind firewalls/bastion hosts.
 * Uses ssh2 library for tunnel creation.
 */

import { Client } from 'ssh2';
import net from 'net';
import type { SSHTunnelConfig } from '@/lib/types';

export interface TunnelInfo {
  localHost: string;
  localPort: number;
  close: () => Promise<void>;
}

// Cache active tunnels by connection ID
const activeTunnels = new Map<string, TunnelInfo>();

/**
 * Create an SSH tunnel for a database connection.
 * Returns the local host/port to connect the database client to.
 */
export async function createSSHTunnel(
  connectionId: string,
  sshConfig: SSHTunnelConfig,
  remoteHost: string,
  remotePort: number
): Promise<TunnelInfo> {
  // Return existing tunnel if already active
  const existing = activeTunnels.get(connectionId);
  if (existing) {
    return existing;
  }

  return new Promise((resolve, reject) => {
    const sshClient = new Client();
    let localServer: net.Server | null = null;

    const cleanup = async () => {
      activeTunnels.delete(connectionId);
      if (localServer) {
        localServer.close();
        localServer = null;
      }
      sshClient.end();
    };

    sshClient.on('ready', () => {
      // Create a local TCP server that forwards to the remote host through SSH
      localServer = net.createServer((socket) => {
        sshClient.forwardOut(
          '127.0.0.1',
          0,
          remoteHost,
          remotePort,
          (err, stream) => {
            if (err) {
              socket.end();
              return;
            }
            socket.pipe(stream).pipe(socket);
          }
        );
      });

      // Listen on a random available port
      localServer.listen(0, '127.0.0.1', () => {
        const address = localServer!.address() as net.AddressInfo;
        const tunnelInfo: TunnelInfo = {
          localHost: '127.0.0.1',
          localPort: address.port,
          close: cleanup,
        };
        activeTunnels.set(connectionId, tunnelInfo);
        console.log(`[SSH] Tunnel created for ${connectionId}: 127.0.0.1:${address.port} -> ${remoteHost}:${remotePort}`);
        resolve(tunnelInfo);
      });

      localServer.on('error', (err) => {
        cleanup();
        reject(new Error(`SSH tunnel local server error: ${err.message}`));
      });
    });

    sshClient.on('error', (err) => {
      cleanup();
      reject(new Error(`SSH connection error: ${err.message}`));
    });

    // Build SSH connection options
    const connectOptions: Parameters<Client['connect']>[0] = {
      host: sshConfig.host,
      port: sshConfig.port || 22,
      username: sshConfig.username,
    };

    if (sshConfig.authMethod === 'password') {
      connectOptions.password = sshConfig.password;
    } else if (sshConfig.authMethod === 'privateKey') {
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
