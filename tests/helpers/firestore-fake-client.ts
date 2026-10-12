/**
 * A fake FirestoreClient for the provider-surface unit tests. Every request passes the real closed request table
 * (`buildRequest`) before the handler sees it, so a request the table refuses fails the test as it would fail the
 * provider, and the built request and its send options are recorded for the tests. A handler answers the parsed JSON
 * Firestore would, or throws a failure built by errors.ts's own mapping with the context the code under test sent, so a
 * surface's wording and the credential's redaction are exercised exactly as the transport would exercise them.
 */
import { TransportError } from "@/lib/db/http/node-transport";
import {
  type ErrorContext,
  mapGoogleError,
  mapTransportFailure,
  readGoogleError,
} from "@/lib/db/providers/document/firestore/errors";
import type { FirestoreTarget } from "@/lib/db/providers/document/firestore/names";
import type { CallBase } from "@/lib/db/providers/document/firestore/objects";
import { type BuiltRequest, buildRequest, type FirestoreRequest } from "@/lib/db/providers/document/firestore/requests";
import type { FirestoreClient, SendOptions } from "@/lib/db/providers/document/firestore/transport";

export const FAKE_TARGET: FirestoreTarget = Object.freeze({ projectId: "demo-studio", databaseId: "(default)" });
export const FAKE_BASE: CallBase = Object.freeze({ credential: "service_account", secretForms: Object.freeze([]) });
const DOCS = "projects/demo-studio/databases/(default)/documents";

/** The full name of a document of FAKE_TARGET. */
export const docName = (...segments: string[]): string => [DOCS, ...segments].join("/");

export type FakeHandler = (request: FirestoreRequest, built: BuiltRequest, options: SendOptions) => unknown;

export interface SentRequest {
  readonly request: FirestoreRequest;
  readonly built: BuiltRequest;
  readonly options: SendOptions;
}

export interface FakeFirestore {
  readonly client: FirestoreClient;
  readonly sent: SentRequest[];
}

export function fakeFirestore(handler: FakeHandler, mode: "google" | "emulator" = "google"): FakeFirestore {
  const sent: SentRequest[] = [];
  const client: FirestoreClient = {
    mode,
    target: FAKE_TARGET,
    async send(request, options) {
      const built = buildRequest(FAKE_TARGET, request);
      sent.push({ request, built, options });
      return handler(request, built, options);
    },
    close() {},
  };
  return { client, sent };
}

const LISTING: ErrorContext = { phase: "listing", credential: "service_account", target: FAKE_TARGET };

/** The error the transport raises for a Google error envelope, mapped by errors.ts under `context`. */
export function googleFailure(
  httpStatus: number,
  status: string,
  message: string,
  context: ErrorContext = LISTING,
): Error {
  return mapGoogleError(
    readGoogleError(httpStatus, JSON.stringify({ error: { code: httpStatus, status, message } })),
    context,
  );
}

/**
 * The error the transport raises when an answer passes its cap, mapped by errors.ts under the context that was
 * sent.
 */
export function tooLargeFailure(context: ErrorContext): Error {
  return mapTransportFailure(new TransportError("too-large", "The response passed its size bound."), context);
}
