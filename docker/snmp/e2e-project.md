# The playwright delivery for SNMP: nothing to add, and the measurement that says so

`playwright.config.ts` and `tests/unit/e2e-project-servers.test.ts` are shared surfaces: five
engines land in one round, and five branches editing one file is a merge to resolve rather than a
change to review. So each engine writes what it needs from those two files here and the
coordinating session applies the five at once. **This engine's change is empty.** An empty
delivery is worth writing down only with the reason, so here it is.

## What `e2e/snmp-provider.spec.ts` needs

Nothing but the shared server. The seven cases drive the connection dialog: the driver is offered,
the address is a host and a port, the secret is labelled a community rather than a password, the
consent to a community in clear is drawn in this protocol's words, no SSL / TLS panel is offered,
no SSH Tunnel toggle is offered, and the read-only sentence says what makes it read-only. **No case
reads from an agent**, so no fixture has to be up, and the spec is as cheap as any other dialog
spec in the shared project.

The two absences are measured here as well as in the unit layer because the unit layer's two halves
are joined by a mock: one test pins that the real entry declares the flag, the other pins that the
flag removes the control, but the second declares it on a mock entry. Neither draws the real entry
on a screen, and this engine's dialog is the only place the two meet.

Reading a live agent from a browser is the live check's job
(`tests/live/snmp-live-check.ts`, nine checks under both runtimes) and the integration layer's
(`tests/integration/db/snmp-provider.test.ts`, replaying recorded datagrams). Putting it in the
browser as well would be a third copy of the same claim, on the slowest layer.

## Why no project block, measured rather than assumed

The shared `chromium` project takes `testDir: "./e2e"` and leaves out exactly the specs named in
its `testIgnore`:

```
/(?:offline-editor|base-path|kafka-provider|etcd-provider|neo4j-provider|milvus-provider|
   qdrant-provider|influxdb-providers|oxia-provider|databend-provider|snowflake-provider|
   spark-provider|s3-provider|kubernetes-provider|firestore-connection|firestore-provider|
   rabbitmq-provider|mqtt-provider|passkey|launch)\.spec\.ts/
```

`snmp-provider.spec.ts` is not in that alternation, so the shared project collects it with no
edit. A project block would also need a second server process, and the specs that have one have it
for a measured reason - a rate-limit budget they exhaust, or a second engine's container. Neither
applies here.

For the same reason the spec is **not** added to `SECOND_SERVER_SPECS` in
`tests/unit/e2e-project-servers.test.ts`: that list says "this spec runs against the second
server", and asserting it for a spec that runs against the first would make both of its cases
fail - the one that holds the spec out of the shared project, and the one that finds its own
project.

## The one cost this does add, stated because the shared project's own comment asks for it

That project's header records a measured hazard: roughly thirty specs share one account's
rate-limit bucket (120 requests per 60 s), and `offline-editor.spec.ts` was moved out after it
spent the budget. This spec signs in once per case in `beforeEach`, so it adds **seven logins** to
that bucket. Measured on this branch, and the scope of that measurement matters: the FIVE cases
that existed then passed against a shared server (`5 passed`). The two absence cases added since
have NOT been run here - Playwright does not start on this machine - so what is measured is five of
seven, and the two are written against the same dialog the other five drive. If the bucket ever
becomes the reason a later spec fails, this file is one of the places to look, and moving these
cases behind their own project is the cheap answer - it needs no fixture, so a second server
process is all it would take.
