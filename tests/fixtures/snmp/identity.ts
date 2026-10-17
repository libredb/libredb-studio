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
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG = join(import.meta.dir, "../../../docker/snmp/snmpd.conf");

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
