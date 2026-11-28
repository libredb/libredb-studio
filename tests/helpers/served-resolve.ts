/**
 * A stand-in for `resolveServedConnection` (src/lib/seed/resolve-connection.ts) in a suite that decides itself which
 * connection a request resolves to: `resolve` answers the connection, and the stand-in answers it with the record the
 * installed server catalog holds of its engine (`servedEngineRecord`), as the served resolve reads it, so a legacy
 * connection reads its legacy record and a provider package's connection the package's record a case installed. The
 * connection is answered as `resolve` gave it, so a suite's partial connection stays as partial as it wrote it.
 */
import { type EngineRecord, servedEngineRecord } from "@/lib/db/server-catalog";

export function servedResolveOver<A extends unknown[], C extends { readonly type: string }>(
  resolve: (...args: A) => Promise<C>,
): (...args: A) => Promise<{ readonly connection: C; readonly engine: EngineRecord }> {
  return async (...args: A) => {
    const connection = await resolve(...args);
    return { connection, engine: servedEngineRecord(connection.type) };
  };
}
