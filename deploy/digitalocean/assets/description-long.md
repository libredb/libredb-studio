# LibreDB Studio

**The open-source SQL IDE built for cloud-native teams.**

LibreDB Studio gives you a full-featured database workspace in your browser — connect to PostgreSQL, MySQL, MongoDB, Redis and more, write and run queries with AI assistance, and share results with your team.

## Features

- **Multi-engine support** — PostgreSQL, MySQL, MongoDB, Redis and more from a single interface
- **AI-assisted SQL** — turn natural language into queries (NL2SQL)
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
