import { DEFAULT_CONNECTION_TYPE } from "@/lib/db/default-connection-type";

/** The engine an explain request names: the view's connection type, or the default connection type when it has none, so `""` gives it too. */
export function explainRequestEngine(databaseType: string | undefined): string {
  return databaseType || DEFAULT_CONNECTION_TYPE;
}
