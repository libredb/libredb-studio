# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LibreDB Studio is a web-based SQL IDE for cloud-native teams. It supports PostgreSQL, MySQL, SQLite, MongoDB, and a demo mode with AI-powered query assistance.

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

# Docker development
docker-compose up -d
```

There is no test suite configured. The project uses ESLint 9 for linting.

## Architecture

### Tech Stack
- **Framework:** Next.js 15 (App Router) with React 19 and TypeScript
- **Styling:** Tailwind CSS 4 with Shadcn/UI components
- **SQL Editor:** Monaco Editor
- **Data Grid:** TanStack React Table with react-virtual for virtualization
- **AI:** Multi-model support (Gemini, OpenAI, Ollama, Custom)
- **Databases:** PostgreSQL (`pg`), MySQL (`mysql2`), SQLite (`better-sqlite3`), MongoDB (`mongodb`)
- **Auth:** JWT-based with `jose` library

### Directory Structure

```
src/
├── app/                    # Next.js App Router
│   ├── api/
│   │   ├── auth/           # Login/logout/me endpoints
│   │   ├── ai/chat/        # AI chat endpoint (streaming)
│   │   └── db/             # Query, schema, health, maintenance
│   ├── admin/              # Admin dashboard (RBAC protected)
│   └── login/              # Login page
├── components/             # React components
│   ├── Studio.tsx          # Main application shell
│   ├── QueryEditor.tsx     # Monaco SQL editor wrapper
│   ├── ResultsGrid.tsx     # Virtualized data grid
│   ├── Sidebar.tsx         # Schema explorer sidebar
│   └── ui/                 # Shadcn/UI primitives
├── hooks/                  # Custom React hooks
└── lib/
    ├── db/                 # Database provider module (Strategy Pattern)
    │   ├── providers/
    │   │   ├── sql/        # SQL providers (postgres, mysql, sqlite)
    │   │   ├── document/   # Document providers (mongodb)
    │   │   └── demo.ts     # Demo mock provider
    │   ├── factory.ts      # Provider factory
    │   ├── types.ts        # Database types
    │   └── errors.ts       # Custom error classes
    ├── llm/                # LLM provider module (Strategy Pattern)
    ├── types.ts            # TypeScript type definitions
    ├── auth.ts             # JWT auth utilities
    └── storage.ts          # LocalStorage management
```

### Key Patterns

1. **Database Abstraction:** `src/lib/db/` module provides Strategy Pattern implementation for multiple database types:
   - **SQL:** PostgreSQL, MySQL, SQLite (extend `SQLBaseProvider`)
   - **Document:** MongoDB (extends `BaseDatabaseProvider`)
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
