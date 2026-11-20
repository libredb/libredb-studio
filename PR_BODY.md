# Redis Sentinel connections (master discovery and failover)

## What / why

Redis connections today address one server (`host` + `port`). A Sentinel-managed deployment
cannot be used that way: the master's address changes on failover, and asking the operator to
type whichever node happens to be master turns every failover into a configuration change. This PR
adds a **Sentinel mode** to the Redis provider. The connection names the master group and the
sentinel nodes; ioredis asks the sentinels for the current master on every connect and reconnect,
so a promotion is picked up without editing the connection. Standalone Redis behaviour is unchanged.

The triad is kept in one PR: provider/form/seed code, [`docs/providers/redis.md`](docs/providers/redis.md)
§4.6 (plus API and seed docs), and provider + cross-layer tests.

## Fields

| Field | Type | Where | Notes |
|---|---|---|---|
| `masterName` | `string` | dialog: Advanced; seed schema | Master group name (ioredis `name`), trimmed. Either this or `sentinelNodes` switches the connection to Sentinel mode; both are required. Public — a group name. |
| `sentinelNodes` | `string` | dialog: Advanced; seed schema | Comma/newline-separated `host[:port]`; node without port takes `26379`; bracketed IPv6 accepted; invalid ports refused naming the entry. Stored byte for byte, parsed at open. Public — addresses. |
| `sentinelPassword` | `string` | dialog: Advanced; seed schema | Sentinels' `AUTH`. Empty falls back to the master's `password` (Bitnami one-secret chart). No sentinel ACL user; sentinels authenticate as `default`. Secret — classified and sealed like `password`. |

In Sentinel mode `host`/`port` are not read. The dialog keeps the Host row and draws the three
boxes behind **Advanced**, because they are an alternative *mode*, not extra always-on fields.

## Design choices and rationale

- **Sentinel trio as three discrete fields, not a connection string.** The provider deliberately
  does not consume `connectionString`; a pasted URL never overrides the Sentinel fields, and a seed
  carrying both is refused. This keeps one source of truth per connection.
- **Either address field enables the mode; validate() refuses a half-filled form.** A connection
  with only `masterName` or only `sentinelNodes` would otherwise silently connect to the standalone
  host and appear to work. Missing nodes, missing name and an enabled SSH tunnel are refused before
  any socket — a tunnel forwards `host:port`, which a Sentinel connection does not have, so
  connecting around the bastion is not an option.
- **Bounded `sentinelRetryStrategy` (200/400/600 ms, then give up).** ioredis retries an unreachable
  sentinel list forever by default; `connect()` would never settle and Test Connection would hang
  with no message. Returning `null` yields ioredis's own "All sentinels are unreachable" with the
  last error, wrapped as a typed connect error that names the master group. A master unreachable
  *after* the sentinels answered stays on ioredis's ordinary retry path: that is the failover window.
- **No `role` override.** ioredis's default `master` is correct here; the provider's `readOnly: true`
  option is the *Cluster* replica setting and must not make a Sentinel connection read a replica.
- **TLS on both hops.** With the SSL panel on, one `tls` object goes to the sentinels as
  `sentinelTLS` and to the resolved master via `enableTLSForSentinelMode: true`; without the flag
  ioredis speaks plaintext to both. The existing mode matrix (`disable`/`require`/`verify-system`/
  `verify-ca`/`verify-full`, CA and client certs) applies unchanged.
- **Dead clients are reported.** An `end` listener marks the provider disconnected when ioredis
  gives up for good during a reconnect, so the provider cache opens a fresh client instead of
  serving a dead handle. The guard keeps a short-lived object-surface client from closing a live
  session.
- **Identity and secret handling.** `masterName` and `sentinelNodes` move the object-edit
  fingerprint, the provider cache key and the agent identity (they decide which server answers).
  `sentinelPassword` is excluded from content digests on the password rule — rotating a credential
  changes who may reach the catalog, not which catalog — but is framed in the provider cache key
  and the seed-copy resolution key, where credential identity matters. The trio is declared in the
  seed schema, copied by the role filter, resolvable from `${ENV}`/`${vault:...}`, and refused by
  name on every other engine.
- **VS Code host prompts** gained the three labels so the desktop form can save a Sentinel
  connection; `FIELD_PROMPTS` is typed by `ConnectionField`, so this is a required row, not UI polish.

## Tests / coverage

- `bun run typecheck` — pass. `bun run lint` — pass (0 errors; pre-existing warnings only).
- `bunx biome format --write` on every changed file — pass.
- Scoped runner: 14 touched test files, **1279 tests pass**, including
  `tests/integration/db/redis-provider.test.ts` (Sentinel options, parsing, validation, retries,
  TLS both hops, failure messages, `end` listener, fingerprint, seed), the new cross-layer
  `tests/unit/db/redis/sentinel-fields.test.ts`, connection-form/hook tests, golden snapshots,
  docs-triad tests, seed tests and secret-classification tests. All 3 doc/golden suites affected by
  the new fields were regenerated/updated and pass.
- Full `bun run test`: the pre-existing environment-dependent failures remain (etcd/RabbitMQ/etc.
  TLS fixture key mismatches, `bun:sqlite` API drift, timing-sensitive seam guards). None are in
  the Redis/Sentinel or fields/docs areas; every test file touched by this PR passes in isolation.
- Focused coverage (`bun tests/run-tests.ts --coverage --merge-into=coverage/pr.info` over the 14
  passing files + `node scripts/check-coverage.mjs coverage/pr.info`): the global 100% gate cannot
  pass on a subset run, but a line-by-line intersection of the merged lcov with the added source
  lines shows **all 294 added executable lines covered**. The repository-wide coverage job runs
  the whole suite in CI.
- Drift guards: `knip`, `chart:check`, `channels:showcase:check`, `readme:check`, `security:check`
  — all pass. VS Code extension `npx mocha` unit suite — 1257 passing.

## Live verification checklist (NOT done)

These are asserted at the option/parser/event boundary with a mocked ioredis; there is **no live
Sentinel deployment** in the suite.

- [ ] Failover: kill/promote the master, confirm the provider reconnects to the new master through
      the sentinels and that a subsequent query reaches it.
- [ ] Sentinel `AUTH` with a sentinel password distinct from the Redis password; and the one-secret
      Bitnami case with `sentinelPassword` empty.
- [ ] TLS to both hops against a Sentinel deployment whose sentinels and master both require TLS,
      including a verifying mode with a shared CA.
- [ ] Give-up behaviour when every sentinel is unreachable (connect), and after the bounded retries
      are exhausted on a reconnect.
- [ ] Seed a Sentinel connection from a deployment file with `${ENV}` and Vault references.
