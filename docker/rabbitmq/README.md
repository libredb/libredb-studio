# RabbitMQ fixture

The files the RabbitMQ services of `database-compose.yml` mount.
The provider, its fixture and its tests are described in [`docs/providers/rabbitmq.md`](../../docs/providers/rabbitmq.md).

| File | Mounted by | What it does |
|---|---|---|
| `enabled_plugins` | every broker, read-only | Enables `rabbitmq_management`, `rabbitmq_prometheus` and `rabbitmq_stream_management`; the image alone enables the first two, and Test Connection's queue check needs the third |
| `cluster.conf` | `rabbitmq-cluster-1` to `-3` | Classic peer discovery of the three nodes by name |
| `tls.conf` | `rabbitmq-tls` | AMQP over TLS on 5671 and the management API over TLS on 15671 |
| `certs.sh` | `rabbitmq-tls-certs` | Writes a CA and a server certificate into the `rabbitmq-tls-certs` volume when missing, so no key is committed |
| `evidence/guest-loopback.conf` | no service | Restores guest's localhost-only rule in a throwaway container of `tests/live/rabbitmq-evidence.ts`, for the 401 that rule answers |

No password is written in the compose file: every RabbitMQ service reads `RABBITMQ_LIVE_ADMIN_PASSWORD` and `RABBITMQ_LIVE_FIXTURE_PASSWORD` from the shell, with no default, and a broker refuses to start without the first.
The seed builds both at run time; export them once per shell, then start and seed the default fixture:

```bash
eval "$(bun tests/live/rabbitmq-seed.ts --env)"
docker compose -f database-compose.yml up -d rabbitmq rabbitmq-init
```

While they are not exported, every command on `database-compose.yml`, for any service, warns that the two variables are not set; the other services are not affected.

The seed refuses a broker that is already seeded, because a stream publish appends and would move every offset the captures key on.
To seed again, remove both containers by name and start them again:

```bash
docker rm -f libredb-rabbitmq libredb-rabbitmq-init
docker compose -f database-compose.yml up -d rabbitmq rabbitmq-init
```

The cluster and TLS profiles are started by service name, because a profile with no names also starts every default service of the file:

```bash
docker compose -f database-compose.yml --profile rabbitmq-cluster up -d --wait rabbitmq-cluster-1 rabbitmq-cluster-2 rabbitmq-cluster-3
docker compose -f database-compose.yml --profile rabbitmq-tls up -d --wait rabbitmq-tls-certs rabbitmq-tls
```

The administrator is `libredb-admin` and the four Studio users (`studio-reader`, `studio-browse`, `studio-wide-read`, `studio-untagged`) share one fixture password; both are the values `bun tests/live/rabbitmq-seed.ts --env` exports, built at run time and never written in the repository.
