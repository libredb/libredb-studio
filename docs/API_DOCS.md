# LibreDB Studio API Documentation

> **Version:** 0.5.2
> **Base URL:** `https://your-domain.com` or `http://localhost:3000`
> **Content-Type:** `application/json`

## Table of Contents

- [Overview](#overview)
- [Authentication](#authentication)
- [API Endpoints](#api-endpoints)
  - [Auth API](#auth-api)
  - [Database API](#database-api)
  - [AI API](#ai-api)
- [Data Types](#data-types)
- [Error Handling](#error-handling)
- [Rate Limiting](#rate-limiting)
- [Examples](#examples)

---

## Overview

LibreDB Studio provides a RESTful API for database management operations. The API supports multiple database types including PostgreSQL, MySQL, SQLite, MongoDB

### Key Features

- **JWT Authentication** - Secure token-based authentication stored in HTTP-only cookies
- **Multi-Database Support** - PostgreSQL, MySQL, SQLite, MongoDB
- **AI-Powered Queries** - Natural language to SQL with streaming responses
- **Real-time Health Monitoring** - Database metrics and performance insights

### Request Format

All API requests must include:
- `Content-Type: application/json` header
- Valid authentication cookie (except public endpoints)

### Response Format

All responses are JSON with the following structure:

```json
// Success
{
  "data": { ... },
  "status": "success"
}

// Error
{
  "error": "Error message",
  "code": "ERROR_CODE",
  "status": 400
}
```

---

## Authentication

LibreDB Studio uses JWT (JSON Web Tokens) for authentication. Tokens are stored in HTTP-only cookies for security.

### Authentication Flow

1. Client sends credentials to `/api/auth/login`
2. Server validates and returns JWT in `auth-token` cookie
3. Client includes cookie in subsequent requests
4. Middleware validates token on protected routes

### Roles

| Role | Access Level |
|------|--------------|
| `admin` | Full access including maintenance operations and admin panel |
| `user` | Query execution, schema viewing (no maintenance) |

### Public Endpoints (No Auth Required)

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/db/health` (service health check only)

---

## API Endpoints

### Auth API

#### POST /api/auth/login

Authenticate user and create session.

**Request:**
```json
{
  "password": "your-password"
}
```

**Response (200 OK):**
```json
{
  "success": true,
  "role": "admin"
}
```

**Response (401 Unauthorized):**
```json
{
  "success": false,
  "message": "Invalid password"
}
```

**Notes:**
- Password is matched against `ADMIN_PASSWORD` or `USER_PASSWORD` environment variables
- Sets `auth-token` HTTP-only cookie on success

---

#### POST /api/auth/logout

Terminate current session.

**Request:** No body required

**Response (200 OK):**
```json
{
  "success": true
}
```

**Notes:**
- Clears the `auth-token` cookie

---

#### GET /api/auth/me

Get current authenticated user information.

**Response (200 OK):**
```json
{
  "authenticated": true,
  "user": {
    "role": "admin",
    "iat": 1703345678,
    "exp": 1703432078
  }
}
```

**Response (401 Unauthorized):**
```json
{
  "authenticated": false
}
```

---

### Database API

#### GET /api/db/health

Simple health check for load balancers and container orchestration.

**Authentication:** Not required

**Response (200 OK):**
```json
{
  "status": "healthy",
  "timestamp": "2025-12-24T12:00:00.000Z",
  "service": "libredb-studio"
}
```

---

#### POST /api/db/health

Detailed health check for a specific database connection.

**Authentication:** Required

**Request:**
```json
{
  "connection": {
    "id": "conn-123",
    "name": "Production DB",
    "type": "postgres",
    "host": "localhost",
    "port": 5432,
    "database": "mydb",
    "user": "admin",
    "password": "secret"
  }
}
```

**Response (200 OK):**
```json
{
  "activeConnections": 5,
  "databaseSize": "256 MB",
  "cacheHitRatio": "99.2%",
  "slowQueries": [
    {
      "query": "SELECT * FROM large_table...",
      "calls": 150,
      "avgTime": "245ms"
    }
  ],
  "activeSessions": [
    {
      "pid": 12345,
      "user": "admin",
      "database": "mydb",
      "state": "active",
      "query": "SELECT * FROM users",
      "duration": "1.5s"
    }
  ]
}
```

**Response (503 Service Unavailable):**
```json
{
  "error": "Connection failed: timeout",
  "activeConnections": 0,
  "databaseSize": "N/A",
  "cacheHitRatio": "N/A",
  "slowQueries": [],
  "activeSessions": []
}
```

---

#### POST /api/db/query

Execute SQL query on connected database.

**Authentication:** Required

**Request:**
```json
{
  "connection": {
    "id": "conn-123",
    "name": "My Database",
    "type": "postgres",
    "host": "localhost",
    "port": 5432,
    "database": "mydb",
    "user": "admin",
    "password": "secret"
  },
  "sql": "SELECT id, name, email FROM users WHERE active = true LIMIT 100"
}
```

**Response (200 OK):**
```json
{
  "rows": [
    { "id": 1, "name": "John Doe", "email": "john@example.com" },
    { "id": 2, "name": "Jane Smith", "email": "jane@example.com" }
  ],
  "fields": ["id", "name", "email"],
  "rowCount": 2,
  "executionTime": 12
}
```

**Response (400 Bad Request):**
```json
{
  "error": "syntax error at or near \"SELEC\"",
  "code": "QUERY_ERROR"
}
```

**Response (408 Request Timeout):**
```json
{
  "error": "Query timed out. Please try a simpler query or increase timeout."
}
```

##### MongoDB Query Format

For MongoDB connections, the `sql` field should contain a JSON query:

```json
{
  "connection": {
    "type": "mongodb",
    "connectionString": "mongodb://localhost:27017/mydb"
  },
  "sql": "{\"collection\":\"users\",\"operation\":\"find\",\"filter\":{\"active\":true},\"options\":{\"limit\":50}}"
}
```

**Supported MongoDB Operations:**
- `find` - Query documents
- `findOne` - Get single document
- `insertOne` - Insert document
- `insertMany` - Insert multiple documents
- `updateOne` - Update single document
- `updateMany` - Update multiple documents
- `deleteOne` - Delete single document
- `deleteMany` - Delete multiple documents
- `aggregate` - Aggregation pipeline
- `countDocuments` - Count documents

---

#### POST /api/db/schema

Get database schema including tables, columns, indexes, and foreign keys.

**Authentication:** Required

**Request:**
```json
{
  "id": "conn-123",
  "name": "My Database",
  "type": "postgres",
  "host": "localhost",
  "port": 5432,
  "database": "mydb",
  "user": "admin",
  "password": "secret"
}
```

**Response (200 OK):**
```json
[
  {
    "name": "users",
    "rowCount": 1500,
    "size": "2.4 MB",
    "columns": [
      {
        "name": "id",
        "type": "integer",
        "nullable": false,
        "isPrimary": true,
        "defaultValue": "nextval('users_id_seq')"
      },
      {
        "name": "email",
        "type": "varchar(255)",
        "nullable": false,
        "isPrimary": false
      },
      {
        "name": "created_at",
        "type": "timestamp",
        "nullable": true,
        "isPrimary": false,
        "defaultValue": "CURRENT_TIMESTAMP"
      }
    ],
    "indexes": [
      {
        "name": "users_pkey",
        "columns": ["id"],
        "unique": true
      },
      {
        "name": "users_email_idx",
        "columns": ["email"],
        "unique": true
      }
    ],
    "foreignKeys": [
      {
        "columnName": "org_id",
        "referencedTable": "organizations",
        "referencedColumn": "id"
      }
    ]
  }
]
```

**Response (503 Service Unavailable):**
```json
{
  "error": "Connection failed: ECONNREFUSED"
}
```

---

#### POST /api/db/maintenance

Run database maintenance operations.

**Authentication:** Required (Admin only)

**Request:**
```json
{
  "connection": {
    "id": "conn-123",
    "name": "Production DB",
    "type": "postgres",
    "host": "localhost",
    "port": 5432,
    "database": "mydb",
    "user": "admin",
    "password": "secret"
  },
  "type": "vacuum",
  "target": "users"
}
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `connection` | object | Yes | Database connection configuration |
| `type` | string | Yes | Maintenance operation type |
| `target` | string | No | Target table name or PID (for kill) |

**Maintenance Types:**

| Type | PostgreSQL | MySQL | SQLite | Description |
|------|------------|-------|--------|-------------|
| `vacuum` | VACUUM ANALYZE | OPTIMIZE | VACUUM | Reclaim storage and update statistics |
| `analyze` | ANALYZE | ANALYZE | ANALYZE | Update query planner statistics |
| `reindex` | REINDEX | - | REINDEX | Rebuild indexes |
| `optimize` | - | OPTIMIZE | - | Optimize table (MySQL only) |
| `check` | - | CHECK | PRAGMA integrity_check | Check table integrity |
| `kill` | pg_terminate_backend | KILL | - | Terminate a session by PID |

**Response (200 OK):**
```json
{
  "success": true,
  "executionTime": 1234,
  "message": "VACUUM completed successfully"
}
```

**Response (403 Forbidden):**
```json
{
  "error": "Unauthorized. Admin access required."
}
```

**Response (400 Bad Request):**
```json
{
  "error": "Invalid maintenance type. Valid types: vacuum, analyze, reindex, kill, optimize, check"
}
```

---

### AI API

#### POST /api/ai/chat

Generate SQL queries using AI with streaming response.

**Authentication:** Required

**Request:**
```json
{
  "prompt": "Show me all users who signed up in the last 30 days",
  "databaseType": "postgres",
  "schemaContext": "Table: users (id, email, name, created_at, status)"
}
```

**Parameters:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | Yes | Natural language query or question |
| `databaseType` | string | No | Database type for syntax (default: postgres) |
| `schemaContext` | string | No | Schema info for context-aware queries |

**Response (200 OK - Streaming):**

Returns `text/plain` with chunked transfer encoding. The response streams the generated SQL:

```sql
SELECT id, email, name, created_at
FROM users
WHERE created_at >= NOW() - INTERVAL '30 days'
ORDER BY created_at DESC;
```

**Response (401 Unauthorized):**
```json
{
  "error": "Invalid API key. Please check your configuration."
}
```

**Response (429 Too Many Requests):**
```json
{
  "error": "AI usage limit reached. Please try again later or check your billing status."
}
```

**Response (400 Bad Request):**
```json
{
  "error": "The prompt was blocked by safety filters."
}
```

**LLM Configuration:**

Configure AI provider via environment variables:

```env
LLM_PROVIDER=gemini          # gemini, openai, ollama, custom
LLM_API_KEY=your-api-key
LLM_MODEL=gemini-2.0-flash   # Model name
LLM_API_URL=http://localhost:11434/v1  # For ollama/custom
```

---

## Data Types

### DatabaseConnection

```typescript
interface DatabaseConnection {
  id: string;              // Unique identifier
  name: string;            // Display name
  type: DatabaseType;      // Database type
  host?: string;           // Hostname or IP
  port?: number;           // Port number
  user?: string;           // Username
  password?: string;       // Password
  database?: string;       // Database name
  connectionString?: string; // Full connection string (alternative)
  createdAt: Date;         // Creation timestamp
}

type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'mongodb' | 'redis' | 'oracle' | 'mssql';
```

### TableSchema

```typescript
interface TableSchema {
  name: string;            // Table name
  columns: ColumnSchema[]; // Column definitions
  indexes: IndexSchema[];  // Index definitions
  foreignKeys?: ForeignKeySchema[];
  rowCount?: number;       // Approximate row count
  size?: string;           // Table size (e.g., "2.4 MB")
}

interface ColumnSchema {
  name: string;            // Column name
  type: string;            // Data type
  nullable: boolean;       // Allows NULL
  isPrimary: boolean;      // Primary key
  defaultValue?: string;   // Default value
}

interface IndexSchema {
  name: string;            // Index name
  columns: string[];       // Indexed columns
  unique: boolean;         // Unique constraint
}

interface ForeignKeySchema {
  columnName: string;      // Local column
  referencedTable: string; // Foreign table
  referencedColumn: string; // Foreign column
}
```

### QueryResult

```typescript
interface QueryResult {
  rows: any[];             // Result rows
  fields: string[];        // Column names
  rowCount: number;        // Number of rows returned
  executionTime: number;   // Execution time in ms
  explainPlan?: any;       // Query execution plan (if requested)
}
```

### HealthInfo

```typescript
interface HealthInfo {
  activeConnections: number;
  databaseSize: string;
  cacheHitRatio: string;
  slowQueries: SlowQuery[];
  activeSessions: ActiveSession[];
}

interface SlowQuery {
  query: string;           // Query text (truncated)
  calls: number;           // Number of executions
  avgTime: string;         // Average execution time
}

interface ActiveSession {
  pid: number | string;    // Process/Session ID
  user: string;            // Database user
  database: string;        // Database name
  state: string;           // Session state
  query: string;           // Current query
  duration: string;        // Query duration
}
```

---

## Error Handling

### HTTP Status Codes

| Code | Description |
|------|-------------|
| `200` | Success |
| `400` | Bad Request - Invalid parameters or query syntax |
| `401` | Unauthorized - Missing or invalid authentication |
| `403` | Forbidden - Insufficient permissions |
| `408` | Request Timeout - Query exceeded time limit |
| `429` | Too Many Requests - Rate limit exceeded (AI) |
| `500` | Internal Server Error |
| `503` | Service Unavailable - Database connection failed |

### Error Response Format

```json
{
  "error": "Human-readable error message",
  "code": "ERROR_CODE"
}
```

### Error Codes

| Code | Description |
|------|-------------|
| `QUERY_ERROR` | SQL syntax or execution error |
| `CONNECTION_ERROR` | Database connection failed |
| `TIMEOUT_ERROR` | Query exceeded time limit |
| `AUTH_ERROR` | Authentication failed |
| `CONFIG_ERROR` | Invalid configuration |

---

## Rate Limiting

### AI Endpoint

The AI chat endpoint (`/api/ai/chat`) is subject to rate limits from the underlying LLM provider:

| Provider | Limits |
|----------|--------|
| Gemini | 15 RPM (free tier) |
| OpenAI | Varies by plan |
| Ollama | No limits (local) |

### Database Operations

Database operations have a default timeout of 60 seconds (`DEFAULT_QUERY_TIMEOUT`).

---

## Examples

### cURL Examples

#### Login
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password": "admin123"}' \
  -c cookies.txt
```

#### Execute Query
```bash
curl -X POST http://localhost:3000/api/db/query \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "connection": {
      "id": "1",
      "name": "Local PG",
      "type": "postgres",
      "host": "localhost",
      "port": 5432,
      "database": "mydb",
      "user": "postgres",
      "password": "postgres"
    },
    "sql": "SELECT * FROM users LIMIT 10"
  }'
```

#### Get Schema
```bash
curl -X POST http://localhost:3000/api/db/schema \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "id": "1",
    "name": "Local PG",
    "type": "postgres",
    "host": "localhost",
    "port": 5432,
    "database": "mydb",
    "user": "postgres",
    "password": "postgres"
  }'
```

#### AI Query Generation
```bash
curl -X POST http://localhost:3000/api/ai/chat \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "prompt": "Count users by country",
    "databaseType": "postgres",
    "schemaContext": "users(id, name, country, created_at)"
  }'
```

#### Health Check
```bash
curl http://localhost:3000/api/db/health
```

#### Run Maintenance (Admin)
```bash
curl -X POST http://localhost:3000/api/db/maintenance \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "connection": {
      "id": "1",
      "name": "Local PG",
      "type": "postgres",
      "host": "localhost",
      "port": 5432,
      "database": "mydb",
      "user": "postgres",
      "password": "postgres"
    },
    "type": "vacuum",
    "target": "users"
  }'
```

### JavaScript/TypeScript Examples

```typescript
// Login and execute query
async function executeQuery(sql: string) {
  // Login
  await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'admin123' }),
    credentials: 'include'
  });

  // Execute query
  const response = await fetch('/api/db/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      connection: {
        id: '1',
        name: 'My DB',
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        database: 'mydb',
        user: 'postgres',
        password: 'postgres'
      },
      sql
    })
  });

  return response.json();
}

// Stream AI response
async function streamAIQuery(prompt: string) {
  const response = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      prompt,
      databaseType: 'postgres',
      schemaContext: 'users(id, name, email)'
    })
  });

  const reader = response.body?.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader!.read();
    if (done) break;
    console.log(decoder.decode(value));
  }
}
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes (prod) | JWT signing secret (min 32 chars) |
| `ADMIN_PASSWORD` | Yes (prod) | Admin user password |
| `USER_PASSWORD` | Yes (prod) | Regular user password |
| `LLM_PROVIDER` | No | AI provider: gemini, openai, ollama, custom |
| `LLM_API_KEY` | No | AI provider API key |
| `LLM_MODEL` | No | AI model name |
| `LLM_API_URL` | No | Custom AI endpoint URL |

---

## Changelog

### v0.5.2
- Added memory optimization with dynamic imports
- Improved Docker deployment for low-memory environments
- Added `serverExternalPackages` for native modules

### v0.5.0
- Full MongoDB support
- Strategy Pattern for database providers
- LLM provider abstraction

### v0.4.0
- AI Query Assistant with streaming
- Multi-provider LLM support

---

**Last Updated:** December 2025
