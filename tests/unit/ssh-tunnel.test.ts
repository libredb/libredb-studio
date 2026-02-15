import '../setup';
import { mock, describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'events';

// --- Mock ssh2 Client ---
class MockSSHClient extends EventEmitter {
  connectOptions: Record<string, unknown> | null = null;
  forwardOutCalls: Array<{ bindAddr: string; bindPort: number; host: string; port: number }> = [];
  ended = false;

  connect(opts: Record<string, unknown>) {
    this.connectOptions = opts;
    // Emit 'ready' asynchronously by default
    setTimeout(() => this.emit('ready'), 0);
  }

  forwardOut(
    bindAddr: string,
    bindPort: number,
    host: string,
    port: number,
    cb: (err: Error | null, stream: unknown) => void
  ) {
    this.forwardOutCalls.push({ bindAddr, bindPort, host, port });
    // Return a mock duplex stream
    const mockStream = new MockDuplexStream();
    cb(null, mockStream);
  }

  end() {
    this.ended = true;
  }
}

class MockDuplexStream extends EventEmitter {
  pipe() { return this; }
}

let mockSSHInstance: MockSSHClient;

mock.module('ssh2', () => ({
  Client: class {
    constructor() {
      mockSSHInstance = new MockSSHClient();
      return mockSSHInstance;
    }
  },
}));

// --- Mock net module ---
class MockServer extends EventEmitter {
  listenPort: number | null = null;
  listenHost: string | null = null;
  connectionHandler: ((socket: unknown) => void) | null = null;
  closed = false;

  constructor(handler: (socket: unknown) => void) {
    super();
    this.connectionHandler = handler;
  }

  listen(port: number, host: string, cb: () => void) {
    this.listenPort = port;
    this.listenHost = host;
    setTimeout(cb, 0);
  }

  address() {
    return { address: '127.0.0.1', family: 'IPv4', port: 54321 };
  }

  close() {
    this.closed = true;
  }
}

let mockServerInstance: MockServer;

mock.module('net', () => ({
  default: {
    createServer: (handler: (socket: unknown) => void) => {
      mockServerInstance = new MockServer(handler);
      return mockServerInstance;
    },
  },
  createServer: (handler: (socket: unknown) => void) => {
    mockServerInstance = new MockServer(handler);
    return mockServerInstance;
  },
}));

// Dynamic import after mocks
const { createSSHTunnel, closeSSHTunnel, hasTunnel, getTunnelInfo } = await import('@/lib/ssh/tunnel');

// We need to clear the activeTunnels map between tests.
// Since it's a module-level Map, we close tunnels in afterEach.
let lastConnectionId: string | null = null;

describe('SSH Tunnel', () => {
  beforeEach(() => {
    lastConnectionId = null;
  });

  afterEach(async () => {
    // Clean up any active tunnel
    if (lastConnectionId && hasTunnel(lastConnectionId)) {
      await closeSSHTunnel(lastConnectionId);
    }
  });

  describe('createSSHTunnel', () => {
    test('creates tunnel with password auth', async () => {
      const connId = 'test-pw-' + Date.now();
      lastConnectionId = connId;

      const tunnel = await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: 'bastion.example.com',
          port: 22,
          username: 'admin',
          authMethod: 'password',
          password: 'secret123',
        },
        'db.internal',
        5432
      );

      expect(tunnel.localHost).toBe('127.0.0.1');
      expect(tunnel.localPort).toBe(54321);
      expect(typeof tunnel.close).toBe('function');

      // Verify SSH connect options
      expect(mockSSHInstance.connectOptions).toEqual({
        host: 'bastion.example.com',
        port: 22,
        username: 'admin',
        password: 'secret123',
      });
    });

    test('creates tunnel with privateKey auth', async () => {
      const connId = 'test-pk-' + Date.now();
      lastConnectionId = connId;

      const tunnel = await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: 'bastion.example.com',
          port: 2222,
          username: 'deploy',
          authMethod: 'privateKey',
          privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
          passphrase: 'keypass',
        },
        'db.internal',
        3306
      );

      expect(tunnel.localHost).toBe('127.0.0.1');
      expect(tunnel.localPort).toBe(54321);
      expect(mockSSHInstance.connectOptions).toEqual({
        host: 'bastion.example.com',
        port: 2222,
        username: 'deploy',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
        passphrase: 'keypass',
      });
    });

    test('creates tunnel with privateKey without passphrase', async () => {
      const connId = 'test-pk-nopw-' + Date.now();
      lastConnectionId = connId;

      await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: 'bastion.example.com',
          port: 22,
          username: 'deploy',
          authMethod: 'privateKey',
          privateKey: 'fake-key',
        },
        'db.internal',
        5432
      );

      expect(mockSSHInstance.connectOptions).toEqual({
        host: 'bastion.example.com',
        port: 22,
        username: 'deploy',
        privateKey: 'fake-key',
      });
      // No passphrase key present
      expect('passphrase' in (mockSSHInstance.connectOptions || {})).toBe(false);
    });

    test('uses default port 22 when not specified', async () => {
      const connId = 'test-defport-' + Date.now();
      lastConnectionId = connId;

      await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: 'bastion.example.com',
          port: 0, // falsy → should default to 22
          username: 'admin',
          authMethod: 'password',
          password: 'pass',
        },
        'db.internal',
        5432
      );

      expect((mockSSHInstance.connectOptions as Record<string, unknown>)?.port).toBe(22);
    });

    test('returns existing tunnel if already active', async () => {
      const connId = 'test-cache-' + Date.now();
      lastConnectionId = connId;

      const tunnel1 = await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: 'bastion.example.com',
          port: 22,
          username: 'admin',
          authMethod: 'password',
          password: 'pass',
        },
        'db.internal',
        5432
      );

      const tunnel2 = await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: 'other-bastion.example.com',
          port: 22,
          username: 'other',
          authMethod: 'password',
          password: 'other',
        },
        'other-db.internal',
        3306
      );

      // Should return the same cached tunnel
      expect(tunnel2).toBe(tunnel1);
      expect(tunnel2.localPort).toBe(tunnel1.localPort);
    });

    test('rejects on SSH connection error', async () => {
      const connId = 'test-ssherr-' + Date.now();
      lastConnectionId = connId;

      const promise = createSSHTunnel(
        connId,
        {
          enabled: true,
          host: 'bad-host.example.com',
          port: 22,
          username: 'admin',
          authMethod: 'password',
          password: 'pass',
        },
        'db.internal',
        5432
      );

      // Emit error on the SSH client after connect is called
      // The mock emits 'ready' via setTimeout, so we emit 'error' immediately
      mockSSHInstance.removeAllListeners('ready');
      setTimeout(() => mockSSHInstance.emit('error', new Error('Connection refused')), 5);

      await expect(promise).rejects.toThrow('SSH connection error: Connection refused');
      // Tunnel should be cleaned up
      expect(hasTunnel(connId)).toBe(false);
    });

    test('rejects on local server error', async () => {
      const connId = 'test-serverr-' + Date.now();
      lastConnectionId = connId;

      // Intercept createServer to make the server emit error before listen callback fires
      const originalListen = MockServer.prototype.listen;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      MockServer.prototype.listen = function (this: MockServer, _port: number, _host: string, _cb: () => void) {
        // Don't call the callback — instead emit error
        setTimeout(() => this.emit('error', new Error('EADDRINUSE')), 0);
      };

      const promise = createSSHTunnel(
        connId,
        {
          enabled: true,
          host: 'bastion.example.com',
          port: 22,
          username: 'admin',
          authMethod: 'password',
          password: 'pass',
        },
        'db.internal',
        5432
      );

      await expect(promise).rejects.toThrow('SSH tunnel local server error: EADDRINUSE');
      expect(hasTunnel(connId)).toBe(false);

      // Restore
      MockServer.prototype.listen = originalListen;
    });

    test('local server listen binds to 127.0.0.1 on random port', async () => {
      const connId = 'test-listen-' + Date.now();
      lastConnectionId = connId;

      await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: 'bastion.example.com',
          port: 22,
          username: 'admin',
          authMethod: 'password',
          password: 'pass',
        },
        'db.internal',
        5432
      );

      expect(mockServerInstance.listenPort).toBe(0); // 0 = random available port
      expect(mockServerInstance.listenHost).toBe('127.0.0.1');
    });

    test('forwards socket connections through SSH', async () => {
      const connId = 'test-fwd-' + Date.now();
      lastConnectionId = connId;

      await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: 'bastion.example.com',
          port: 22,
          username: 'admin',
          authMethod: 'password',
          password: 'pass',
        },
        'db.internal',
        5432
      );

      // Simulate incoming connection to local server
      const mockSocket = new MockDuplexStream();
      (mockSocket as unknown as { end: () => void }).end = () => {};
      mockServerInstance.connectionHandler!(mockSocket);

      expect(mockSSHInstance.forwardOutCalls.length).toBe(1);
      expect(mockSSHInstance.forwardOutCalls[0]).toEqual({
        bindAddr: '127.0.0.1',
        bindPort: 0,
        host: 'db.internal',
        port: 5432,
      });
    });
  });

  describe('closeSSHTunnel', () => {
    test('closes an active tunnel', async () => {
      const connId = 'test-close-' + Date.now();

      await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: 'bastion.example.com',
          port: 22,
          username: 'admin',
          authMethod: 'password',
          password: 'pass',
        },
        'db.internal',
        5432
      );

      expect(hasTunnel(connId)).toBe(true);

      await closeSSHTunnel(connId);

      expect(hasTunnel(connId)).toBe(false);
      expect(mockSSHInstance.ended).toBe(true);
      expect(mockServerInstance.closed).toBe(true);
    });

    test('does nothing for non-existent tunnel', async () => {
      // Should not throw
      await closeSSHTunnel('non-existent-id');
    });
  });

  describe('hasTunnel', () => {
    test('returns false for unknown connection', () => {
      expect(hasTunnel('unknown-id')).toBe(false);
    });

    test('returns true for active tunnel', async () => {
      const connId = 'test-has-' + Date.now();
      lastConnectionId = connId;

      await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: 'bastion.example.com',
          port: 22,
          username: 'admin',
          authMethod: 'password',
          password: 'pass',
        },
        'db.internal',
        5432
      );

      expect(hasTunnel(connId)).toBe(true);
    });
  });

  describe('getTunnelInfo', () => {
    test('returns undefined for unknown connection', () => {
      expect(getTunnelInfo('unknown-id')).toBeUndefined();
    });

    test('returns tunnel info for active tunnel', async () => {
      const connId = 'test-info-' + Date.now();
      lastConnectionId = connId;

      await createSSHTunnel(
        connId,
        {
          enabled: true,
          host: 'bastion.example.com',
          port: 22,
          username: 'admin',
          authMethod: 'password',
          password: 'pass',
        },
        'db.internal',
        5432
      );

      const info = getTunnelInfo(connId);
      expect(info).toBeDefined();
      expect(info!.localHost).toBe('127.0.0.1');
      expect(info!.localPort).toBe(54321);
      expect(typeof info!.close).toBe('function');
    });
  });
});
