/**
 * Redis Provider Integration Tests
 *
 * Uses mock.module() from bun:test to mock the 'ioredis' driver
 * before importing the RedisProvider class.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { DatabaseConnection } from '@/lib/types';

// ============================================================================
// Mock Setup — MUST come before provider import
// ============================================================================

const MOCK_INFO_STRING = [
  '# Server',
  'redis_version:7.2.4',
  'uptime_in_seconds:86400',
  'maxclients:10000',
  '',
  '# Clients',
  'connected_clients:12',
  '',
  '# Memory',
  'used_memory:2048000',
  'used_memory_human:1.95MB',
  'maxmemory:0',
  '',
  '# Stats',
  'instantaneous_ops_per_sec:42',
  'keyspace_hits:900',
  'keyspace_misses:100',
  '',
].join('\n');

const MOCK_CLIENT_LIST = 'id=1 addr=127.0.0.1:6379 name=app1 db=0 flags=N cmd=get idle=5\nid=2 addr=127.0.0.1:6380 name=app2 db=0 flags=N cmd=set idle=10';

const mockCallResults: Record<string, unknown> = {
  GET: 'hello-world',
  SET: 'OK',
  KEYS: ['user:1', 'user:2', 'session:abc'],
  HGETALL: ['field1', 'value1', 'field2', 'value2'],
  INFO: MOCK_INFO_STRING,
  DEL: 1,
  PING: 'PONG',
  DBSIZE: 42,
};

mock.module('ioredis', () => {
  class MockRedis {
    private _config: unknown;

    constructor(config?: unknown) {
      this._config = config;
    }

    async connect() {
      // noop — connection established
    }

    disconnect() {
      // noop — connection closed
    }

    async info() {
      return MOCK_INFO_STRING;
    }

    async dbsize() {
      return 42;
    }

    async scan(): Promise<[string, string[]]> {
      return ['0', ['user:1', 'user:2', 'session:abc']];
    }

    async type() {
      return 'string';
    }

    async client(subcommand: string) {
      if (subcommand === 'LIST') return MOCK_CLIENT_LIST;
      return 'OK';
    }

    async call(command: string) {
      const cmd = command.toUpperCase();
      if (cmd in mockCallResults) {
        return mockCallResults[cmd];
      }
      return null;
    }
  }

  return { default: MockRedis };
});

// ============================================================================
// Provider import — AFTER mock registration
// ============================================================================

const { RedisProvider } = await import('@/lib/db/providers/keyvalue/redis');
const { DatabaseConfigError } = await import('@/lib/db/errors');

// ============================================================================
// Test Config
// ============================================================================

const baseConfig: DatabaseConnection = {
  id: 'test-redis',
  name: 'Test Redis',
  type: 'redis',
  host: 'localhost',
  port: 6379,
  createdAt: new Date(),
};

// ============================================================================
// Tests
// ============================================================================

describe('RedisProvider', () => {
  let provider: InstanceType<typeof RedisProvider>;

  beforeEach(() => {
    provider = new RedisProvider({ ...baseConfig });
  });

  afterEach(async () => {
    try {
      await provider.disconnect();
    } catch {
      // ignore
    }
  });

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  describe('validation', () => {
    test('throws DatabaseConfigError when host is missing', () => {
      expect(
        () =>
          new RedisProvider({
            ...baseConfig,
            host: undefined,
          })
      ).toThrow(DatabaseConfigError);
    });
  });

  // --------------------------------------------------------------------------
  // Connection lifecycle
  // --------------------------------------------------------------------------

  describe('connect / disconnect', () => {
    test('connect succeeds and marks provider as connected', async () => {
      await provider.connect();
      expect(provider.isConnected()).toBe(true);
    });

    test('disconnect succeeds and marks provider as disconnected', async () => {
      await provider.connect();
      await provider.disconnect();
      expect(provider.isConnected()).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // getCapabilities()
  // --------------------------------------------------------------------------

  describe('getCapabilities()', () => {
    test('returns correct capability metadata', () => {
      const caps = provider.getCapabilities();
      expect(caps.queryLanguage).toBe('json');
      expect(caps.defaultPort).toBe(6379);
      expect(caps.supportsConnectionString).toBe(false);
      expect(caps.supportsCreateTable).toBe(false);
      expect(caps.supportsMaintenance).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // getLabels()
  // --------------------------------------------------------------------------

  describe('getLabels()', () => {
    test('returns correct provider labels', () => {
      const labels = provider.getLabels();
      expect(labels.entityName).toBe('Key Pattern');
      expect(labels.rowName).toBe('key');
      expect(labels.selectAction).toBe('Scan Keys');
    });
  });

  // --------------------------------------------------------------------------
  // prepareQuery()
  // --------------------------------------------------------------------------

  describe('prepareQuery()', () => {
    test('returns query unchanged with wasLimited=false', () => {
      const input = '{"command":"GET","args":["mykey"]}';
      const prepared = provider.prepareQuery(input);
      expect(prepared.query).toBe(input);
      expect(prepared.wasLimited).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // query()
  // --------------------------------------------------------------------------

  describe('query()', () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test('JSON format command works', async () => {
      const result = await provider.query(
        JSON.stringify({ command: 'GET', args: ['mykey'] })
      );
      expect(result.rows).toBeArray();
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows[0].result).toBe('hello-world');
    });

    test('plain text command works', async () => {
      const result = await provider.query('GET mykey');
      expect(result.rows).toBeArray();
      expect(result.rows[0].result).toBe('hello-world');
    });

    test('empty command throws QueryError', async () => {
      await expect(provider.query('   ')).rejects.toThrow();
    });

    test('HGETALL returns field/value pairs', async () => {
      const result = await provider.query(
        JSON.stringify({ command: 'HGETALL', args: ['user:1'] })
      );
      expect(result.rows).toBeArray();
      expect(result.fields).toContain('field');
      expect(result.fields).toContain('value');
      expect(result.rows[0].field).toBe('field1');
      expect(result.rows[0].value).toBe('value1');
    });

    test('INFO returns section/key/value rows', async () => {
      const result = await provider.query(
        JSON.stringify({ command: 'INFO', args: [] })
      );
      expect(result.rows).toBeArray();
      expect(result.fields).toContain('section');
      expect(result.fields).toContain('key');
      expect(result.fields).toContain('value');
      // Should contain redis_version
      const versionRow = result.rows.find((r: Record<string, unknown>) => r.key === 'redis_version');
      expect(versionRow).toBeDefined();
      expect(versionRow!.value).toBe('7.2.4');
    });

    test('null result returns (nil)', async () => {
      await provider.query(
        JSON.stringify({ command: 'GET', args: ['nonexistent'] })
      );
      // The mock returns 'hello-world' for GET, so let's use PING which returns null
      // Actually, let's test with a command that returns null from our mock
      const result2 = await provider.query(
        JSON.stringify({ command: 'RANDOMKEY', args: [] })
      );
      // RANDOMKEY is not in mockCallResults, so call() returns null
      expect(result2.rows[0].result).toBe('(nil)');
    });
  });

  // --------------------------------------------------------------------------
  // getSchema()
  // --------------------------------------------------------------------------

  describe('getSchema()', () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test('returns key patterns as tables from SCAN', async () => {
      const schemas = await provider.getSchema();
      expect(schemas).toBeArray();
      expect(schemas.length).toBeGreaterThan(0);

      // user:1 and user:2 -> "user:*" pattern; session:abc -> "session:*"
      const userPattern = schemas.find((s) => s.name === 'user:*');
      expect(userPattern).toBeDefined();
      expect(userPattern!.rowCount).toBe(2);

      const sessionPattern = schemas.find((s) => s.name === 'session:*');
      expect(sessionPattern).toBeDefined();
      expect(sessionPattern!.rowCount).toBe(1);

      // Columns should include key, value, type
      expect(userPattern!.columns.length).toBe(3);
      expect(userPattern!.columns[0].name).toBe('key');
    });
  });

  // --------------------------------------------------------------------------
  // getHealth()
  // --------------------------------------------------------------------------

  describe('getHealth()', () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test('returns activeConnections, databaseSize, cacheHitRatio', async () => {
      const health = await provider.getHealth();
      expect(health.activeConnections).toBe(12);
      expect(health.databaseSize).toBe('1.95MB');
      // hitRatio: 900/(900+100)*100 = 90.0
      expect(health.cacheHitRatio).toBe('90.0');
    });
  });

  // --------------------------------------------------------------------------
  // runMaintenance()
  // --------------------------------------------------------------------------

  describe('runMaintenance()', () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test('analyze returns server info', async () => {
      const result = await provider.runMaintenance('analyze');
      expect(result.success).toBe(true);
      expect(result.message).toContain('Server info retrieved');
    });

    test('unsupported maintenance type throws', async () => {
      await expect(
        provider.runMaintenance('vacuum')
      ).rejects.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // getOverview()
  // --------------------------------------------------------------------------

  describe('getOverview()', () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test('returns version, uptime, connections, size', async () => {
      const overview = await provider.getOverview();
      expect(typeof overview.version).toBe('string');
      expect(overview.version).toContain('7.2.4');
      expect(typeof overview.uptime).toBe('string');
      expect(typeof overview.activeConnections).toBe('number');
      expect(overview.activeConnections).toBe(12);
      expect(typeof overview.databaseSize).toBe('string');
      expect(typeof overview.databaseSizeBytes).toBe('number');
      expect(typeof overview.tableCount).toBe('number');
    });
  });

  // --------------------------------------------------------------------------
  // getPerformanceMetrics()
  // --------------------------------------------------------------------------

  describe('getPerformanceMetrics()', () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test('returns cache hit ratio and ops per sec', async () => {
      const metrics = await provider.getPerformanceMetrics();
      expect(typeof metrics.cacheHitRatio).toBe('number');
      // hitRatio: 900/(900+100)*100 = 90.0
      expect(metrics.cacheHitRatio).toBe(90);
    });
  });

  // --------------------------------------------------------------------------
  // getSlowQueries()
  // --------------------------------------------------------------------------

  describe('getSlowQueries()', () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test('returns slow query data', async () => {
      const slow = await provider.getSlowQueries();
      expect(slow).toBeArray();
    });
  });

  // --------------------------------------------------------------------------
  // getActiveSessions()
  // --------------------------------------------------------------------------

  describe('getActiveSessions()', () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test('returns client list as sessions', async () => {
      const sessions = await provider.getActiveSessions();
      expect(sessions).toBeArray();
      expect(sessions.length).toBe(2);
      expect(sessions[0].user).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // getTableStats()
  // --------------------------------------------------------------------------

  describe('getTableStats()', () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test('returns key pattern stats', async () => {
      const stats = await provider.getTableStats();
      expect(stats).toBeArray();
    });
  });

  // --------------------------------------------------------------------------
  // getIndexStats()
  // --------------------------------------------------------------------------

  describe('getIndexStats()', () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test('returns empty array (Redis has no indexes)', async () => {
      const stats = await provider.getIndexStats();
      expect(stats).toBeArray();
    });
  });

  // --------------------------------------------------------------------------
  // getStorageStats()
  // --------------------------------------------------------------------------

  describe('getStorageStats()', () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test('returns memory usage info', async () => {
      const stats = await provider.getStorageStats();
      expect(stats).toBeArray();
      expect(stats.length).toBeGreaterThan(0);
      expect(typeof stats[0].name).toBe('string');
      expect(typeof stats[0].sizeBytes).toBe('number');
    });
  });

  // --------------------------------------------------------------------------
  // getMonitoringData()
  // --------------------------------------------------------------------------

  describe('getMonitoringData()', () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test('returns monitoring data', async () => {
      const data = await provider.getMonitoringData();
      expect(data.timestamp).toBeInstanceOf(Date);
      expect(data.overview).toBeDefined();
      expect(data.performance).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Additional query scenarios
  // --------------------------------------------------------------------------

  describe('additional query scenarios', () => {
    beforeEach(async () => {
      await provider.connect();
    });

    test('KEYS command returns key list', async () => {
      const result = await provider.query(
        JSON.stringify({ command: 'KEYS', args: ['*'] })
      );
      expect(result.rows).toBeArray();
    });

    test('SET command returns OK', async () => {
      const result = await provider.query(
        JSON.stringify({ command: 'SET', args: ['mykey', 'myvalue'] })
      );
      expect(result.rows[0].result).toBe('OK');
    });

    test('DEL command returns integer count', async () => {
      const result = await provider.query(
        JSON.stringify({ command: 'DEL', args: ['mykey'] })
      );
      expect(result.rows[0].result).toBe('(integer) 1');
    });

    test('PING returns PONG', async () => {
      const result = await provider.query(
        JSON.stringify({ command: 'PING', args: [] })
      );
      expect(result.rows[0].result).toBe('PONG');
    });

    test('DBSIZE returns integer key count', async () => {
      const result = await provider.query(
        JSON.stringify({ command: 'DBSIZE', args: [] })
      );
      expect(result.rows[0].result).toBe('(integer) 42');
    });
  });
});
