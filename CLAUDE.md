# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LibreDB Studio is a web-based SQL IDE for cloud-native teams. It supports PostgreSQL, MySQL, SQLite, Oracle, SQL Server, MongoDB, Redis, and a demo mode with AI-powered query assistance.

## Development Commands

```bash
# Install dependencies (Bun preferred)
bun install

# Development server with Turbopack
bun dev

# Production build
bun run build

# Start production server
bun start

# Lint code
bun run lint

# Run all tests (unit + API + integration + hooks + components)
bun run test

# Run individual test layers
bun run test:unit
bun run test:api
bun run test:integration
bun run test:hooks
bun run test:components

# E2E tests (Playwright, requires build)
bun run test:e2e

# Coverage report
bun run test:coverage

# Docker development
docker-compose up -d
```

The project uses ESLint 9 for linting and `bun:test` for testing with `@testing-library/react` + `happy-dom` for component tests and Playwright for E2E tests.

> **Important**: Always use `bun run test` instead of bare `bun test`. Component tests require isolated execution groups (handled by `tests/run-components.sh`) to prevent `mock.module()` cross-contamination between test files.

## Architecture

### Tech Stack
- **Framework:** Next.js 15 (App Router) with React 19 and TypeScript
- **Styling:** Tailwind CSS 4 with Shadcn/UI components
- **SQL Editor:** Monaco Editor
- **Data Grid:** TanStack React Table with react-virtual for virtualization
- **AI:** Multi-model support (Gemini, OpenAI, Ollama, Custom)
- **Databases:** PostgreSQL (`pg`), MySQL (`mysql2`), SQLite (`better-sqlite3`), Oracle (`oracledb`), SQL Server (`mssql`), MongoDB (`mongodb`), Redis (`ioredis`)
- **Auth:** JWT-based with `jose` library

### Directory Structure

```
src/
├── app/                    # Next.js App Router
│   ├── api/
│   │   ├── auth/           # Login/logout/me endpoints
│   │   ├── ai/             # AI endpoints (chat, nl2sql, explain, safety)
│   │   ├── db/             # Query, schema, health, maintenance, transactions
│   │   └── admin/          # Fleet health, audit endpoints
│   ├── admin/              # Admin dashboard (RBAC protected)
│   └── login/              # Login page
├── components/             # React components
│   ├── Studio.tsx          # Main application shell
│   ├── QueryEditor.tsx     # Monaco SQL editor wrapper
│   ├── ResultsGrid.tsx     # Virtualized data grid
│   ├── sidebar/            # Sidebar, ConnectionsList, ConnectionItem
│   ├── studio/             # StudioTabBar, QueryToolbar, BottomPanel
│   ├── admin/              # AdminDashboard, tabs (Overview, Operations, etc.)
│   ├── schema-explorer/    # SchemaExplorer component
│   └── ui/                 # Shadcn/UI primitives
├── hooks/                  # Custom React hooks
└── lib/
    ├── db/                 # Database provider module (Strategy Pattern)
    │   ├── providers/
    │   │   ├── sql/        # SQL providers (postgres, mysql, sqlite, oracle, mssql)
    │   │   ├── document/   # Document providers (mongodb)
    │   │   ├── keyvalue/   # Key-value providers (redis)
    │   │   └── demo.ts     # Demo mock provider
    │   ├── factory.ts      # Provider factory
    │   ├── types.ts        # Database types
    │   └── errors.ts       # Custom error classes
    ├── llm/                # LLM provider module (Strategy Pattern)
    ├── schema-diff/        # Schema diff engine + migration SQL generator
    ├── sql/                # SQL statement splitter, alias extractor
    ├── types.ts            # TypeScript type definitions
    ├── auth.ts             # JWT auth utilities
    └── storage.ts          # LocalStorage management

tests/
├── setup.ts               # Global test setup (env vars, localStorage mock)
├── setup-dom.ts            # DOM environment setup (happy-dom)
├── run-components.sh       # Component test isolation runner
├── fixtures/               # Mock data (connections, schemas, query results)
├── helpers/                # Test utilities (mock providers, mock Monaco, etc.)
├── unit/                   # Pure function tests
├── api/                    # API route handler tests
├── integration/            # Database provider tests (mocked drivers)
├── hooks/                  # React hook tests
└── components/             # Component tests (happy-dom)

e2e/                        # Playwright E2E tests (browser)
```

### Key Patterns

1. **Database Abstraction:** `src/lib/db/` module provides Strategy Pattern implementation for multiple database types:
   - **SQL:** PostgreSQL, MySQL, SQLite, Oracle, SQL Server (extend `SQLBaseProvider`)
   - **Document:** MongoDB (extends `BaseDatabaseProvider`)
   - **Key-Value:** Redis (extends `BaseDatabaseProvider`)
   - **Demo:** Mock data provider for testing

2. **LLM Abstraction:** `src/lib/llm/` module provides Strategy Pattern for AI providers (Gemini, OpenAI, Ollama, Custom)

3. **Authentication Flow:** JWT tokens stored in HTTP-only cookies. Middleware (`src/middleware.ts`) protects routes and enforces RBAC (admin vs user roles)

4. **API Routes:** All backend logic in `src/app/api/`. Protected routes require valid JWT. Public routes: `/login`, `/api/auth`, `/api/db/health`

5. **Client State:** LocalStorage for connections, query history, and saved queries (`src/lib/storage.ts`)

6. **Multi-Tab Workspace:** Each query tab has independent state (query, results, execution status)

### Environment Variables

Required in `.env.local`:
```
ADMIN_PASSWORD=<password>       # Admin login
USER_PASSWORD=<password>        # User login
JWT_SECRET=<32+ chars>          # JWT signing secret

# Optional AI config
LLM_PROVIDER=gemini             # gemini, openai, ollama, custom
LLM_API_KEY=<key>
LLM_MODEL=gemini-2.0-flash
LLM_API_URL=<url>               # For ollama/custom providers
```

### Path Aliases

TypeScript path alias `@/*` maps to `./src/*`. Use `@/components/...`, `@/lib/...`, etc.

## Docker Build

The Dockerfile uses multi-stage Bun build with standalone Next.js output. Build args: `JWT_SECRET_BUILD`, `ADMIN_PASSWORD_BUILD`, `USER_PASSWORD_BUILD`. Health check: `GET /api/db/health`.

## Database Connections

### SQL Databases (PostgreSQL, MySQL, SQLite)
```typescript
const connection = {
  type: 'postgres', // or 'mysql', 'sqlite'
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  user: 'admin',
  password: 'secret',
};
```

### MongoDB
```typescript
const connection = {
  type: 'mongodb',
  connectionString: 'mongodb://localhost:27017/mydb',
  // or host/port/database format
};

// Query format (JSON)
const query = JSON.stringify({
  collection: 'users',
  operation: 'find',
  filter: { status: 'active' },
  options: { limit: 50 }
});
```
