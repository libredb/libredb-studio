# MCP server

LibreDB Studio serves the [Model Context Protocol](https://modelcontextprotocol.io) at `/api/mcp`.
An AI client of your own, such as Claude Code, Codex, Cursor, VS Code or Gemini CLI, reads the schemas of the connections an operator opted in and runs bounded, read-only SQL through Studio, while the database credentials stay on the server.
It is off by default.

## What it is

- One endpoint, `POST /api/mcp`, served by the official MCP TypeScript SDK.
  It speaks revision 2026-07-28 and, without sessions, the 2025 revisions 2025-11-25 and 2025-06-18 that most clients still use.
- Three tools, each annotated read-only and closed-world:
  - `list_connections` lists the connections opted in for MCP that your token's role may use, without credentials.
    It works for every engine.
  - `inspect_schema` lists one connection's tables with their columns and, on request, their indexes.
    It works on every engine: it lists every object kind the engine reads rows from, such as views beside tables, MongoDB collections, Redis keyspaces and search indexes, and `kind` names which one each entry is.
  - `run_read_query` runs one read-only statement: a `SELECT` (a `WITH` is fine), `VALUES`, `TABLE`, or `EXPLAIN` without `ANALYZE`.
    Runs on PostgreSQL, SQLite, DuckDB and SQL Server; other engines refuse it, so use inspect_schema there.
- Read-only is the database's own enforcement, not a filter over SQL text: `run_read_query` takes the connection under Studio's agent read-only execution profile and runs through the provider's read-only statement path, which PostgreSQL enforces with a read-only transaction, SQLite and DuckDB with a read-only open, and SQL Server by verifying the principal cannot write.
  A statement check runs first as defence in depth.
- A result that carries database content starts with a text block telling the model to treat what follows as untrusted data.

## Enabling it

Four variables decide it, and `.env.example` documents each.

| Variable | What it sets |
|---|---|
| `LIBREDB_MCP_ENABLED` | `true`, `on` or `1` enable MCP; `false`, `off`, `0`, empty or unset leave it off; any other value is an error on every authenticated request |
| `LIBREDB_MCP_URL` | The address clients use, which every token is bound to: an absolute http(s) URL ending in `/api/mcp`, with your `BASE_PATH`, and no user name, password, query or fragment |
| `LIBREDB_MCP_TOKEN_LABEL` | Any non-empty value; changing it revokes every MCP token at once |
| `LIBREDB_MCP_TOKEN_TTL_DAYS` | How many days a minted token stays valid, from 1 to 365, 30 when unset |

### npx

The launcher derives `LIBREDB_MCP_URL` from the address and port it serves on, so only the switch and the label are yours:

```bash
LIBREDB_MCP_ENABLED=true LIBREDB_MCP_TOKEN_LABEL=studio-mcp-1 npx @libredb/studio
```

The derived address is `http://127.0.0.1:3000/api/mcp` unless `--host` or `--port` says otherwise, and changing either invalidates every token minted for the old address.
Set `LIBREDB_MCP_URL` yourself when clients reach Studio through another address, such as a reverse proxy.

### Docker and Compose

Add the three settings to the container's environment:

```bash
docker run -p 3000:3000 \
  -e LIBREDB_MCP_ENABLED=true \
  -e LIBREDB_MCP_URL=https://studio.example.com/api/mcp \
  -e LIBREDB_MCP_TOKEN_LABEL=studio-mcp-1 \
  ghcr.io/libredb/libredb-studio:latest
```

In `docker-compose.example.yml`, uncomment the four `LIBREDB_MCP_*` lines beside the agent flag.

### Helm

```bash
helm upgrade libredb libredb/libredb-studio --reuse-values \
  --set mcp.enabled=true \
  --set mcp.url=https://studio.example.com/api/mcp \
  --set mcp.tokenLabel=studio-mcp-1
```

An enabled `mcp` block without `mcp.url` or `mcp.tokenLabel` refuses to render and names the value.

### Other channels

The native packages and every other way of running `server.js` derive nothing: set all three yourself.

## Opting connections in

An MCP client reaches a connection only when its seed entry says `mcp: true`, and only when the connection's `roles` admit the role your token carries ([`docs/SEED_CONNECTIONS.md`](SEED_CONNECTIONS.md)).

```yaml
connections:
  - id: shop
    name: Shop
    type: postgres
    host: db.internal
    database: shop
    roles: ["*"]
    mcp: true
```

The opt-in is per connection, so `defaults.mcp` is refused.
The built-in sample connections are never visible to an MCP client.
An empty `list_connections` answer means no connection is opted in for your token's role: an operator adds `mcp: true` to a seed connection.

`run_read_query` refuses a PostgreSQL or SQL Server connection whose own login could do more than read, so an opted-in seed for those engines needs a least-privilege principal.
On PostgreSQL the seed's role must not be a superuser and must not hold `pg_read_server_files`, `pg_write_server_files` or `pg_execute_server_program`.
On SQL Server the login must hold no fixed server role, neither `CONTROL SERVER` nor `ADMINISTER BULK OPERATIONS`, and none of `db_owner`, `db_accessadmin`, `db_securityadmin`, `db_ddladmin`, `db_backupoperator` or `db_datawriter`, and it must be granted `SHOWPLAN`.
A seed entry cannot carry a separate agent credential, so the fix is the seed's own login; `inspect_schema` has no such requirement.

## Getting a token

Open **MCP** in the user menu, the settings screen at `/settings/mcp`.
It shows whether MCP is ready on this server, what an operator has to set when it is not, and how many connections your role can reach.
When it is ready, **Create token** mints one for you and shows it once: copy it then, because it is not shown again and nothing about it is stored.

- A token is valid for `LIBREDB_MCP_TOKEN_TTL_DAYS` days, 30 by default.
- It carries the role you had when you minted it, so a lowered role keeps working until the token expires or the label changes.
- Changing `LIBREDB_MCP_TOKEN_LABEL` revokes every MCP token at once, and it is the only revocation there is.
- Creating a token needs a sign-in from the last ten minutes: an older session is asked to sign in again, because a session lives 24 hours and cannot be ended on the server.
- Deleting a local user, disabling an OIDC account or changing a password leaves that user's MCP tokens valid until they expire.
  Removing a person's access therefore takes two steps: stop them signing in, then rotate `LIBREDB_MCP_TOKEN_LABEL` once ten minutes have passed, so no session they still hold can mint under the new label.
  Rotating `JWT_SECRET` instead ends every session and revokes every MCP token at once.
- A changed `LIBREDB_MCP_URL`, and under npx a changed `--host` or `--port`, invalidates every token too.

## Client configuration

Every example that reads the token from the environment reads `LIBREDB_MCP_TOKEN`:

```bash
export LIBREDB_MCP_TOKEN='<your-mcp-token>'
```

The name is Studio's own on purpose: Claude Code reads a set of well-known credential variables as empty toward a remote server, and a name of your own expands.
Never commit a token.

### Claude Code

Verified live on 2026-09-26 with Claude Code 2.1.283.

In `.mcp.json`:

```json
{
  "mcpServers": {
    "libredb": {
      "type": "http",
      "url": "https://studio.example.com/api/mcp",
      "headers": {
        "Authorization": "Bearer ${LIBREDB_MCP_TOKEN}"
      }
    }
  }
}
```

Or from a shell:

```bash
claude mcp add --transport http libredb https://studio.example.com/api/mcp --header "Authorization: Bearer ${LIBREDB_MCP_TOKEN}"
```

Claude Code shows a 401 from a server whose `Authorization` header you configured as a failed connection, and it marks a server configured without that header for an OAuth sign-in, which Studio does not offer.

### Codex

Not verified live.

In `~/.codex/config.toml`:

```toml
[mcp_servers.libredb]
url = "https://studio.example.com/api/mcp"
bearer_token_env_var = "LIBREDB_MCP_TOKEN"
```

### Cursor

Not verified live.

In `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "libredb": {
      "url": "https://studio.example.com/api/mcp",
      "headers": {
        "Authorization": "Bearer ${env:LIBREDB_MCP_TOKEN}"
      }
    }
  }
}
```

### VS Code

Not verified live.

In `.vscode/mcp.json`; VS Code asks for the token once and stores it:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "libredb-mcp-token",
      "description": "LibreDB Studio MCP token",
      "password": true
    }
  ],
  "servers": {
    "libredb": {
      "type": "http",
      "url": "https://studio.example.com/api/mcp",
      "headers": {
        "Authorization": "Bearer ${input:libredb-mcp-token}"
      }
    }
  }
}
```

VS Code's Agent Host does not receive servers that need an `${input:...}` value.

### Gemini CLI

Not verified live.

In `~/.gemini/settings.json`; Gemini CLI takes the streaming HTTP address as `httpUrl`, because `url` selects its SSE client, and it takes the token written in:

```json
{
  "mcpServers": {
    "libredb": {
      "httpUrl": "https://studio.example.com/api/mcp",
      "headers": {
        "Authorization": "Bearer <your-mcp-token>"
      }
    }
  }
}
```

Or run `gemini mcp add -t http -H "Authorization: Bearer <your-mcp-token>" libredb https://studio.example.com/api/mcp`.
Do not commit a settings file that holds a token.

