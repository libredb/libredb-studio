import type { ObjectSourceDocument } from "@libredb/provider-sdk/calls";
import type { ObjectModel } from "@libredb/provider-sdk/manifest";
import { callContext, EXECUTE_SLACK_MS, executeDeadlineFor } from "@/lib/api/editor-query";
import type { SessionTarget } from "@/lib/api/session-target";
import { errorCode, errorKind } from "@/lib/db/error-record";
import { waitedSeconds } from "@/lib/db/errors";
import { logger } from "@/lib/logger";
import { type CallerView, refusalError, stopError } from "@/lib/provider-host/access";
import type { ObjectsSession, SourceRecord } from "@/lib/provider-host/core/objects";
import { hostCore } from "@/lib/provider-host/instance";

/*
 * THE OBJECT SOURCE ON THE PROVIDER HOST CORE (docs/providers/CONTRACT.md, clauses C-115, C-111 and M-89).
 *
 * `objectSource` is the caller facade of the object source read: the source route (`POST /api/db/objects/source`)
 * reads one object's source document through it. Each read is one host core source call on the session of the target
 * its caller hands it (`SessionTarget` in src/lib/api/session-target.ts), the legacy bridge's session of a legacy
 * provider (`providerSourceTarget`) or any other session offering `objects.source`, so the facade builds no session and
 * reads nothing of who serves the engine. Each read carries the target's environment, is counted on the target from its
 * start until it ended (`started`, `ended`), or, for a read a stop ended, as the target counts a stopped call, and
 * reads the core the process's composition root installed when it starts, so a read made before the install fails by
 * name as `HostCoreBootOrderError` and sends the session no source call. It builds a fresh request for each read, with
 * a copy of the caller's path, so the core freezes nothing a caller holds.
 *
 * Deadline. Each read waits until its own deadline, taken at that read's start from `clock`, the target's statement
 * timeout plus `EXECUTE_SLACK_MS` (`executeDeadlineFor`), and until the caller's signal.
 *
 * Answer. A read answers the document the host core checked once with `checkSourceAnswer` and cut with
 * `boundSourceAnswer`: a new document, each readable part past `SOURCE_CHARACTER_LIMIT` cut and marked and each part in
 * the form the check read it, so the facade checks and cuts nothing of its own.
 *
 * Errors. A read the caller left is answered as `QueryCancelledError`, outcome unknown, or not-sent when refused
 * before the call; a read past its deadline as `StudioTimeoutRefusal` naming the source read, the statement timeout
 * and the slack. A request naming a kind the session's object model does not state or states without source, or a
 * path deeper than it admits, is refused before any call as `StudioObjectModelRefusal`, outcome not-sent, and a
 * session that does not offer `objects.source` as `FacetNotOfferedError` naming the call, outcome not-sent. An answer
 * that is not the source document of its request is refused by the core and answered by the accessor as a
 * `HostDefectError` naming the rule `source-answer-unreadable` and its pointer, never a value of the answer. A
 * provider's error passes as the same object. A read's failure after its wait ended is logged by route, the request's
 * object kind, and the failure's kind and code, never its text, which can carry a server's words.
 *
 * This module value-imports no provider factory module, so a caller hands it a target of any session.
 */

/** The object source of one session target: each read one host core source call. */
export interface ObjectSource {
  read(path: readonly string[], kind: string): Promise<ObjectSourceDocument>;
}

/**
 * The object model of `session`, read for a session that offers `objects.source`: the model the host core holds every
 * source call to, and the one a caller reads a kind's source and source edits through.
 *
 * @throws {Error} A host defect, when the session states no object model.
 */
export function sourceModel(session: ObjectsSession): ObjectModel {
  if (session.objectModel === undefined) {
    throw new Error("The session offers objects.source and states no object model, a defect of the host's session.");
  }
  return session.objectModel;
}

/**
 * The late port of a source read: a failure after the caller stopped waiting, logged under `route` and the request's
 * object kind `objectKind`, a word of the engine's model, by the failure's kind and code, never its text.
 */
function sourceLate(route: string, objectKind: string): (failure: unknown) => void {
  return (failure) => {
    logger.warn("A source read Studio stopped waiting for failed afterwards", {
      route,
      objectKind,
      kind: errorKind(failure),
      code: errorCode(failure),
    });
  };
}

/**
 * The object source of `target`'s session: each read a host core source call on it under its own deadline, taken from
 * `clock` at its start and the target's timeout, the target's environment and `caller`, counted on the target, its
 * failures after the caller left logged under `route`.
 */
export function objectSource(
  target: SessionTarget<ObjectsSession>,
  caller: AbortSignal,
  route: string,
  clock: () => number = Date.now,
): ObjectSource {
  const view: CallerView = {
    caller,
    deadlineSentence: `The source read did not answer within the statement timeout of ${waitedSeconds(target.timeout())} and ${waitedSeconds(EXECUTE_SLACK_MS)} more for the engine's own answer, so Studio stopped waiting for it.`,
  };
  return {
    read: async (path, kind) => {
      const core = hostCore();
      const ctx = callContext(executeDeadlineFor(target.timeout(), clock()), caller, target.env);
      target.started();
      let record: SourceRecord | undefined;
      try {
        record = await core.sourceCall(target.session, { path: [...path], kind }, ctx, {
          late: sourceLate(route, kind),
        });
      } finally {
        target.ended(record);
      }
      if (record.kind === "refused") throw refusalError(record, view);
      if (record.kind === "stopped") throw stopError(record.reason, view);
      return record.answer;
    },
  };
}
