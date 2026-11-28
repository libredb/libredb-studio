import { NextResponse } from "next/server";
import type { UserPayload } from "@/lib/auth";
import { createErrorResponse } from "@/lib/api/errors";
import { editorMaintenanceOpening, metadataMaintenanceOpening } from "@/lib/api/editor-provider";
import { type PackageAnswers, packageAnswers } from "@/lib/api/package-errors";
import type { AcceptedMaintenance, MaintenanceOpening } from "@/lib/api/session-target";
import { requestCatalog } from "@/lib/db/catalog-scope";
import { assertMaintenanceAccepted, assertMaintenanceOffered } from "@/lib/db/engine-facets/maintenance";
import { connectionTextScrub, type ProviderTextScrub, type ProviderWords } from "@/lib/db/operations/provider-text";
import { type EngineConnection, type EngineRecord, legacyProviderType } from "@/lib/db/server-catalog";
import type { MaintenanceOperation } from "@/lib/db/types";
import { resolveServedConnection } from "@/lib/seed/resolve-connection";

/** What the maintenance and preview routes differ in on their shared path. */
export interface MaintenanceRouteForm<Target extends string | undefined> {
  /** The route a package's failure and a withheld sentence are logged under: "POST /api/db/maintenance". */
  readonly route: string;
  /** `createErrorResponse`'s label: "api/db/maintenance". */
  readonly errorRoute: string;
  /** The request's `target` as this route reads it, or the 400 sentence refusing it. */
  readonly readTarget: (target: unknown) => { readonly target: Target } | { readonly refusal: string };
  /** True where a kill runs on the record's metadata session (the run); the preview opens the editor's for every operation. */
  readonly killOnMetadata: boolean;
}

/** A maintenance request past the shared checks, on its opened session. */
export interface MaintenanceRequest<Target extends string | undefined> {
  readonly connection: EngineConnection;
  readonly engine: EngineRecord;
  readonly type: MaintenanceOperation;
  readonly target: Target;
  /** The container the request named, undefined for none or an empty one. */
  readonly container: string | undefined;
  readonly answers: PackageAnswers;
  /** The words of the provider's sentences in the answer, under the record's grant (clause C-112). */
  readonly words: ProviderWords;
  readonly opened: MaintenanceOpening;
  readonly accepted: AcceptedMaintenance;
}

/**
 * The shared path of `POST /api/db/maintenance` and `POST /api/db/maintenance/preview`, run after each route's guard
 * and admin check, which stay in the route files (the role-denial table of docs/SECURITY.md reads them there). In this
 * order, nothing opened or run for a request refused on the way: a JSON object body; the connection and the record of
 * its engine (`resolveServedConnection`), for any engine the server serves (docs/providers/CONTRACT.md, clause C-107);
 * `type` present and text; `container` text or absent; `target` as `form.readTarget` reads it; the operation listed in
 * the record's maintenance, before any session opens (`400 FACET_NOT_OFFERED`, outcome not-sent); a catalog the record
 * does not offer, refused by name before any open (clause C-111); the open, of the record's metadata session for a run's
 * kill (clause C-66) and of the editor's otherwise, its failure the package's open's; and the operation the opened
 * session's server accepts (the same code and outcome, before any call).
 *
 * `serve` answers the request past those checks. A failure anywhere, `serve`'s rejection included, is answered here
 * through `createErrorResponse` under core's scrub of the resolved connection, a package's failure logged once through
 * the request's `PackageAnswers` (clause C-112).
 */
