# The two shared-surface lines Sparkplug B's e2e spec needs

`e2e/sparkplug-provider.spec.ts` runs today on the shared `chromium` project, because a new spec
falls there on its own. It should move to the second server, and the reason is the same one
`mqtt-provider.spec.ts` was moved for, measured rather than assumed:

**the spec drives Test Connection three times** - once for a group holding a filter character,
once against the fixture broker, once against a port with nothing on it. The server keeps one
`query` rate-limit bucket per account per process (120 requests a minute), and the shared
project's specs spend it in file order.

Two files change, both shared surfaces, so neither is edited here.

## 1. `playwright.config.ts`

**a.** The shared `chromium` project's `testIgnore`, line 76 at the time of writing, gains one
name. The pattern is one alternation list; add `sparkplug-provider` beside `mqtt-provider`:

```
        /(?:offline-editor|base-path|kafka-provider|etcd-provider|neo4j-provider|milvus-provider|qdrant-provider|influxdb-providers|oxia-provider|databend-provider|snowflake-provider|spark-provider|s3-provider|kubernetes-provider|firestore-connection|firestore-provider|rabbitmq-provider|mqtt-provider|sparkplug-provider|passkey|launch)\.spec\.ts/,
```

**b.** A project block of its own, beside the `chromium-mqtt` one, in the same shape:

```ts
    {
      // sparkplug-provider.spec.ts drives Test Connection three times: a group holding an MQTT
      // filter character, the fixture broker, and a port with nothing on it. It runs against the
      // second server so those requests spend counters only its own specs touch (#1293).
      name: "chromium-sparkplug",
      use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${offlinePort}` },
      testMatch: /sparkplug-provider\.spec\.ts/,
    },
```

## 2. `tests/unit/e2e-project-servers.test.ts`

`SECOND_SERVER_SPECS` gains one entry, so the choice above is pinned rather than remembered:

```ts
  "mqtt-provider.spec.ts",
  "sparkplug-provider.spec.ts",
```

## What the spec needs beside the server

The two tests that reach the fixture need it up:

```
docker compose -f docker/sparkplug/compose-service.yml up -d
```

With the fixture down, exactly one test fails - `Test Connection reaches the fixture broker` -
and the one that asserts a port with nothing on it still passes. The two are not measuring the
same thing, which is the distinction the provider exists to keep, and it was shown by stopping
the broker rather than argued.
