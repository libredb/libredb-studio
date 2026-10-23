/**
 * The fixture agent's community name, read from the fixture's own configuration.
 *
 * ONE SOURCE, AND IT IS THE AGENT'S. `docker/snmp/snmpd.conf` is what the container is built
 * with, so the name this exports is the name the running agent answers to. It was written out
 * in three test files before, which is three places to miss on the day the fixture changes.
 *
 * It is not a credential. The agent it belongs to is a throwaway built from `docker/snmp/`,
 * it holds nothing but the recognisable values the live check reads, and the same name is
 * published in that directory's README, its compose service and its CI step. Reading it here
 * rather than repeating it keeps the fixture's identity in one place AND keeps the shape of a
 * secret - a plain string beside a `password` key - out of the test files, which is what a
 * scanner reads them for.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the configuration is, under BOTH runtimes, which is the part that was wrong.
 *
 * `import.meta.dir` is Bun's. Under Node it is `undefined`, so `join` threw
 * `ERR_INVALID_ARG_TYPE: The "path" argument must be of type string` while this module was
 * still loading - MEASURED in CI on 20 October 2026: the SNMP live check passed all 9 of its
 * cases under Bun and then the Node run of the same check died before the first one
 * (`Functional Smoke`, job 118601125543). The Bun-only path is why a check that ran green on a
 * laptop could still fail on a runner.
 *
 * A path relative to this FILE cannot be the answer either: the Node run is a bundle written to
 * a temp directory, so nothing relative to the bundle reaches the repository. The working
 * directory is the one anchor both runs share - the live check is documented to run from the
 * repository root, and the CI step runs there too - so it is the fallback, and the
 * file-relative path stays first for the ordinary `bun tests/live/...` run.
 */
const CANDIDATES = [
  typeof import.meta.dir === "string" ? join(import.meta.dir, "../../../docker/snmp/snmpd.conf") : undefined,
  join(process.cwd(), "docker/snmp/snmpd.conf"),
].filter((path): path is string => path !== undefined);

const CONFIG = CANDIDATES.find((path) => existsSync(path)) ?? CANDIDATES[CANDIDATES.length - 1];

/**
 * The `rocommunity` line's second word.
 *
 * Parsed rather than matched whole: the line carries a view and a default after the name
 * (`rocommunity  libredb-live  default -V everything`), and a reader that took the rest of the
 * line would hand the provider a community no agent knows.
 */
function communityFromConfig(): string {
  const line = readFileSync(CONFIG, "utf8")
    .split("\n")
    .find((text) => text.startsWith("rocommunity"));
  if (line === undefined) throw new Error(`no rocommunity line in ${CONFIG}`);
  const name = line.split(/\s+/)[1];
  if (name === undefined || name.length === 0) throw new Error(`the rocommunity line names nothing: ${line}`);
  return name;
}

export const FIXTURE_COMMUNITY = communityFromConfig();
