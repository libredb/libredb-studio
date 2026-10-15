# Modbus and `playwright.config.ts`: nothing to land

`e2e/modbus-provider.spec.ts` needs **no project block and no `testIgnore` entry**, so this
delivery is a statement rather than a patch.

The second-server projects exist for one reason, which the config states: a spec that drives
**Test Connection** spends the shared account's per-process rate-limit bucket, and ~30 specs
replaying "fresh login" against one server exhaust it. This spec never clicks Test Connection. It
signs in once, establishes one connection and runs one read, which is what `functional-smoke.spec.ts`
does on the shared server.

It needs no entry in `SECOND_SERVER_SPECS` either, and
`tests/unit/e2e-project-servers.test.ts` was run against this branch to check that: 57 pass, 0 fail.

**What would change this.** If the spec ever asserts a Test Connection outcome - the refusal a
wrong port gets, say, which is a real thing to want for an engine whose `connect()` dials - it
takes a second server at that moment, and the entry belongs here then.
