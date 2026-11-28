import { NextRequest, NextResponse } from "next/server";
import { readProviderDeclarations } from "@/lib/db";
import { createErrorResponse } from "@/lib/api/errors";
import { assertOpenable } from "@/lib/db/open-check";
import { connectionTextScrub, type ProviderTextScrub } from "@/lib/db/operations/provider-text";
import { declaredSessionModel, legacyConnection, legacyProviderType } from "@/lib/db/server-catalog";
import { resolveServedConnection } from "@/lib/seed/resolve-connection";
import { guardRoute } from "@/lib/api/require-session";
import { editorExecutionContext } from "@/lib/api/execution-context";

export const dynamic = "force-dynamic";

/**
 * Return provider capabilities/labels without opening a live DB connection.
 * Metadata methods are sync and type-driven; connecting would needlessly contend
 * for exclusive file locks (SQLite / LibreDB) and network pools.
 *
 * The connection resolves for any engine the server serves (`resolveServedConnection`). A record that offers
 * connection declarations (`EngineOffers.connectionDeclarations`), a legacy engine's, answers its provider's
 * capabilities and labels. Any other, a provider package's engine, answers its record's body instead,
 * `{ engine: { id, displayName }, objectModel }`: the object model its declared session states, null where it states
 * none (`declaredSessionModel`), with no capabilities, labels or cancel offer, which only an opened session states
 * (docs/providers/CONTRACT.md, clause C-107). That body is read without opening a session, after core's open check
 * refuses by name, not-sent, a connection it could never open. The browser reads a package's engine from the server's
 * catalog route (M7), not from this body.
 */
export async function POST(req: NextRequest) {
  // Moved ahead of body parsing: an unauthenticated caller no longer gets a body parsed on its
  // behalf, and the rate limiter sees the request before any work is done for it.
  const guard = await guardRoute({ route: "POST /api/db/provider-meta", bucket: "query", request: req });
  if ("response" in guard) return guard.response;

  // Core's scrub of the resolved connection, held out here for the `catch` below: before the connection resolves no
  // provider ran.
  let scrub: ProviderTextScrub | undefined;
  try {
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Empty request body" }, { status: 400 });
    }

    if (!body || (typeof body === "object" && Object.keys(body).length === 0)) {
      return NextResponse.json({ error: "Empty request body" }, { status: 400 });
    }

    // The resolve refuses a connection that names no type, or none the server serves, before anything is read.
    const { connection: named, engine } = await resolveServedConnection(
      body.connectionId ? body : body.connection ? body : { connection: body },
      guard.session,
    );
    scrub = connectionTextScrub(named, legacyProviderType(engine), "any");

    if (!engine.offers.connectionDeclarations) {
      // Core's checks of any open, to their declarations step: a connection core could never open is refused by name
      // before anything of the engine is answered, as a legacy record's declarations read refuses it.
      assertOpenable(engine, named, editorExecutionContext(guard.session, named), "declarations");
      return NextResponse.json({
        engine: { id: engine.id, displayName: engine.displayName },
        objectModel: declaredSessionModel(engine),
      });
    }
    const connection = legacyConnection(engine, named);

    // No `withOneShotTunnel` here, unlike test-connection and schema-snapshot (#457): this route never connects.
    // Capabilities and labels are type-driven and read by `readProviderDeclarations` without a socket and without
    // opening the connection's tunnel, and it hands back data, never a provider (FND-2 slice 5). The execution context
    // is passed as the other routes pass it (non-admin DuckDB file access): the factory refuses a connection whose
    // engine refuses a denied posture under one that denies it (SQLite), with the sentence its connect gives, before
    // the provider is built, so a caller who could never open it gets that refusal here too.
    const declarations = await readProviderDeclarations(connection, editorExecutionContext(guard.session, connection));

    return NextResponse.json({
      // `supportsQueryCancel` is read off the provider's surface rather than declared by
      // it: it is the cancel route's own check, so the two cannot disagree (#1364).
      capabilities: { ...declarations.capabilities, supportsQueryCancel: declarations.supportsQueryCancel },
      labels: declarations.labels,
    });
  } catch (error) {
    return createErrorResponse(error, { route: "api/db/provider-meta", scrub });
  }
}
