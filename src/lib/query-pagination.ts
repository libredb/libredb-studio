import type { QueryTab } from "@/lib/types";

/** A result belongs to the query and connection that produced it, even while its editor changes. */
export function hasPageableResult(tab: QueryTab, connectionId: string | undefined): boolean {
  return (
    tab.result?.pagination?.hasMore === true &&
    tab.result.pagination.wasLimited === true &&
    (tab.resultSourceQuery === undefined || tab.resultSourceQuery === tab.query) &&
    (tab.resultConnectionId === undefined || tab.resultConnectionId === connectionId)
  );
}
