/**
 * One console run: the statement (with the grid's paging clause, when `prepareQuery` added one) parsed, refused
 * before any request when it is outside v1, then answered by its command as one grid.
 *
 * A type the server stopped serving since discovery was read (a `text/plain` 404) reads discovery again once and
 * runs the statement once more, as kubectl refreshes its cache on an unknown type.
 */
import { QueryError } from "@/lib/db/errors";
import { withTypeRefresh } from "../discovery";
import { KUBERNETES_TYPE } from "../limits";
import { apiResources, apiVersions, version } from "./api";
import { canI, whoami } from "./auth";
import type { KubectlContext, KubectlGrid } from "./context";
import { describeObject } from "./describe";
import { listEvents } from "./events";
import { explain } from "./explain";
import { getDocuments } from "./get-documents";
import { getList, getNamed, type RowWindow } from "./get-list";
import { readLogs } from "./logs";
import { readKubectlRun } from "./paging";
import type { KubectlStatement } from "./parse";
import { readTop } from "./top";
import { getWatch } from "./watch";

async function answer(
  context: KubectlContext,
  statement: KubectlStatement,
  window: RowWindow | undefined,
): Promise<KubectlGrid> {
  switch (statement.command) {
    case "get":
      if (statement.watch) return getWatch(context, statement);
      if (statement.output === "json" || statement.output === "yaml") return getDocuments(context, statement);
      return statement.names.length > 0 ? getNamed(context, statement) : getList(context, statement, window);
    case "describe":
      return describeObject(context, statement);
    case "logs":
      return readLogs(context, statement);
    case "top":
      return readTop(context, statement);
    case "events":
      return listEvents(context, statement);
    case "api-resources":
      return apiResources(context, statement);
    case "api-versions":
      return apiVersions(context);
    case "explain":
      return explain(context, statement);
    case "auth-can-i":
      return canI(context, statement);
    case "auth-whoami":
      return whoami(context);
    case "version":
      return version(context);
  }
}

/** The grid one statement answers, or the sentence it is refused with before anything is sent. */
export async function runKubectl(context: KubectlContext, text: string): Promise<KubectlGrid> {
  const run = readKubectlRun(text);
  if (!run.ok) throw new QueryError(run.message, KUBERNETES_TYPE);
  return withTypeRefresh(context.surface.discovery, () => answer(context, run.statement, run.page));
}
