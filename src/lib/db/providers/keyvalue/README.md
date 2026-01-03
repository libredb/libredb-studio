# Redis Provider

Redis database provider for LibreDB Studio. Supports Redis 6.0+.

## Features

- ✅ Connection management (single connection, no pooling needed)
- ✅ Command execution (JSON and direct command formats)
- ✅ Schema introspection (key patterns as "tables")
- ✅ Health monitoring (INFO command)
- ✅ Performance metrics (cache hit ratio, queries/sec)
- ✅ Slow query log
- ✅ Active sessions/clients
- ✅ Storage statistics
- ✅ Maintenance operations

## Connection Configuration

```typescript
const connection: DatabaseConnection = {
  id: "redis-1",
  name: "My Redis",
  type: "redis",
  host: "localhost",
  port: 6379,
  password: "optional-password",
  database: "0", // Redis database number (0-15)
  createdAt: new Date(),
};

// Or use connection string
const connection: DatabaseConnection = {
  id: "redis-1",
  name: "My Redis",
  type: "redis",
  connectionString: "redis://username:password@localhost:6379/0",
  createdAt: new Date(),
};
```

## Query Formats

### JSON Format (Recommended)

```json
{
  "command": "GET",
  "args": ["user:123"]
}

{
  "command": "SET",
  "args": ["user:123", "John Doe"]
}

{
  "command": "KEYS",
  "args": ["user:*"]
}

{
  "command": "HGETALL",
  "args": ["user:123"]
}
```

### Direct Command Format

```
GET user:123
SET user:123 "John Doe"
KEYS user:*
HGETALL user:123
DEL user:123
EXPIRE user:123 3600
```

## Supported Commands

### String Operations

- GET, SET, SETEX, SETNX, GETSET, GETRANGE
- MGET, MSET
- STRLEN, APPEND
- INCR, DECR, INCRBY, DECRBY

### Hash Operations

- HGET, HSET, HMGET, HMSET
- HGETALL, HKEYS, HVALS
- HDEL, HEXISTS, HLEN

### List Operations

- LPUSH, RPUSH, LPOP, RPOP
- LRANGE, LLEN, LINDEX

### Set Operations

- SADD, SREM, SMEMBERS
- SINTER, SUNION, SDIFF
- SCARD, SISMEMBER

### Sorted Set Operations

- ZADD, ZREM, ZRANGE, ZREVRANGE
- ZCARD, ZSCORE, ZRANK

### Key Operations

- KEYS, SCAN
- DEL, EXISTS, EXPIRE, EXPIREAT, PERSIST
- TTL, TYPE, RENAME

### Server Operations

- INFO, DBSIZE, PING
- FLUSHDB, FLUSHALL (use with caution)

## Schema Representation

Redis keys are grouped by patterns and represented as "tables":

| Pattern       | Example Keys             | Description         |
| ------------- | ------------------------ | ------------------- |
| `user:*`      | user:1, user:2, user:123 | User data           |
| `session:*`   | session:abc, session:xyz | Session data        |
| `cache:*`     | cache:page1, cache:page2 | Cache entries       |
| `simple_keys` | count, status, config    | Keys without colons |

Each "table" shows:

- Key pattern name
- Number of keys matching pattern
- Inferred column structure based on key type (string, hash, list, set, zset)

## Health Monitoring

The provider returns:

- Active connections count
- Memory usage (used_memory)
- Cache hit ratio (keyspace_hits / (keyspace_hits + keyspace_misses))
- Slow query log (last 5 slow commands)
- Active client sessions

## Maintenance Operations

### Analyze

```typescript
await provider.runMaintenance("analyze");
// Returns database size and memory info
```

### Optimize/Vacuum

```typescript
await provider.runMaintenance("optimize");
// Triggers background AOF rewrite
```

### Check

```typescript
await provider.runMaintenance("check");
// Pings Redis server
```

### Kill Client

```typescript
await provider.runMaintenance("kill", "client-id");
// Kills a specific client connection
```

## Performance Metrics

- **Cache Hit Ratio**: Percentage of successful key lookups
- **Queries Per Second**: Average commands processed per second
- **Memory Usage**: Current memory consumption
- **Uptime**: Server uptime

## Example Usage

```typescript
import { createDatabaseProvider } from "@/lib/db/factory";

// Create provider
const provider = await createDatabaseProvider({
  id: "redis-1",
  name: "My Redis",
  type: "redis",
  host: "localhost",
  port: 6379,
  createdAt: new Date(),
});

// Connect
await provider.connect();

// Execute commands
const result = await provider.query('{"command": "GET", "args": ["user:123"]}');
console.log(result.rows); // [{ key: 'user:123', value: 'John Doe' }]

// Get schema
const schema = await provider.getSchema();
console.log(schema); // [{ name: 'user:*', rowCount: 150, ... }]

// Get health
const health = await provider.getHealth();
console.log(health.cacheHitRatio); // "99.5%"

// Disconnect
await provider.disconnect();
```

## Notes

- Redis doesn't have traditional tables/schemas - keys are grouped by patterns
- No connection pooling needed (Redis uses single connection efficiently)
- Schema introspection samples keys to infer structure
- Memory usage calculations are estimates based on sampling
- Slow query log requires `slowlog-log-slower-than` configuration in Redis
- Client list shows all connected clients, not just queries

## Limitations

- No traditional foreign keys or indexes
- Schema is inferred from key patterns (may not be 100% accurate)
- Large key scans (KEYS \*) can be slow - use SCAN in production
- Memory usage is estimated via sampling
- No transaction support in query interface (use Redis MULTI/EXEC directly)

## Dependencies

- `ioredis`: ^5.3.0
