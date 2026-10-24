import type { ActiveSessionDetails, SessionActivity } from "@/lib/db/types";

/**
 * One summary card, counted from `activity`.
 *
 * A refused read and a list the engine did not classify are both N/A: either one printed as 0
 * would claim a measurement that was not made. An empty list is a measurement and stays 0.
 * One unclassified row makes every card N/A, because a partial classification is not a count.
 */
export function sessionActivityFigure(
  sessions: readonly Pick<ActiveSessionDetails, "activity">[],
  activity: SessionActivity,
  unavailable: boolean,
): string {
  if (unavailable || sessions.some((session) => session.activity === undefined)) return "N/A";
  return String(sessions.filter((session) => session.activity === activity).length);
}
