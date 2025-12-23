# LibreDB Studio v0.5.6 - Initial Stable Release

We are excited to announce the first public release of **LibreDB Studio** — a modern, blazing-fast SQL IDE for the cloud era.

---

## What is LibreDB Studio?

LibreDB Studio is an open-source, web-based SQL editor designed for cloud-native teams. It bridges the gap between heavyweight desktop applications and minimal CLI tools, offering a professional database management experience accessible from any browser.

**Live Demo:** [app.libredb.org](https://app.libredb.org)

---

## Core Features

### Mobile-First, Professional-Always
- Fully responsive design optimized for phones, tablets, and desktops
- Run SQL queries from your phone while on-call or away from your desk
- Touch-friendly interface with native-like experience on mobile browsers
- No app installation required — just open your browser and connect

### All-in-One Architecture
- Single Docker image contains everything: frontend, backend, and API
- No separate services to configure or maintain
- Deploy once, connect to any database in your private network
- Zero external dependencies — runs completely self-contained

### Cloud-Native Deployment
- Docker-ready with optimized multi-stage builds
- Kubernetes compatible with health check endpoints
- Horizontal scaling support via stateless JWT architecture
- Perfect for private network database management

### Multi-Database Support
- **PostgreSQL** — Full support including maintenance operations
- **MySQL** — Query execution and schema exploration
- **SQLite** — Lightweight database support
- **MongoDB** — Document database with JSON query interface
- **Demo Mode** — Try the IDE without a real database

### Professional SQL Editor
- Monaco Editor (VS Code engine) with syntax highlighting
- Schema-aware autocomplete for tables, columns, and keywords
- Multi-tab workspace with independent execution states
- Query formatting and keyboard shortcuts

### AI-Powered Query Assistant
- Natural language to SQL generation
- Multi-provider support: Gemini, OpenAI, Ollama, or custom endpoints
- Schema-aware context for accurate query suggestions
- Streaming responses for real-time feedback

### High-Performance Data Grid
- Virtualized rendering for large datasets (TanStack)
- Inline cell editing with instant updates
- One-click export to CSV and JSON
- Column sorting and resizing

### DBA Maintenance Toolkit
- Live connection monitoring and session management
- One-click VACUUM, ANALYZE, and REINDEX operations
- Query history with full audit trail
- Database health metrics and statistics

### Enterprise Ready
- JWT-based authentication with role-based access control
- Admin and User roles with granular permissions
- Secure HTTP-only cookie session management
- Built-in query auditing and history tracking

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 15, React 19, TypeScript |
| Styling | Tailwind CSS 4, Shadcn/UI, Radix UI |
| Editor | Monaco Editor |
| Data Grid | TanStack Table + React Virtual |
| AI | Multi-model (Gemini, OpenAI, Ollama) |
| Auth | JWT with HTTP-only cookies |

---

## Quick Start

```bash
# Clone the repository
git clone https://github.com/libredb/libredb-studio.git
cd libredb-studio

# Install dependencies
bun install

# Configure environment
cp env.example .env.local
# Edit .env.local with your settings

# Start development server
bun dev
```

Open [http://localhost:3000](http://localhost:3000) and connect to your database.

---

## Deployment

### Docker
```bash
docker-compose up -d
```

### Render (One-Click)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/libredb/libredb-studio)

---

## Documentation

- [API Documentation](./API_DOCS.md)
- [Contributing Guide](../CONTRIBUTING.md)

---

## What's Next

- Interactive ER Diagrams
- Advanced Mobile SQL Keyboard
- SSO Integration (OIDC/SAML)
- Query result visualization charts

---

## Links

- **Repository:** [github.com/libredb/libredb-studio](https://github.com/libredb/libredb-studio)
- **Live Demo:** [app.libredb.org](https://app.libredb.org)
- **License:** MIT

---

Thank you for trying LibreDB Studio. We welcome contributions and feedback from the community.
