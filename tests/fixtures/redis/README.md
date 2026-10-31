# Redis captures

What Redis 8.10.2 and Valkey 9.1.2 answered ioredis before any provider code ran, which the Redis provider's agent tests replay instead of a live server.

## The agent boundary

`8.10.2/agent-boundary/` and `valkey-9.1.2/agent-boundary/` hold what each server answers every principal the agent read-only profile may meet.
Each directory's `run.sh` writes every file there: it starts one digest-pinned server of its own with the image's stock configuration, so its `default` user is `on nopass ~* &* +@all`, and runs `agent-boundary-probe.ts`, which seeds it, creates the ACL users with passwords generated for the run and refuses to write a capture holding any form of any of them.
The container is removed when the run ends; `REDIS_PREFIX` names it and `REDIS_PORT` picks its loopback port.

- `command-info.json`: `COMMAND INFO` of every command the agent's table holds, every proof probe, and the reads a reviewer would try first, which the table walk test reads.
- `identity.json` and `identity-compatibility.json`: what `HELLO 2` and `INFO server` say the server is, and what Valkey says with `extended-redis-compatibility` on.
- `<principal>.json`: per principal, the no-op write probes with what the server held before and after them, the table's reads, and the reads outside the table, each on a connection of its own.
- `midrun.json`: the probes before and after the admin grants `+del` to a user that passed them.
- `notifications.json`: what the table's reads and the refused probes publish on a server that notifies every keyspace class.
