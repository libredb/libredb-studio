/**
 * This Studio instance's id under governance: `GOVERNANCE_INSTANCE_ID` (docs/GOVERNANCE.md#instance-id).
 *
 * The id keys the instance's heartbeat row and names its listener's ping channel, so it must stay the same across
 * restarts: a recreated container or pod has to update the row it left, not add another. That is why nothing stands
 * in for a missing id, the host name least of all. A container's host name is its id, which changes on every
 * recreate, so each restart would leave a dead heartbeat row behind. Governance requires the variable, and the boot
 * preflight refuses to start without it.
 */

/** The CHECK on the heartbeat's `instance_id` column as `contract.ts` publishes it; the tests pin this copy to it. */
const INSTANCE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const INSTANCE_ID_MISSING_MESSAGE =
  "GOVERNANCE_INSTANCE_ID is not set: governance mode needs an id for this instance that stays the same across restarts, such as libredb-studio";

export function governanceInstanceId(): string {
  const value = process.env.GOVERNANCE_INSTANCE_ID;
  if (value === undefined || value === "") throw new Error(INSTANCE_ID_MISSING_MESSAGE);
  if (!INSTANCE_ID.test(value)) {
    throw new Error(
      `GOVERNANCE_INSTANCE_ID must be 1 to 128 ASCII letters, digits, dots, underscores, colons or hyphens (${INSTANCE_ID.source}), got ${JSON.stringify(value)}`,
    );
  }
  return value;
}