export async function handleMaintenanceRequest<Target extends string | undefined>(
  request: Request,
  session: UserPayload,
  form: MaintenanceRouteForm<Target>,
  serve: (served: MaintenanceRequest<Target>) => Promise<Response>,
): Promise<Response> {
  // Core's scrub of the resolved connection and the request's record of a package's failures, held out here for the
  // `catch` below: before the connection resolves no provider ran.
  let scrub: ProviderTextScrub | undefined;
  let answers: PackageAnswers | undefined;
  try {
    // A body that is not JSON, or JSON that is not an object (`null`, an array, a number), is the caller's mistake and
    // answers 400 in a fixed sentence, rather than reaching the destructuring below as a raw runtime error.
    const body = await request.json().catch(() => null);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const { type, target, container } = body;

    const { connection, engine } = await resolveServedConnection(body, session);
    const connectionScrub = connectionTextScrub(connection, legacyProviderType(engine), "any");
    scrub = connectionScrub;
    const opening = packageAnswers(engine, connectionScrub, form.route);
    answers = opening;

    if (!type) {
      return NextResponse.json({ error: "Maintenance type is required" }, { status: 400 });
    }

    // A `type` that is not text names no operation, and the refusal below quotes the operation, so it is answered here
    // in a fixed sentence that repeats nothing of the value.
    if (typeof type !== "string") {
      return NextResponse.json({ error: `"type" must be a string naming a maintenance operation` }, { status: 400 });
    }

    // `container` is the row's `schemaName`: a string naming the container the target lives in,
    // or absent for a request that names none. A non-string one is a malformed request, and it
    // is answered HERE rather than allowed through to a provider, where the first use - an
    // `identifier.replace` - threw a TypeError and the client read a 500 for a request this
    // route could have refused by reading the field's type (#1091 review). Nothing is opened
    // and nothing is run for it.
    if (container !== undefined && typeof container !== "string") {
      return NextResponse.json(
        { error: `"container" must be a string naming the target's container` },
        { status: 400 },
      );
    }

    // `target` is the same kind of field, read by the route: a non-string one reached the provider, where a number
    // failed as `identifier.replace is not a function` and the client read a 500 quoting provider source, and the run's
    // audit row recorded the serialized value. It is refused here, before any provider opens and before any audit row.
    const read = form.readTarget(target);
    if ("refusal" in read) {
      return NextResponse.json({ error: read.refusal }, { status: 400 });
    }

    // An EMPTY string reads as the absence of a container, the same way the run reads an empty `target` as the
    // whole-database form. Nothing here may hand a provider a value that its own falsy test would have refused anyway,
    // because the run's audit row records what arrived.
    const requestedContainer: string | undefined = container || undefined;

    // The record's maintenance list (FND-4), read before any session opens: an operation the engine does not offer is
    // refused 400 FACET_NOT_OFFERED by name, not-sent, and no provider, SSH tunnel or connection is opened for it.
    assertMaintenanceOffered(engine, type);

    // A run's kill runs on the record's metadata session (docs/providers/CONTRACT.md, clause C-66), so it never waits
    // for a connection the editor's statements hold; every other operation, and every preview, runs on the editor's
    // session. A failure of the open is the package's open's.
    const catalog = requestCatalog(body);
    const opened = await (type === "kill" && form.killOnMetadata
      ? metadataMaintenanceOpening(session, connection, engine, catalog)
      : editorMaintenanceOpening(session, connection, engine, catalog)
    ).catch((error: unknown) => {
      throw opening.answer("open", error);
    });
    const accepted = opened.accepted();

    // The opened session's server may accept fewer operations than the record lists (PostgreSQL and MySQL narrow at
    // connect, a package's open may refine its maintenance), so what it accepts is read, and a refusal answers the same
    // code and outcome.
    assertMaintenanceAccepted(engine, type, accepted);

    // Awaited here, so a rejection of `serve` is answered by the `catch` below.
    return await serve({
      connection,
      engine,
      type,
      target: read.target,
      container: requestedContainer,
      answers: opening,
      words: { scrub: connectionScrub, ownWords: engine.grants.ownWords, route: form.route },
      opened,
      accepted,
    });
  } catch (error) {
    return createErrorResponse(error, { route: form.errorRoute, scrub, logged: answers?.logged(error) === true });
  }
}
