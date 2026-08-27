# LibreDB Studio

**The open-source SQL IDE built for cloud-native teams.**

LibreDB Studio gives you a full-featured database workspace in your browser — connect to PostgreSQL, MySQL, MongoDB, Redis and twelve more engines, write and run queries, have the optional AI explain them wherever the engine returns a query plan, and share results with your team.

## Features

- **Sixteen engines, one interface** — PostgreSQL, MySQL, Oracle, SQL Server, SQLite, libSQL, DuckDB, MongoDB, Redis, Couchbase, ClickHouse, Apache Druid, Elasticsearch, OpenSearch, Apache Trino and Apache Cassandra
- **Read-only AI agent** — state a question and the agent investigates it, and every claim in its report cites the result it came from; it runs SQL on PostgreSQL, SQLite and DuckDB only, in a session the database enforces as read-only, so writes and DDL are refused by the engine rather than by reading the statement. On every other engine it drafts the statement and you run it, and nothing reaches your editor unless you consent to the hand-over when the run opens
- **AI query explanation** — one click turns an unfamiliar query into plain English, with your own schema as context, on PostgreSQL, MySQL, SQLite, libSQL, DuckDB, Couchbase, ClickHouse, Apache Druid and Apache Trino: the write-up is derived from the engine's own `EXPLAIN` plan, so it is offered where an engine returns one (bring your own key: Gemini, OpenAI, Ollama or any OpenAI-compatible endpoint; off unless configured)
- **Modern editor** — autocomplete, syntax highlighting, query history
- **Zero-config start** — this 1-Click App boots fully configured; credentials are generated uniquely for your Droplet on first boot
- **Self-hosted & private** — the app and its configuration store run entirely on your Droplet (local SQLite by default); traffic to the databases and optional AI providers you configure flows directly from your Droplet to those services

## Getting started

1. Create the Droplet from this 1-Click App.
2. SSH in (`ssh root@your-droplet-ip`) — the welcome message (MOTD) shows your access URL and where to find the generated admin credentials (`/etc/libredb-studio.env`).
3. Open `http://your-droplet-ip:3000` in your browser and log in.

## How it works

LibreDB Studio runs as a Docker container managed by systemd (`libredb-studio.service`). Application data persists in `/app/data` and survives restarts and upgrades. A unique JWT secret and admin/user passwords are generated on first boot — no shared default credentials.

## Links

- Documentation & source: https://github.com/libredb/libredb-studio
- Issues & support: https://github.com/libredb/libredb-studio/issues