### OpenCode

Verified live on 2026-09-26 with OpenCode 1.18.31.

In `opencode.json`, as a remote server ([OpenCode's MCP servers page](https://opencode.ai/docs/mcp-servers)); `oauth: false` turns off the OAuth sign-in OpenCode would otherwise attempt, and `{env:...}` reads the token from the environment:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "libredb": {
      "type": "remote",
      "url": "https://studio.example.com/api/mcp",
      "enabled": true,
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:LIBREDB_MCP_TOKEN}"
      }
    }
  }
}
```

`opencode mcp list` shows the server as connected when the token verifies.

## Limits

- Authentication is a static bearer token that Studio mints: there is no OAuth and no protected resource metadata document, so a client needs its `Authorization` header configured.
- `run_read_query` reads at most 1000 rows and 1 MiB from the database, and answers at most `max_rows` rows (default 100, at most 500) and 32 KiB; `truncated`, `truncated_by`, `pagination.hasMore` and `pagination.nextOffset` say what was cut and where the next page starts.
- A query with its own `LIMIT` or `TOP`, and `VALUES`, `TABLE` or `EXPLAIN`, cannot be paged with `offset`; the answer says how to page it in SQL.
- `inspect_schema` and `list_connections` fit each page to 32 KiB, and `has_more` and `next_offset` say where the next page starts.
- Every `POST` spends one slot of the same per-user budget the database routes use (`RATE_LIMIT_QUERY_MAX`, 120 a minute by default), so a session and an MCP token of one person share it.
- Studio honours a cancel only when the client closes the request.
  A 2026-07-28 client does that on every cancel, and a 2025 client only by disconnecting.
  A 2025 client's `notifications/cancelled`, sent in a `POST` of its own, gets 202 and is ignored, because each `POST` is answered by a server that keeps no session and does not know the call it names: the call runs to completion or `timeout_ms`, answers on the request that is still open, and is audited that way, never as cancelled.
- A cancel or a timeout ends the wait, not the statement:

| Engine | The client closes the request | `timeout_ms` passes |
|---|---|---|
| PostgreSQL | Studio stops waiting; the statement runs on until `statement_timeout`, which is set to the time left | The database ends the statement, and the client gets the timeout answer |
| SQL Server | Studio stops waiting; the statement runs until the provider's deadline cancels it | The provider cancels the statement, and the client gets the timeout answer |
| DuckDB | Studio stops waiting; the statement runs to completion and its result is discarded | The client gets the timeout answer near `timeout_ms`, and the statement runs on |
| SQLite | The driver is synchronous, so the whole Studio process, the UI included, waits until the statement ends | The client is answered after the statement ends |

- One MCP query against a large SQLite table stops the Studio process while it runs.
- An MCP call on a LibreDB connection that no Studio session holds open opens the file itself and keeps its exclusive lock until that handle has been idle for 30 minutes.
  Every MCP call resets that clock, and meanwhile opening the connection in the Studio editor fails with 503, `LibreDB file is already open by another process (exclusive lock)`.
  When the editor opened the file first, MCP borrows its handle and nothing conflicts ([`docs/providers/libredb.md`](providers/libredb.md#421-on-disk-format-locking-and-version-compatibility-02x)).
- Every request's `Origin` is checked, and on a loopback bind (`HOSTNAME` of 127.0.0.1, ::1 or localhost) its `Host` too; a container binds every address, so there the Origin check and the token protect the endpoint.
- JSON-RPC batches are refused: a request body that is a JSON array gets 400 and `-32600`.
- A client must send `MCP-Protocol-Version` on every request after `initialize`; a request without it gets 400 and `-32020`.
- `GET` and `DELETE` get 405, and a hand-built `DELETE` with neither an `Origin` nor a JSON content type is refused 403 by Studio's CSRF check first.

## Troubleshooting

| Status | Meaning |
|---|---|
| 401 | No `Authorization: Bearer` header, or a token that does not verify: expired, minted before the label changed, or minted for another address (a changed `LIBREDB_MCP_URL`, or under npx a changed `--host` or `--port`); the audit reason says `mcp_token_invalid`, or `mcp_channel_unconfigured` when the label or the URL is unset |
| 403 | The request's `Origin`, or on a loopback bind its `Host`, is not allowed |
| 404 | MCP is off on this server; a client that falls back to the older HTTP+SSE transport retries with `GET` and reports a transport error rather than "disabled" |
| 409 | At minting, the channel is not ready, and the screen lists what to set |
| 429 | The per-user query budget is spent; retry after `Retry-After` seconds |
| 400 `-32020` | A required `MCP-Protocol-Version`, `Mcp-Method` or `Mcp-Name` header is missing, malformed or disagrees with the body |
| 500 | An unrecognized `LIBREDB_MCP_ENABLED`, an unset server version, or a server fault such as a missing `JWT_SECRET`; the server log names which |

A tool call that reaches a database writes two `mcp_operation` audit events: a decision before the database is reached and an outcome after it, under one correlation id, with the token's user and the connection's seed id.
`list_connections` reaches no database, so it writes one event.
A call whose audit record cannot be written is not run.
