/**
 * How a spawned child failed, in one sentence a reader can act on (B20).
 *
 * WHY THIS EXISTS. A test that spawns a binary and reports only the child's stderr says nothing
 * at all when the child was KILLED, and that is the one case worth telling apart from the rest.
 * MEASURED on bun 1.4.2 with OpenSSL 3.6.3, ON A POSIX SYSTEM - the platform is part of the
 * measurement, because signals are. On the Windows runner of this repository the same kill reports
 * `exitCode` 0 instead of null (MEASURED, PR #1800: both bun's `exitCode` and node's `status` came
 * back 0, which is what the two red assertions read). There is therefore no signal to name there,
 * and the sentence below becomes `failed with exit 0` - the whole of what that platform reports.
 * The helper needs no branch for it: the signal is simply absent, and the code is what gets named.
 * `tests/unit/spawn-outcome.test.ts` holds each platform's half, each skipped on the other with
 * its reason in the title.
 *
 *   openssl x509 -in /missing          exitCode 1     signalCode -        stderr "Could not open file or uri..."
 *   openssl x509 -unknown-option       exitCode 1     signalCode -        stderr "x509: Unknown option..."
 *   a child sent SIGKILL               exitCode null  signalCode SIGKILL  stderr ""
 *   a child sent SIGTERM               exitCode null  signalCode SIGTERM  stderr ""
 *
 * So every ordinary refusal writes to stderr, and an EMPTY stderr means the child did not get to
 * refuse: something killed it. On 2026-10-16 that is exactly what reached CI on a pull request -
 * `error: openssl x509 -in etcd-ca.crt -trustout -out etcd-ca-trusted.crt failed:` and nothing
 * after the colon - and the file reported `0 pass 1 fail` because its beforeAll never finished.
 * A reader cannot tell that from a mistyped argument, and the two are fixed in different places.
 *
 * `tests/run-tests.ts` already words it this way for the coverage merge it spawns, in its own
 * comment: *"A child that died by a signal reports exitCode null and signalCode instead (measured
 * on bun 1.4.2) ... `failed with exit null` names no cause."* This is that sentence, shared, so
 * every test that spawns something says it the same way.
 *
 * AND THE RUNNER KEEPS ITS OWN COPY ON PURPOSE, which is why that one line was not replaced with a
 * call to this. MEASURED: `tests/run-tests.ts` imports from `node:*` and `./runner/*` only, and
 * NONE from `tests/helpers/`. The runner must not depend on the helpers of the tests it runs, or
 * the dependency points the wrong way. So the sentence has two homes by design,
 * and a reader changing one should know to look at the other: `run-tests.ts` around its coverage
 * merge, and here.
 *
 * WHAT THIS DOES NOT DO: it does not stop a child being killed. It makes the next kill name
 * itself, which is what the run on 2026-10-16 could not do.
 */

/**
 * The parts of a spawn result this reads. THREE SPELLINGS, because this repository spawns three
 * ways and each names the same two facts differently:
 *
 *   `Bun.spawnSync` / `Bun.spawn`   `exitCode`  `signalCode`
 *   `node:child_process.spawnSync`  `status`    `signal`
 *   an awaited `child.exited`       a number    (the caller holds the child for the name)
 *
 * The third is why `exitCode` is optional: `await child.exited` resolves to 137 for a SIGKILL
 * rather than null (MEASURED), so a caller there passes the child itself and gets the name.
 */
export interface SpawnFailure {
  readonly exitCode?: number | null;
  /** node:child_process calls it `status`. */
  readonly status?: number | null;
  /** bun gives a signal with no name (a Linux real-time one) as its number. */
  readonly signalCode?: string | number | null;
  /** node:child_process calls it `signal`. */
  readonly signal?: string | number | null;
  /** node:child_process sets this instead of a status when it could not run or timed out. */
  readonly error?: Error | undefined;
}

/**
 * `was killed by SIGKILL`, or `failed with exit 1`.
 *
 * Truthiness rather than `!== null` on purpose: bun reports `undefined` for a child that was not
 * signalled (measured), node reports `null`, and a kill is the only case where either field
 * carries a name.
 */
export function howItFailed(run: SpawnFailure): string {
  const signal = run.signalCode ?? run.signal;
  if (signal) return `was killed by ${signal}`;
  // node:child_process reports neither a status nor a signal when the child could not be started
  // or hit its `timeout`, and puts the reason in `error` instead. `tests/integration/db/
  // sqlite-provider.test.ts:3801` records the same thing: a status of null read on its own USED TO
  // raise a message that names nothing, and under a concurrent runner a timeout is the likely
  // failure. (That file's wording is past tense because this change gave its message a cause.)
  if (run.error) return `could not run (${run.error.message})`;
  // Whichever field the caller's spawn HAS, not whichever is non-null: `exitCode ?? status` turned
  // a bun result of `{ exitCode: null }` into "exit undefined", which the test below caught.
  const code = run.exitCode !== undefined ? run.exitCode : run.status;
  return `failed with exit ${code}`;
}
